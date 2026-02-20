import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import puppeteer from 'puppeteer-core';
import config from '../config.js';

/** Viewports matching screen emulation (desktop/mobile). */
const VIEWPORTS = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1 },
  mobile: { width: 390, height: 844, deviceScaleFactor: 2 },
};

const WEBP_QUALITY = 85;
const PAGE_LOAD_TIMEOUT_MS = 30000;

/** Number of Lighthouse runs to perform; median summary is used for stable scores (aligns with PageSpeed methodology). */
const MEDIAN_RUNS = 3;

function median(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].filter((v) => v != null && !Number.isNaN(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Take full-page WebP screenshot using the same Chrome instance (by port).
 * Uses deviceScaleFactor 1 for mobile to avoid Chromium/Puppeteer bugs with
 * fullPage + deviceScaleFactor 2 (clipping, duplication, or capture failure).
 * @param {number} port - Chrome remote debugging port
 * @param {string} url - Page URL
 * @param {'desktop'|'mobile'} formFactor
 * @returns {Promise<{ buffer: Buffer, ext: 'webp' } | null>}
 */
async function takeScreenshotInBrowser(port, url, formFactor) {
  const vp = VIEWPORTS[formFactor] || VIEWPORTS.mobile;
  let browser;
  try {
    browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${port}`,
    });
    const page = await browser.newPage();
    const screenshotScale = formFactor === 'mobile' ? 1 : vp.deviceScaleFactor;
    await page.setViewport({
      width: vp.width,
      height: vp.height,
      deviceScaleFactor: screenshotScale,
    });
    await page.goto(url, {
      waitUntil: 'load',
      timeout: PAGE_LOAD_TIMEOUT_MS,
    });
    await page.evaluate(() => window.scrollTo(0, 0));
    const buffer = await page.screenshot({
      type: 'webp',
      quality: WEBP_QUALITY,
      fullPage: true,
    });
    await browser.disconnect();
    return { buffer: Buffer.from(buffer), ext: 'webp' };
  } catch (err) {
    if (browser) await browser.disconnect().catch(() => {});
    console.error('Screenshot in Lighthouse session failed (%s):', formFactor, err.message);
    return null;
  }
}

/**
 * Run a single Lighthouse pass (launch Chrome, run audit, screenshot, kill).
 * @param {string} url - Valid http(s) URL
 * @param {{ formFactor?: 'mobile'|'desktop', categories?: string[] }} options
 * @returns {{ report: object, summary: object, screenshot: { buffer: Buffer, ext: 'webp' } | null }}
 */
async function runOneLighthouseRun(url, options) {
  const launchOpts = { chromeFlags: config.chromeFlags };
  if (config.chromePath) {
    launchOpts.chromePath = config.chromePath;
  }
  let chrome;
  try {
    chrome = await chromeLauncher.launch(launchOpts);
  } catch (launchErr) {
    const msg =
      launchErr.code === 'ECONNREFUSED'
        ? 'Chrome started but could not connect. Ensure Chromium/Chrome is installed and set CHROME_PATH if needed (see README).'
        : launchErr.message;
    throw new Error(`Chrome failed to start: ${msg}`);
  }
  try {
    const lighthouseOptions = {
      port: chrome.port,
      logLevel: 'error',
      output: 'json',
    };
    const formFactor = options.formFactor === 'desktop' ? 'desktop' : 'mobile';
    const settings = {
      formFactor,
      screenEmulation: formFactor === 'desktop'
        ? { mobile: false, width: 1440, height: 900, deviceScaleFactor: 1, disabled: false }
        : { mobile: true, width: 390, height: 844, deviceScaleFactor: 2, disabled: false },
    };
    if (options.categories && options.categories.length) {
      settings.onlyCategories = options.categories;
    }
    const lighthouseConfig = {
      extends: 'lighthouse:default',
      settings,
      // Full-resolution filmstrip (no thumbnail scaling), more frames for smoother load video
      audits: [
        { path: 'screenshot-thumbnails', options: { thumbnailWidth: null, numberOfThumbnails: 25 } },
      ],
    };
    const result = await lighthouse(url, lighthouseOptions, lighthouseConfig);
    const lhr = result.lhr;
    const summary = extractSummary(lhr);
    const screenshotUrl = lhr.finalUrl || url;
    const screenshot = await takeScreenshotInBrowser(chrome.port, screenshotUrl, formFactor);
    await chrome.kill();
    return { report: lhr, summary, screenshot };
  } catch (lighthouseErr) {
    await chrome.kill().catch(() => {});
    const msg =
      lighthouseErr.code === 'ECONNREFUSED'
        ? 'Chrome exited before Lighthouse could connect. Try installing Chromium (e.g. apt install chromium-browser) and set CHROME_PATH to its binary (see README).'
        : lighthouseErr.message;
    throw new Error(`Lighthouse run failed: ${msg}`);
  }
}

/**
 * Build a summary from median category scores and median metric values across runs.
 * Recommendations and metadata (finalUrl, chromeVersion) come from the run whose performance score is closest to the median.
 */
function mergeMedianSummary(runs) {
  if (!Array.isArray(runs) || runs.length === 0) return null;
  const first = runs[0].summary;
  if (!first) return null;

  const categories = {};
  for (const id of Object.keys(first.categories || {})) {
    const values = runs.map((r) => r.summary.categories && r.summary.categories[id]).filter((v) => v != null);
    const m = median(values);
    if (m != null) categories[id] = Math.round(m);
  }

  const metrics = {};
  const metricIds = [
    'first-contentful-paint',
    'largest-contentful-paint',
    'total-blocking-time',
    'cumulative-layout-shift',
    'speed-index',
    'interactive',
  ];
  for (const id of metricIds) {
    const values = runs.map((r) => r.summary.metrics && r.summary.metrics[id] && r.summary.metrics[id].value).filter((v) => v != null);
    const m = median(values);
    if (m != null) {
      const runWithMedian = runs.find((r) => r.summary.metrics && r.summary.metrics[id]);
      const displayValue = runWithMedian && runWithMedian.summary.metrics[id].displayValue;
      metrics[id] = { value: m, displayValue: displayValue || String(m) };
    }
  }

  const perfScores = runs.map((r) => (r.summary.categories && r.summary.categories.performance) ?? null).filter((v) => v != null);
  const medianPerf = median(perfScores);
  const bestRun = medianPerf == null
    ? runs[0]
    : runs.reduce((best, r) => {
        const score = (r.summary.categories && r.summary.categories.performance) ?? 0;
        const bestScore = (best.summary.categories && best.summary.categories.performance) ?? 0;
        return Math.abs(score - medianPerf) < Math.abs(bestScore - medianPerf) ? r : best;
      });

  return {
    categories,
    metrics,
    recommendations: (bestRun.summary.recommendations || []).slice(),
    finalUrl: bestRun.summary.finalUrl || first.finalUrl,
    chromeVersion: bestRun.summary.chromeVersion || first.chromeVersion,
  };
}

/**
 * Run Lighthouse on a URL and return full report, summary, and full-page screenshot.
 * Runs Lighthouse MEDIAN_RUNS times and uses the median of category scores and metrics for the summary (aligns with PageSpeed Insights methodology).
 * The stored report and screenshot are from the run whose performance score is closest to the median.
 * @param {string} url - Valid http(s) URL
 * @param {{ formFactor?: 'mobile'|'desktop', categories?: string[] }} options
 * @returns {{ report: object, summary: object, screenshot: { buffer: Buffer, ext: 'webp' } | null }}
 */
export async function runLighthouse(url, options = {}) {
  const runs = [];
  for (let i = 0; i < MEDIAN_RUNS; i++) {
    const result = await runOneLighthouseRun(url, options);
    runs.push(result);
  }
  const medianSummary = mergeMedianSummary(runs);
  const perfScores = runs.map((r) => (r.summary.categories && r.summary.categories.performance) ?? null).filter((v) => v != null);
  const medianPerf = median(perfScores);
  const bestRun = medianPerf == null
    ? runs[0]
    : runs.reduce((best, r) => {
        const score = (r.summary.categories && r.summary.categories.performance) ?? 0;
        const bestScore = (best.summary.categories && best.summary.categories.performance) ?? 0;
        return Math.abs(score - medianPerf) < Math.abs(bestScore - medianPerf) ? r : best;
      });
  return {
    report: bestRun.report,
    summary: medianSummary,
    screenshot: bestRun.screenshot,
  };
}

/**
 * Normalize a Lighthouse category score to 0-100.
 * LHR stores scores in 0-1 range; we always persist 0-100 for display.
 * If a value already looks like 0-100 (> 1), use it as-is (clamped).
 */
function normalizeCategoryScore(score) {
  const n = Number(score);
  if (Number.isNaN(n) || n < 0) return null;
  const out = n <= 1 ? Math.round(n * 100) : Math.round(Math.min(100, n));
  return Math.max(0, Math.min(100, out));
}

/**
 * Parse Chrome/Chromium version from a host user agent string.
 * @param {string} [ua]
 * @returns {string|null} e.g. "120.0.6099.0" or null
 */
function parseChromeVersion(ua) {
  if (!ua || typeof ua !== 'string') return null;
  const m = ua.match(/Chrom(?:e|ium)\/([\d.]+)/i);
  return m ? m[1] : null;
}

/**
 * Extract category scores and key metrics from LHR for list/dashboard display.
 */
function extractSummary(lhr) {
  const categories = {};
  if (lhr.categories) {
    for (const [id, cat] of Object.entries(lhr.categories)) {
      if (cat && cat.score != null) {
        const score = normalizeCategoryScore(cat.score);
        if (score !== null) {
          categories[id] = score;
        }
      }
    }
  }
  const audits = lhr.audits || {};
  const metrics = {};
  const metricIds = [
    'first-contentful-paint',
    'largest-contentful-paint',
    'total-blocking-time',
    'cumulative-layout-shift',
    'speed-index',
    'interactive',
  ];
  for (const id of metricIds) {
    const audit = audits[id];
    if (audit && audit.numericValue != null) {
      metrics[id] = {
        value: audit.numericValue,
        displayValue: audit.displayValue || String(audit.numericValue),
      };
    }
  }
  const recommendations = extractRecommendations(audits);
  const hostUserAgent = lhr.environment && lhr.environment.hostUserAgent;
  const chromeVersion = parseChromeVersion(hostUserAgent || lhr.userAgent);
  return {
    categories,
    metrics,
    recommendations,
    finalUrl: lhr.finalUrl || lhr.requestedUrl,
    chromeVersion: chromeVersion || undefined,
  };
}

/**
 * Extract audits that need attention (score < 1) for the report page.
 * @param {object} audits - LHR audits
 * @returns {Array<{ id: string, title: string, description?: string, score: number, displayValue?: string }>}
 */
function extractRecommendations(audits) {
  const out = [];
  const MAX_RECOMMENDATIONS = 20;
  for (const [id, audit] of Object.entries(audits)) {
    if (out.length >= MAX_RECOMMENDATIONS) break;
    if (!audit || audit.score == null || typeof audit.score !== 'number') continue;
    if (audit.score >= 0.9) continue;
    const title = audit.title || id.replace(/-/g, ' ');
    if (!title) continue;
    out.push({
      id,
      title,
      description: typeof audit.description === 'string' ? audit.description : undefined,
      score: Math.round(audit.score * 100),
      displayValue: typeof audit.displayValue === 'string' ? audit.displayValue : undefined,
    });
  }
  out.sort((a, b) => a.score - b.score);
  return out;
}

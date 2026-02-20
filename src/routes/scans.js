import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { randomBytes } from 'crypto';
import { mkdir, writeFile, readFile, unlink } from 'fs/promises';
import { dirname, join } from 'path';
import * as db from '../db/index.js';
import config from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { ensureCsrfToken, validateCsrf } from '../middleware/csrf.js';
import { runLighthouse } from '../services/lighthouse.js';
import { generateReport } from 'lighthouse';
import puppeteer from 'puppeteer-core';

const SCREENSHOTS_DIR = join(dirname(config.dbPath), 'screenshots');
const FILMSTRIPS_DIR = join(dirname(config.dbPath), 'filmstrips');

const createScanLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Too many scans started. Please try again in 15 minutes.',
  standardHeaders: true,
  legacyHeaders: false,
});

/** Only allow filenames we generate: digits + .png|.jpg|.jpeg|.webp to prevent path traversal */
function isSafeScreenshotPath(filename) {
  if (typeof filename !== 'string' || filename.length === 0) return false;
  return /^\d+\.(png|jpg|jpeg|webp)$/i.test(filename);
}

function screenshotContentType(filename) {
  const ext = filename.toLowerCase().replace(/^.*\./, '');
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  return 'image/jpeg';
}

/** Escape HTML and turn URLs into links for safe display in recommendations. */
function linkifyDescription(text) {
  if (typeof text !== 'string') return '';
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  return escaped.replace(
    /(https?:\/\/[^\s<>"']+)/g,
    (url) => {
      const trimmed = url.replace(/[.,;:)]+$/, '');
      const href = trimmed.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      const trail = url.slice(trimmed.length);
      return `<a href="${href}" target="_blank" rel="noopener noreferrer" class="report-recommendations__link">${trimmed}</a>${trail}`;
    }
  );
}

const router = Router();

/** Public: view shared report (read-only, no auth) */
router.get('/share/:token', (req, res) => {
  const token = req.params.token;
  const scan = db.getScanByShareToken(token);
  if (!scan) return res.status(404).send('Shared report not found or link has been disabled.');
  res.render('report-shared', {
    title: `Report: ${scan.url}`,
    scan,
    shareToken: token,
    linkifyDescription,
  });
});

/** Public: serve screenshot for shared report */
router.get('/share/:token/screenshot', async (req, res) => {
  const scan = db.getScanByShareToken(req.params.token);
  if (!scan || !scan.screenshot_path || !isSafeScreenshotPath(scan.screenshot_path))
    return res.status(404).send('Screenshot not available');
  const filePath = join(SCREENSHOTS_DIR, scan.screenshot_path);
  try {
    const buf = await readFile(filePath);
    res.setHeader('Content-Type', screenshotContentType(scan.screenshot_path));
    res.send(buf);
  } catch (e) {
    if (e.code === 'ENOENT') return res.status(404).send('Screenshot not found');
    throw e;
  }
});

/** Public: serve filmstrip for shared report (load video in speed viz). */
router.get('/share/:token/filmstrip', async (req, res) => {
  const scan = db.getScanByShareToken(req.params.token);
  if (!scan) return res.status(404).json({ error: 'Report not found or link disabled' });
  try {
    const filePath = filmstripFilePath(scan.id);
    const raw = await readFile(filePath, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.frames) || data.frames.length === 0) {
      return res.status(404).json({ error: 'Filmstrip not available' });
    }
    res.setHeader('Content-Type', 'application/json');
    res.json({ frames: data.frames, chromeVersion: data.chromeVersion });
  } catch (e) {
    if (e.code === 'ENOENT') return res.status(404).json({ error: 'Filmstrip not available' });
    console.error('Share filmstrip read failed:', e.message);
    return res.status(500).json({ error: 'Failed to read filmstrip' });
  }
});

const GUEST_SCANS_LIMIT = 2;
const guestScanLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many scan attempts. Please try again in 15 minutes.',
  standardHeaders: true,
  legacyHeaders: false,
});

/** One-time tokens for guest report (avoids relying on session cookie after fetch). */
const guestReportTokens = new Map();
const GUEST_TOKEN_TTL_MS = 15 * 60 * 1000;
function setGuestReportToken(report, used) {
  const token = randomBytes(24).toString('hex');
  guestReportTokens.set(token, { report, used });
  setTimeout(() => guestReportTokens.delete(token), GUEST_TOKEN_TTL_MS);
  return token;
}

/** Public: run a guest scan (no account). Max 2 per session. Accepts JSON for fetch (returns { redirect } or { error }). */
router.post('/guest/scan', guestScanLimiter, async (req, res) => {
  const acceptsJson = req.get('accept') && req.get('accept').includes('application/json');
  const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  if (!isValidUrl(url)) {
    if (acceptsJson) return res.status(400).json({ error: 'invalid_url' });
    return res.redirect('/?guest_error=invalid_url');
  }
  const raw = req.body.formFactor;
  const devices = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const runMobile = devices.includes('mobile');
  const runDesktop = devices.includes('desktop');
  const formFactor = runMobile && runDesktop ? 'mobile' : runDesktop ? 'desktop' : 'mobile';
  const count = typeof req.session.guestScansCount === 'number' ? req.session.guestScansCount : 0;
  if (count >= GUEST_SCANS_LIMIT) {
    if (acceptsJson) return res.status(400).json({ error: 'limit_reached' });
    return res.redirect('/?guest_error=limit_reached');
  }
  try {
    const options = { formFactor, categories: undefined };
    const { report, summary } = await runLighthouse(url, options);
    const used = count + 1;
    const reportData = {
      url: summary.finalUrl || url,
      formFactor,
      summary: {
        categories: summary.categories || {},
        metrics: summary.metrics || {},
        recommendations: (summary.recommendations || []).slice(0, 15),
      },
      createdAt: new Date().toISOString(),
    };
    req.session.guestScansCount = used;
    req.session.guestLastReport = reportData;
    if (acceptsJson) {
      const token = setGuestReportToken(reportData, used);
      req.session.save((err) => {
        if (err) console.error('Guest scan session save error:', err);
        res.json({ redirect: '/guest/report?t=' + encodeURIComponent(token) });
      });
    } else {
      req.session.save((err) => {
        if (err) {
          console.error('Guest scan session save error:', err);
          return res.redirect('/?guest_error=session');
        }
        res.redirect('/guest/report');
      });
    }
  } catch (err) {
    console.error('Guest scan failed:', err);
    if (acceptsJson) return res.status(500).json({ error: 'scan_failed' });
    res.redirect('/?guest_error=scan_failed');
  }
});

/** Public: show guest scan report (from one-time token ?t= or from session). */
router.get('/guest/report', (req, res) => {
  const token = typeof req.query.t === 'string' ? req.query.t.trim() : '';
  if (token) {
    const stored = guestReportTokens.get(token);
    if (stored) {
      guestReportTokens.delete(token);
      return res.render('guest-report', {
        title: `Report: ${stored.report.url}`,
        report: stored.report,
        guestScansUsed: stored.used,
        guestScansLimit: GUEST_SCANS_LIMIT,
        linkifyDescription,
      });
    }
  }
  const report = req.session && req.session.guestLastReport;
  if (!report) {
    return res.redirect('/');
  }
  const used = typeof req.session.guestScansCount === 'number' ? req.session.guestScansCount : 1;
  res.render('guest-report', {
    title: `Report: ${report.url}`,
    report,
    guestScansUsed: used,
    guestScansLimit: GUEST_SCANS_LIMIT,
    linkifyDescription,
  });
});

router.use(requireAuth);
router.use(ensureCsrfToken);
router.use((req, res, next) => {
  if (req.method === 'POST') return validateCsrf(req, res, next);
  next();
});

const MAX_URL_LENGTH = 2048;
const MAX_REPORT_JSON_LENGTH = 5 * 1024 * 1024; // 5MB max stored
const SCANS_PER_PAGE = 6;
const SCANS_FETCH_FOR_GROUPS = 50;

/** Group scans by run_id (same submission); single scans become a group of one. */
function groupScansByRun(scans) {
  if (!Array.isArray(scans) || scans.length === 0) return [];
  const byKey = new Map();
  for (const scan of scans) {
    const key = scan.run_id != null ? scan.run_id : scan.id;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(scan);
  }
  return Array.from(byKey.values()).map((group) =>
    group.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  );
}

function isValidUrl(url) {
  if (typeof url !== 'string' || url.length > MAX_URL_LENGTH) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Trends page: select a website and see score evolution over scans. */
router.get('/trends', (req, res, next) => {
  try {
    const userId = req.session.userId;
    const distinctUrls = userId != null ? db.getDistinctUrlsByUserId(userId) : [];
    res.render('trends', {
      title: 'Trends',
      email: req.session.email,
      distinctUrls,
    });
  } catch (err) {
    next(err);
  }
});

/** JSON: scan history for a URL (scores over time) for charts. */
router.get('/trends/data', (req, res) => {
  const rawUrl = typeof req.query.url === 'string' ? req.query.url.trim() : '';
  if (!rawUrl) {
    return res.status(400).json({ error: 'Missing url' });
  }
  try {
    new URL(rawUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid url' });
  }
  const userId = req.session.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  /* Use exact URL from request so query matches DB (dropdown values are stored URLs). */
  const scans = db.getScansByUrlAndUserId(userId, rawUrl, 200);
  const payload = scans.map((s) => ({
    id: s.id,
    created_at: s.created_at,
    run_id: s.run_id || null,
    formFactor: (s.options && s.options.formFactor) === 'desktop' ? 'desktop' : 'mobile',
    categories: (s.summary && s.summary.categories) ? s.summary.categories : {},
    metrics: (s.summary && s.summary.metrics) ? s.summary.metrics : {},
  }));
  res.json({ url: rawUrl, scans: payload });
});

router.get('/dashboard', (req, res, next) => {
  try {
    const userId = req.session.userId;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const totalCount = userId != null ? db.getScanGroupCountByUserId(userId) : 0;
    const totalPages = Math.max(1, Math.ceil(totalCount / SCANS_PER_PAGE));
    const currentPage = Math.min(page, totalPages);
    const offset = (currentPage - 1) * SCANS_PER_PAGE;
    const rawScans = userId != null ? db.getScansByUserId(userId, SCANS_FETCH_FOR_GROUPS, 0) : [];
    const allGroups = groupScansByRun(rawScans);
    const scanGroups = allGroups.slice(offset, offset + SCANS_PER_PAGE);
    res.render('dashboard', {
      title: 'Dashboard',
      email: req.session.email,
      scanGroups: scanGroups || [],
      pagination: { page: currentPage, totalPages, totalCount },
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    next(err);
  }
});

async function runOneScan(userId, url, formFactor, runId = null) {
  const options = { formFactor, categories: undefined };
  const { report, summary, screenshot } = await runLighthouse(url, options);
  const filmstripPayload = extractFilmstripFromLhr(report);
  stripFilmstripFromLhr(report);
  const reportJson = JSON.stringify(report);
  const reportToStore =
    reportJson.length <= MAX_REPORT_JSON_LENGTH ? reportJson : null;
  const scanId = db.createScan(userId, url, options, reportToStore, summary, runId);
  if (filmstripPayload && filmstripPayload.frames.length > 0) {
    try {
      await mkdir(FILMSTRIPS_DIR, { recursive: true });
      await writeFile(
        filmstripFilePath(scanId),
        JSON.stringify({ frames: filmstripPayload.frames, chromeVersion: filmstripPayload.chromeVersion }),
        'utf8'
      );
    } catch (e) {
      console.error('Filmstrip save failed (scan saved):', e.message);
    }
  }
  if (screenshot && screenshot.buffer && screenshot.buffer.length > 0) {
    try {
      await mkdir(SCREENSHOTS_DIR, { recursive: true });
      const filePath = join(SCREENSHOTS_DIR, `${scanId}.${screenshot.ext}`);
      await writeFile(filePath, screenshot.buffer);
      db.updateScanScreenshot(scanId, `${scanId}.${screenshot.ext}`);
    } catch (e) {
      console.error('Screenshot save failed (scan saved):', e.message);
    }
  }
  return scanId;
}

router.post('/scans', createScanLimiter, async (req, res) => {
  const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  if (!isValidUrl(url)) {
    const totalCount = db.getScanGroupCountByUserId(req.session.userId);
    const totalPages = Math.max(1, Math.ceil(totalCount / SCANS_PER_PAGE));
    const rawScans = db.getScansByUserId(req.session.userId, SCANS_FETCH_FOR_GROUPS, 0);
    const scanGroups = groupScansByRun(rawScans).slice(0, SCANS_PER_PAGE);
    return res.status(400).render('dashboard', {
      title: 'Dashboard',
      email: req.session.email,
      scanGroups,
      pagination: { page: 1, totalPages, totalCount },
      error: 'Please enter a valid http or https URL.',
    });
  }
  const raw = req.body.formFactor;
  const devices = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const runMobile = devices.includes('mobile');
  const runDesktop = devices.includes('desktop');
  if (!runMobile && !runDesktop) {
    const totalCount = db.getScanGroupCountByUserId(req.session.userId);
    const totalPages = Math.max(1, Math.ceil(totalCount / SCANS_PER_PAGE));
    const rawScans = db.getScansByUserId(req.session.userId, SCANS_FETCH_FOR_GROUPS, 0);
    const scanGroups = groupScansByRun(rawScans).slice(0, SCANS_PER_PAGE);
    return res.status(400).render('dashboard', {
      title: 'Dashboard',
      email: req.session.email,
      scanGroups,
      pagination: { page: 1, totalPages, totalCount },
      error: 'Select at least one device (Mobile and/or Desktop).',
    });
  }

  try {
    if (runMobile && runDesktop) {
      const runId = `run-${Date.now()}-${randomBytes(4).toString('hex')}`;
      const mobileScanId = await runOneScan(req.session.userId, url, 'mobile', runId);
      try {
        await runOneScan(req.session.userId, url, 'desktop', runId);
      } catch (desktopErr) {
        console.error('Desktop scan failed after mobile succeeded:', desktopErr);
        return res.redirect('/scans?error=desktop');
      }
      return res.redirect(`/scans/${mobileScanId}`);
    }
    const formFactor = runMobile ? 'mobile' : 'desktop';
    const scanId = await runOneScan(req.session.userId, url, formFactor, null);
    res.redirect(`/scans/${scanId}`);
  } catch (err) {
    console.error('Lighthouse run failed:', err);
    const totalCount = db.getScanGroupCountByUserId(req.session.userId);
    const totalPages = Math.max(1, Math.ceil(totalCount / SCANS_PER_PAGE));
    const rawScans = db.getScansByUserId(req.session.userId, SCANS_FETCH_FOR_GROUPS, 0);
    const scanGroups = groupScansByRun(rawScans).slice(0, SCANS_PER_PAGE);
    res.status(500).render('dashboard', {
      title: 'Dashboard',
      email: req.session.email,
      scanGroups,
      pagination: { page: 1, totalPages, totalCount },
      error: err.message || 'Scan failed. Ensure Chrome/Chromium is installed.',
    });
  }
});

const SCANS_LIST_FETCH_MAX = 500;

router.get('/scans', (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const searchQuery = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const totalCount = searchQuery
      ? db.getScanGroupCountByUserIdSearch(req.session.userId, searchQuery)
      : db.getScanGroupCountByUserId(req.session.userId);
    const rawScans = searchQuery
      ? db.getScansByUserIdSearch(req.session.userId, searchQuery, SCANS_LIST_FETCH_MAX, 0)
      : db.getScansByUserId(req.session.userId, SCANS_LIST_FETCH_MAX, 0);
    const allGroups = groupScansByRun(rawScans || []);
    const groupsAvailable = allGroups.length;
    const totalPages = Math.max(1, Math.ceil(Math.min(totalCount, groupsAvailable) / SCANS_PER_PAGE));
    const currentPage = Math.min(page, totalPages);
    const offset = (currentPage - 1) * SCANS_PER_PAGE;
    const scanGroups = allGroups.slice(offset, offset + SCANS_PER_PAGE);
    const error = req.query.error === 'desktop' ? 'Desktop scan failed. Mobile scan completed.' : undefined;
    res.render('scans-list', {
      title: 'Scans',
      email: req.session.email,
      scanGroups: scanGroups || [],
      pagination: { page: currentPage, totalPages, totalCount },
      searchQuery: searchQuery || undefined,
      error,
    });
  } catch (err) {
    next(err);
  }
});

/** Return only table body rows (HTML) for dashboard live search. */
router.get('/scans/table-rows', (req, res, next) => {
  try {
    const searchQuery = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const userId = req.session.userId;
    const limit = searchQuery ? 100 : SCANS_FETCH_FOR_GROUPS;
    const rawScans = searchQuery
      ? db.getScansByUserIdSearch(userId, searchQuery, limit, 0)
      : db.getScansByUserId(userId, limit, 0);
    const allGroups = groupScansByRun(rawScans || []);
    const maxGroups = searchQuery ? 30 : SCANS_PER_PAGE;
    const scanGroups = allGroups.slice(0, maxGroups);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.render('partials/dashboard-tbody', { scanGroups, searchQuery }, (err, html) => {
      if (err) return next(err);
      res.send(html || '');
    });
  } catch (err) {
    next(err);
  }
});

router.get('/scans/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).send('Invalid scan ID');
  const scan = db.getScanByIdAndUserId(id, req.session.userId);
  if (!scan) return res.status(404).send('Scan not found');
  const hasReportJson = Boolean(scan.report_json);
  let scanGroup = null;
  if (scan.run_id) {
    const group = db.getScansByRunIdAndUserId(scan.run_id, req.session.userId);
    if (group.length >= 2) {
      group.sort((a, b) => (a.options?.formFactor === 'desktop' ? -1 : 1) - (b.options?.formFactor === 'desktop' ? -1 : 1));
      scanGroup = group.map((s) => ({
        ...s,
        report_json: undefined,
        hasReportJson: Boolean(s.report_json),
      }));
    }
  }
  res.render('report-detail', {
    title: `Report: ${scan.url}`,
    email: req.session.email,
    scan: { ...scan, report_json: undefined },
    hasReportJson,
    scanGroup,
    activeScanId: scanGroup ? id : null,
    linkifyDescription,
  });
});

router.get('/scans/:id/json', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).send('Invalid scan ID');
  const scan = db.getScanByIdAndUserId(id, req.session.userId);
  if (!scan) return res.status(404).send('Scan not found');
  if (!scan.report_json) return res.status(404).send('Full report not available');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="lighthouse-report.json"');
  res.send(scan.report_json);
});

router.get('/scans/:id/export/pdf', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).send('Invalid scan ID');
  const scan = db.getScanByIdAndUserId(id, req.session.userId);
  if (!scan) return res.status(404).send('Scan not found');
  if (!scan.report_json) return res.status(404).send('Full report not available. PDF export requires the full Lighthouse report.');
  let browser;
  try {
    const lhr = JSON.parse(scan.report_json);
    const html = generateReport(lhr, 'html');
    const executablePath = config.chromePath;
    if (!executablePath) {
      return res.status(503).send('PDF export requires CHROME_PATH to be set (path to Chrome/Chromium).');
    }
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '20px', right: '20px', bottom: '20px', left: '20px' },
    });
    await browser.close();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="lighthouse-report.pdf"');
    res.send(pdfBuffer);
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('PDF export failed:', err);
    res.status(500).send(err.message || 'Failed to generate PDF.');
  }
});

router.post('/scans/:id/share', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).send('Invalid scan ID');
  const scan = db.getScanByIdAndUserId(id, req.session.userId);
  if (!scan) return res.status(404).send('Scan not found');
  const token = scan.share_token || randomBytes(32).toString('hex');
  db.updateScanShareToken(id, req.session.userId, token);
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const shareUrl = `${baseUrl}/share/${token}`;
  if (req.get('accept') && req.get('accept').includes('application/json')) {
    return res.json({ shareUrl });
  }
  res.redirect(shareUrl);
});

router.post('/scans/:id/unshare', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).send('Invalid scan ID');
  const scan = db.getScanByIdAndUserId(id, req.session.userId);
  if (!scan) return res.status(404).send('Scan not found');
  db.updateScanShareToken(id, req.session.userId, null);
  res.redirect(`/scans/${id}`);
});

router.get('/scans/:id/screenshot', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).send('Invalid scan ID');
  const scan = db.getScanByIdAndUserId(id, req.session.userId);
  if (!scan || !scan.screenshot_path || !isSafeScreenshotPath(scan.screenshot_path)) return res.status(404).send('Screenshot not available');
  const filePath = join(SCREENSHOTS_DIR, scan.screenshot_path);
  try {
    const buf = await readFile(filePath);
    res.setHeader('Content-Type', screenshotContentType(scan.screenshot_path));
    res.send(buf);
  } catch (e) {
    if (e.code === 'ENOENT') return res.status(404).send('Screenshot not found');
    throw e;
  }
});

/** Filmstrip frames from Lighthouse report (for load “video” in speed viz). */
function parseChromeVersionFromUA(ua) {
  if (!ua || typeof ua !== 'string') return null;
  const m = String(ua).match(/Chrom(?:e|ium)\/([\d.]+)/i);
  return m ? m[1] : null;
}

const FILMSTRIP_MAX_FRAMES = 25;

function extractFilmstripFromLhr(lhr) {
  const audit = lhr.audits && lhr.audits['screenshot-thumbnails'];
  const details = audit && audit.details;
  if (!details || details.type !== 'filmstrip' || !Array.isArray(details.items) || details.items.length === 0) {
    return null;
  }
  const frames = details.items
    .slice(0, FILMSTRIP_MAX_FRAMES)
    .map((item) => ({ timing: item.timing, data: item.data || '' }))
    .filter((f) => f.data);
  if (frames.length === 0) return null;
  const hostUserAgent = lhr.environment && lhr.environment.hostUserAgent;
  const chromeVersion = parseChromeVersionFromUA(hostUserAgent || lhr.userAgent);
  return { frames, chromeVersion: chromeVersion || undefined };
}

function stripFilmstripFromLhr(lhr) {
  const audit = lhr.audits && lhr.audits['screenshot-thumbnails'];
  if (audit && audit.details && audit.details.type === 'filmstrip' && Array.isArray(audit.details.items)) {
    audit.details.items = [];
  }
}

function filmstripFilePath(scanId) {
  return join(FILMSTRIPS_DIR, `${scanId}.json`);
}

router.get('/scans/:id/filmstrip', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid scan ID' });
  const scan = db.getScanByIdAndUserId(id, req.session.userId);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  try {
    try {
      const raw = await readFile(filmstripFilePath(id), 'utf8');
      const data = JSON.parse(raw);
      if (Array.isArray(data.frames) && data.frames.length > 0) {
        res.setHeader('Content-Type', 'application/json');
        return res.json({ frames: data.frames, chromeVersion: data.chromeVersion });
      }
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('Filmstrip file read failed:', e.message);
    }
    if (!scan.report_json) return res.status(404).json({ error: 'Filmstrip not available' });
    const lhr = JSON.parse(scan.report_json);
    const payload = extractFilmstripFromLhr(lhr);
    if (!payload || payload.frames.length === 0) {
      return res.status(404).json({ error: 'Filmstrip not available' });
    }
    res.setHeader('Content-Type', 'application/json');
    res.json({ frames: payload.frames, chromeVersion: payload.chromeVersion });
  } catch (e) {
    console.error('Filmstrip failed:', e.message);
    return res.status(500).json({ error: 'Failed to read filmstrip' });
  }
});

router.post('/scans/delete-batch', async (req, res) => {
  const raw = req.body?.ids;
  const ids = Array.isArray(raw) ? raw : (typeof raw === 'string' ? raw.split(',').map((s) => s.trim()).filter(Boolean) : []);
  const scanIds = [...new Set(ids.map((id) => parseInt(id, 10)).filter((n) => !Number.isNaN(n)))];
  if (scanIds.length === 0) {
    const redirectTo = (req.body?.redirect || req.query?.redirect) === 'dashboard' ? '/dashboard' : '/scans';
    return res.redirect(redirectTo);
  }
  for (const id of scanIds) {
    const scan = db.getScanByIdAndUserId(id, req.session.userId);
    if (scan?.screenshot_path && isSafeScreenshotPath(scan.screenshot_path)) {
      try {
        await unlink(join(SCREENSHOTS_DIR, scan.screenshot_path));
      } catch (e) {
        if (e.code !== 'ENOENT') console.error('Delete screenshot failed:', e);
      }
    }
    try {
      await unlink(filmstripFilePath(id));
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('Delete filmstrip failed:', e);
    }
  }
  db.deleteScansByIds(req.session.userId, scanIds);
  const redirectTo = (req.body?.redirect || req.query?.redirect) === 'dashboard' ? '/dashboard' : '/scans';
  res.redirect(redirectTo);
});

router.post('/scans/:id/delete', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).send('Invalid scan ID');
  const scan = db.getScanByIdAndUserId(id, req.session.userId);
  if (!scan) return res.status(404).send('Scan not found');
  if (scan.screenshot_path && isSafeScreenshotPath(scan.screenshot_path)) {
    try {
      await unlink(join(SCREENSHOTS_DIR, scan.screenshot_path));
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('Delete screenshot failed:', e);
    }
  }
  try {
    await unlink(filmstripFilePath(id));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Delete filmstrip failed:', e);
  }
  const deleted = db.deleteScan(id, req.session.userId);
  if (!deleted) return res.status(404).send('Scan not found');
  const redirectTo = (req.body?.redirect || req.query?.redirect) === 'dashboard' ? '/dashboard' : '/scans';
  res.redirect(redirectTo);
});

router.post('/scans/rescan-both', async (req, res) => {
  const runId = typeof req.body?.run_id === 'string' ? req.body.run_id.trim() : '';
  if (!runId) return res.status(400).json({ error: 'Missing run_id' });
  const group = db.getScansByRunIdAndUserId(runId, req.session.userId);
  if (!group || group.length < 2) return res.status(404).json({ error: 'Scan group not found' });
  const url = group[0].url;
  const acceptsJson = req.get('accept') && req.get('accept').includes('application/json');
  try {
    const newRunId = `run-${Date.now()}-${randomBytes(4).toString('hex')}`;
    const mobileScanId = await runOneScan(req.session.userId, url, 'mobile', newRunId);
    try {
      await runOneScan(req.session.userId, url, 'desktop', newRunId);
    } catch (desktopErr) {
      console.error('Rescan both: desktop failed after mobile:', desktopErr);
      if (acceptsJson) return res.status(500).json({ error: 'Desktop rescan failed.' });
      return res.redirect('/scans?error=desktop');
    }
    if (acceptsJson) return res.json({ redirect: `/scans/${mobileScanId}` });
    res.redirect(`/scans/${mobileScanId}`);
  } catch (err) {
    console.error('Rescan both failed:', err);
    if (acceptsJson) return res.status(500).json({ error: err.message || 'Rescan failed.' });
    res.redirect('/scans?error=rescan');
  }
});

router.post('/scans/:id/rescan', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid scan ID' });
  const scan = db.getScanByIdAndUserId(id, req.session.userId);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  const url = scan.url;
  const options = scan.options || { formFactor: 'mobile' };
  try {
    const { report, summary, screenshot } = await runLighthouse(url, options);
    const filmstripPayload = extractFilmstripFromLhr(report);
    stripFilmstripFromLhr(report);
    const reportJson = JSON.stringify(report);
    const reportToStore =
      reportJson.length <= MAX_REPORT_JSON_LENGTH ? reportJson : null;
    const scanId = db.createScan(
      req.session.userId,
      url,
      options,
      reportToStore,
      summary
    );
    if (filmstripPayload && filmstripPayload.frames.length > 0) {
      try {
        await mkdir(FILMSTRIPS_DIR, { recursive: true });
        await writeFile(
          filmstripFilePath(scanId),
          JSON.stringify({ frames: filmstripPayload.frames, chromeVersion: filmstripPayload.chromeVersion }),
          'utf8'
        );
      } catch (e) {
        console.error('Rescan filmstrip save failed:', e.message);
      }
    }
    if (screenshot && screenshot.buffer && screenshot.buffer.length > 0) {
      try {
        await mkdir(SCREENSHOTS_DIR, { recursive: true });
        const filePath = join(SCREENSHOTS_DIR, `${scanId}.${screenshot.ext}`);
        await writeFile(filePath, screenshot.buffer);
        db.updateScanScreenshot(scanId, `${scanId}.${screenshot.ext}`);
      } catch (e) {
        console.error('Rescan screenshot save failed:', e.message);
      }
    }
    const acceptsJson = req.get('accept') && req.get('accept').includes('application/json');
    if (acceptsJson) {
      return res.json({ redirect: `/scans/${scanId}` });
    }
    res.redirect(`/scans/${scanId}`);
  } catch (err) {
    console.error('Rescan failed:', err);
    const acceptsJson = req.get('accept') && req.get('accept').includes('application/json');
    if (acceptsJson) {
      return res.status(500).json({ error: err.message || 'Rescan failed.' });
    }
    return res.status(500).render('report-detail', {
      title: `Report: ${scan.url}`,
      email: req.session.email,
      scan: { ...scan, report_json: undefined },
      hasReportJson: Boolean(scan.report_json),
      error: err.message || 'Rescan failed. Try again.',
      linkifyDescription,
    });
  }
});

export default router;

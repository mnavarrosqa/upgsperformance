import puppeteer from 'puppeteer-core';
import config from '../config.js';

/** Viewport presets: desktop a bit bigger, mobile matches common phone resolution (e.g. iPhone 14/15) */
const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};

const DEFAULT_TIMEOUT_MS = 30000;

/** WebP quality for screenshots (0–100). Higher = better quality, larger file. 85 gives strong compression with minimal visible loss. */
const WEBP_QUALITY = 85;

/**
 * Take a full-page WebP screenshot of a URL with a proper viewport.
 * Uses WebP with high compression to minimize storage.
 * @param {string} url - Valid http(s) URL
 * @param {{ formFactor: 'mobile'|'desktop' }} options
 * @returns {Promise<{ buffer: Buffer, ext: 'webp' }>}
 */
export async function takeScreenshot(url, options = {}) {
  const formFactor = options.formFactor === 'desktop' ? 'desktop' : 'mobile';
  const viewport = VIEWPORTS[formFactor];
  const executablePath = config.chromePath;
  if (!executablePath) {
    throw new Error('Screenshot requires CHROME_PATH to be set.');
  }
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
      ],
    });
    const page = await browser.newPage();
    await page.setViewport({
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 2,
    });
    await page.goto(url, {
      waitUntil: 'load',
      timeout: DEFAULT_TIMEOUT_MS,
    });
    await page.evaluate(() => window.scrollTo(0, 0));
    const buffer = await page.screenshot({
      type: 'webp',
      quality: WEBP_QUALITY,
      fullPage: true,
    });
    await browser.close();
    return { buffer: Buffer.from(buffer), ext: 'webp' };
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    throw err;
  }
}

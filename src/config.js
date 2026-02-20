import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default {
  port: parseInt(process.env.PORT || '3000', 10),
  dbPath: process.env.DB_PATH || resolve(__dirname, '../data/upgs.db'),
  sessionSecret: process.env.SESSION_SECRET || 'change-me-in-production',
  /** Path to Chrome/Chromium binary; required for screenshots and PDF export. */
  chromePath: process.env.CHROME_PATH || undefined,
  /** Use in-memory only when SESSION_STORE=memory; default is SQLite so multiple processes (e.g. PM2) share the same sessions. */
  useMemorySession: process.env.SESSION_STORE === 'memory',
  chromeFlags: [
    '--headless',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-software-rasterizer',
  ],
};

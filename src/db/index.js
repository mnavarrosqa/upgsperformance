import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import config from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let db = null;

export function getDb() {
  if (!db) {
    db = new Database(config.dbPath);
    db.pragma('journal_mode = WAL');
    const schemaPath = resolve(__dirname, 'schema.sql');
    const schema = readFileSync(schemaPath, 'utf8');
    db.exec(schema);
    try {
      db.exec('ALTER TABLE scans ADD COLUMN screenshot_path TEXT');
    } catch (e) {
      if (!/duplicate column name/i.test(e.message)) throw e;
    }
    try {
      db.exec('ALTER TABLE scans ADD COLUMN share_token TEXT');
    } catch (e) {
      if (!/duplicate column name/i.test(e.message)) throw e;
    }
    try {
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_scans_share_token ON scans(share_token) WHERE share_token IS NOT NULL');
    } catch (e) {
      if (!/already exists/i.test(e.message)) throw e;
    }
    try {
      db.exec('ALTER TABLE scans ADD COLUMN run_id TEXT');
    } catch (e) {
      if (!/duplicate column name/i.test(e.message)) throw e;
    }
  }
  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

// --- Users ---
export function createUser(email, passwordHash, name = null) {
  const stmt = getDb().prepare(
    'INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)'
  );
  const result = stmt.run(email, passwordHash, name);
  return result.lastInsertRowid;
}

export function findUserByEmail(email) {
  const stmt = getDb().prepare('SELECT * FROM users WHERE email = ?');
  return stmt.get(email);
}

export function findUserById(id) {
  const stmt = getDb().prepare('SELECT id, email, name, created_at FROM users WHERE id = ?');
  return stmt.get(id);
}

/** Get user by id including password_hash (for auth/settings verification only). */
export function findUserByIdWithPassword(id) {
  const stmt = getDb().prepare('SELECT * FROM users WHERE id = ?');
  return stmt.get(id);
}

/** Update user profile. updates: { name?, email?, password_hash? }. Returns true if updated. */
export function updateUser(userId, updates) {
  if (!userId || !updates || typeof updates !== 'object') return false;
  const allowed = ['name', 'email', 'password_hash'];
  const setParts = [];
  const values = [];
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(updates, key)) continue;
    setParts.push(`${key} = ?`);
    values.push(key === 'name' ? (updates[key] || null) : updates[key]);
  }
  if (setParts.length === 0) return false;
  values.push(userId);
  const sql = `UPDATE users SET ${setParts.join(', ')} WHERE id = ?`;
  const stmt = getDb().prepare(sql);
  const result = stmt.run(...values);
  return result.changes > 0;
}

// --- Scans ---
export function createScan(userId, url, options, reportJson, summary, runId = null) {
  const stmt = getDb().prepare(
    'INSERT INTO scans (user_id, url, options, report_json, summary, run_id) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const optionsStr = options ? JSON.stringify(options) : null;
  const summaryStr = typeof summary === 'string' ? summary : JSON.stringify(summary);
  const result = stmt.run(userId, url, optionsStr, reportJson, summaryStr, runId || null);
  return result.lastInsertRowid;
}

export function updateScanScreenshot(scanId, screenshotPath) {
  const stmt = getDb().prepare(
    'UPDATE scans SET screenshot_path = ? WHERE id = ?'
  );
  return stmt.run(screenshotPath, scanId);
}

export function getScanCountByUserId(userId) {
  const stmt = getDb().prepare(
    'SELECT COUNT(*) AS count FROM scans WHERE user_id = ?'
  );
  const row = stmt.get(userId);
  return row ? row.count : 0;
}

/** Number of distinct groups (run_id or single scan id) for pagination. */
export function getScanGroupCountByUserId(userId) {
  const stmt = getDb().prepare(
    'SELECT COUNT(DISTINCT COALESCE(run_id, id)) AS count FROM scans WHERE user_id = ?'
  );
  const row = stmt.get(userId);
  return row ? row.count : 0;
}

export function getScanGroupCountByUserIdSearch(userId, searchQuery) {
  const term = escapeLike(searchQuery.trim());
  if (!term) return getScanGroupCountByUserId(userId);
  const pattern = `%${term}%`;
  const stmt = getDb().prepare(
    'SELECT COUNT(DISTINCT COALESCE(run_id, id)) AS count FROM scans WHERE user_id = ? AND url LIKE ? ESCAPE \'\\\''
  );
  const row = stmt.get(userId, pattern);
  return row ? row.count : 0;
}

/**
 * Escape LIKE special chars (%, _) for safe contains search.
 * @param {string} raw
 * @returns {string}
 */
function escapeLike(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export function getScanCountByUserIdSearch(userId, searchQuery) {
  const term = escapeLike(searchQuery.trim());
  if (!term) return getScanCountByUserId(userId);
  const pattern = `%${term}%`;
  const stmt = getDb().prepare(
    'SELECT COUNT(*) AS count FROM scans WHERE user_id = ? AND url LIKE ? ESCAPE \'\\\''
  );
  const row = stmt.get(userId, pattern);
  return row ? row.count : 0;
}

export function getScansByUserIdSearch(userId, searchQuery, limit = 50, offset = 0) {
  const term = escapeLike(searchQuery.trim());
  if (!term) return getScansByUserId(userId, limit, offset);
  const pattern = `%${term}%`;
  const stmt = getDb().prepare(
    'SELECT id, url, options, summary, created_at, run_id FROM scans WHERE user_id = ? AND url LIKE ? ESCAPE \'\\\' ORDER BY created_at DESC LIMIT ? OFFSET ?'
  );
  const rows = stmt.all(userId, pattern, limit, offset);
  return rows.map((row) => {
    let summary = null;
    let options = null;
    try {
      summary = row.summary ? JSON.parse(row.summary) : null;
      options = row.options ? JSON.parse(row.options) : null;
    } catch {
      /* corrupted JSON: keep null summary/options */
    }
    return { ...row, summary, options };
  });
}

export function getScansByUserId(userId, limit = 50, offset = 0) {
  const stmt = getDb().prepare(
    'SELECT id, url, options, summary, created_at, run_id FROM scans WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
  );
  const rows = stmt.all(userId, limit, offset);
  return rows.map((row) => {
    let summary = null;
    let options = null;
    try {
      summary = row.summary ? JSON.parse(row.summary) : null;
      options = row.options ? JSON.parse(row.options) : null;
    } catch {
      /* corrupted JSON: keep null summary/options */
    }
    return { ...row, summary, options };
  });
}

export function getScanByIdAndUserId(scanId, userId) {
  const stmt = getDb().prepare(
    'SELECT id, user_id, url, options, report_json, summary, screenshot_path, share_token, created_at, run_id FROM scans WHERE id = ? AND user_id = ?'
  );
  const row = stmt.get(scanId, userId);
  if (!row) return null;
  let summary = null;
  let options = null;
  try {
    summary = row.summary ? JSON.parse(row.summary) : null;
    options = row.options ? JSON.parse(row.options) : null;
  } catch {
    /* corrupted JSON: keep null so report still renders URL/meta */
  }
  return {
    ...row,
    summary,
    options,
    report_json: row.report_json,
  };
}

/** All scans in the same run (same URL, both devices). For tabbed report view. */
export function getScansByRunIdAndUserId(runId, userId) {
  if (!runId || typeof runId !== 'string') return [];
  const stmt = getDb().prepare(
    'SELECT id, user_id, url, options, report_json, summary, screenshot_path, share_token, created_at, run_id FROM scans WHERE run_id = ? AND user_id = ? ORDER BY id ASC'
  );
  const rows = stmt.all(runId, userId);
  return rows.map((row) => {
    let summary = null;
    let options = null;
    try {
      summary = row.summary ? JSON.parse(row.summary) : null;
      options = row.options ? JSON.parse(row.options) : null;
    } catch {
      /* ignore */
    }
    return { ...row, summary, options, report_json: row.report_json };
  });
}

export function getScanByShareToken(token) {
  if (!token || typeof token !== 'string') return null;
  const stmt = getDb().prepare(
    'SELECT id, user_id, url, options, summary, screenshot_path, created_at FROM scans WHERE share_token = ?'
  );
  const row = stmt.get(token.trim());
  if (!row) return null;
  let summary = null;
  let options = null;
  try {
    summary = row.summary ? JSON.parse(row.summary) : null;
    options = row.options ? JSON.parse(row.options) : null;
  } catch {
    return null;
  }
  return { ...row, summary, options };
}

export function updateScanShareToken(scanId, userId, token) {
  const stmt = getDb().prepare(
    'UPDATE scans SET share_token = ? WHERE id = ? AND user_id = ?'
  );
  const result = stmt.run(token ? token.trim() : null, scanId, userId);
  return result.changes > 0;
}

export function deleteScan(scanId, userId) {
  const stmt = getDb().prepare(
    'DELETE FROM scans WHERE id = ? AND user_id = ?'
  );
  const result = stmt.run(scanId, userId);
  return result.changes > 0;
}

/** Delete multiple scans by id; all must belong to userId. */
export function deleteScansByIds(userId, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return 0;
  const placeholders = ids.map(() => '?').join(',');
  const stmt = getDb().prepare(
    `DELETE FROM scans WHERE user_id = ? AND id IN (${placeholders})`
  );
  const result = stmt.run(userId, ...ids);
  return result.changes;
}

/** Scan ids and screenshot paths for a user (for account deletion / file cleanup). */
export function getScanScreenshotPathsByUserId(userId) {
  const stmt = getDb().prepare(
    'SELECT id, screenshot_path FROM scans WHERE user_id = ? AND screenshot_path IS NOT NULL'
  );
  return stmt.all(userId);
}

/** Distinct URLs the user has scanned (for trends / website selector). */
export function getDistinctUrlsByUserId(userId) {
  const stmt = getDb().prepare(
    'SELECT DISTINCT url FROM scans WHERE user_id = ? ORDER BY url ASC'
  );
  const rows = stmt.all(userId);
  return rows.map((r) => r.url);
}

/** Scans for a given URL and user, chronological (oldest first) for trend charts. */
export function getScansByUrlAndUserId(userId, url, limit = 200) {
  const stmt = getDb().prepare(
    'SELECT id, url, options, summary, created_at, run_id FROM scans WHERE user_id = ? AND url = ? ORDER BY created_at ASC LIMIT ?'
  );
  const rows = stmt.all(userId, url, limit);
  return rows.map((row) => {
    let summary = null;
    let options = null;
    try {
      summary = row.summary ? JSON.parse(row.summary) : null;
      options = row.options ? JSON.parse(row.options) : null;
    } catch {
      /* keep null */
    }
    return { ...row, summary, options };
  });
}

/** All scans for a user (metadata + summary only, no report_json) for data export. */
export function getScansForUserExport(userId) {
  const stmt = getDb().prepare(
    'SELECT id, url, options, summary, created_at, run_id FROM scans WHERE user_id = ? ORDER BY created_at DESC'
  );
  const rows = stmt.all(userId);
  return rows.map((row) => {
    let summary = null;
    let options = null;
    try {
      summary = row.summary ? JSON.parse(row.summary) : null;
      options = row.options ? JSON.parse(row.options) : null;
    } catch {
      /* keep null */
    }
    return {
      id: row.id,
      url: row.url,
      options,
      summary,
      created_at: row.created_at,
      run_id: row.run_id,
    };
  });
}

/** Permanently delete a user. Scans are removed by CASCADE. Returns true if deleted. */
export function deleteUser(userId) {
  const stmt = getDb().prepare('DELETE FROM users WHERE id = ?');
  const result = stmt.run(userId);
  return result.changes > 0;
}

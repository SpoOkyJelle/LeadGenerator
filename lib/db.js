const path = require('path');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, '..', 'leads.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    name TEXT DEFAULT '',
    status TEXT DEFAULT 'new',
    notes TEXT DEFAULT '',
    created INTEGER NOT NULL,
    scan_result TEXT DEFAULT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS quotes (
    lead_id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS outreach (
    lead_id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL,
    data TEXT NOT NULL,
    created INTEGER NOT NULL
  );

  -- Client-facing report pages (one per lead), reachable via a hard-to-guess token
  CREATE TABLE IF NOT EXISTS reports (
    lead_id TEXT PRIMARY KEY,
    token TEXT UNIQUE NOT NULL,
    html TEXT NOT NULL,
    lang TEXT DEFAULT 'nl',
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL
  );

  -- One row per real view of a report (counted only after the page was visible for a few seconds)
  CREATE TABLE IF NOT EXISTS report_views (
    view_id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL,
    token TEXT NOT NULL,
    at INTEGER NOT NULL,
    seconds INTEGER DEFAULT 0,
    device TEXT DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_report_views_at ON report_views(at);
`);

// Columns added after the first release: add them to existing databases
const leadColumns = db.prepare('PRAGMA table_info(leads)').all().map(c => c.name);
for (const col of ['email', 'phone']) {
  if (!leadColumns.includes(col)) db.exec(`ALTER TABLE leads ADD COLUMN ${col} TEXT DEFAULT ''`);
}

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  if (!row) return undefined;
  try { return JSON.parse(row.value); } catch { return undefined; }
}

module.exports = { db, getSetting };

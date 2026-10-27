const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { db, getSetting } = require('./lib/db');
const { scanSite, fetchSiteLogo } = require('./lib/scanner');
const { discoverBusinesses, DiscoverError } = require('./lib/discover');
const { aiConfigured, generateOutreach, OutreachError } = require('./lib/ai');
const { mailConfigured, verifyMail, sendMail, MailError } = require('./lib/mailer');
const { takeScreenshots, findBrowser, screenshotPath, saveImage } = require('./lib/screenshot');
const reports = require('./lib/reports');

const app = express();
const PORT = Number(process.env.PORT) || 3001;
// Only reachable from this computer by default. Set HOST=0.0.0.0 to open it to your network
// (note: there is no login, so anyone on that network can then use the app).
const HOST = process.env.HOST || '127.0.0.1';

// The API keys live only on the server; they are never sent back to the browser.
const SECRET_KEYS = ['anthropicApiKey', 'pagespeedApiKey', 'smtpPass'];

// A full backup (report HTML, scan results) can be a few MB, so allow more than the usual 1mb.
app.use(express.json({ limit: '25mb' }));

// ── Access control (optional password) ──
// Off by default (open on localhost, as before). The moment you set a password in Settings
// the whole dashboard and API require a login cookie; the public report server is unaffected.
const SESSION_COOKIE = 'leadgen_session';
const SESSION_DAYS = 30;

function authEnabled() { return Boolean(getSetting('authHash')); }

function authSecret() {
  let s = getSetting('authSecret');
  if (!s) {
    s = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('authSecret', JSON.stringify(s));
  }
  return s;
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return 'scrypt$' + salt.toString('hex') + '$' + crypto.scryptSync(pw, salt, 64).toString('hex');
}

function verifyPassword(pw, stored) {
  const [scheme, saltHex, hashHex] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const got = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}

function makeToken() {
  const payload = 'v1.' + (Date.now() + SESSION_DAYS * 864e5);
  return payload + '.' + crypto.createHmac('sha256', authSecret()).update(payload).digest('hex');
}

function validToken(tok) {
  const parts = String(tok || '').split('.');
  if (parts.length !== 3) return false;
  const payload = parts[0] + '.' + parts[1];
  const expected = crypto.createHmac('sha256', authSecret()).update(payload).digest('hex');
  const a = Buffer.from(parts[2]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return Number(parts[1]) > Date.now();
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function setSessionCookie(res, token, maxAgeSec) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}`);
}

// Reachable without a session, so you can log in (and out) in the first place.
app.get('/api/health', (req, res) => res.json({ ok: true, authEnabled: authEnabled() }));

app.post('/api/login', (req, res) => {
  if (!authEnabled()) return res.json({ ok: true });
  const pw = req.body && req.body.password;
  if (!pw || !verifyPassword(pw, getSetting('authHash'))) return res.status(401).json({ error: 'bad_password' });
  setSessionCookie(res, makeToken(), SESSION_DAYS * 24 * 3600);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  setSessionCookie(res, '', 0);
  res.json({ ok: true });
});

// The gate: everything below this line needs a valid session once a password is set.
app.use((req, res, next) => {
  if (!authEnabled() || validToken(readCookie(req, SESSION_COOKIE))) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'auth_required' });
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Only the dashboard files are public - never the database or the server code.
app.use(express.static(path.join(__dirname, 'public')));

// ── Scanning ──
app.get('/api/scan', async (req, res) => {
  let targetUrl = req.query.url;
  if (!targetUrl) return res.json({ success: false, error: 'Missing url parameter', findings: [] });
  if (!/^https?:\/\//i.test(targetUrl)) targetUrl = 'https://' + targetUrl;

  // Screenshots run alongside the scan (they need the lead id for the file names)
  const leadId = req.query.leadId ? String(req.query.leadId) : null;
  const wantShots = leadId && getSetting('screenshotsEnabled') !== false;
  const shotsPromise = wantShots ? takeScreenshots(targetUrl, leadId) : Promise.resolve(null);

  try {
    const result = await scanSite(targetUrl, { pagespeedKey: getSetting('pagespeedApiKey') });
    const screenshots = await shotsPromise;
    const findings = result.findings;
    // Measured on a real phone-sized screen: does the page need sideways scrolling?
    if (screenshots && screenshots.mobileOverflow > 20 && !findings.some(f => f.tech === 'Mobile')) {
      findings.push({ tech: 'Mobile', severity: 'warning', overflow: screenshots.mobileOverflow,
        title: 'Page does not fit on a phone screen',
        description: `On a phone the page is ${screenshots.mobileOverflow}px wider than the screen, so visitors have to scroll sideways. Google ranks such pages lower in mobile search.` });
      const order = { critical: 0, warning: 1, info: 2 };
      findings.sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
    }
    // The client's own logo, for the report
    const logo = leadId && result.logo ? saveImage(`${leadId}-logo`, result.logo.buffer, result.logo.type) : null;
    return res.json({
      success: true,
      url: result.finalUrl,
      statusCode: result.statusCode,
      findings,
      contact: result.contact,
      profile: result.profile,
      screenshots,
      logo,
      scannedAt: new Date().toISOString(),
    });
  } catch (err) {
    return res.json({
      success: false,
      error: err.message || 'Unknown error during scan',
      errorCode: ['blocked', 'dns', 'refused', 'timeout'].includes(err.code) ? err.code : null,
      httpStatus: err.httpStatus || null,
      findings: [],
    });
  }
});

// ── Discover local businesses (OpenStreetMap, free, no key) ──
app.get('/api/discover', async (req, res) => {
  const area = String(req.query.area || '').trim();
  const type = String(req.query.type || 'all');
  if (!area) return res.status(400).json({ error: 'no_area' });
  try {
    const result = await discoverBusinesses({ area, type });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof DiscoverError) {
      const status = err.code === 'area_not_found' || err.code === 'area_too_large' || err.code === 'no_area' ? 400 : 502;
      return res.status(status).json({ error: err.code, message: err.message });
    }
    console.error('Discover failed:', err);
    res.status(500).json({ error: 'discover_failed', message: err.message });
  }
});

// ── Leads ──
app.get('/api/leads', (req, res) => {
  const rows = db.prepare(`
    SELECT l.*, q.data AS quote_data, o.data AS outreach_data
    FROM leads l
    LEFT JOIN quotes q ON q.lead_id = l.id
    LEFT JOIN outreach o ON o.lead_id = l.id
    ORDER BY l.created DESC
  `).all();
  const reportInfo = reports.reportSummaries();
  res.json(rows.map(r => ({
    ...r,
    report: reportInfo[r.id] || null,
    email: r.email || '',
    phone: r.phone || '',
    scanResult: r.scan_result ? JSON.parse(r.scan_result) : null,
    quote: r.quote_data ? JSON.parse(r.quote_data) : null,
    outreach: r.outreach_data ? JSON.parse(r.outreach_data) : null,
    scan_result: undefined,
    quote_data: undefined,
    outreach_data: undefined,
  })));
});

app.post('/api/leads', (req, res) => {
  const { id, url, name, status, notes, created, email, phone } = req.body;
  db.prepare('INSERT INTO leads (id, url, name, status, notes, created, email, phone) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, url, name || '', status || 'new', notes || '', created || Date.now(), email || '', phone || '');
  res.json({ ok: true });
});

app.put('/api/leads/:id', (req, res) => {
  const { url, name, status, notes, scanResult, email, phone } = req.body;
  db.prepare('UPDATE leads SET url=?, name=?, status=?, notes=?, scan_result=?, email=?, phone=? WHERE id=?')
    .run(url, name || '', status || 'new', notes || '', scanResult ? JSON.stringify(scanResult) : null, email || '', phone || '', req.params.id);
  res.json({ ok: true });
});

app.delete('/api/leads/:id', (req, res) => {
  for (const table of ['leads', 'quotes', 'outreach', 'messages']) {
    db.prepare(`DELETE FROM ${table} WHERE ${table === 'leads' ? 'id' : 'lead_id'}=?`).run(req.params.id);
  }
  reports.deleteReport(req.params.id);
  res.json({ ok: true });
});

// ── Screenshots & client reports ──
app.get('/api/screenshots/:file', (req, res) => {
  const file = screenshotPath(req.params.file);
  if (!file) return res.sendStatus(404);
  reports.sendImage(res, file);
});

// Your own logo, taken from your own website (returned as a data URL for the settings)
app.get('/api/fetch-logo', async (req, res) => {
  let url = String(req.query.url || '').trim();
  if (!url) return res.status(400).json({ error: 'no_url' });
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try {
    const logo = await fetchSiteLogo(url);
    if (!logo) return res.status(404).json({ error: 'not_found' });
    res.json({ dataUrl: `data:${logo.type};base64,${logo.buffer.toString('base64')}`, source: logo.url });
  } catch {
    res.status(404).json({ error: 'not_found' });
  }
});

// Publish (or update) the client-facing report page; the token and link stay the same
app.put('/api/reports/:leadId', (req, res) => {
  const lead = db.prepare('SELECT id FROM leads WHERE id=?').get(req.params.leadId);
  const html = req.body && req.body.html;
  if (!lead || typeof html !== 'string' || !html.includes('</body>')) return res.status(400).json({ error: 'Invalid report' });
  res.json(reports.saveReport(lead.id, html, req.body.lang));
});

app.delete('/api/reports/:leadId', (req, res) => {
  reports.deleteReport(req.params.leadId);
  res.json({ ok: true });
});

// Preview for yourself: same page, but views are not counted
app.get('/api/reports/:leadId/preview', (req, res) => {
  const r = db.prepare('SELECT html FROM reports WHERE lead_id=?').get(req.params.leadId);
  if (!r) return res.sendStatus(404);
  res.type('html').send(reports.renderReport(r.html, `/api/reports/${encodeURIComponent(req.params.leadId)}/img/`, false));
});

app.get('/api/reports/:leadId/img/:kind', (req, res) => {
  const file = reports.leadScreenshot(req.params.leadId, req.params.kind);
  if (!file) return res.sendStatus(404);
  reports.sendImage(res, file);
});

app.get('/api/report-views', (req, res) => {
  res.json(reports.recentViews(req.query.since));
});

// ── Saved messages (to send later / already sent) ──
app.get('/api/messages', (req, res) => {
  const rows = db.prepare('SELECT * FROM messages ORDER BY created DESC').all();
  res.json(rows.map(r => ({ ...JSON.parse(r.data), id: r.id, leadId: r.lead_id, created: r.created })));
});

app.put('/api/messages/:id', (req, res) => {
  const body = req.body || {};
  if (!body.leadId) return res.status(400).json({ error: 'leadId required' });
  const { id, leadId, created, ...data } = body;
  db.prepare(
    'INSERT INTO messages (id, lead_id, data, created) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data'
  ).run(req.params.id, leadId, JSON.stringify(data), created || Date.now());
  res.json({ ok: true });
});

app.delete('/api/messages/:id', (req, res) => {
  db.prepare('DELETE FROM messages WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── Settings (key/value, values stored as JSON) ──
app.get('/api/settings', (req, res) => {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) {
    // Never expose secrets or the auth hash/secret to the browser.
    if (SECRET_KEYS.includes(r.key) || ['authHash', 'authSecret'].includes(r.key)) continue;
    try { out[r.key] = JSON.parse(r.value); } catch { /* skip bad row */ }
  }
  out.anthropicApiKeySet = Boolean(getSetting('anthropicApiKey'));
  out.pagespeedApiKeySet = Boolean(getSetting('pagespeedApiKey'));
  out.smtpPassSet = Boolean(getSetting('smtpPass'));
  out.authEnabled = authEnabled();
  out.aiConfigured = aiConfigured();
  out.mailConfigured = mailConfigured();
  const browser = findBrowser();
  out.screenshotBrowser = browser ? path.basename(browser) : null;
  out.reportPort = reports.REPORT_PORT;
  out.publicBaseUrl = reports.publicBaseUrl();
  res.json(out);
});

const upsertSetting = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

const AUTH_KEYS = ['authEnabled', 'authPassword', 'authDisable', 'authHash', 'authSecret'];

app.put('/api/settings', (req, res) => {
  const body = req.body || {};
  db.transaction(() => {
    // Password handling is explicit; the raw hash/secret can never be set through this loop.
    if (typeof body.authPassword === 'string' && body.authPassword.trim()) {
      authSecret(); // make sure a signing secret exists
      upsertSetting.run('authHash', JSON.stringify(hashPassword(body.authPassword.trim())));
    }
    if (body.authDisable === true) db.prepare('DELETE FROM settings WHERE key=?').run('authHash');
    for (const [key, value] of Object.entries(body)) {
      if (AUTH_KEYS.includes(key)) continue;
      if (['anthropicApiKeySet', 'pagespeedApiKeySet', 'smtpPassSet', 'aiConfigured', 'mailConfigured', 'screenshotBrowser', 'reportPort', 'publicBaseUrl'].includes(key)) continue;
      if (SECRET_KEYS.includes(key)) {
        // null removes a secret, an empty string leaves it unchanged
        if (value === null) db.prepare('DELETE FROM settings WHERE key=?').run(key);
        else if (typeof value === 'string' && value.trim()) upsertSetting.run(key, JSON.stringify(value.trim()));
        continue;
      }
      upsertSetting.run(key, JSON.stringify(value));
    }
  })();
  res.json({ ok: true });
});

// ── Backup / restore (the whole database as one JSON file) ──
// leads.db is never in git and never leaves this computer, so this is how you move
// your data to another machine or keep a safety copy.
const BACKUP_TABLES = ['leads', 'settings', 'quotes', 'outreach', 'messages', 'reports', 'report_views'];

app.get('/api/backup', (req, res) => {
  const tables = {};
  for (const table of BACKUP_TABLES) tables[table] = db.prepare(`SELECT * FROM ${table}`).all();
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename="leadgen-backup-${stamp}.json"`);
  res.type('application/json').send(JSON.stringify({
    app: 'lead-generator', version: 1, exportedAt: new Date().toISOString(), tables,
  }, null, 2));
});

app.post('/api/restore', (req, res) => {
  const body = req.body || {};
  if (body.app !== 'lead-generator' || !body.tables || typeof body.tables !== 'object') {
    return res.status(400).json({ error: 'invalid_backup' });
  }
  try {
    const counts = {};
    db.transaction(() => {
      for (const table of BACKUP_TABLES) {
        const rows = body.tables[table];
        if (!Array.isArray(rows)) continue;
        db.prepare(`DELETE FROM ${table}`).run();
        for (const row of rows) {
          const cols = Object.keys(row);
          if (!cols.length) continue;
          db.prepare(`INSERT INTO ${table} (${cols.map(c => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
            .run(...cols.map(c => row[c]));
        }
        counts[table] = rows.length;
      }
    })();
    res.json({ ok: true, counts });
  } catch (err) {
    console.error('Restore failed:', err);
    res.status(500).json({ error: 'restore_failed' });
  }
});

// ── Sending email directly (SMTP) ──
app.post('/api/smtp-test', async (req, res) => {
  try {
    await verifyMail();
    res.json({ ok: true });
  } catch (err) {
    const status = err instanceof MailError && err.code === 'not_configured' ? 400 : 502;
    res.status(status).json({ error: (err && err.code) || 'send_failed', message: err && err.message });
  }
});

app.post('/api/send-email', async (req, res) => {
  const body = req.body || {};
  const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(body.leadId);
  if (!lead) return res.status(404).json({ error: 'lead_not_found' });
  const to = (body.to && String(body.to).trim()) || lead.email;
  try {
    const info = await sendMail({ to, subject: body.subject, text: body.body });
    res.json({ ok: true, to, messageId: info.messageId });
  } catch (err) {
    if (err instanceof MailError) {
      const status = ['not_configured', 'no_recipient'].includes(err.code) ? 400 : 502;
      return res.status(status).json({ error: err.code, message: err.message });
    }
    console.error('Send email failed:', err);
    res.status(500).json({ error: 'send_failed' });
  }
});

// ── Outreach drafts (one per lead) ──
app.put('/api/outreach/:leadId', (req, res) => {
  db.prepare(
    'INSERT INTO outreach (lead_id, data, updated) VALUES (?, ?, ?) ON CONFLICT(lead_id) DO UPDATE SET data = excluded.data, updated = excluded.updated'
  ).run(req.params.leadId, JSON.stringify(req.body || {}), Date.now());
  res.json({ ok: true });
});

app.delete('/api/outreach/:leadId', (req, res) => {
  db.prepare('DELETE FROM outreach WHERE lead_id=?').run(req.params.leadId);
  res.json({ ok: true });
});

app.post('/api/outreach/:leadId/generate', async (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(req.params.leadId);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  const body = req.body || {};
  const options = {
    channel: body.channel || 'email',
    tone: body.tone || 'friendly',
    length: body.length || 'normal',
    language: body.language || 'nl',
    formality: body.formality || 'u',
    extra: body.extra || '',
    followUp: body.followUp || null,
    reportMode: body.reportMode || 'offer',
    reportUrl: null,
    bookingUrl: String(getSetting('bookingUrl') || '').trim() || null,
  };
  if (options.reportMode === 'link') {
    const info = reports.reportSummaries()[lead.id];
    if (!info) return res.status(400).json({ error: 'no_report' });
    options.reportUrl = info.url;
  }
  const scan = lead.scan_result ? JSON.parse(lead.scan_result) : null;
  const findings = (scan && scan.success ? scan.findings : []).filter(f => f.severity !== 'info');
  options.profile = scan && scan.profile ? scan.profile : null;

  try {
    return res.json(await generateOutreach(lead, findings, options));
  } catch (err) {
    if (err instanceof OutreachError) {
      return res.status(err.status).json({ error: ['no_key', 'no_workspace'].includes(err.code) ? err.code : err.message });
    }
    console.error('Outreach generation failed:', err);
    return res.status(500).json({ error: 'Unexpected error while generating the message.' });
  }
});

// ── Quotes (one per lead) ──
app.put('/api/quotes/:leadId', (req, res) => {
  db.prepare(
    'INSERT INTO quotes (lead_id, data, updated) VALUES (?, ?, ?) ON CONFLICT(lead_id) DO UPDATE SET data = excluded.data, updated = excluded.updated'
  ).run(req.params.leadId, JSON.stringify(req.body || {}), Date.now());
  res.json({ ok: true });
});

app.delete('/api/quotes/:leadId', (req, res) => {
  db.prepare('DELETE FROM quotes WHERE lead_id=?').run(req.params.leadId);
  res.json({ ok: true });
});

// ── Automatic background rescans ──
// Refresh already-scanned leads on a schedule so you notice a site going offline
// or a certificate about to expire. Runs only while this process is up.
let autoRescanBusy = false;

async function rescanLeadRow(lead) {
  let prev = null;
  try { prev = lead.scan_result ? JSON.parse(lead.scan_result) : null; } catch { /* ignore */ }
  const result = await scanSite(lead.url, { pagespeedKey: getSetting('pagespeedApiKey') });
  const logo = (prev && prev.logo) || (result.logo ? saveImage(`${lead.id}-logo`, result.logo.buffer, result.logo.type) : null);
  const scanResult = {
    success: true,
    url: result.finalUrl,
    statusCode: result.statusCode,
    findings: result.findings,
    contact: result.contact,
    profile: result.profile,
    screenshots: prev ? prev.screenshots || null : null, // background scans take no screenshots
    logo,
    scannedAt: new Date().toISOString(),
    autoScanned: true,
  };
  // Fill in a contact email we didn't have yet, but never overwrite one you curated
  const email = (lead.email && lead.email.trim()) ? lead.email : (result.contact && result.contact.email) || lead.email || '';
  db.prepare('UPDATE leads SET scan_result=?, email=? WHERE id=?').run(JSON.stringify(scanResult), email, lead.id);
}

async function autoRescanTick() {
  if (autoRescanBusy) return;
  const days = Number(getSetting('autoRescanDays')) || 0;
  if (!days) return;
  autoRescanBusy = true;
  try {
    const cutoff = Date.now() - days * 864e5;
    const stale = db.prepare('SELECT * FROM leads').all().filter(l => {
      if (!l.scan_result) return false; // only refresh leads that were scanned before
      let sr; try { sr = JSON.parse(l.scan_result); } catch { return false; }
      return sr && sr.success && sr.scannedAt && Date.parse(sr.scannedAt) < cutoff;
    });
    for (const lead of stale.slice(0, 5)) { // a few per tick to stay gentle
      try { await rescanLeadRow(lead); }
      catch (err) { console.error('Auto-rescan failed for', lead.url, '-', err.message); }
    }
    if (stale.length) console.log(`Auto-rescan: refreshed ${Math.min(stale.length, 5)} of ${stale.length} stale lead(s)`);
  } finally {
    autoRescanBusy = false;
  }
}

setInterval(autoRescanTick, 60 * 60 * 1000).unref(); // check hourly
setTimeout(autoRescanTick, 30 * 1000).unref();       // and once shortly after startup

// ── Start ──
// Report pages get their own server so you can put only that one online (e.g. via a Cloudflare Tunnel)
reports.startPublicServer(process.env.REPORT_HOST || '127.0.0.1');

app.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`LeadGen running at ${url}`);
  if (process.env.NO_BROWSER) return;
  const { exec } = require('child_process');
  if (process.platform === 'win32') exec(`start ${url}`);
  else if (process.platform === 'darwin') exec(`open ${url}`);
});

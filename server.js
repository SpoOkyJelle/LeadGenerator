const path = require('path');
const express = require('express');
const { db, getSetting } = require('./lib/db');
const { scanSite } = require('./lib/scanner');
const { aiConfigured, generateOutreach, OutreachError } = require('./lib/ai');

const app = express();
const PORT = Number(process.env.PORT) || 3001;
// Only reachable from this computer by default. Set HOST=0.0.0.0 to open it to your network
// (note: there is no login, so anyone on that network can then use the app).
const HOST = process.env.HOST || '127.0.0.1';

// The API keys live only on the server; they are never sent back to the browser.
const SECRET_KEYS = ['anthropicApiKey', 'pagespeedApiKey'];

// Only the dashboard files are public - never the database or the server code.
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// ── Scanning ──
app.get('/api/scan', async (req, res) => {
  let targetUrl = req.query.url;
  if (!targetUrl) return res.json({ success: false, error: 'Missing url parameter', findings: [] });
  if (!/^https?:\/\//i.test(targetUrl)) targetUrl = 'https://' + targetUrl;

  try {
    const result = await scanSite(targetUrl, { pagespeedKey: getSetting('pagespeedApiKey') });
    return res.json({
      success: true,
      url: result.finalUrl,
      statusCode: result.statusCode,
      findings: result.findings,
      contact: result.contact,
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

// ── Leads ──
app.get('/api/leads', (req, res) => {
  const rows = db.prepare(`
    SELECT l.*, q.data AS quote_data, o.data AS outreach_data
    FROM leads l
    LEFT JOIN quotes q ON q.lead_id = l.id
    LEFT JOIN outreach o ON o.lead_id = l.id
    ORDER BY l.created DESC
  `).all();
  res.json(rows.map(r => ({
    ...r,
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
  res.json({ ok: true });
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
    if (SECRET_KEYS.includes(r.key)) continue;
    try { out[r.key] = JSON.parse(r.value); } catch { /* skip bad row */ }
  }
  out.anthropicApiKeySet = Boolean(getSetting('anthropicApiKey'));
  out.pagespeedApiKeySet = Boolean(getSetting('pagespeedApiKey'));
  out.aiConfigured = aiConfigured();
  res.json(out);
});

const upsertSetting = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

app.put('/api/settings', (req, res) => {
  const body = req.body || {};
  db.transaction(() => {
    for (const [key, value] of Object.entries(body)) {
      if (['anthropicApiKeySet', 'pagespeedApiKeySet', 'aiConfigured'].includes(key)) continue;
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
  };
  const scan = lead.scan_result ? JSON.parse(lead.scan_result) : null;
  const findings = (scan && scan.success ? scan.findings : []).filter(f => f.severity !== 'info');

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

// ── Start ──
app.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`LeadGen running at ${url}`);
  if (process.env.NO_BROWSER) return;
  const { exec } = require('child_process');
  if (process.platform === 'win32') exec(`start ${url}`);
  else if (process.platform === 'darwin') exec(`open ${url}`);
});

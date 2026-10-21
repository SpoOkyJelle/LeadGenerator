// Client-facing reports: stored HTML snapshots, served on a separate public server with view tracking.
const crypto = require('crypto');
const express = require('express');
const { db, getSetting } = require('./db');
const { screenshotPath } = require('./screenshot');

const REPORT_PORT = Number(process.env.REPORT_PORT) || 3002;

function newToken() {
  return crypto.randomBytes(12).toString('base64url');
}

function publicBaseUrl() {
  const configured = String(getSetting('publicReportUrl') || '').trim().replace(/\/+$/, '');
  return configured || `http://localhost:${REPORT_PORT}`;
}

function reportUrl(token) {
  return `${publicBaseUrl()}/r/${token}`;
}

function saveReport(leadId, html, lang) {
  const existing = db.prepare('SELECT token FROM reports WHERE lead_id=?').get(leadId);
  const token = existing ? existing.token : newToken();
  const now = Date.now();
  db.prepare(`
    INSERT INTO reports (lead_id, token, html, lang, created, updated) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(lead_id) DO UPDATE SET html = excluded.html, lang = excluded.lang, updated = excluded.updated
  `).run(leadId, token, html, lang || 'nl', now, now);
  return { token, url: reportUrl(token) };
}

function deleteReport(leadId) {
  db.prepare('DELETE FROM reports WHERE lead_id=?').run(leadId);
  db.prepare('DELETE FROM report_views WHERE lead_id=?').run(leadId);
}

// Per-lead summary for the dashboard
function reportSummaries() {
  const rows = db.prepare(`
    SELECT r.lead_id, r.token, r.updated,
      (SELECT COUNT(*) FROM report_views v WHERE v.lead_id = r.lead_id) AS views,
      (SELECT MAX(at) FROM report_views v WHERE v.lead_id = r.lead_id) AS last_view,
      (SELECT COALESCE(SUM(seconds), 0) FROM report_views v WHERE v.lead_id = r.lead_id) AS seconds
    FROM reports r
  `).all();
  const out = {};
  for (const r of rows) {
    out[r.lead_id] = { token: r.token, url: reportUrl(r.token), updated: r.updated, views: r.views, lastViewAt: r.last_view, totalSeconds: r.seconds };
  }
  return out;
}

function recentViews(since) {
  return db.prepare('SELECT lead_id AS leadId, at, seconds, device FROM report_views WHERE at > ? ORDER BY at DESC LIMIT 50').all(Number(since) || 0);
}

// Screenshot file for a lead ("desktop" / "mobile"), taken from its latest scan
function leadScreenshot(leadId, kind) {
  const row = db.prepare('SELECT scan_result FROM leads WHERE id=?').get(leadId);
  if (!row || !row.scan_result) return null;
  try {
    const sr = JSON.parse(row.scan_result);
    if (kind === 'logo') return sr.logo ? screenshotPath(sr.logo) : null;
    const shots = sr.screenshots || {};
    return ['desktop', 'mobile'].includes(kind) && shots[kind] ? screenshotPath(shots[kind]) : null;
  } catch { return null; }
}

function renderReport(html, imgBase, withTracker, token) {
  let out = html.split('{{IMG_BASE}}').join(imgBase);
  if (withTracker) out = out.replace('</body>', trackerScript(token) + '</body>');
  return out;
}

// Counts a view only once the page has really been looked at for a few seconds (link scanners in
// Outlook/Gmail open links automatically but don't stay), then reports the reading time.
function trackerScript(token) {
  return `<script>
(function(){
  var id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  var url = '/r/${token}/v', seconds = 0, counted = false, last = Date.now();
  function send(final){
    var body = JSON.stringify({ id: id, seconds: seconds, device: window.innerWidth < 760 ? 'mobile' : 'desktop' });
    if (final && navigator.sendBeacon) navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
    else fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true }).catch(function(){});
  }
  setInterval(function(){
    var now = Date.now();
    if (document.visibilityState === 'visible') seconds += Math.round((now - last) / 1000);
    last = now;
    if (!counted && seconds >= 4) { counted = true; send(false); }
    else if (counted && seconds % 15 < 1) send(false);
  }, 1000);
  document.addEventListener('visibilitychange', function(){ if (counted && document.visibilityState === 'hidden') send(true); });
})();
</script>`;
}

// ── The public server: only report pages, nothing else ──
function startPublicServer(host) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  const byToken = (token) => db.prepare('SELECT lead_id, token, html FROM reports WHERE token=?').get(String(token));

  app.get('/r/:token', (req, res) => {
    const r = byToken(req.params.token);
    if (!r) return res.status(404).send(notFoundPage());
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(renderReport(r.html, `/r/${r.token}/img/`, true, r.token));
  });

  app.get('/r/:token/img/:kind', (req, res) => {
    const r = byToken(req.params.token);
    const file = r && leadScreenshot(r.lead_id, req.params.kind);
    if (!file) return res.sendStatus(404);
    sendImage(res, file);
  });

  app.post('/r/:token/v', express.json({ limit: '2kb', type: () => true }), (req, res) => {
    const r = byToken(req.params.token);
    const body = req.body || {};
    const viewId = String(body.id || '').slice(0, 40);
    if (!r || !viewId) return res.sendStatus(204);
    const seconds = Math.max(0, Math.min(3600, Math.round(Number(body.seconds) || 0)));
    const device = body.device === 'mobile' ? 'mobile' : 'desktop';
    db.prepare(`
      INSERT INTO report_views (view_id, lead_id, token, at, seconds, device) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(view_id) DO UPDATE SET seconds = MAX(seconds, excluded.seconds)
    `).run(viewId, r.lead_id, r.token, Date.now(), seconds, device);
    res.sendStatus(204);
  });

  app.use((req, res) => res.status(404).send(notFoundPage()));

  app.listen(REPORT_PORT, host, () => console.log(`Report pages served at http://localhost:${REPORT_PORT}/r/...`));
}

// Images come from other people's websites; a strict policy stops a hostile SVG from running scripts
function sendImage(res, file) {
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(file);
}

function notFoundPage() {
  return '<!doctype html><meta charset="utf-8"><title>Niet gevonden</title><body style="font-family:system-ui;padding:60px;text-align:center;color:#555">Dit rapport bestaat niet (meer).</body>';
}

module.exports = { saveReport, deleteReport, reportSummaries, recentViews, leadScreenshot, renderReport, startPublicServer, publicBaseUrl, sendImage, REPORT_PORT };

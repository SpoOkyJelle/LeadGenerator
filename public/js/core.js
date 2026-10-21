// ── Helpers ──
const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function normalize(url) {
  url = url.trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  return url;
}

function domain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function fmtDate(ts) {
  return new Date(ts).toLocaleDateString(lang === 'nl' ? 'nl-NL' : 'en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtDateTime(ts) {
  return new Date(ts).toLocaleString(lang === 'nl' ? 'nl-NL' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function favicon(url, lg) {
  return '<div class="fav' + (lg ? ' lg' : '') + '"><img src="https://www.google.com/s2/favicons?sz=64&domain=' + encodeURIComponent(domain(url)) +
    '" alt="" onerror="this.parentNode.innerHTML=\'<i class=&quot;fa-solid fa-globe&quot;></i>\'"></div>';
}

// ── State ──
let leads = [];
let loaded = false;
let statusFilter = 'all';
let messages = [];
let view = 'list';
let currentId = null;
let sevFilter = 'all';
let editingId = null;
let confirmFn = null;
let settingsBuilt = false;
let settingsDirty = false;
let quoteDraft = null;
let quoteLeadId = null;
let quoteCreating = false;
let quoteSaveTimer = null;
let quotePending = null;
let quoteSaveState = 'saved';
let scanAllRunning = false;
const scanningIds = new Set(); // kept in memory so an interrupted scan never gets stuck

// ── API ──
async function apiLoad() {
  const [leadsRes, msgRes] = await Promise.all([fetch('/api/leads'), fetch('/api/messages')]);
  leads = await leadsRes.json();
  messages = msgRes.ok ? await msgRes.json() : [];
  loaded = true;
  render();
}

async function apiAdd(lead) {
  await fetch('/api/leads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(lead) });
}

async function apiDelete(id) {
  await fetch('/api/leads/' + id, { method: 'DELETE' });
}

// The server's PUT replaces every column, so always send the full lead
// (otherwise saving an edit wipes the scan result).
async function saveLead(id, changes) {
  const l = leads.find(x => x.id === id);
  if (!l) return;
  const merged = { url: l.url, name: l.name, status: l.status, notes: l.notes, email: l.email || '', phone: l.phone || '', scanResult: l.scanResult, ...changes };
  Object.assign(l, merged);
  await fetch('/api/leads/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(merged) });
}

// ── Scan state ──
function countFindings(findings) {
  return {
    critical: (findings || []).filter(f => f.severity === 'critical').length,
    warning: (findings || []).filter(f => f.severity === 'warning').length,
    info: (findings || []).filter(f => f.severity === 'info').length,
  };
}

function scanState(l) {
  if (scanningIds.has(l.id)) return 'scanning';
  const sr = l.scanResult;
  if (!sr || sr.scanning) return 'none';
  if (!sr.success) return 'error';
  return 'done';
}

function hasIssues(l) {
  if (scanState(l) !== 'done') return false;
  const c = countFindings(l.scanResult.findings);
  return c.critical + c.warning > 0;
}

function healthScore(findings) {
  const c = countFindings(findings);
  return Math.max(0, 100 - c.critical * 30 - c.warning * 12);
}

function healthColor(score) {
  return score >= 80 ? 'var(--green)' : score >= 50 ? 'var(--amber)' : 'var(--red)';
}

// ── Router ──
function route() {
  flushQuoteSave();
  flushOutreachSave();
  const h = location.hash || '#/';
  const prevView = view, prevId = currentId;
  let m;
  if ((m = h.match(/^#\/lead\/([^/]+)\/(quote|outreach)$/))) {
    view = m[2];
    currentId = decodeURIComponent(m[1]);
  } else if ((m = h.match(/^#\/lead\/([^/]+)$/))) {
    view = 'detail';
    currentId = decodeURIComponent(m[1]);
    if (currentId !== prevId) sevFilter = 'all';
  } else if (h === '#/settings') {
    view = 'settings';
    currentId = null;
    if (prevView !== 'settings') settingsBuilt = false;
  } else if (h === '#/attention' || h === '#/messages') {
    view = h.slice(2);
    currentId = null;
  } else {
    view = 'list';
    currentId = null;
  }
  // Leaving settings with unsaved edits: save them instead of losing them
  if (prevView === 'settings' && view !== 'settings' && settingsDirty) saveSettings();
  render();
  if (prevView !== view || prevId !== currentId) window.scrollTo(0, 0);
}

function go(id) { location.hash = '#/lead/' + encodeURIComponent(id); }

// ── Render ──
function render() {
  for (const v of ['list', 'detail', 'settings', 'quote', 'outreach', 'attention', 'messages']) $('view-' + v).hidden = view !== v;

  const a = attentionData();
  const attentionCount = a.ready.length + a.followUp.length + a.due.length;
  $('nav-count-all').textContent = leads.length;
  $('nav-count-attention').textContent = attentionCount || '';
  $('nav-count-messages').textContent = a.due.length || '';
  $('nav-all').classList.toggle('active', view === 'list');
  $('nav-attention').classList.toggle('active', view === 'attention');
  $('nav-messages').classList.toggle('active', view === 'messages');
  $('nav-settings').classList.toggle('active', view === 'settings');

  renderCrumbs();
  if (view === 'list') renderList();
  else if (view === 'attention') renderAttention(a);
  else if (view === 'messages') renderMessages();
  else if (view === 'detail') renderDetail();
  else if (view === 'settings') renderSettings();
  else if (view === 'outreach') renderOutreach();
  else renderQuote();
}

function renderCrumbs() {
  const sep = '<i class="fa-solid fa-chevron-right sep"></i>';
  const top = { list: 'allLeads', attention: 'needsAttention', messages: 'messages', settings: 'settings' };
  if (top[view]) {
    $('crumbs').innerHTML = '<span class="current">' + esc(t(top[view])) + '</span>';
    return;
  }
  const l = currentLead();
  const d = esc(l ? domain(l.url) : '');
  let html = '<a href="#/">' + esc(t('allLeads')) + '</a>' + sep;
  if (view === 'quote' || view === 'outreach') html += '<a href="#/lead/' + encodeURIComponent(currentId) + '">' + d + '</a>' + sep + '<span class="current">' + esc(t(view)) + '</span>';
  else html += '<span class="current">' + d + '</span>';
  $('crumbs').innerHTML = html;
}

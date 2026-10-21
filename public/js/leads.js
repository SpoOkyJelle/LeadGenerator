function renderStats() {
  const total = leads.length;
  const qualified = leads.filter(l => l.status === 'qualified').length;
  const scanned = leads.filter(l => scanState(l) === 'done').length;
  const issues = leads.filter(hasIssues).length;
  const weekAgo = Date.now() - 7 * 864e5;
  const recent = leads.filter(l => l.created > weekAgo).length;
  const pct = total ? Math.round(qualified / total * 100) : 0;

  const card = (label, value, sub, icon, tone) =>
    '<div class="card stat"><div class="stat-top"><span class="stat-label">' + label + '</span><span class="stat-icon ' + tone + '"><i class="fa-solid ' + icon + '"></i></span></div>' +
    '<div class="stat-value">' + value + '</div><div class="stat-sub">' + sub + '</div></div>';

  $('stats').innerHTML =
    card(t('totalLeads'), total, t('thisWeek', recent), 'fa-layer-group', 'tone-accent') +
    card(t('qualified'), qualified, t('ofTotal', pct), 'fa-circle-check', 'tone-green') +
    card(t('scanned'), scanned, t('notScannedYet', total - scanned), 'fa-satellite-dish', 'tone-blue') +
    card(t('withIssues'), issues, t('readyToPitch'), 'fa-fire', 'tone-amber');
}

function renderStatusSeg() {
  const base = leads;
  const opts = [['all', t('all')], ['new', t('statusNew')], ['contacted', t('statusContacted')], ['qualified', t('statusQualified')], ['rejected', t('statusRejected')]];
  $('status-seg').innerHTML = opts.map(([k, label]) => {
    const n = k === 'all' ? base.length : base.filter(l => l.status === k).length;
    return '<button class="' + (statusFilter === k ? 'active' : '') + '" onclick="setFilter(\'' + k + '\')">' + esc(label) + '<span class="n">' + n + '</span></button>';
  }).join('');
}

function techPills(l) {
  if (scanState(l) !== 'done') return '<span class="dash">—</span>';
  const findings = l.scanResult.findings;
  const pills = [];
  const add = (tech, label, icon) => {
    const f = findings.find(x => x.tech === tech);
    if (!f) return;
    const old = f.severity === 'critical' || f.severity === 'warning';
    const v = f.version && f.version !== 'detected' ? '<span class="v">' + esc(f.version) + '</span>' : '';
    pills.push('<span class="tech' + (old ? ' old' : '') + '" title="' + esc(f.title) + '"><i class="' + icon + '"></i>' + label + v + '</span>');
  };
  add('WordPress', 'WP', 'fa-brands fa-wordpress');
  add('PHP', 'PHP', 'fa-brands fa-php');
  add('Drupal', 'Drupal', 'fa-solid fa-cube');
  add('Joomla', 'Joomla', 'fa-solid fa-cube');
  return pills.length ? '<div class="tech-pills">' + pills.join('') + '</div>' : '<span class="dash">—</span>';
}

function scanPill(l) {
  const st = scanState(l);
  if (st === 'scanning') return '<span class="scan-pill busy"><span class="spin"></span>' + t('scanning') + '</span>';
  if (st === 'none') return '<span class="scan-pill none">' + t('notScanned') + '</span>';
  if (st === 'error') return '<span class="scan-pill crit"><i class="fa-solid fa-circle-exclamation"></i>' + t('scanFailed') + '</span>';
  const c = countFindings(l.scanResult.findings);
  if (c.critical) return '<span class="scan-pill crit"><i class="fa-solid fa-circle-xmark"></i>' + t('criticalBadge', c.critical) + '</span>';
  if (c.warning) return '<span class="scan-pill warn"><i class="fa-solid fa-triangle-exclamation"></i>' + t('warningBadge', c.warning) + '</span>';
  return '<span class="scan-pill ok"><i class="fa-solid fa-check"></i>' + t('allClear') + '</span>';
}

function badge(status) {
  const map = { new: t('statusNew'), contacted: t('statusContacted'), qualified: t('statusQualified'), rejected: t('statusRejected') };
  const key = map[status] ? status : 'new';
  return '<span class="badge badge-' + key + '"><span class="dot"></span>' + esc(map[key]) + '</span>';
}

function renderList() {
  $('list-title').textContent = t('allLeads');
  $('list-sub').textContent = t('pageSubtitle');
  $('btn-scan-all').disabled = scanAllRunning;

  renderStats();
  renderStatusSeg();

  const query = $('search-input').value.toLowerCase().trim();
  const visible = leads.filter(l => {
    if (statusFilter !== 'all' && l.status !== statusFilter) return false;
    if (query && !(l.url + ' ' + l.name + ' ' + l.notes).toLowerCase().includes(query)) return false;
    return true;
  });

  const tbody = $('leads-tbody');
  const empty = $('empty-state');
  tbody.parentElement.hidden = visible.length === 0;

  if (!visible.length) {
    let icon = 'fa-plus', title = t('noLeads'), hint = t('noLeadsHint');
    if (leads.length) { icon = 'fa-magnifying-glass'; title = t('noMatch'); hint = t('noMatchHint'); }
    empty.hidden = !loaded;
    empty.innerHTML = '<div class="empty-icon"><i class="fa-solid ' + icon + '"></i></div><h3>' + esc(title) + '</h3><p>' + esc(hint) + '</p>';
    tbody.innerHTML = '';
    return;
  }

  empty.hidden = true;
  tbody.innerHTML = visible.map(l => {
    const id = esc(l.id);
    const busy = scanState(l) === 'scanning';
    return '<tr class="row" onclick="go(\'' + id + '\')">' +
      '<td><div class="site">' + favicon(l.url) + '<div style="min-width:0"><div class="site-domain">' + esc(domain(l.url)) + '</div>' +
        '<div class="site-sub">' + esc(l.name || l.url) + '</div></div></div></td>' +
      '<td>' + badge(l.status) + '</td>' +
      '<td>' + techPills(l) + '</td>' +
      '<td>' + scanPill(l) + '</td>' +
      '<td class="date">' + fmtDate(l.created) + '</td>' +
      '<td><div class="row-actions" onclick="event.stopPropagation()">' +
        '<button class="icon-btn" title="' + esc(t('scan')) + '" onclick="scanLead(\'' + id + '\')"' + (busy ? ' disabled' : '') + '><i class="fa-solid fa-rotate"></i></button>' +
        '<button class="icon-btn" title="' + esc(t('edit')) + '" onclick="openEdit(\'' + id + '\')"><i class="fa-solid fa-pen"></i></button>' +
        '<button class="icon-btn danger" title="' + esc(t('delete')) + '" onclick="askDelete(\'' + id + '\')"><i class="fa-solid fa-trash-can"></i></button>' +
      '</div></td>' +
    '</tr>';
  }).join('');
}

// ── Filters ──
function setFilter(f) {
  statusFilter = f;
  render();
}

// ── Quick add ──
async function quickAdd() {
  const url = normalize($('quick-url').value);
  if (!url) { toast(t('toastNeedUrl'), 'error'); $('quick-url').focus(); return; }
  const lead = { id: uid(), url, name: $('quick-name').value.trim(), status: $('quick-status').value, notes: '', created: Date.now() };
  await apiAdd(lead);
  $('quick-url').value = '';
  $('quick-name').value = '';
  await apiLoad();
  toast(t('toastAdded'), 'success');
}

$('quick-url').addEventListener('keydown', e => { if (e.key === 'Enter') quickAdd(); });
$('quick-name').addEventListener('keydown', e => { if (e.key === 'Enter') quickAdd(); });

// ── Delete ──
function openConfirm(title, text, okLabel, danger, fn) {
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  const ok = $('confirm-ok');
  ok.textContent = okLabel;
  ok.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');
  confirmFn = fn;
  $('confirm').classList.add('open');
}

function closeConfirm() {
  $('confirm').classList.remove('open');
  confirmFn = null;
}

async function runConfirm() {
  const fn = confirmFn;
  closeConfirm();
  if (fn) await fn();
}

function askDelete(id) {
  const l = leads.find(x => x.id === id);
  if (!l) return;
  openConfirm(t('deleteTitle'), t('deleteText', domain(l.url)), t('delete'), true, async () => {
    await apiDelete(id);
    if (quoteLeadId === id) { quoteDraft = null; quoteLeadId = null; }
    if (outreachLeadId === id) { clearTimeout(outreachSaveTimer); outreachPending = null; outreachDraft = null; outreachLeadId = null; }
    if (['detail', 'quote', 'outreach'].includes(view) && currentId === id) location.hash = '#/';
    await apiLoad();
    toast(t('toastRemoved'), '');
  });
}

// ── Add / edit modal ──
function openModal() {
  editingId = null;
  $('modal-title').textContent = t('addLeadModal');
  $('modal-save').textContent = t('create');
  $('modal-url').value = '';
  $('modal-name').value = '';
  $('modal-email').value = '';
  $('modal-phone').value = '';
  $('modal-status').value = 'new';
  $('modal-notes').value = '';
  $('modal').classList.add('open');
  setTimeout(() => $('modal-url').focus(), 50);
}

function openEdit(id) {
  const lead = leads.find(l => l.id === id);
  if (!lead) return;
  editingId = id;
  $('modal-title').textContent = t('editLead');
  $('modal-save').textContent = t('saveChanges');
  $('modal-url').value = lead.url;
  $('modal-name').value = lead.name;
  $('modal-email').value = lead.email || '';
  $('modal-phone').value = lead.phone || '';
  $('modal-status').value = lead.status;
  $('modal-notes').value = lead.notes;
  $('modal').classList.add('open');
  setTimeout(() => $('modal-name').focus(), 50);
}

function closeModal() {
  $('modal').classList.remove('open');
  editingId = null;
}

async function saveModal() {
  const url = normalize($('modal-url').value);
  if (!url) { toast(t('toastNeedUrl'), 'error'); return; }
  const name = $('modal-name').value.trim();
  const status = $('modal-status').value;
  const notes = $('modal-notes').value.trim();
  const email = $('modal-email').value.trim();
  const phone = $('modal-phone').value.trim();

  if (editingId) {
    await saveLead(editingId, { url, name, status, notes, email, phone });
    toast(t('toastUpdated'), 'success');
  } else {
    await apiAdd({ id: uid(), url, name, status, notes, email, phone, created: Date.now() });
    toast(t('toastAdded'), 'success');
  }
  closeModal();
  await apiLoad();
}

// ── Keyboard ──
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeModal(); closeConfirm(); closeSchedule(); return; }
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  if (e.key === '/' && !typing && view === 'list') { e.preventDefault(); $('search-input').focus(); }
  if (e.key === 'Enter' && $('modal').classList.contains('open') && document.activeElement.tagName === 'INPUT') saveModal();
});

// ── Export ──
function exportCSV() {
  if (!leads.length) { toast(t('toastExportEmpty'), 'error'); return; }
  const rows = [['URL', 'Company', 'Email', 'Phone', 'Status', 'Notes', 'Added']];
  leads.forEach(l => rows.push([l.url, l.name, l.email, l.phone, l.status, l.notes, fmtDate(l.created)]));
  const csv = rows.map(r => r.map(c => '"' + (c || '').replace(/"/g, '""') + '"').join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'leads.csv';
  a.click();
  toast(t('toastExported'), 'success');
}

// ── Toast ──
function toast(msg, type) {
  const el = document.createElement('div');
  el.className = 'toast ' + (type || '');
  const icon = type === 'success' ? 'fa-circle-check' : type === 'error' ? 'fa-circle-exclamation' : 'fa-circle-info';
  el.innerHTML = '<i class="fa-solid ' + icon + '"></i><span>' + esc(msg) + '</span>';
  $('toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 200); }, 3200);
}

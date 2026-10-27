// ── Find leads: discover local businesses with a website (OpenStreetMap) ──
let discoverArea = '';
let discoverType = 'all';
let discoverLoading = false;
let discoverError = null;
let discoverResult = null;             // { area: {query, displayName}, count, results: [...] }
let discoverAdding = false;
const discoverSelected = new Set();    // hostnames the user has ticked

const DISCOVER_TYPES = ['all', 'shop', 'food', 'craft', 'office', 'health'];

function hostOf(url) { return domain(url).toLowerCase(); }

function isExistingLead(url) {
  const h = hostOf(url);
  return leads.some(l => domain(l.url).toLowerCase() === h);
}

async function runDiscover() {
  const area = $('discover-area').value.trim();
  if (!area) { toast(t('discNeedArea'), 'error'); $('discover-area').focus(); return; }
  discoverArea = area;
  discoverLoading = true;
  discoverError = null;
  discoverResult = null;
  discoverSelected.clear();
  render();
  try {
    const res = await fetch('/api/discover?area=' + encodeURIComponent(area) + '&type=' + encodeURIComponent(discoverType));
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      discoverError = t('discErr_' + (data.error || 'failed'));
    } else {
      discoverResult = data;
      // Pre-tick every result that isn't already a lead
      data.results.forEach(r => { if (!isExistingLead(r.url)) discoverSelected.add(hostOf(r.url)); });
    }
  } catch {
    discoverError = t('discErr_failed');
  }
  discoverLoading = false;
  render();
}

function setDiscoverType(k) { discoverType = k; render(); }

function toggleDiscover(host) {
  if (discoverSelected.has(host)) discoverSelected.delete(host);
  else discoverSelected.add(host);
  render();
}

function selectAllDiscover(on) {
  discoverSelected.clear();
  if (on && discoverResult) {
    discoverResult.results.forEach(r => { if (!isExistingLead(r.url)) discoverSelected.add(hostOf(r.url)); });
  }
  render();
}

function discoverNote(r) {
  const parts = [];
  if (r.category) parts.push(r.category);
  parts.push(t('discFoundVia', discoverResult.area.query));
  return parts.join(' · ');
}

async function addDiscovered(which) {
  if (!discoverResult || discoverAdding) return;
  let picks = discoverResult.results.filter(r => !isExistingLead(r.url));
  if (which === 'selected') picks = picks.filter(r => discoverSelected.has(hostOf(r.url)));
  if (!picks.length) { toast(t('discNonePicked'), 'error'); return; }

  discoverAdding = true;
  render();
  const now = Date.now();
  for (let i = 0; i < picks.length; i++) {
    const r = picks[i];
    await apiAdd({ id: uid(), url: r.url, name: r.name || '', status: 'new', notes: discoverNote(r), email: r.email || '', phone: r.phone || '', created: now + i });
  }
  discoverAdding = false;
  await apiLoad(); // reloads leads and re-renders; added sites now show as "already a lead"
  toast(t('discAdded', picks.length), 'success');
}

function discoverRow(r) {
  const host = hostOf(r.url);
  const exists = isExistingLead(r.url);
  const checked = discoverSelected.has(host);
  const meta = [r.category, r.phone, r.city].filter(Boolean).map(esc).join(' · ');
  return '<tr class="row"' + (exists ? '' : ' onclick="toggleDiscover(\'' + esc(host) + '\')"') + '>' +
    '<td style="width:34px">' + (exists
      ? '<i class="fa-solid fa-check" style="color:var(--green)"></i>'
      : '<input type="checkbox"' + (checked ? ' checked' : '') + ' onclick="event.stopPropagation();toggleDiscover(\'' + esc(host) + '\')">') + '</td>' +
    '<td><div class="site">' + favicon(r.url) + '<div style="min-width:0">' +
      '<div class="site-domain">' + esc(r.name || host) + '</div>' +
      '<div class="site-sub">' + esc(host) + (meta ? ' · ' + meta : '') + '</div></div></div></td>' +
    '<td style="text-align:right">' + (exists
      ? '<span class="scan-pill none">' + esc(t('discAlready')) + '</span>'
      : '<a class="link" href="' + esc(r.url) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">' + esc(t('open')) + ' <i class="fa-solid fa-arrow-up-right-from-square" style="font-size:10px"></i></a>') +
    '</td></tr>';
}

function renderDiscover() {
  const el = $('view-discover');
  const restore = captureFocus();

  const typeSeg = '<div class="seg">' + DISCOVER_TYPES.map(k =>
    '<button class="' + (discoverType === k ? 'active' : '') + '" onclick="setDiscoverType(\'' + k + '\')">' + esc(t('discType_' + k)) + '</button>'
  ).join('') + '</div>';

  let html = '<div class="page-head"><div>' +
    '<h1 class="page-title">' + esc(t('discover')) + '</h1>' +
    '<p class="page-sub">' + esc(t('discoverSub')) + '</p></div></div>';

  html += '<div class="card quick">' +
    '<div class="q-url"><i class="fa-solid fa-location-dot"></i>' +
    '<input type="text" id="discover-area" value="' + esc(discoverArea) + '" placeholder="' + esc(t('discAreaPh')) + '" autocomplete="off" oninput="discoverArea=this.value" onkeydown="if(event.key===\'Enter\')runDiscover()"></div>' +
    '<div class="divider"></div>' + typeSeg +
    '<button class="btn btn-primary" onclick="runDiscover()"' + (discoverLoading ? ' disabled' : '') + '>' +
      (discoverLoading ? '<span class="spin"></span>' + esc(t('discSearching')) : '<i class="fa-solid fa-magnifying-glass"></i>' + esc(t('discSearch'))) +
    '</button></div>';

  const emptyCard = (icon, title, hint) => '<div class="card empty"><div class="empty-icon"><i class="fa-solid ' + icon + '"></i></div><h3>' + esc(title) + '</h3><p>' + esc(hint) + '</p></div>';

  if (discoverLoading) {
    html += emptyCard('fa-satellite-dish', t('discSearchingTitle'), t('discSearchingHint'));
  } else if (discoverError) {
    html += emptyCard('fa-triangle-exclamation', t('discErrorTitle'), discoverError);
  } else if (discoverResult) {
    const results = discoverResult.results;
    if (!results.length) {
      html += emptyCard('fa-magnifying-glass', t('discNoneTitle'), t('discNoneHint'));
    } else {
      const newOnes = results.filter(r => !isExistingLead(r.url));
      const selCount = newOnes.filter(r => discoverSelected.has(hostOf(r.url))).length;
      const allNewPicked = newOnes.length > 0 && selCount === newOnes.length;

      html += '<div class="card"><div class="table-tools">' +
        '<div style="font-size:13px;color:var(--muted)">' + esc(t('discFound', results.length, esc(discoverResult.area.displayName))) + '</div>' +
        '<div class="row-actions-static">' +
        (newOnes.length ? '<button class="btn btn-ghost btn-sm" onclick="selectAllDiscover(' + (allNewPicked ? 'false' : 'true') + ')">' + esc(allNewPicked ? t('discSelectNone') : t('discSelectAll')) + '</button>' : '') +
        '<button class="btn btn-primary btn-sm" onclick="addDiscovered(\'selected\')"' + (discoverAdding || !selCount ? ' disabled' : '') + '>' +
          (discoverAdding ? '<span class="spin"></span>' : '<i class="fa-solid fa-plus"></i>') + esc(t('discAddSelected', selCount)) + '</button>' +
        '</div></div>' +
        '<div class="table-scroll"><table><tbody>' + results.map(discoverRow).join('') + '</tbody></table></div></div>';
    }
  } else {
    html += emptyCard('fa-map-location-dot', t('discStartTitle'), t('discStartHint'));
  }

  el.innerHTML = '<div class="doc-stack fade-in">' + html + '</div>';
  restore();
}

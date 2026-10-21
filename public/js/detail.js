// ── Detail page ──
const techIcon = {
  'WordPress': 'fa-brands fa-wordpress', 'PHP': 'fa-brands fa-php',
  'jQuery': 'fa-brands fa-js', 'Bootstrap': 'fa-brands fa-bootstrap',
  'SSL/HTTPS': 'fa-solid fa-lock-open', 'Apache': 'fa-solid fa-server',
  'Nginx': 'fa-solid fa-server', 'Microsoft IIS': 'fa-solid fa-server',
  'ASP.NET': 'fa-solid fa-code', 'Drupal': 'fa-solid fa-cube',
  'Joomla': 'fa-solid fa-cube', 'Security Headers': 'fa-solid fa-shield-halved',
  'SSL Certificate': 'fa-solid fa-certificate', 'Copyright': 'fa-regular fa-copyright',
  'Mobile': 'fa-solid fa-mobile-screen', 'SEO': 'fa-solid fa-magnifying-glass-chart',
  'Privacy': 'fa-solid fa-user-shield', 'Cookies': 'fa-solid fa-cookie-bite',
  'Performance': 'fa-solid fa-gauge-high', 'Availability': 'fa-solid fa-plug-circle-xmark',
};

// Findings about the site itself rather than a piece of software
const NON_TECH = ['Availability', 'Security Headers','SSL/HTTPS', 'SSL Certificate', 'Copyright', 'Mobile', 'SEO', 'Privacy', 'Cookies', 'Performance'];

function contactCard(l) {
  const c = (l.scanResult && l.scanResult.contact) || {};
  const id = esc(l.id);
  const others = (c.emails || []).filter(e => e !== l.email).slice(0, 4);
  const socials = c.socials || {};
  const socialIcons = [['linkedin', 'fa-linkedin'], ['facebook', 'fa-facebook'], ['instagram', 'fa-instagram']]
    .filter(([k]) => socials[k])
    .map(([k, icon]) => '<a class="icon-btn" href="' + esc(socials[k]) + '" target="_blank" rel="noopener" title="' + k + '"><i class="fa-brands ' + icon + '"></i></a>').join('');
  const dash = '<span class="dash">—</span>';

  return '<div class="card"><div class="card-head"><div class="card-title">' + esc(t('contact')) + '</div>' +
    '<button class="btn btn-ghost btn-sm" onclick="openEdit(\'' + id + '\')"><i class="fa-solid fa-pen"></i>' + esc(t('edit')) + '</button></div>' +
    '<div class="card-body kv" style="padding-top:4px;padding-bottom:4px">' +
      kvRow(t('sEmail'), l.email ? '<a class="link" href="mailto:' + esc(l.email) + '">' + esc(l.email) + '</a>' : dash) +
      kvRow(t('sPhone'), l.phone ? '<a class="link" href="tel:' + esc(l.phone) + '">' + esc(l.phone) + '</a>' : dash) +
      (c.kvk ? kvRow(t('sKvk'), '<a class="link" href="https://www.kvk.nl/zoeken/?source=all&q=' + esc(c.kvk) + '" target="_blank" rel="noopener">' + esc(c.kvk) + '</a>') : '') +
      (socialIcons ? kvRow(t('socials'), '<span style="display:inline-flex;gap:2px">' + socialIcons + '</span>') : '') +
      (c.contactPage ? kvRow(t('contactPage'), '<a class="link" href="' + esc(c.contactPage) + '" target="_blank" rel="noopener">' + esc(t('open')) + ' <i class="fa-solid fa-arrow-up-right-from-square" style="font-size:10px"></i></a>') : '') +
    '</div>' +
    (others.length ? '<div class="card-body" style="border-top:1px solid var(--border);padding-top:12px"><div class="hint" style="margin-bottom:6px">' + esc(t('otherEmails')) + '</div>' +
      others.map(e => '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12.5px;padding:3px 0"><span style="overflow:hidden;text-overflow:ellipsis">' + esc(e) + '</span>' +
        '<button class="btn btn-ghost btn-sm" onclick="useEmail(\'' + id + '\', \'' + esc(e) + '\')">' + esc(t('useThis')) + '</button></div>').join('') + '</div>' : '') +
    (!l.email && !l.phone && l.scanResult ? '<div class="card-body hint" style="border-top:1px solid var(--border)">' + esc(t('noContactFound')) + '</div>' : '') +
    '</div>';
}

async function useEmail(id, email) {
  await saveLead(id, { email });
  render();
  toast(t('toastUpdated'), 'success');
}

function sevLabel(s) { return s === 'critical' ? t('critical') : s === 'warning' ? t('warning') : t('info'); }

function renderDetail() {
  const el = $('view-detail');
  const l = leads.find(x => x.id === currentId);

  if (!l) {
    el.innerHTML = loaded
      ? '<div class="card empty fade-in"><div class="empty-icon"><i class="fa-solid fa-ghost"></i></div><h3>' + esc(t('notFound')) + '</h3><p>' + esc(t('notFoundHint')) + '</p>' +
        '<a class="btn btn-secondary" href="#/"><i class="fa-solid fa-arrow-left"></i>' + esc(t('backToLeads')) + '</a></div>'
      : '';
    return;
  }

  // Keep an in-progress notes edit across re-renders (e.g. when a scan finishes)
  const notesEl = $('detail-notes');
  const notesDraft = notesEl && document.activeElement === notesEl ? notesEl.value : null;

  const id = esc(l.id);
  const st = scanState(l);
  const sr = l.scanResult;
  const findings = st === 'done' ? sr.findings : [];
  const c = countFindings(findings);
  const busy = st === 'scanning';
  const nextStep = nextStepFor(l);

  // Hero
  let html = '<div class="hero fade-in"><div class="hero-left">' + favicon(l.url, true) + '<div style="min-width:0">' +
    '<h1 class="hero-title">' + esc(domain(l.url)) + badge(l.status) + '</h1>' +
    '<div class="hero-meta"><a href="' + esc(l.url) + '" target="_blank" rel="noopener"><i class="fa-solid fa-arrow-up-right-from-square"></i>' + esc(l.url) + '</a>' +
    (l.name ? '<span><i class="fa-solid fa-building"></i>' + esc(l.name) + '</span>' : '') + '</div></div></div>' +
    '<div class="head-actions" style="align-items:center">' +
      '<button class="icon-btn danger" title="' + esc(t('delete')) + '" onclick="askDelete(\'' + id + '\')"><i class="fa-solid fa-trash-can"></i></button>' +
      '<button class="icon-btn" title="' + esc(t('edit')) + '" onclick="openEdit(\'' + id + '\')"><i class="fa-solid fa-pen"></i></button>' +
      (st === 'done' ? '<button class="icon-btn" title="' + esc(t('copyReport')) + '" onclick="copyReport()"><i class="fa-regular fa-copy"></i></button>' +
                       '<button class="icon-btn" title="' + esc(t('downloadPdf')) + '" onclick="downloadPdf()"><i class="fa-solid fa-file-pdf"></i></button>' : '') +
      '<button class="btn ' + (nextStep === 'scan' ? 'btn-primary' : 'btn-secondary') + '" onclick="scanLead(\'' + id + '\')"' + (busy ? ' disabled' : '') + '>' +
        (busy ? '<span class="spin"></span>' + esc(t('scanning')) : '<i class="fa-solid fa-rotate"></i>' + esc(st === 'none' ? t('scanNow') : t('rescan'))) + '</button>' +
      '<a class="btn ' + (nextStep === 'outreach' ? 'btn-primary' : 'btn-secondary') + '" href="#/lead/' + encodeURIComponent(l.id) + '/outreach"><i class="fa-solid fa-wand-magic-sparkles"></i>' +
        esc(outreachDone(l) ? t('openOutreach') : t('writeOutreach')) + '</a>' +
      '<a class="btn ' + (nextStep === 'quote' ? 'btn-primary' : 'btn-secondary') + '" href="#/lead/' + encodeURIComponent(l.id) + '/quote"><i class="fa-solid fa-file-invoice"></i>' +
        esc(l.quote ? t('openQuote') : t('createQuote')) + '</a>' +
    '</div></div>';

  // Main column
  let main = '';
  if (st === 'none') {
    main = '<div class="card empty"><div class="empty-icon"><i class="fa-solid fa-satellite-dish"></i></div><h3>' + esc(t('notScannedTitle')) + '</h3><p>' + esc(t('notScannedHint')) + '</p>' +
      '<button class="btn btn-primary" onclick="scanLead(\'' + id + '\')"><i class="fa-solid fa-play"></i>' + esc(t('scanNow')) + '</button></div>';
  } else if (st === 'scanning') {
    main = '<div class="card"><div class="summary"><div class="empty-icon" style="margin:0;color:var(--accent-2)"><span class="spin lg"></span></div>' +
      '<div class="summary-text"><div class="h">' + esc(t('scanningTitle')) + '</div><div class="s">' + esc(t('scanningHint')) + '</div></div></div></div>' +
      '<div class="card"><div class="card-body" style="display:flex;flex-direction:column;gap:14px">' +
      [80, 60, 72, 45].map(w => '<div class="skel" style="width:' + w + '%"></div>').join('') + '</div></div>';
  } else if (st === 'error') {
    main = '<div class="card card-body"><div class="alert err"><i class="fa-solid fa-circle-exclamation" style="margin-top:3px"></i><div><div style="font-weight:600;color:var(--text);margin-bottom:2px">' +
      esc(t('scanErrorTitle')) + '</div>' + esc(sr.error || t('toastScanFail')) + '</div></div>' +
      '<div style="margin-top:14px"><button class="btn btn-secondary" onclick="scanLead(\'' + id + '\')"><i class="fa-solid fa-rotate"></i>' + esc(t('retry')) + '</button></div></div>';
  } else {
    const score = healthScore(findings);
    const verdict = score >= 80 ? t('healthGood') : score >= 50 ? t('healthMid') : t('healthBad');
    main += '<div class="card"><div class="summary">' +
      '<div class="ring" style="--p:' + score + ';--c:' + healthColor(score) + '" title="' + esc(t('healthScore')) + '"><div class="ring-inner"><div><div class="ring-val">' + score + '</div><div class="ring-max">/ 100</div></div></div></div>' +
      '<div class="summary-text"><div class="h">' + esc(verdict) + '</div><div class="s">' + esc(t('healthSummary', c.critical, c.warning)) + '<br>' + esc(t('lastScanned')) + ': ' + esc(fmtDateTime(sr.scannedAt)) + '</div></div>' +
      '<div class="counts">' +
        countBox(c.critical, t('criticalPl'), 'var(--red)') +
        countBox(c.warning, t('warningPl'), 'var(--amber)') +
        countBox(c.info, t('info'), 'var(--blue)') +
      '</div></div></div>';

    const shown = sevFilter === 'all' ? findings : findings.filter(f => f.severity === sevFilter);
    const segBtn = (k, label, n) => '<button class="' + (sevFilter === k ? 'active' : '') + '" onclick="setSevFilter(\'' + k + '\')">' + esc(label) + '<span class="n">' + n + '</span></button>';

    main += '<div class="card"><div class="card-head"><div class="card-title">' + esc(t('findings')) + '</div>' +
      (findings.length ? '<div class="seg small">' + segBtn('all', t('all'), findings.length) + segBtn('critical', t('critical'), c.critical) + segBtn('warning', t('warning'), c.warning) + segBtn('info', t('info'), c.info) + '</div>' : '') +
      '</div>';

    if (!findings.length) {
      main += '<div class="empty"><div class="empty-icon" style="color:var(--green)"><i class="fa-solid fa-shield-heart"></i></div><h3>' + esc(t('noIssues')) + '</h3><p>' + esc(t('noIssuesHint')) + '</p></div>';
    } else if (!shown.length) {
      main += '<div class="card-body muted-note">' + esc(t('noFindingsFilter')) + '</div>';
    } else {
      main += shown.map(f => {
        const ft = findingText(f, lang);
        const hasVer = f.version && f.version !== 'detected';
        return '<div class="finding">' +
          '<div class="f-icon sev-' + f.severity + '"><i class="' + (techIcon[f.tech] || 'fa-solid fa-circle-dot') + '"></i></div>' +
          '<div class="f-body"><div class="f-row"><span class="f-title">' + esc(ft.title) + '</span><span class="sev sev-' + f.severity + '">' + esc(sevLabel(f.severity)) + '</span></div>' +
          '<div class="f-tech">' + esc(f.tech) + '</div>' +
          '<div class="f-desc">' + esc(ft.description) + '</div>' +
          (ft.opportunity && f.severity !== 'info' ? '<div class="f-rec"><i class="fa-solid fa-lightbulb"></i><span>' + esc(ft.opportunity) + '</span></div>' : '') +
          '</div>' +
          (hasVer ? '<span class="f-ver" title="' + esc(t('version')) + '">v' + esc(f.version) + '</span>' : '') +
        '</div>';
      }).join('');
    }
    main += '</div>';
  }

  // Side column
  const statusOpts = ['new', 'contacted', 'qualified', 'rejected'].map(s =>
    '<option value="' + s + '"' + (l.status === s ? ' selected' : '') + '>' + esc(t('status' + s[0].toUpperCase() + s.slice(1))) + '</option>').join('');

  let side = stepsCard(l) + quoteCard(l) + '<div class="card"><div class="card-head"><div class="card-title">' + esc(t('details')) + '</div></div><div class="card-body kv" style="padding-top:4px;padding-bottom:4px">' +
    kvRow(t('status'), '<select onchange="setStatus(\'' + id + '\', this.value)">' + statusOpts + '</select>') +
    kvRow(t('company'), l.name ? esc(l.name) : '<span class="dash">—</span>') +
    kvRow(t('added'), esc(fmtDate(l.created))) +
    kvRow(t('lastScanned'), st === 'done' || st === 'error' ? esc(fmtDateTime(sr.scannedAt)) : '<span class="dash">' + esc(t('never')) + '</span>') +
    '</div></div>' + contactCard(l);

  if (st === 'done') {
    const opps = findings.filter(f => f.severity !== 'info').map(f => findingText(f, lang).opportunity).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
    side += '<div class="card"><div class="card-head"><div class="card-title"><i class="fa-solid fa-lightbulb" style="color:var(--accent-2);font-size:12px"></i>' + esc(t('opportunities')) + '</div></div><div class="card-body">' +
      (opps.length ? '<ol class="opps">' + opps.map((o, i) => '<li><span class="num">' + (i + 1) + '</span><span>' + esc(o) + '</span></li>').join('') + '</ol>'
                   : '<div class="muted-note">' + esc(t('noOpportunities')) + '</div>') + '</div></div>';

    const seen = new Set();
    const techs = findings.filter(f => !NON_TECH.includes(f.tech) && !seen.has(f.tech) && seen.add(f.tech));
    side += '<div class="card"><div class="card-head"><div class="card-title">' + esc(t('techDetected')) + '</div></div><div class="card-body">' +
      (techs.length ? '<div class="tech-pills">' + techs.map(f => {
        const old = f.severity === 'critical' || f.severity === 'warning';
        const v = f.version && f.version !== 'detected' ? '<span class="v">' + esc(f.version) + '</span>' : '';
        return '<span class="tech' + (old ? ' old' : '') + '"><i class="' + (techIcon[f.tech] || 'fa-solid fa-circle-dot') + '"></i>' + esc(f.tech) + v + '</span>';
      }).join('') + '</div>' : '<div class="muted-note">' + esc(t('noTech')) + '</div>') + '</div></div>';
  }

  side += '<div class="card"><div class="card-head"><div class="card-title">' + esc(t('notes')) + '</div><span class="saved-hint">' + esc(t('savedAuto')) + '</span></div><div class="card-body">' +
    '<textarea id="detail-notes" placeholder="' + esc(t('notesPlaceholder')) + '" onblur="saveNotes(\'' + id + '\', this.value)">' + esc(l.notes) + '</textarea></div></div>';

  html += '<div class="detail-grid"><div class="stack">' + main + '</div><div class="stack">' + side + '</div></div>';
  el.innerHTML = html;

  if (notesDraft !== null) {
    const n = $('detail-notes');
    n.value = notesDraft;
    n.focus();
    n.setSelectionRange(n.value.length, n.value.length);
  }
}

function countBox(v, label, color) {
  return '<div class="count"><div class="v">' + v + '</div><div class="l"><span class="dot" style="background:' + color + '"></span>' + esc(label) + '</div></div>';
}

function kvRow(k, v) {
  return '<div class="kv-row"><span class="k">' + esc(k) + '</span><span class="v">' + v + '</span></div>';
}

function setSevFilter(f) { sevFilter = f; render(); }

async function setStatus(id, status) {
  await saveLead(id, { status });
  render();
  toast(t('toastUpdated'), 'success');
}

async function saveNotes(id, notes) {
  const l = leads.find(x => x.id === id);
  if (!l || (l.notes || '') === notes.trim()) return;
  await saveLead(id, { notes: notes.trim() });
  toast(t('toastNotesSaved'), 'success');
}

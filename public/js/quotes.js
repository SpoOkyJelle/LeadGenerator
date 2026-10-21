// ── Quotes ──
function todayISO() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function parseISODate(iso) {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  return y && m && d ? new Date(y, m - 1, d) : new Date();
}

function addDays(iso, n) {
  const d = parseISODate(iso);
  d.setDate(d.getDate() + (Number(n) || 0));
  return d;
}

function fmtLong(d) {
  return d.toLocaleDateString(lang === 'nl' ? 'nl-NL' : 'en-US', { day: 'numeric', month: 'long', year: 'numeric' });
}

function quoteTotals(q) {
  const sub = (q.items || []).reduce((a, i) => a + (i.include ? (Number(i.hours) || 0) * (Number(i.rate) || 0) : 0), 0);
  const vat = sub * (Number(q.vatRate) || 0) / 100;
  return { sub, vat, total: sub + vat };
}

// One line per technology with a problem (findings are sorted most severe first)
function buildItems(lead) {
  const items = [];
  const seen = new Set();
  if (scanState(lead) !== 'done') return items;
  lead.scanResult.findings.forEach(f => {
    if (f.severity === 'info' || seen.has(f.tech)) return;
    const def = SERVICE_DEFS.find(d => d.tech === f.tech);
    if (!def) return;
    seen.add(f.tech);
    items.push({
      id: uid(),
      description: serviceName(def),
      detail: findingText(f, lang).title,
      hours: hoursFor(f.tech),
      rate: Number(settings.hourlyRate) || 0,
      include: true,
    });
  });
  return items;
}

async function apiSaveQuote(leadId, q) {
  await fetch('/api/quotes/' + encodeURIComponent(leadId), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(q) });
}

async function apiDeleteQuote(leadId) {
  await fetch('/api/quotes/' + encodeURIComponent(leadId), { method: 'DELETE' });
}

async function createQuote(lead) {
  const n = Math.max(1, settings.nextQuoteNumber || 1);
  const q = {
    number: formatQuoteNumber(settings.quotePrefix, n),
    date: todayISO(),
    validDays: Number(settings.validDays) || 30,
    vatRate: Number(settings.vatRate) || 0,
    intro: settings.introText || t('defaultIntro'),
    terms: settings.termsText || t('defaultTerms'),
    items: buildItems(lead),
    created: Date.now(),
  };
  settings.nextQuoteNumber = n + 1;
  await apiSaveSettings();
  await apiSaveQuote(lead.id, q);
  lead.quote = q;
  if (!settingsDirty) settingsBuilt = false;
}

function setSaveState(s) {
  quoteSaveState = s;
  const el = $('q-save-state');
  if (el) el.innerHTML = saveStateHtml();
}

function saveStateHtml() {
  return quoteSaveState === 'saving'
    ? '<span class="spin"></span>' + esc(t('saving'))
    : '<i class="fa-solid fa-check"></i>' + esc(t('saved'));
}

function scheduleQuoteSave() {
  const leadId = quoteLeadId, q = quoteDraft;
  setSaveState('saving');
  clearTimeout(quoteSaveTimer);
  quotePending = async () => {
    quotePending = null;
    await apiSaveQuote(leadId, q);
    const l = leads.find(x => x.id === leadId);
    if (l) l.quote = JSON.parse(JSON.stringify(q));
    setSaveState('saved');
  };
  quoteSaveTimer = setTimeout(() => quotePending && quotePending(), 600);
}

async function flushQuoteSave() {
  clearTimeout(quoteSaveTimer);
  if (quotePending) await quotePending();
}

// Keep focus/cursor when the quote page re-renders
function captureFocus() {
  const a = document.activeElement;
  if (!a || !a.id) return () => {};
  const id = a.id;
  let s = null, e = null;
  try { s = a.selectionStart; e = a.selectionEnd; } catch {}
  return () => {
    const n = $(id);
    if (!n) return;
    n.focus();
    try { if (s !== null) n.setSelectionRange(s, e); } catch {}
  };
}

function quoteCard(l) {
  if (!l.quote) return '';
  const tot = quoteTotals(l.quote);
  return '<a class="card quote-card" href="#/lead/' + encodeURIComponent(l.id) + '/quote"><div class="card-body" style="display:flex;align-items:center;gap:12px">' +
    '<div class="stat-icon tone-accent" style="width:36px;height:36px;font-size:14px"><i class="fa-solid fa-file-invoice"></i></div>' +
    '<div style="flex:1;min-width:0"><div style="font-weight:600;font-size:13.5px">' + esc(t('quote')) + ' ' + esc(l.quote.number) + '</div>' +
    '<div class="site-sub">' + esc(fmtLong(parseISODate(l.quote.date))) + '</div></div>' +
    '<div style="font-weight:600;font-variant-numeric:tabular-nums">' + money(tot.total) + '</div></div></a>';
}

function qRow(i) {
  const id = i.id;
  const call = (key, val) => 'qItem(\'' + id + '\',\'' + key + '\',' + val + ')';
  return '<tr data-qid="' + id + '"' + (i.include ? '' : ' class="off"') + '>' +
    '<td><input type="checkbox" id="q-inc-' + id + '"' + (i.include ? ' checked' : '') + ' onchange="' + call('include', 'this.checked') + '"></td>' +
    '<td style="min-width:240px"><input class="cell" id="q-desc-' + id + '" value="' + esc(i.description) + '" oninput="' + call('description', 'this.value') + '">' +
      '<input class="cell sub" id="q-det-' + id + '" value="' + esc(i.detail) + '" placeholder="' + esc(t('detailPh')) + '" oninput="' + call('detail', 'this.value') + '"></td>' +
    '<td style="text-align:right"><input class="cell num" type="number" min="0" step="0.25" id="q-h-' + id + '" value="' + esc(i.hours) + '" oninput="' + call('hours', 'this.value') + '"></td>' +
    '<td style="text-align:right"><div class="input-affix" style="margin-left:auto"><span>€</span><input class="cell num" type="number" min="0" step="1" id="q-r-' + id + '" value="' + esc(i.rate) + '" oninput="' + call('rate', 'this.value') + '"></div></td>' +
    '<td class="amt" id="amt-' + id + '">' + money((Number(i.hours) || 0) * (Number(i.rate) || 0)) + '</td>' +
    '<td><button class="icon-btn danger" title="' + esc(t('delete')) + '" onclick="qRemove(\'' + id + '\')"><i class="fa-solid fa-xmark"></i></button></td></tr>';
}

function renderQuote() {
  const el = $('view-quote');
  const l = currentLead();

  if (!l) {
    el.innerHTML = loaded
      ? '<div class="card empty fade-in"><div class="empty-icon"><i class="fa-solid fa-ghost"></i></div><h3>' + esc(t('notFound')) + '</h3><p>' + esc(t('notFoundHint')) + '</p>' +
        '<a class="btn btn-secondary" href="#/"><i class="fa-solid fa-arrow-left"></i>' + esc(t('backToLeads')) + '</a></div>'
      : '';
    return;
  }

  if (!quoteDraft || quoteLeadId !== l.id) {
    if (l.quote) {
      quoteDraft = JSON.parse(JSON.stringify(l.quote));
      quoteLeadId = l.id;
    } else {
      if (loaded && !quoteCreating) {
        quoteCreating = true;
        createQuote(l).then(
          () => { quoteCreating = false; render(); },
          () => { quoteCreating = false; toast(t('toastQuoteFail'), 'error'); }
        );
      }
      el.innerHTML = '';
      return;
    }
  }

  const q = quoteDraft;
  const tot = quoteTotals(q);
  const restore = captureFocus();
  const qf = (label, ctl) => '<div class="field"><label>' + esc(label) + '</label>' + ctl + '</div>';

  let html = '<div class="hero fade-in"><div class="hero-left">' + favicon(l.url, true) + '<div style="min-width:0">' +
    '<h1 class="hero-title">' + esc(t('quote')) + ' <span style="color:var(--text-2);font-weight:500" id="q-num-title">' + esc(q.number) + '</span></h1>' +
    '<div class="hero-meta"><span><i class="fa-solid fa-building"></i>' + esc(l.name || domain(l.url)) + '</span>' +
    '<a href="' + esc(l.url) + '" target="_blank" rel="noopener"><i class="fa-solid fa-arrow-up-right-from-square"></i>' + esc(domain(l.url)) + '</a></div></div></div>' +
    '<div class="head-actions" style="align-items:center">' +
      '<span class="save-state" id="q-save-state">' + saveStateHtml() + '</span>' +
      '<button class="icon-btn danger" title="' + esc(t('deleteQuote')) + '" onclick="askDeleteQuote()"><i class="fa-solid fa-trash-can"></i></button>' +
      (scanState(l) === 'done' ? '<button class="btn btn-secondary" onclick="askRebuildQuote()"><i class="fa-solid fa-wand-magic-sparkles"></i>' + esc(t('rebuild')) + '</button>' : '') +
      '<button class="btn btn-primary" onclick="downloadQuotePdf()"><i class="fa-solid fa-file-pdf"></i>' + esc(t('downloadPdf')) + '</button>' +
    '</div></div>';

  if (!settings.companyName) {
    html += '<div class="alert info"><i class="fa-solid fa-circle-info"></i><div style="flex:1">' + esc(t('setupBusiness')) + '</div>' +
      '<a class="btn btn-secondary btn-sm" href="#/settings">' + esc(t('goSettings')) + '</a></div>';
  }

  const main = '<div class="card"><div class="card-head"><div class="card-title">' + esc(t('quoteLines')) + ' <span class="n">' + q.items.length + '</span></div></div>' +
    '<div class="table-scroll"><table class="qtable"><thead><tr><th></th><th>' + esc(t('colDescription')) + '</th><th style="text-align:right">' + esc(t('colHours')) +
    '</th><th style="text-align:right">' + esc(t('colRate')) + '</th><th style="text-align:right">' + esc(t('colAmount')) + '</th><th></th></tr></thead><tbody>' +
    q.items.map(qRow).join('') + '</tbody></table></div>' +
    (q.items.length ? '' : '<div class="card-body muted-note">' + esc(t('noLines')) + '</div>') +
    '<div class="q-foot"><button class="btn btn-secondary btn-sm" onclick="qAdd()"><i class="fa-solid fa-plus"></i>' + esc(t('addLine')) + '</button>' +
      '<div class="totals">' +
        '<div class="tr"><span>' + esc(t('subtotal')) + '</span><span id="q-sub">' + money(tot.sub) + '</span></div>' +
        '<div class="tr"><span id="q-vat-label">' + esc(t('vat', q.vatRate)) + '</span><span id="q-vat">' + money(tot.vat) + '</span></div>' +
        '<div class="tr grand"><span>' + esc(t('total')) + '</span><span id="q-total">' + money(tot.total) + '</span></div>' +
      '</div></div></div>';

  // Laid out in the same order as the PDF: details → introduction → lines → terms
  const detailsCard =
    '<div class="card"><div class="card-head"><div class="card-title">' + esc(t('quoteDetails')) + '</div>' +
      '<span class="hint" id="qf-valid">' + esc(t('validUntil')) + ': ' + esc(fmtLong(addDays(q.date, q.validDays))) + '</span></div>' +
    '<div class="card-body"><div class="form-grid cols-4">' +
      qf(t('quoteNumber'), '<input id="qf-number" value="' + esc(q.number) + '" oninput="qField(\'number\', this.value)">') +
      qf(t('quoteDate'), '<input type="date" id="qf-date" value="' + esc(q.date) + '" oninput="qField(\'date\', this.value)">') +
      qf(t('sValidDays'), '<div class="input-affix suffix"><input type="number" min="0" id="qf-valid-days" value="' + esc(q.validDays) + '" oninput="qField(\'validDays\', this.value)"><span>' + esc(t('days')) + '</span></div>') +
      qf(t('sVatRate'), '<div class="input-affix suffix"><input type="number" min="0" step="1" id="qf-vat" value="' + esc(q.vatRate) + '" oninput="qField(\'vatRate\', this.value)"><span>%</span></div>') +
    '</div></div></div>';

  const textCard = (key, label, rows) =>
    '<div class="card"><div class="card-head"><div class="card-title">' + esc(label) + '</div></div>' +
    '<textarea class="doc-text bare" id="qf-' + key + '" rows="' + rows + '" oninput="qField(\'' + key + '\', this.value)">' + esc(q[key]) + '</textarea></div>';

  el.innerHTML = html + '<div class="stack doc-stack">' + detailsCard + textCard('intro', t('sIntro'), 5) + main + textCard('terms', t('sTerms'), 4) + '</div>';
  restore();
}

function updateQuoteTotals() {
  const q = quoteDraft;
  if (!q) return;
  q.items.forEach(i => {
    const c = $('amt-' + i.id);
    if (c) c.textContent = money((Number(i.hours) || 0) * (Number(i.rate) || 0));
  });
  const tot = quoteTotals(q);
  if ($('q-sub')) {
    $('q-sub').textContent = money(tot.sub);
    $('q-vat').textContent = money(tot.vat);
    $('q-total').textContent = money(tot.total);
  }
}

function qItem(id, key, val) {
  const it = quoteDraft && quoteDraft.items.find(x => x.id === id);
  if (!it) return;
  it[key] = key === 'hours' || key === 'rate' ? (parseFloat(val) || 0) : val;
  if (key === 'include') {
    const row = document.querySelector('tr[data-qid="' + id + '"]');
    if (row) row.classList.toggle('off', !val);
  }
  updateQuoteTotals();
  scheduleQuoteSave();
}

function qField(key, val) {
  if (!quoteDraft) return;
  quoteDraft[key] = key === 'validDays' || key === 'vatRate' ? (parseFloat(val) || 0) : val;
  if (key === 'vatRate') $('q-vat-label').textContent = t('vat', quoteDraft.vatRate);
  if (key === 'number') $('q-num-title').textContent = val;
  if (key === 'date' || key === 'validDays') $('qf-valid').textContent = t('validUntil') + ': ' + fmtLong(addDays(quoteDraft.date, quoteDraft.validDays));
  updateQuoteTotals();
  scheduleQuoteSave();
}

function qAdd() {
  const it = { id: uid(), description: t('newLine'), detail: '', hours: 1, rate: Number(settings.hourlyRate) || 0, include: true };
  quoteDraft.items.push(it);
  renderQuote();
  scheduleQuoteSave();
  const d = $('q-desc-' + it.id);
  if (d) { d.focus(); d.select(); }
}

function qRemove(id) {
  quoteDraft.items = quoteDraft.items.filter(i => i.id !== id);
  renderQuote();
  scheduleQuoteSave();
}

function askRebuildQuote() {
  const l = currentLead();
  if (!l || !quoteDraft) return;
  openConfirm(t('rebuildTitle'), t('rebuildText'), t('rebuildOk'), false, () => {
    quoteDraft.items = buildItems(l);
    renderQuote();
    scheduleQuoteSave();
  });
}

function askDeleteQuote() {
  const l = currentLead();
  if (!l) return;
  openConfirm(t('deleteQuoteTitle'), t('deleteQuoteText'), t('delete'), true, async () => {
    clearTimeout(quoteSaveTimer);
    quotePending = null;
    await apiDeleteQuote(l.id);
    l.quote = null;
    quoteDraft = null;
    quoteLeadId = null;
    quoteSaveState = 'saved';
    location.hash = '#/lead/' + encodeURIComponent(l.id);
    toast(t('toastQuoteDeleted'), '');
  });
}

function downloadQuotePdf() {
  const l = currentLead();
  if (!l || !quoteDraft) return;
  const win = window.open('', '_blank'); // open right away so the popup isn't blocked
  flushQuoteSave();
  win.document.write(generateQuoteHTML(l, quoteDraft));
  win.document.close();
  setTimeout(() => win.print(), 600);
}

function generateQuoteHTML(lead, q) {
  const nl = lang === 'nl';
  const s = settings;
  const loc = nl ? 'nl-NL' : 'en-US';
  const longDate = (d) => d.toLocaleDateString(loc, { day: 'numeric', month: 'long', year: 'numeric' });
  const tot = quoteTotals(q);
  const items = q.items.filter(i => i.include);
  const nl2br = (x) => esc(x).replace(/\n/g, '<br>');
  const fmtH = (h) => (Number(h) || 0).toLocaleString(loc, { maximumFractionDigits: 2 });
  const L = nl
    ? { quote: 'Offerte', number: 'Offertenummer', date: 'Datum', valid: 'Geldig tot', to: 'Aan', re: 'Betreft', reText: 'Onderhoud en beveiliging van ',
        desc: 'Omschrijving', hours: 'Uren', rate: 'Tarief', amount: 'Bedrag', sub: 'Subtotaal', vat: 'Btw', total: 'Totaal',
        terms: 'Voorwaarden', agree: 'Voor akkoord', behalf: 'Namens', name: 'Naam', sign: 'Handtekening', kvk: 'KvK', vatNo: 'Btw-nr.' }
    : { quote: 'Quote', number: 'Quote number', date: 'Date', valid: 'Valid until', to: 'To', re: 'Re', reText: 'Maintenance and security of ',
        desc: 'Description', hours: 'Hours', rate: 'Rate', amount: 'Amount', sub: 'Subtotal', vat: 'VAT', total: 'Total',
        terms: 'Terms', agree: 'Agreed', behalf: 'On behalf of', name: 'Name', sign: 'Signature', kvk: 'CoC', vatNo: 'VAT no.' };

  const contact = [s.email, s.phone, s.website].filter(Boolean).map(esc).join(' &middot; ');
  const legal = [s.kvk && L.kvk + ' ' + esc(s.kvk), s.vatNumber && L.vatNo + ' ' + esc(s.vatNumber), s.iban && 'IBAN ' + esc(s.iban)].filter(Boolean).join(' &middot; ');
  const line = '<div style="border-bottom:1px solid #d1d5db;height:28px;margin-bottom:10px"></div>';

  const rows = items.map(i => `
    <tr>
      <td style="padding:12px 0;border-bottom:1px solid #eef0f3">
        <div style="font-weight:600;color:#111827">${esc(i.description)}</div>
        ${i.detail ? `<div style="font-size:12px;color:#6b7280;margin-top:2px">${esc(i.detail)}</div>` : ''}
      </td>
      <td style="padding:12px 0;border-bottom:1px solid #eef0f3;text-align:right">${fmtH(i.hours)}</td>
      <td style="padding:12px 0;border-bottom:1px solid #eef0f3;text-align:right">${money(i.rate)}</td>
      <td style="padding:12px 0;border-bottom:1px solid #eef0f3;text-align:right;font-weight:600;color:#111827">${money((Number(i.hours) || 0) * (Number(i.rate) || 0))}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="${nl ? 'nl' : 'en'}">
<head>
<meta charset="UTF-8"/>
<title>${L.quote} ${esc(q.number)} — ${esc(lead.name || domain(lead.url))}</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; background: #f3f4f6; color: #374151; font-size: 13px; line-height: 1.5; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.page { max-width: 820px; margin: 32px auto; background: #fff; border-radius: 12px; box-shadow: 0 4px 24px rgba(0,0,0,.08); padding: 48px 52px; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.lbl { font-size: 10px; text-transform: uppercase; letter-spacing: .8px; color: #9ca3af; font-weight: 600; margin-bottom: 4px; }
@media print {
  body { background: #fff; }
  .page { max-width: 100%; margin: 0; border-radius: 0; box-shadow: none; padding: 0; }
  @page { margin: 16mm; size: A4; }
}
</style>
</head>
<body>
<div class="page">

<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:24px;padding-bottom:28px;border-bottom:3px solid #4f46e5">
  <div>
    <div style="font-size:20px;font-weight:800;color:#111827;letter-spacing:-.3px">${esc(s.companyName) || '&nbsp;'}</div>
    ${s.address ? `<div style="margin-top:6px;color:#6b7280">${nl2br(s.address)}</div>` : ''}
    ${contact ? `<div style="margin-top:4px;color:#6b7280">${contact}</div>` : ''}
  </div>
  <div style="text-align:right">
    <div style="font-size:28px;font-weight:800;color:#4f46e5;letter-spacing:-.5px;line-height:1">${L.quote.toUpperCase()}</div>
    <div style="margin-top:10px;font-size:12px;color:#6b7280">${L.number}: <strong style="color:#111827">${esc(q.number)}</strong></div>
    <div style="font-size:12px;color:#6b7280">${L.date}: <strong style="color:#111827">${longDate(parseISODate(q.date))}</strong></div>
    <div style="font-size:12px;color:#6b7280">${L.valid}: <strong style="color:#111827">${longDate(addDays(q.date, q.validDays))}</strong></div>
  </div>
</div>

<div style="display:flex;gap:48px;margin:28px 0">
  <div>
    <div class="lbl">${L.to}</div>
    <div style="font-weight:600;color:#111827;font-size:14px">${esc(lead.name || domain(lead.url))}</div>
    <div style="color:#6b7280">${esc(lead.url)}</div>
  </div>
  <div>
    <div class="lbl">${L.re}</div>
    <div style="color:#111827">${L.reText}${esc(domain(lead.url))}</div>
  </div>
</div>

${q.intro ? `<p style="margin-bottom:28px;color:#374151">${nl2br(q.intro)}</p>` : ''}

<table>
  <thead>
    <tr style="font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:#9ca3af">
      <th style="text-align:left;padding-bottom:8px;border-bottom:2px solid #e5e7eb">${L.desc}</th>
      <th style="text-align:right;padding-bottom:8px;border-bottom:2px solid #e5e7eb;width:70px">${L.hours}</th>
      <th style="text-align:right;padding-bottom:8px;border-bottom:2px solid #e5e7eb;width:100px">${L.rate}</th>
      <th style="text-align:right;padding-bottom:8px;border-bottom:2px solid #e5e7eb;width:110px">${L.amount}</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
</table>

<div style="display:flex;justify-content:flex-end;margin-top:16px;page-break-inside:avoid">
  <table style="width:280px">
    <tr><td style="padding:4px 0;color:#6b7280">${L.sub}</td><td style="padding:4px 0;text-align:right">${money(tot.sub)}</td></tr>
    <tr><td style="padding:4px 0;color:#6b7280">${L.vat} ${esc(q.vatRate)}%</td><td style="padding:4px 0;text-align:right">${money(tot.vat)}</td></tr>
    <tr><td style="padding:10px 0 0;border-top:2px solid #111827;font-weight:800;color:#111827;font-size:15px">${L.total}</td>
        <td style="padding:10px 0 0;border-top:2px solid #111827;text-align:right;font-weight:800;color:#4f46e5;font-size:17px">${money(tot.total)}</td></tr>
  </table>
</div>

${q.terms ? `
<div style="margin-top:36px;page-break-inside:avoid">
  <div class="lbl">${L.terms}</div>
  <div style="color:#6b7280;font-size:12px">${nl2br(q.terms)}</div>
</div>` : ''}

<div style="display:grid;grid-template-columns:1fr 1fr;gap:48px;margin-top:40px;page-break-inside:avoid">
  <div>
    <div class="lbl">${L.behalf} ${esc(s.companyName)}</div>
    <div style="margin-top:8px;color:#111827">${esc(s.contactName) || '&nbsp;'}</div>
    ${line}
  </div>
  <div>
    <div class="lbl">${L.agree} ${esc(lead.name || domain(lead.url))}</div>
    <div style="font-size:11px;color:#9ca3af;margin-top:8px">${L.name}</div>${line}
    <div style="font-size:11px;color:#9ca3af">${L.date}</div>${line}
    <div style="font-size:11px;color:#9ca3af">${L.sign}</div>${line}
  </div>
</div>

${legal ? `<div style="margin-top:40px;padding-top:14px;border-top:1px solid #e5e7eb;font-size:11px;color:#9ca3af;text-align:center">${legal}</div>` : ''}
</div>
</body>
</html>`;
}

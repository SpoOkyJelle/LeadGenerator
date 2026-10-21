// ── Client-facing report (web page + PDF from the same design) ──

// Checks that always run, with how they read when nothing was found
const PASSED_CHECKS = [
  ['Availability', { nl: 'Website is bereikbaar', en: 'Website is online' }],
  ['SSL/HTTPS', { nl: 'Beveiligde verbinding (HTTPS)', en: 'Secure connection (HTTPS)' }],
  ['SSL Certificate', { nl: 'Geldig SSL-certificaat', en: 'Valid SSL certificate' }],
  ['Mobile', { nl: 'Werkt goed op telefoons', en: 'Works well on phones' }],
  ['SEO', { nl: 'SEO-basis aanwezig', en: 'SEO basics in place' }],
  ['Privacy', { nl: 'Privacyverklaring aanwezig', en: 'Privacy statement present' }],
  ['Cookies', { nl: 'Geen tracking zonder toestemming', en: 'No tracking without consent' }],
  ['Security Headers', { nl: 'Beveiligingsinstellingen van de server', en: 'Server security settings' }],
  ['Performance', { nl: 'Server reageert snel', en: 'Server responds quickly' }],
];

// Some findings are written for you (the expert); the client gets a plain-language version
function clientText(f, reportLang) {
  const nl = reportLang === 'nl';
  if (f.tech === 'Security Headers') {
    return {
      title: nl ? 'Beveiligingsinstellingen van de server ontbreken' : 'Server security settings are missing',
      description: nl
        ? 'De server mist een aantal standaard beveiligingsinstellingen. Die beschermen bezoekers onder andere tegen nagemaakte pagina’s en kwaadaardige scripts. Meestal zijn ze in korte tijd in te stellen.'
        : 'The server is missing several standard security settings. These protect visitors against, among other things, spoofed pages and malicious scripts. They can usually be set up quickly.',
    };
  }
  return findingText(f, reportLang);
}

function clientSolution(f, nl) {
  const def = SERVICE_DEFS.find(d => d.tech === f.tech);
  return def ? (nl ? def.nl : def.en) : null;
}

function buildClientReport(lead, reportLang) {
  const nl = reportLang === 'nl';
  const L = (a, b) => (nl ? a : b);
  const sr = lead.scanResult || {};
  const findings = sr.findings || [];
  const s = settings;
  const brand = /^#[0-9a-f]{6}$/i.test(s.brandColor || '') ? s.brandColor : '#1f3a5f';
  const company = s.companyName || '';
  const client = lead.name || domain(lead.url);
  const site = domain(lead.url);
  const loc = nl ? 'nl-NL' : 'en-GB';
  const date = new Date(sr.scannedAt || Date.now()).toLocaleDateString(loc, { day: 'numeric', month: 'long', year: 'numeric' });
  const ref = (nl ? 'WA-' : 'WR-') + new Date(sr.scannedAt || Date.now()).getFullYear() + '-' + String(lead.id).replace(/[^a-z0-9]/gi, '').slice(-5).toUpperCase();
  const score = healthScore(findings);
  const counts = countFindings(findings);
  const shots = sr.screenshots || null;
  const shown = new Set(findings.map(f => f.tech));
  const passed = PASSED_CHECKS.filter(([tech]) => !shown.has(tech)).map(([, label]) => nl ? label.nl : label.en);
  const ordered = ['critical', 'warning', 'info'].flatMap(sev => findings.filter(f => f.severity === sev));
  const priority = { critical: L('Hoog', 'High'), warning: L('Middel', 'Medium'), info: L('Laag', 'Low') };

  // Executive summary in plain prose, the way an adviser would write it
  const top = ordered.find(f => f.severity !== 'info');
  const n = (k, one, many) => k === 1 ? one : many;
  const summary = [];
  summary.push(nl
    ? `Op ${date} hebben wij de website ${site} geanalyseerd op beveiliging, techniek, vindbaarheid en gebruiksgemak.`
    : `On ${date} we analysed the website ${site} for security, technology, findability and usability.`);
  if (counts.critical || counts.warning) {
    const parts = [];
    if (counts.critical) parts.push(nl ? `${counts.critical} ${n(counts.critical, 'punt dat', 'punten die')} directe aandacht ${n(counts.critical, 'vraagt', 'vragen')}` : `${counts.critical} ${n(counts.critical, 'point that needs', 'points that need')} immediate attention`);
    if (counts.warning) parts.push(nl ? `${counts.warning} aanbevolen ${n(counts.warning, 'verbetering', 'verbeteringen')}` : `${counts.warning} recommended ${n(counts.warning, 'improvement', 'improvements')}`);
    summary.push(nl ? `Daarbij vonden wij ${parts.join(' en ')}.` : `We found ${parts.join(' and ')}.`);
    if (top) summary.push(nl ? `Het belangrijkste aandachtspunt: ${clientText(top, reportLang).title.replace(/\.$/, '')}.` : `The most important point: ${clientText(top, reportLang).title.replace(/\.$/, '')}.`);
  } else {
    summary.push(L('Wij vonden geen punten die directe actie vragen. De website is technisch in goede staat.', 'We found no points that require immediate action. The website is technically in good shape.'));
  }
  if (passed.length) summary.push(nl ? `${passed.length} van de gecontroleerde onderdelen ${n(passed.length, 'is', 'zijn')} in orde.` : `${passed.length} of the checked items ${n(passed.length, 'is', 'are')} in order.`);

  const verdict = score >= 80 ? L('Goed', 'Good') : score >= 50 ? L('Voldoende, met verbeterpunten', 'Fair, with points to improve') : L('Onvoldoende, actie nodig', 'Insufficient, action needed');

  let num = 0;
  const findingRows = ordered.map(f => {
    num++;
    const ft = clientText(f, reportLang);
    const fix = clientSolution(f, nl);
    return `
      <div class="finding">
        <div class="f-num">3.${num}</div>
        <div class="f-body">
          <div class="f-head"><h3>${esc(ft.title)}</h3><span class="prio p-${f.severity}">${esc(priority[f.severity])}</span></div>
          <p>${esc(ft.description)}</p>
          ${fix && f.severity !== 'info' ? `<p class="advice"><span>${L('Advies', 'Advice')}</span>${esc(fix)}</p>` : ''}
        </div>
      </div>`;
  }).join('');

  const contactLines = [
    s.contactName ? `<div class="sig-name">${esc(s.contactName)}</div>` : '',
    company ? `<div>${esc(company)}</div>` : '',
    s.phone ? `<div><a href="tel:${esc(s.phone)}">${esc(s.phone)}</a></div>` : '',
    s.email ? `<div><a href="mailto:${esc(s.email)}">${esc(s.email)}</a></div>` : '',
  ].join('');
  const legal = [company, s.kvk && (L('KvK ', 'CoC ') + s.kvk), s.vatNumber && (L('Btw ', 'VAT ') + s.vatNumber), s.website].filter(Boolean).map(esc).join('&nbsp;&nbsp;·&nbsp;&nbsp;');
  const logo = s.logoDataUrl && /^data:image\/(png|jpe?g|svg\+xml|webp);base64,/i.test(s.logoDataUrl)
    ? `<img class="logo" src="${s.logoDataUrl}" alt="${esc(company)}">`
    : `<span class="wordmark">${esc(company || L('Website-analyse', 'Website analysis'))}</span>`;

  let section = 0;
  const h2 = (title) => `<h2><span class="sec-num">${++section}</span>${esc(title)}</h2>`;

  return `<!DOCTYPE html>
<html lang="${nl ? 'nl' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(L('Website-analyse', 'Website analysis'))} ${esc(site)}${company ? ' · ' + esc(company) : ''}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --brand: ${brand};
    --ink: #1c1c1c; --text: #3a3a3a; --muted: #757575; --rule: #e3e3e3; --rule-strong: #c9c9c9; --paper: #ffffff; --desk: #eeeeec;
    --serif: 'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, 'Times New Roman', serif;
    --sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Helvetica, Arial, sans-serif;
  }
  html { -webkit-text-size-adjust: 100%; }
  body { background: var(--desk); color: var(--text); font: 15px/1.65 var(--sans); -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  a { color: var(--brand); text-decoration: none; border-bottom: 1px solid color-mix(in srgb, var(--brand) 30%, transparent); }
  .page { max-width: 820px; margin: 40px auto; background: var(--paper); padding: 56px 64px 40px; box-shadow: 0 1px 2px rgba(0,0,0,.06), 0 8px 30px rgba(0,0,0,.06); }

  /* Letterhead */
  .letterhead { display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; padding-bottom: 18px; border-bottom: 2px solid var(--brand); }
  .logo { max-height: 46px; max-width: 220px; display: block; }
  .wordmark { font: 600 17px/1.2 var(--sans); color: var(--ink); letter-spacing: .02em; }
  .docmeta { text-align: right; font-size: 12px; color: var(--muted); line-height: 1.6; }
  .docmeta b { color: var(--ink); font-weight: 600; }

  /* Title block */
  .titleblock { padding: 44px 0 34px; border-bottom: 1px solid var(--rule); }
  .overline { font-size: 11.5px; letter-spacing: .16em; text-transform: uppercase; color: var(--brand); font-weight: 600; }
  h1 { font: 400 40px/1.15 var(--serif); color: var(--ink); margin: 10px 0 16px; letter-spacing: -.01em; word-break: break-word; }
  .prepared { display: grid; grid-template-columns: auto 1fr; gap: 4px 18px; font-size: 13.5px; }
  .prepared dt { color: var(--muted); }
  .prepared dd { color: var(--ink); }

  /* Sections */
  section { padding: 34px 0 6px; break-inside: auto; }
  h2 { font: 400 23px/1.3 var(--serif); color: var(--ink); margin-bottom: 14px; display: flex; align-items: baseline; gap: 14px; }
  .sec-num { font: 600 13px/1 var(--sans); color: var(--brand); min-width: 18px; }
  .lead-text { font: 400 17px/1.7 var(--serif); color: var(--ink); }
  .lead-text p + p { margin-top: 10px; }

  /* Key figures */
  .figures { display: grid; grid-template-columns: 1.4fr 1fr 1fr 1fr; border-top: 1px solid var(--rule-strong); border-bottom: 1px solid var(--rule-strong); margin-top: 26px; }
  .fig { padding: 16px 18px 16px 0; }
  .fig + .fig { padding-left: 18px; border-left: 1px solid var(--rule); }
  .fig .k { font-size: 11.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
  .fig .v { font: 400 30px/1.15 var(--serif); color: var(--ink); margin-top: 4px; font-variant-numeric: lining-nums tabular-nums; }
  .fig .v small { font: 400 14px var(--sans); color: var(--muted); }
  .scale { height: 4px; background: var(--rule); margin-top: 10px; position: relative; }
  .scale i { position: absolute; inset: 0 auto 0 0; width: ${score}%; background: var(--brand); }
  .fig .note { font-size: 12.5px; color: var(--muted); margin-top: 6px; }

  /* Screenshots */
  .shots { display: grid; grid-template-columns: 1fr 190px; gap: 26px; align-items: start; }
  figure img { display: block; width: 100%; border: 1px solid var(--rule-strong); object-fit: cover; object-position: top; background: #fafafa; }
  figure.desk img { aspect-ratio: 1366 / 860; }
  figure.mob img { aspect-ratio: 390 / 844; border-radius: 14px; }
  figcaption { font-size: 12px; color: var(--muted); margin-top: 8px; }
  figcaption b { color: var(--ink); font-weight: 600; }

  /* Findings */
  .finding { display: grid; grid-template-columns: 44px 1fr; gap: 0 8px; padding: 18px 0; border-top: 1px solid var(--rule); break-inside: avoid; }
  .finding:last-child { border-bottom: 1px solid var(--rule); }
  .f-num { font: 600 13px/1.9 var(--sans); color: var(--muted); font-variant-numeric: tabular-nums; }
  .f-head { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; }
  .f-head h3 { font: 600 15.5px/1.45 var(--sans); color: var(--ink); }
  .prio { flex-shrink: 0; font-size: 11.5px; letter-spacing: .06em; text-transform: uppercase; font-weight: 600; display: inline-flex; align-items: center; gap: 7px; color: var(--muted); }
  .prio::before { content: ''; width: 8px; height: 8px; display: inline-block; }
  .p-critical::before { background: #b42318; } .p-warning::before { background: #c4780f; } .p-info::before { background: #98a2b3; }
  .f-body p { margin-top: 4px; }
  .advice { margin-top: 10px !important; padding-left: 12px; border-left: 2px solid var(--brand); color: var(--ink); }
  .advice span { display: block; font-size: 11.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); font-weight: 600; }
  .none { color: var(--muted); font-style: italic; }

  /* Passed checks */
  table.ok { width: 100%; border-collapse: collapse; font-size: 14px; }
  table.ok td { padding: 9px 0; border-top: 1px solid var(--rule); }
  table.ok tr:last-child td { border-bottom: 1px solid var(--rule); }
  table.ok td:last-child { text-align: right; color: var(--muted); white-space: nowrap; }
  table.ok td:last-child::before { content: '✓'; color: var(--brand); font-weight: 700; margin-right: 8px; }

  /* Next steps */
  .next { display: grid; grid-template-columns: 1fr 230px; gap: 34px; align-items: start; }
  .next p + p { margin-top: 10px; }
  .actions { margin-top: 20px; display: flex; gap: 18px; align-items: center; flex-wrap: wrap; }
  .btn { display: inline-block; background: var(--brand); color: #fff; border: 0; padding: 11px 20px; font: 600 14px var(--sans); cursor: pointer; letter-spacing: .01em; }
  .btn:hover { filter: brightness(1.1); }
  .textlink { background: none; border: 0; border-bottom: 1px solid var(--rule-strong); padding: 0 0 1px; font: 500 14px var(--sans); color: var(--ink); cursor: pointer; }
  .signature { border-left: 1px solid var(--rule-strong); padding-left: 20px; font-size: 13.5px; line-height: 1.7; }
  .signature .label { font-size: 11.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin-bottom: 6px; }
  .sig-name { font: 400 18px var(--serif); color: var(--ink); }

  .method { font-size: 13px; color: var(--muted); }
  .method p + p { margin-top: 8px; }

  footer { margin-top: 44px; padding-top: 14px; border-top: 1px solid var(--rule); display: flex; justify-content: space-between; gap: 16px; font-size: 11.5px; color: var(--muted); flex-wrap: wrap; }

  @media (max-width: 720px) {
    .page { margin: 0; padding: 30px 22px; box-shadow: none; }
    h1 { font-size: 30px; }
    .figures { grid-template-columns: 1fr 1fr; }
    .fig:nth-child(3) { padding-left: 0; border-left: 0; }
    .fig:nth-child(n+3) { border-top: 1px solid var(--rule); }
    .shots, .next { grid-template-columns: 1fr; }
    figure.mob { max-width: 200px; }
    .signature { border-left: 0; padding-left: 0; border-top: 1px solid var(--rule); padding-top: 16px; }
    .letterhead { flex-direction: column; align-items: flex-start; }
    .docmeta { text-align: left; }
  }
  @media print {
    body { background: #fff; font-size: 12.5px; }
    .page { margin: 0; padding: 0; box-shadow: none; max-width: none; }
    .no-print { display: none !important; }
    section { padding-top: 20px; }
    h2 { break-after: avoid; margin-bottom: 10px; }
    .titleblock { padding: 30px 0 24px; }
    .figures { margin-top: 18px; }
    /* Compact screenshots so they fit under the summary on page 1 */
    .shots { grid-template-columns: 1fr 112px; gap: 18px; break-inside: avoid; }
    figure.desk img { max-height: 62mm; }
    figcaption { margin-top: 4px; font-size: 10.5px; }
    footer { margin-top: 18px; break-inside: avoid; }
    a { border: 0; color: var(--ink); }
    @page { size: A4; margin: 16mm 16mm 18mm; }
  }
</style>
</head>
<body>
<div class="page">
  <header class="letterhead">
    <div>${logo}</div>
    <div class="docmeta">
      <div><b>${esc(L('Website-analyse', 'Website analysis'))}</b></div>
      <div>${esc(L('Kenmerk', 'Reference'))} ${esc(ref)}</div>
      <div>${esc(date)}</div>
    </div>
  </header>

  <div class="titleblock">
    <div class="overline">${esc(L('Website-analyse', 'Website analysis'))}</div>
    <h1>${esc(site)}</h1>
    <dl class="prepared">
      <dt>${esc(L('Opgesteld voor', 'Prepared for'))}</dt><dd>${esc(client)}</dd>
      ${company || s.contactName ? `<dt>${esc(L('Opgesteld door', 'Prepared by'))}</dt><dd>${esc([s.contactName, company].filter(Boolean).join(', '))}</dd>` : ''}
      <dt>${esc(L('Datum', 'Date'))}</dt><dd>${esc(date)}</dd>
    </dl>
  </div>

  <section>
    ${h2(L('Samenvatting', 'Summary'))}
    <div class="lead-text"><p>${summary.map(esc).join(' ')}</p></div>
    <div class="figures">
      <div class="fig">
        <div class="k">${esc(L('Totaalscore', 'Overall score'))}</div>
        <div class="v">${score}<small> / 100</small></div>
        <div class="scale"><i></i></div>
        <div class="note">${esc(verdict)}</div>
      </div>
      <div class="fig"><div class="k">${esc(L('Prioriteit hoog', 'High priority'))}</div><div class="v">${counts.critical}</div></div>
      <div class="fig"><div class="k">${esc(L('Prioriteit middel', 'Medium priority'))}</div><div class="v">${counts.warning}</div></div>
      <div class="fig"><div class="k">${esc(L('In orde', 'In order'))}</div><div class="v">${passed.length}</div></div>
    </div>
  </section>

  ${shots && (shots.desktop || shots.mobile) ? `
  <section>
    ${h2(L('Uw website in beeld', 'Your website at a glance'))}
    <div class="shots">
      ${shots.desktop ? `<figure class="desk"><img src="{{IMG_BASE}}desktop" alt=""><figcaption><b>${esc(L('Afbeelding 1', 'Figure 1'))}</b> — ${esc(L('weergave op een computer', 'as seen on a computer'))}</figcaption></figure>` : ''}
      ${shots.mobile ? `<figure class="mob"><img src="{{IMG_BASE}}mobile" alt=""><figcaption><b>${esc(L('Afbeelding ' + (shots.desktop ? 2 : 1), 'Figure ' + (shots.desktop ? 2 : 1)))}</b> — ${esc(L('weergave op een telefoon', 'as seen on a phone'))}</figcaption></figure>` : ''}
    </div>
  </section>` : ''}

  <section>
    ${h2(L('Bevindingen', 'Findings'))}
    ${ordered.length
      ? `<p style="margin-bottom:14px">${esc(L('De bevindingen staan in volgorde van prioriteit. Punten met prioriteit hoog raden wij aan als eerste op te pakken.', 'Findings are listed in order of priority. We recommend addressing high-priority items first.'))}</p>${findingRows}`
      : `<p class="none">${esc(L('Er zijn geen aandachtspunten gevonden.', 'No points of attention were found.'))}</p>`}
  </section>

  ${passed.length ? `
  <section>
    ${h2(L('Wat in orde is', 'What is in order'))}
    <table class="ok">${passed.map(p => `<tr><td>${esc(p)}</td><td>${esc(L('In orde', 'In order'))}</td></tr>`).join('')}</table>
  </section>` : ''}

  <section>
    ${h2(L('Advies en vervolg', 'Recommendation and next steps'))}
    <div class="next">
      <div>
        <p>${esc(counts.critical || counts.warning
          ? L('Wij adviseren de punten met prioriteit hoog op korte termijn op te lossen; de overige verbeteringen kunnen daarna gefaseerd worden opgepakt. Graag lichten wij de bevindingen toe in een kort, vrijblijvend gesprek, waarin we ook de aanpak en planning bespreken.',
              'We recommend resolving the high-priority items in the short term; the other improvements can then be addressed in phases. We would be happy to explain the findings in a short, no-obligation call in which we also discuss approach and planning.')
          : L('De website is in goede staat. Regelmatig onderhoud houdt dat zo. Graag bespreken wij in een kort, vrijblijvend gesprek hoe wij daarbij kunnen helpen.',
              'The website is in good shape. Regular maintenance keeps it that way. We would be happy to discuss in a short, no-obligation call how we can help.'))}</p>
        <div class="actions no-print">
          ${s.bookingUrl ? `<a class="btn" href="${esc(s.bookingUrl)}" target="_blank" rel="noopener" style="border:0">${esc(L('Plan een gesprek', 'Schedule a call'))}</a>`
            : s.email ? `<a class="btn" href="mailto:${esc(s.email)}?subject=${encodeURIComponent(L('Website-analyse ', 'Website analysis ') + site)}" style="border:0">${esc(L('Neem contact op', 'Get in touch'))}</a>` : ''}
          <button class="textlink" onclick="window.print()">${esc(L('Download als PDF', 'Download as PDF'))}</button>
        </div>
      </div>
      ${contactLines ? `<div class="signature"><div class="label">${esc(L('Contact', 'Contact'))}</div>${contactLines}</div>` : ''}
    </div>
  </section>

  <section class="method">
    ${h2(L('Over dit onderzoek', 'About this analysis'))}
    <p>${esc(L(
      `Deze analyse is op ${date} uitgevoerd op basis van openbaar toegankelijke informatie van ${site}: de homepage en enkele onderliggende pagina's, de serverinstellingen en het SSL-certificaat. Er is niets aan de website gewijzigd en er zijn geen inloggegevens gebruikt.`,
      `This analysis was carried out on ${date} using publicly accessible information from ${site}: the homepage and a few underlying pages, the server settings and the SSL certificate. Nothing on the website was changed and no login details were used.`))}</p>
    <p>${esc(L('De resultaten zijn een momentopname. De totaalscore is een indicatie op basis van het aantal en de ernst van de bevindingen.', 'The results are a snapshot in time. The overall score is an indication based on the number and severity of the findings.'))}</p>
  </section>

  <footer>
    <span>${legal || '&nbsp;'}</span>
    <span>${esc(L('Kenmerk', 'Ref.'))} ${esc(ref)}</span>
  </footer>
</div>
</body>
</html>`;
}

// The report is written in the dashboard's current language
function reportLang() {
  return lang;
}

// Publish (or refresh) the online report; the link stays the same
async function publishReport(leadId, { silent = false } = {}) {
  const lead = leads.find(l => l.id === leadId);
  if (!lead || scanState(lead) !== 'done') return null;
  const res = await fetch('/api/reports/' + encodeURIComponent(leadId), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html: buildClientReport(lead, reportLang(lead)), lang: reportLang(lead) }),
  });
  if (!res.ok) { toast(t('toastReportFail'), 'error'); return null; }
  const data = await res.json();
  lead.report = { ...(lead.report || { views: 0, totalSeconds: 0, lastViewAt: null }), token: data.token, url: data.url, updated: Date.now() };
  if (!silent) {
    render();
    toast(t('toastReportPublished'), 'success');
  }
  return data.url;
}

function askUnpublishReport(leadId) {
  openConfirm(t('unpublishTitle'), t('unpublishText'), t('unpublish'), true, async () => {
    await fetch('/api/reports/' + encodeURIComponent(leadId), { method: 'DELETE' });
    const lead = leads.find(l => l.id === leadId);
    if (lead) lead.report = null;
    render();
    toast(t('toastReportRemoved'), '');
  });
}

function copyReportLink(leadId) {
  const lead = leads.find(l => l.id === leadId);
  if (lead && lead.report) navigator.clipboard.writeText(lead.report.url).then(() => toast(t('toastLinkCopied'), 'success'));
}

// Your own preview: same page, but it does not count as a view
function previewReport(leadId) {
  const lead = leads.find(l => l.id === leadId);
  if (!lead) return;
  if (lead.report) { window.open('/api/reports/' + encodeURIComponent(leadId) + '/preview', '_blank'); return; }
  openReportWindow(lead, false);
}

function downloadPdf(leadId) {
  const lead = leadId ? leads.find(l => l.id === leadId) : currentLead();
  if (!lead || !lead.scanResult) return;
  openReportWindow(lead, true);
}

function openReportWindow(lead, print) {
  const win = window.open('', '_blank'); // open right away so the popup isn't blocked
  const html = buildClientReport(lead, reportLang(lead)).split('{{IMG_BASE}}').join('/api/reports/' + encodeURIComponent(lead.id) + '/img/');
  win.document.write(html);
  win.document.close();
  if (!print) return;
  // Wait for the screenshots before opening the print dialog
  const imgs = [...win.document.images];
  Promise.all(imgs.map(img => img.complete ? null : new Promise(r => { img.onload = img.onerror = r; })))
    .then(() => setTimeout(() => win.print(), 300));
}

function fmtDuration(sec) {
  sec = Math.round(sec || 0);
  if (sec < 60) return sec + 's';
  return Math.floor(sec / 60) + 'm ' + String(sec % 60).padStart(2, '0') + 's';
}

function timeAgo(ts) {
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) return t('justNow');
  if (min < 60) return t('minutesAgo', min);
  const h = Math.round(min / 60);
  if (h < 24) return t('hoursAgo', h);
  return t('daysAgo', Math.round(h / 24));
}

// Report card on the lead page: publish, share and see whether it was opened
function reportCard(l) {
  if (scanState(l) !== 'done') return '';
  const id = esc(l.id);
  const r = l.report;
  const localOnly = !settings.publicReportUrl;
  let body;
  if (!r) {
    body = '<p class="muted-note" style="margin-bottom:12px">' + esc(t('reportIntro')) + '</p>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap">' +
        '<button class="btn btn-primary btn-sm" onclick="publishReport(\'' + id + '\')"><i class="fa-solid fa-globe"></i>' + esc(t('publishReport')) + '</button>' +
        '<button class="btn btn-secondary btn-sm" onclick="previewReport(\'' + id + '\')"><i class="fa-regular fa-eye"></i>' + esc(t('preview')) + '</button>' +
      '</div>';
  } else {
    const viewed = r.views > 0;
    body =
      '<div class="report-status ' + (viewed ? 'seen' : '') + '"><i class="fa-solid ' + (viewed ? 'fa-eye' : 'fa-eye-slash') + '"></i><div>' +
        (viewed
          ? '<b>' + esc(t('viewedTimes', r.views)) + '</b><div class="hint">' + esc(t('lastViewed', timeAgo(r.lastViewAt))) + ' · ' + esc(t('readingTime', fmtDuration(r.totalSeconds))) + '</div>'
          : '<b>' + esc(t('notViewedYet')) + '</b><div class="hint">' + esc(t('notViewedHint')) + '</div>') +
      '</div></div>' +
      '<div class="link-box"><input readonly value="' + esc(r.url) + '" onclick="this.select()"><button class="icon-btn" title="' + esc(t('copyLink')) + '" onclick="copyReportLink(\'' + id + '\')"><i class="fa-regular fa-copy"></i></button></div>' +
      (localOnly ? '<div class="hint" style="margin-top:8px;color:var(--amber)"><i class="fa-solid fa-triangle-exclamation"></i> ' + esc(t('reportLocalOnly')) + ' <a class="link" href="#/settings">' + esc(t('goSettings')) + '</a></div>' : '') +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:12px">' +
        '<button class="btn btn-secondary btn-sm" onclick="previewReport(\'' + id + '\')"><i class="fa-regular fa-eye"></i>' + esc(t('preview')) + '</button>' +
        '<button class="btn btn-secondary btn-sm" onclick="publishReport(\'' + id + '\')" title="' + esc(t('updateReportHint')) + '"><i class="fa-solid fa-rotate"></i>' + esc(t('updateReport')) + '</button>' +
        '<button class="btn btn-secondary btn-sm" onclick="downloadPdf(\'' + id + '\')"><i class="fa-solid fa-file-pdf"></i>PDF</button>' +
        '<button class="icon-btn danger" title="' + esc(t('unpublish')) + '" onclick="askUnpublishReport(\'' + id + '\')"><i class="fa-solid fa-link-slash"></i></button>' +
      '</div>';
  }
  return '<div class="card"><div class="card-head"><div class="card-title"><i class="fa-solid fa-file-lines" style="color:var(--accent-2);font-size:12px"></i>' + esc(t('clientReport')) + '</div></div>' +
    '<div class="card-body">' + body + '</div></div>';
}

// Screenshots on the lead page
function screenshotsCard(l) {
  const shots = l.scanResult && l.scanResult.screenshots;
  if (!shots || (!shots.desktop && !shots.mobile)) return '';
  const src = (f) => '/api/screenshots/' + encodeURIComponent(f) + '?v=' + encodeURIComponent(shots.takenAt || '');
  return '<div class="card"><div class="card-head"><div class="card-title">' + esc(t('screenshots')) + '</div><span class="hint">' + esc(fmtDateTime(shots.takenAt)) + '</span></div>' +
    '<div class="card-body shot-grid">' +
      (shots.desktop ? '<a href="' + src(shots.desktop) + '" target="_blank" class="shot desktop"><img src="' + src(shots.desktop) + '" alt="" loading="lazy"><span>' + esc(t('shotDesktop')) + '</span></a>' : '') +
      (shots.mobile ? '<a href="' + src(shots.mobile) + '" target="_blank" class="shot mobile"><img src="' + src(shots.mobile) + '" alt="" loading="lazy"><span>' + esc(t('shotMobile')) + '</span></a>' : '') +
    '</div></div>';
}

// ── Live "report opened" notifications ──
let lastViewCheck = Date.now();

async function checkReportViews() {
  try {
    const views = await (await fetch('/api/report-views?since=' + lastViewCheck)).json();
    if (!views.length) return;
    lastViewCheck = Math.max(...views.map(v => v.at));
    const names = [...new Set(views.map(v => {
      const l = leads.find(x => x.id === v.leadId);
      return l ? (l.name || domain(l.url)) : null;
    }).filter(Boolean))];
    names.forEach(n => toast(t('toastReportViewed', n), 'success'));
    await apiLoad();
  } catch { /* server offline; try again later */ }
}

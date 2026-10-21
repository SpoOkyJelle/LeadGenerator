// ── Scanner ──
const SCANNER_URL = ''; // same server as the dashboard

async function checkServer() {
  try {
    const r = await fetch(SCANNER_URL + '/api/health', { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

async function refreshServerPill() {
  const ok = await checkServer();
  $('server-pill').className = 'server-pill ' + (ok ? 'ok' : 'down');
  $('server-text').textContent = ok ? t('serverOk') : t('serverDown');
}

async function scanLead(id, { quiet = false } = {}) {
  const lead = leads.find(l => l.id === id);
  if (!lead || scanningIds.has(id)) return null;

  scanningIds.add(id);
  render();

  let scanResult;
  try {
    const res = await fetch(SCANNER_URL + '/api/scan?url=' + encodeURIComponent(lead.url));
    const data = await res.json();
    scanResult = {
      success: data.success,
      findings: data.findings || [],
      contact: data.contact || null,
      error: data.errorCode === 'blocked' ? t('scanBlocked', data.httpStatus)
        : data.errorCode ? t('scanErr_' + data.errorCode, domain(lead.url))
        : (data.error || null),
      errorCode: data.errorCode || null,
      scannedAt: data.scannedAt || new Date().toISOString(),
      url: data.url || lead.url,
    };
  } catch (e) {
    scanResult = {
      success: false,
      findings: [],
      error: 'Could not reach scanner server. Make sure it is running on port 3001.',
      scannedAt: new Date().toISOString(),
    };
  }

  scanningIds.delete(id);
  // Update contact details from the site. A value you typed yourself is kept; a value that came
  // from an earlier scan is refreshed.
  const found = scanResult.contact || {};
  const previous = (lead.scanResult && lead.scanResult.contact) || {};
  const changes = { scanResult };
  if (found.email && (!lead.email || lead.email === previous.email)) changes.email = found.email;
  if (found.phone && (!lead.phone || lead.phone === previous.phone)) changes.phone = found.phone;
  await saveLead(id, changes);
  render();

  const counts = countFindings(scanResult.findings);
  if (quiet) return scanResult;
  if (scanResult.success) {
    const msg = counts.critical ? t('toastCrit', counts.critical) : counts.warning ? t('toastWarn', counts.warning) : t('toastClean');
    toast(domain(lead.url) + ' — ' + msg, counts.critical ? 'error' : counts.warning ? '' : 'success');
  } else {
    toast(t('toastScanFail') + ': ' + scanResult.error, 'error');
  }
  return scanResult;
}

// Rescans every lead (or only the ones never scanned / failed) and reports one summary at the end
let scanAllProgress = null;

async function scanAllLeads(onlyNew = false) {
  if (scanAllRunning) return;
  const todo = onlyNew ? leads.filter(l => ['none', 'error'].includes(scanState(l))) : leads.slice();
  if (!todo.length) { toast(onlyNew ? t('toastAllScanned') : t('toastExportEmpty'), ''); return; }

  if (!(await checkServer())) { toast(t('toastNoServer'), 'error'); refreshServerPill(); return; }

  scanAllRunning = true;
  scanAllProgress = { done: 0, total: todo.length };
  render();
  let withIssues = 0, failed = 0, emails = 0;
  for (const lead of todo) {
    const hadEmail = Boolean(lead.email);
    const sr = await scanLead(lead.id, { quiet: true });
    if (sr && !sr.success) failed++;
    else if (sr && sr.findings.some(f => f.severity !== 'info')) withIssues++;
    const updated = leads.find(l => l.id === lead.id);
    if (!hadEmail && updated && updated.email) emails++;
    scanAllProgress.done++;
    render();
    await new Promise(r => setTimeout(r, 300));
  }
  scanAllRunning = false;
  scanAllProgress = null;
  render();
  toast(t('toastScanAllSummary', todo.length, withIssues, emails, failed), failed ? '' : 'success');
}

function findingText(f, lang) {
  const nl = lang === 'nl';
  const v = f.version && f.version !== 'detected' ? f.version : null;
  const isOld = f.severity === 'critical' || f.severity === 'warning';

  const templates = {
    'SSL/HTTPS': {
      title: nl ? 'Geen HTTPS / SSL' : 'No HTTPS / SSL',
      description: nl
        ? 'De website draait op onbeveiligd HTTP. Alle data wordt onversleuteld verzonden, wat bezoekers en zoekmachine rankings schaadt.'
        : 'The site runs on plain HTTP. All data is transmitted unencrypted, harming visitors and search rankings.',
      opportunity: nl
        ? 'Bied SSL-certificaat installatie en HTTPS-migratie aan'
        : 'Offer SSL certificate installation and HTTPS migration',
    },
    'PHP': (() => {
      // Newer scans carry a status; older scans only have a severity
      const status = f.status || (f.severity === 'critical' ? 'eol' : f.severity === 'warning' ? 'security' : 'current');
      const cycle = v ? v.split('.').slice(0, 2).join('.') : '';
      const until = f.eolDate ? fmtLong(parseISODate(f.eolDate)) : '';
      if (!nl) return { title: f.title, description: f.description, opportunity: f.opportunity };
      return {
        title: status === 'eol' ? 'PHP ' + (v || '') + ' — End-of-Life, geen beveiligingsupdates meer'
          : status === 'security' ? 'PHP ' + (v || '') + ' — Alleen nog beveiligingsfixes' + (until ? ' tot ' + until : '')
          : 'PHP ' + (v || '') + ' — Ondersteund',
        description: status === 'eol' ? 'De server draait PHP ' + (v || '') + '. PHP ' + cycle + ' krijgt ' + (until ? 'sinds ' + until + ' ' : '') + 'geen beveiligingsupdates meer, dus bekende lekken worden niet meer gedicht.'
          : status === 'security' ? 'De server draait PHP ' + (v || '') + '. PHP ' + cycle + ' krijgt alleen nog beveiligingsfixes' + (until ? ' tot ' + until : '') + '; daarna wordt het onveilig. Een upgrade moet nu gepland worden.'
          : 'De server draait PHP ' + (v || '') + ', een versie die nog volledig ondersteund wordt.',
        opportunity: 'Bied PHP-upgrade en serverbeheer aan',
      };
    })(),
    'WordPress': (() => {
      const exposed = /exposed publicly/i.test(f.title || '');
      if (!nl) return { title: f.title, description: f.description, opportunity: f.opportunity };
      if (exposed) return {
        title: 'WordPress-versie openbaar zichtbaar',
        description: 'De WordPress-versie (' + (v || '') + ') staat zichtbaar in de broncode. Aanvallers kunnen zo gericht zoeken naar bekende lekken in deze versie.',
        opportunity: 'Bied WordPress onderhoud, updates en beveiliging aan',
      };
      const latest = f.latest ? ' De nieuwste versie is ' + f.latest + '.' : '';
      return {
        title: f.severity === 'critical' ? 'WordPress ' + (v || '') + ' — Zwaar verouderd' : f.severity === 'warning' ? 'WordPress ' + (v || '') + ' — Verouderd' : 'WordPress ' + (v || 'gedetecteerd'),
        description: f.severity === 'critical' ? 'WordPress ' + v + ' is ernstig verouderd en bevat bekende beveiligingslekken die actief worden misbruikt.' + latest
          : f.severity === 'warning' ? 'WordPress ' + v + ' is verouderd.' + latest + ' Verouderde WordPress-sites zijn een populair doelwit.'
          : v ? 'WordPress ' + v + ' gedetecteerd — lijkt actueel.' : 'WordPress gedetecteerd (versie verborgen).',
        opportunity: 'Bied WordPress onderhoud, updates en beveiliging aan',
      };
    })(),
    'jQuery': {
      title: nl ? 'jQuery ' + (v || '') + ' — Verouderd' : f.title,
      description: nl ? 'jQuery ' + v + ' is een verouderde versie met bekende XSS-kwetsbaarheden.' : f.description,
      opportunity: nl ? 'Bied frontend modernisering en jQuery-upgrade aan' : f.opportunity,
    },
    'Bootstrap': {
      title: nl ? 'Bootstrap ' + (v || '') + ' — Verouderd' : f.title,
      description: nl ? 'Bootstrap ' + v + ' is verouderd. Bootstrap 5 biedt betere features en vereist geen jQuery.' : f.description,
      opportunity: nl ? 'Bied een frontend redesign aan met moderne Bootstrap 5' : f.opportunity,
    },
    'Apache': {
      title: nl ? (isOld ? 'Apache ' + (v || '') + ' — Verouderd' : 'Apache ' + (v || '')) : f.title,
      description: nl ? (isOld ? 'Apache ' + v + ' is verouderd en mist mogelijk beveiligingspatches.' : 'Apache ' + v + ' gedetecteerd.') : f.description,
      opportunity: nl ? 'Bied server-upgrade en hardening aan' : f.opportunity,
    },
    'Nginx': {
      title: nl ? (isOld ? 'Nginx ' + (v || '') + ' — Verouderd' : 'Nginx ' + (v || '')) : f.title,
      description: nl ? (isOld ? 'Nginx ' + v + ' is verouderd en mist mogelijk beveiligingsfixes.' : 'Nginx ' + v + ' gedetecteerd.') : f.description,
      opportunity: nl ? 'Bied server-upgrade en prestatieoptimalisatie aan' : f.opportunity,
    },
    'Microsoft IIS': {
      title: nl ? (isOld ? 'IIS ' + (v || '') + ' — Verouderd' : 'IIS ' + (v || '')) : f.title,
      description: nl ? (isOld ? 'IIS ' + v + ' is een verouderde versie met mogelijke kwetsbaarheden.' : 'IIS ' + v + ' gedetecteerd.') : f.description,
      opportunity: nl ? 'Bied Windows Server migratie aan' : f.opportunity,
    },
    'ASP.NET': {
      title: nl ? (isOld ? 'ASP.NET ' + (v || '') + ' — Verouderd' : 'ASP.NET ' + (v || '')) : f.title,
      description: nl ? (isOld ? 'ASP.NET ' + v + ' is verouderd. Migratie naar .NET Core of .NET 8 wordt aanbevolen.' : 'ASP.NET ' + v + ' gedetecteerd.') : f.description,
      opportunity: nl ? 'Bied .NET upgrade of migratie naar .NET Core aan' : f.opportunity,
    },
    'Security Headers': {
      title: nl ? (f.title.match(/^\d+/)?.[0] || '') + ' Beveiligingsheaders Ontbreken' : f.title,
      description: nl
        ? 'De volgende beveiligingsheaders zijn niet ingesteld: ' + (f.description.match(/not set: (.+?)\. This/)?.[1] || '') + '. Dit maakt de website kwetsbaar voor clickjacking, MIME-sniffing en XSS-aanvallen.'
        : f.description,
      opportunity: nl ? 'Bied webbeveiliging en header-configuratie aan' : f.opportunity,
    },
    'Drupal': {
      title: nl ? (isOld ? 'Drupal ' + (v || '') + ' — Verouderd' : 'Drupal ' + (v || 'gedetecteerd')) : f.title,
      description: nl ? (isOld ? 'Drupal ' + v + ' is verouderd. Drupal 10/11 is de huidige versie.' : 'Drupal gedetecteerd.') : f.description,
      opportunity: nl ? 'Bied Drupal upgrade en onderhoud aan' : f.opportunity,
    },
    'Joomla': {
      title: nl ? (isOld ? 'Joomla ' + (v || '') + ' — Verouderd' : 'Joomla ' + (v || 'gedetecteerd')) : f.title,
      description: nl ? (isOld ? 'Joomla ' + v + ' is verouderd. Joomla 5 is de huidige versie.' : 'Joomla gedetecteerd.') : f.description,
      opportunity: nl ? 'Bied Joomla upgrade of migratie aan' : f.opportunity,
    },
    'Availability': {
      title: nl ? 'Website toont een foutpagina (HTTP ' + f.httpStatus + ')' : f.title,
      description: !nl ? f.description
        : f.httpStatus === 404 ? 'De homepage geeft “niet gevonden” (404). Bezoekers en Google zien een foutpagina in plaats van de website.'
        : 'De server geeft een foutmelding (HTTP ' + f.httpStatus + '). Bezoekers zien een foutpagina in plaats van de website.',
      opportunity: nl ? 'Bied aan de website weer werkend te krijgen en te monitoren' : 'Offer to get the website working again and monitor it',
    },
    'SSL Certificate': {
      title: !nl ? f.title
        : f.status === 'expired' ? 'SSL-certificaat is verlopen'
        : f.status === 'invalid' ? 'SSL-certificaat is ongeldig'
        : 'SSL-certificaat verloopt over ' + f.days + ' dagen',
      description: !nl ? f.description
        : f.status === 'expired' ? 'Het SSL-certificaat is verlopen op ' + fmtLong(parseISODate(f.validTo)) + '. Elke bezoeker krijgt nu een paginagrote beveiligingswaarschuwing te zien.'
        : f.status === 'invalid' ? 'Browsers vertrouwen het SSL-certificaat niet (' + (f.reason || 'onbekende reden') + '). Bezoekers kunnen een beveiligingswaarschuwing te zien krijgen.'
        : 'Het SSL-certificaat verloopt op ' + fmtLong(parseISODate(f.validTo)) + '. Als het niet op tijd wordt vernieuwd, krijgen bezoekers een beveiligingswaarschuwing.',
      opportunity: nl ? 'Bied SSL-vernieuwing met automatische verlenging aan' : 'Offer SSL renewal with automatic renewal',
    },
    'Copyright': {
      title: nl ? 'Copyright-vermelding staat nog op ' + f.year : f.title,
      description: nl ? 'In de footer staat © ' + f.year + '. Voor bezoekers lijkt het daardoor alsof de site al ' + (new Date().getFullYear() - f.year) + ' jaar niet is bijgewerkt.' : f.description,
      opportunity: nl ? 'Bied website-onderhoud en een content-update aan' : 'Offer website maintenance and a content refresh',
    },
    'Mobile': {
      title: nl ? 'Niet mobielvriendelijk' : f.title,
      description: nl ? 'De pagina heeft geen viewport-instelling, waardoor telefoons een uitgezoomde desktopversie tonen. Google laat zulke pagina’s lager zien in mobiele zoekresultaten.' : f.description,
      opportunity: nl ? 'Bied een mobielvriendelijke (responsive) versie aan' : 'Offer a mobile-friendly (responsive) version',
    },
    'SEO': (() => {
      const names = { 'title': 'paginatitel', 'meta description': 'meta-omschrijving', 'h1 heading': 'hoofdkop (h1)' };
      const list = (f.missing || []).map(m => names[m] || m).join(', ');
      return {
        title: nl ? 'SEO-basis ontbreekt: ' + list : f.title,
        description: nl ? 'De homepage heeft geen ' + list + '. Die helpen Google om de site goed te tonen in de zoekresultaten.' : f.description,
        opportunity: nl ? 'Bied het op orde brengen van de SEO-basis aan' : 'Offer fixing the SEO basics',
      };
    })(),
    'Privacy': {
      title: nl ? 'Geen privacyverklaring gevonden' : f.title,
      description: nl ? 'Op de homepage staat geen link naar een privacyverklaring. Volgens de AVG heeft elke site die persoonsgegevens verzamelt, bijvoorbeeld via een contactformulier, er een nodig.' : f.description,
      opportunity: nl ? 'Bied het opstellen en plaatsen van een privacyverklaring aan' : 'Offer writing and adding a privacy statement',
    },
    'Cookies': {
      title: nl ? 'Tracking zonder cookiemelding' : f.title,
      description: nl ? 'De site laadt ' + (f.trackers || []).join(', ') + ', maar er is geen cookiemelding gevonden. Volgens de AVG moeten bezoekers daar eerst toestemming voor geven.' : f.description,
      opportunity: nl ? 'Bied een AVG-proof cookiemelding aan' : 'Offer a GDPR-compliant cookie banner',
    },
    'Performance': {
      title: !nl ? f.title
        : f.source === 'pagespeed' ? 'Traag op mobiel: PageSpeed-score ' + f.score + '/100'
        : 'Trage server: ' + (f.responseMs / 1000).toFixed(1).replace('.', ',') + ' seconden voordat de pagina begint te laden',
      description: !nl ? f.description
        : f.source === 'pagespeed' ? 'Google PageSpeed geeft de mobiele site ' + f.score + '/100' + (f.lcp ? ' (hoofdinhoud zichtbaar na ' + f.lcp + ')' : '') + '. Trage sites verliezen bezoekers en scoren lager in Google.'
        : 'De server deed er ' + (f.responseMs / 1000).toFixed(1).replace('.', ',') + ' seconden over om te reageren. Bezoekers haken vaak al na 3 seconden af.',
      opportunity: nl ? 'Bied snelheidsoptimalisatie aan' : 'Offer speed optimisation',
    },
  };

  return templates[f.tech] || { title: f.title, description: f.description, opportunity: f.opportunity };
}

function currentLead() {
  return leads.find(l => l.id === currentId);
}

function copyReport() {
  const lead = currentLead();
  if (!lead || !lead.scanResult) return;
  const sr = lead.scanResult;
  let text = 'Scan Report: ' + lead.url + '\nDate: ' + new Date(sr.scannedAt).toLocaleString() + '\n\n';
  if (!sr.findings.length) {
    text += 'No issues found.\n';
  } else {
    sr.findings.forEach(f => {
      const ft = findingText(f, lang);
      text += '[' + f.severity.toUpperCase() + '] ' + ft.title + '\n';
      text += '  ' + ft.description + '\n';
      if (ft.opportunity) text += '  Opportunity: ' + ft.opportunity + '\n';
      text += '\n';
    });
  }
  navigator.clipboard.writeText(text).then(() => toast(t('toastCopied'), 'success'));
}

function downloadPdf(leadId) {
  const lead = leadId ? leads.find(l => l.id === leadId) : currentLead();
  if (!lead || !lead.scanResult) return;
  const html = generateReportHTML(lead, lang);
  const win = window.open('', '_blank');
  win.document.write(html);
  win.document.close();
  setTimeout(() => win.print(), 600);
}

function generateReportHTML(lead, lang) {
  const nl = lang === 'nl';
  const sr = lead.scanResult;
  const findings = sr.findings || [];
  const counts = countFindings(findings);
  const scanDate = new Date(sr.scannedAt).toLocaleDateString(nl ? 'nl-NL' : 'en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const sevMeta = {
    critical: { label: nl ? 'Kritiek'      : 'Critical', color: '#b91c1c', bg: '#fef2f2', border: '#fca5a5', dot: '#dc2626' },
    warning:  { label: nl ? 'Waarschuwing' : 'Warning',  color: '#92400e', bg: '#fffbeb', border: '#fcd34d', dot: '#d97706' },
    info:     { label: 'Info',                            color: '#1e3a8a', bg: '#eff6ff', border: '#93c5fd', dot: '#2563eb' },
  };

  const findingsHtml = findings.length === 0
    ? `<p style="color:#6b7280;padding:32px 0;text-align:center;font-size:14px">${nl ? 'Er zijn geen problemen gevonden tijdens deze scan.' : 'No issues were detected during this scan.'}</p>`
    : findings.map(f => {
        const ft = findingText(f, lang);
        const m = sevMeta[f.severity] || sevMeta.info;
        const hasVer = f.version && f.version !== 'detected';
        return `
          <div style="margin-bottom:12px;border:1px solid ${m.border};border-radius:8px;overflow:hidden;page-break-inside:avoid">
            <div style="background:${m.bg};padding:14px 20px;display:flex;justify-content:space-between;align-items:flex-start;gap:16px">
              <div style="flex:1">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
                  <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${m.dot};flex-shrink:0"></span>
                  <span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:${m.color}">${m.label}</span>
                  <span style="color:#d1d5db;font-size:10px">|</span>
                  <span style="font-size:11px;color:#6b7280;font-weight:500">${f.tech}${hasVer ? ' v' + f.version : ''}</span>
                </div>
                <div style="font-size:14px;font-weight:700;color:#111827;margin-bottom:6px">${ft.title}</div>
                <div style="font-size:13px;color:#374151;line-height:1.6">${ft.description}</div>
                ${ft.opportunity ? `
                <div style="margin-top:10px;padding:10px 14px;background:#fff;border:1px solid #e5e7eb;border-radius:6px;font-size:12px;color:#111827;display:flex;gap:8px;align-items:flex-start">
                  <span style="color:#4f46e5;font-weight:700;flex-shrink:0">${nl ? 'Aanbeveling' : 'Recommendation'}:</span>
                  <span style="color:#374151">${ft.opportunity}</span>
                </div>` : ''}
              </div>
              ${hasVer ? `<div style="flex-shrink:0;text-align:right;padding-left:8px"><div style="font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px">${nl ? 'Versie' : 'Version'}</div><div style="font-size:18px;font-weight:800;color:${m.dot};font-variant-numeric:tabular-nums">${f.version}</div></div>` : ''}
            </div>
          </div>`;
      }).join('');

  const recs = findings
    .filter(f => f.severity !== 'info')
    .map(f => findingText(f, lang).opportunity)
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i);

  const recSection = recs.length ? `
    <div style="margin-top:32px;page-break-inside:avoid">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#6b7280;margin-bottom:12px;padding-bottom:8px;border-bottom:2px solid #e5e7eb">${nl ? 'Aanbevelingen' : 'Recommendations'}</div>
      ${recs.map((r, i) => `
        <div style="display:flex;gap:14px;align-items:flex-start;padding:10px 0;border-bottom:1px solid #f3f4f6">
          <span style="flex-shrink:0;width:22px;height:22px;border-radius:50%;background:#4f46e5;color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;margin-top:1px">${i + 1}</span>
          <span style="font-size:13px;color:#374151;line-height:1.5">${r}</span>
        </div>`).join('')}
    </div>` : '';

  return `<!DOCTYPE html>
<html lang="${nl ? 'nl' : 'en'}">
<head>
<meta charset="UTF-8"/>
<title>${nl ? 'Website Audit Rapport' : 'Website Audit Report'} — ${esc(domain(lead.url))}</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, sans-serif; background: #f3f4f6; color: #111827; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.page { max-width: 860px; margin: 32px auto; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,.1); }
@media print {
  body { background: #fff; }
  .page { max-width: 100%; margin: 0; border-radius: 0; box-shadow: none; }
  @page { margin: 15mm 15mm; size: A4; }
}
</style>
</head>
<body>
<div class="page">
<div style="background:#1e1b4b;color:#fff;padding:32px 40px;display:flex;justify-content:space-between;align-items:flex-end">
  <div>
    <div style="font-size:10px;text-transform:uppercase;letter-spacing:2px;color:#a5b4fc;margin-bottom:10px;font-weight:600">LeadGen Scanner</div>
    <div style="font-size:24px;font-weight:800;letter-spacing:-.3px;line-height:1.1">${nl ? 'Website Audit Rapport' : 'Website Audit Report'}</div>
    <div style="font-size:14px;color:#c7d2fe;margin-top:6px">${esc(domain(lead.url))}</div>
  </div>
  <div style="text-align:right">
    <div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#a5b4fc;margin-bottom:4px">${nl ? 'Scandatum' : 'Scan date'}</div>
    <div style="font-size:14px;font-weight:600;color:#e0e7ff">${scanDate}</div>
  </div>
</div>

<div style="background:#f8fafc;border-bottom:1px solid #e5e7eb;padding:14px 40px;display:flex;gap:32px;flex-wrap:wrap">
  <div style="font-size:12px;color:#6b7280"><span style="font-weight:600;color:#374151;margin-right:6px">Website:</span><a href="${esc(lead.url)}" style="color:#4f46e5;text-decoration:none">${esc(lead.url)}</a></div>
  ${lead.name ? `<div style="font-size:12px;color:#6b7280"><span style="font-weight:600;color:#374151;margin-right:6px">${nl ? 'Bedrijf' : 'Company'}:</span>${esc(lead.name)}</div>` : ''}
</div>

<div style="padding:36px 40px">
  <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#6b7280;margin-bottom:12px;padding-bottom:8px;border-bottom:2px solid #e5e7eb">${nl ? 'Samenvatting' : 'Executive Summary'}</div>
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:32px">
    <div style="border:1px solid #fca5a5;border-radius:8px;padding:18px 20px;background:#fef2f2">
      <div style="font-size:32px;font-weight:800;color:#dc2626;line-height:1">${counts.critical}</div>
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:#b91c1c;margin-top:6px;font-weight:600">${nl ? 'Kritieke problemen' : 'Critical issues'}</div>
    </div>
    <div style="border:1px solid #fcd34d;border-radius:8px;padding:18px 20px;background:#fffbeb">
      <div style="font-size:32px;font-weight:800;color:#d97706;line-height:1">${counts.warning}</div>
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:#92400e;margin-top:6px;font-weight:600">${nl ? 'Waarschuwingen' : 'Warnings'}</div>
    </div>
    <div style="border:1px solid #93c5fd;border-radius:8px;padding:18px 20px;background:#eff6ff">
      <div style="font-size:32px;font-weight:800;color:#2563eb;line-height:1">${counts.info}</div>
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:#1e3a8a;margin-top:6px;font-weight:600">${nl ? 'Informatief' : 'Informational'}</div>
    </div>
  </div>

  <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#6b7280;margin-bottom:12px;padding-bottom:8px;border-bottom:2px solid #e5e7eb">${nl ? 'Bevindingen' : 'Findings'}</div>
  ${findingsHtml}

  ${recSection}
</div>

<div style="background:#f8fafc;border-top:1px solid #e5e7eb;padding:16px 40px;display:flex;justify-content:space-between;align-items:center">
  <div style="font-size:11px;color:#9ca3af">${nl ? 'Automatisch gegenereerd door LeadGen Scanner' : 'Generated by LeadGen Scanner'}</div>
  <div style="font-size:11px;color:#9ca3af">${scanDate}</div>
</div>
</div>
</body>
</html>`;
}

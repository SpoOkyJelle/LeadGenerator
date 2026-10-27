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
    const res = await fetch(SCANNER_URL + '/api/scan?url=' + encodeURIComponent(lead.url) + '&leadId=' + encodeURIComponent(id));
    const data = await res.json();
    scanResult = {
      success: data.success,
      findings: data.findings || [],
      contact: data.contact || null,
      profile: data.profile || null,
      screenshots: data.screenshots || (lead.scanResult && lead.scanResult.screenshots) || null,
      logo: data.logo || (lead.scanResult && lead.scanResult.logo) || null,
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
  // A published report follows the latest scan (same link, new content)
  if (lead.report && scanResult.success) await publishReport(id, { silent: true });
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
      const list = (Array.isArray(f.missing) ? f.missing : []).map(m => names[m] || m).join(', ');
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
    'Email Security': (() => {
      if (!nl) return { title: f.title, description: f.description, opportunity: f.opportunity };
      const dom = f.domain || '';
      const opp = 'Bied het instellen van e-mailbeveiliging (SPF, DKIM en DMARC) aan';
      if (f.issue === 'dmarc_none') return {
        title: 'DMARC staat alleen op monitoren (p=none)',
        description: 'Het DMARC-beleid voor ' + dom + ' staat op “none”: het rapporteert alleen en blokkeert vervalste e-mail niet. Met quarantine of reject wordt spoofing echt tegengehouden.',
        opportunity: 'Bied aan het DMARC-beleid aan te scherpen naar quarantine/reject' };
      if (f.issue === 'spf_missing') return {
        title: 'Geen SPF-record ingesteld',
        description: 'Het domein ' + dom + ' heeft geen SPF-record. SPF bepaalt welke servers namens het domein mogen mailen; zonder SPF belandt mail vaker in spam en is het domein makkelijker te vervalsen.',
        opportunity: opp };
      return {
        title: 'Geen DMARC-record — domein is te vervalsen',
        description: 'Het domein ' + dom + ' heeft geen DMARC-record, waardoor iedereen e-mail kan versturen die lijkt te komen van dit domein (spoofing/phishing) en de eigen mail vaker in spam belandt.',
        opportunity: opp };
    })(),
    'Exposed Files': (() => {
      if (!nl) return { title: f.title, description: f.description, opportunity: f.opportunity };
      if (f.issue === 'xmlrpc') return {
        title: 'WordPress XML-RPC staat aan',
        description: 'Het adres /xmlrpc.php is bereikbaar. Dit is een veelgebruikt doelwit voor brute-force-aanvallen en DDoS-versterking en is op moderne sites zelden nodig.',
        opportunity: 'Bied WordPress-hardening aan (XML-RPC uitschakelen)' };
      return {
        title: 'WordPress readme.html is openbaar toegankelijk' + (f.version ? ' (toont versie ' + f.version + ')' : ''),
        description: 'Het bestand /readme.html is bereikbaar' + (f.version ? ' en toont de exacte WordPress-versie (' + f.version + ')' : '') + '. Aanvallers gebruiken dit om passende exploits te vinden; het hoort afgeschermd of verwijderd te worden.',
        opportunity: 'Bied WordPress-hardening aan (bestanden afschermen, versie verbergen)' };
    })(),
    'Mixed Content': {
      title: nl ? 'Onveilige (http) inhoud op een beveiligde pagina' : f.title,
      description: nl ? 'De pagina laadt bronnen via onbeveiligd http' + (f.hosts && f.hosts.length ? ' van ' + f.hosts.slice(0, 3).join(', ') : '') + '. Browsers kunnen die blokkeren of het slotje afzwakken, waardoor de site onveilig of kapot lijkt.' : f.description,
      opportunity: nl ? 'Bied aan mixed content op te lossen en HTTPS volledig af te ronden' : f.opportunity,
    },
    'Broken Links': {
      title: nl ? f.count + ' gebroken link' + (f.count === 1 ? '' : 's') + ' gevonden' : f.title,
      description: nl ? 'Van ' + f.checked + ' gecontroleerde links op de homepage gaven er ' + f.count + ' een fout (dode link). Gebroken links irriteren bezoekers en schaden de SEO.' : f.description,
      opportunity: nl ? 'Bied een link-audit en reparatie aan' : f.opportunity,
    },
    'Accessibility': {
      title: nl ? f.missing + ' van ' + f.total + ' afbeeldingen zonder alt-tekst' : f.title,
      description: nl ? 'De meeste afbeeldingen op de homepage hebben geen alt-tekst. Schermlezers kunnen ze niet beschrijven en zoekmachines niet lezen, wat de toegankelijkheid en SEO schaadt.' : f.description,
      opportunity: nl ? 'Bied een toegankelijkheidsronde aan (alt-teksten en basis)' : f.opportunity,
    },
    'WordPress Plugins': {
      title: nl ? f.pluginCount + ' WordPress-plugin' + (f.pluginCount === 1 ? '' : 's') + ' gedetecteerd' : f.title,
      description: nl ? f.pluginCount + ' plugin(s)' + (f.themeCount ? ' en ' + f.themeCount + ' thema(’s)' : '') + ' gevonden' + (f.plugins && f.plugins.length ? ': ' + f.plugins.slice(0, 8).join(', ') + (f.plugins.length > 8 ? '…' : '') : '') + '. Elke plugin is extra aanvalsoppervlak, en verouderde plugins zijn de meest voorkomende manier waarop WordPress-sites gehackt worden.' : f.description,
      opportunity: nl ? 'Bied WordPress-onderhoud en plugin-updates aan' : f.opportunity,
    },
    'Tech Stack': {
      title: nl ? 'Ook gedetecteerd: ' + (f.items || []).join(', ') : f.title,
      description: nl ? 'Extra techniek gedetecteerd op de site: ' + (f.items || []).join(', ') + '.' : f.description,
      opportunity: f.opportunity,
    },
    'SEO Extras': (() => {
      const names = { 'canonical link': 'canonical-link', 'structured data': 'gestructureerde data (schema.org)', 'language attribute': 'taalkenmerk (lang)', 'favicon': 'favicon' };
      const list = (Array.isArray(f.missing) ? f.missing : []).map(m => names[m] || m).join(', ');
      return {
        title: nl ? 'SEO-extra’s ontbreken: ' + list : f.title,
        description: nl ? 'De homepage mist: ' + list + '. Die helpen zoekmachines en browsers de site goed te begrijpen en te tonen.' : f.description,
        opportunity: f.opportunity,
      };
    })(),
    'Social Sharing': {
      title: nl ? 'Geen social media-voorvertoning (Open Graph)' : f.title,
      description: nl ? 'De pagina heeft geen Open Graph- of Twitter Card-tags, dus bij delen op social media of in chat-apps verschijnt er geen titel, omschrijving of afbeelding.' : f.description,
      opportunity: nl ? 'Bied aan social media-voorvertoning (Open Graph) toe te voegen' : f.opportunity,
    },
    'Indexing': (() => {
      const list = (Array.isArray(f.missing) ? f.missing : []).join(nl ? ' en ' : ' and ');
      return {
        title: nl ? 'Ontbreekt: ' + list : f.title,
        description: nl ? 'De site heeft geen ' + list + '. Die helpen zoekmachines om alle pagina’s efficiënt te vinden en te indexeren.' : f.description,
        opportunity: nl ? 'Bied technische SEO-inrichting aan (robots.txt en sitemap)' : f.opportunity,
      };
    })(),
    'Page SEO': {
      title: nl ? f.count + ' pagina' + (f.count === 1 ? '' : '’s') + ' zonder paginatitel' : f.title,
      description: nl ? 'Enkele interne pagina’s hebben geen <title>. Elke pagina heeft een eigen titel nodig om goed in Google te verschijnen.' : f.description,
      opportunity: nl ? 'Bied SEO per pagina aan (unieke titels en omschrijvingen)' : f.opportunity,
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

const http = require('http');
const https = require('https');
const dns = require('dns').promises;
const { URL } = require('url');
const cheerio = require('cheerio');

const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

// ── fetchURL ──
function fetchURL(targetUrl, redirectsLeft = 6) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (e) {
      return reject(new Error(`Invalid URL: ${targetUrl}`));
    }

    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      rejectUnauthorized: false,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    };

    const req = transport.request(options, (res) => {
      const statusCode = res.statusCode;

      // Handle redirects
      if ([301, 302, 303, 307, 308].includes(statusCode) && res.headers.location) {
        if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
        let location = res.headers.location;
        // Handle relative redirects
        try {
          location = new URL(location, targetUrl).href;
        } catch (e) {
          return reject(new Error(`Bad redirect location: ${location}`));
        }
        res.resume();
        return fetchURL(location, redirectsLeft - 1).then(resolve).catch(reject);
      }

      let body = '';
      let size = 0;
      const MAX_SIZE = 1024 * 1024; // 1MB

      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_SIZE) {
          req.destroy();
          body += chunk.slice(0, MAX_SIZE - (size - chunk.length));
          return;
        }
        body += chunk;
      });

      res.on('end', () => {
        resolve({
          finalUrl: targetUrl,
          statusCode,
          headers: res.headers,
          body,
        });
      });

      res.on('error', reject);
    });

    req.setTimeout(15000, () => {
      req.destroy();
      reject(Object.assign(new Error('Request timed out after 15 seconds'), { code: 'ETIMEDOUT' }));
    });

    req.on('error', reject);
    req.end();
  });
}

// ── Current version data (fetched live, cached, with a built-in fallback) ──
// Fallback as of October 2026; only used when the live lookups fail.
const PHP_FALLBACK = [
  { cycle: '8.5', support: '2027-12-31', eol: '2029-12-31' },
  { cycle: '8.4', support: '2026-12-31', eol: '2028-12-31' },
  { cycle: '8.3', support: '2025-12-31', eol: '2027-12-31' },
  { cycle: '8.2', support: '2024-12-31', eol: '2026-12-31' },
  { cycle: '8.1', support: '2023-11-25', eol: '2025-12-31' },
  { cycle: '8.0', support: '2022-11-26', eol: '2023-11-26' },
  { cycle: '7.4', support: '2021-11-28', eol: '2022-11-28' },
];
const versionData = { php: PHP_FALLBACK, wpLatest: '7.1', fetchedAt: 0 };

async function refreshVersionData() {
  if (Date.now() - versionData.fetchedAt < 12 * 3600 * 1000) return;
  versionData.fetchedAt = Date.now();
  try {
    const r = await fetch('https://endoflife.date/api/php.json', { signal: AbortSignal.timeout(5000) });
    const list = await r.json();
    if (Array.isArray(list) && list.length) versionData.php = list;
  } catch { /* keep previous data */ }
  try {
    const r = await fetch('https://api.wordpress.org/core/version-check/1.7/', { signal: AbortSignal.timeout(5000) });
    const data = await r.json();
    const latest = data && data.offers && data.offers[0] && (data.offers[0].current || data.offers[0].version);
    if (latest) versionData.wpLatest = latest;
  } catch { /* keep previous data */ }
}

const isoToday = () => new Date().toISOString().slice(0, 10);
const asDate = (v) => (typeof v === 'string' ? v : null); // endoflife.date uses `false` for "no date yet"

// Returns 'eol' (no more security fixes), 'security' (security fixes only) or 'current'
function phpStatus(ver) {
  const [maj, min] = ver.split('.').map(Number);
  const cycle = `${maj}.${min || 0}`;
  const entry = versionData.php.find(e => String(e.cycle) === cycle);
  const today = isoToday();
  if (!entry) {
    const oldest = versionData.php[versionData.php.length - 1];
    const [oMaj, oMin] = String(oldest.cycle).split('.').map(Number);
    const older = maj < oMaj || (maj === oMaj && (min || 0) < oMin);
    return older ? { status: 'eol', cycle, eol: null } : { status: 'current', cycle, eol: null };
  }
  const eol = asDate(entry.eol);
  const support = asDate(entry.support);
  if (eol && eol < today) return { status: 'eol', cycle, eol };
  // Security-only is only worth flagging once the end is less than a year away
  const inAYear = new Date(Date.now() + 365 * 864e5).toISOString().slice(0, 10);
  if (support && support < today && eol && eol < inAYear) return { status: 'security', cycle, eol };
  return { status: 'current', cycle, eol };
}

// WordPress only patches recent branches; compare against the latest release
function wpStatus(ver) {
  const branch = (s) => { const [a, b] = String(s).split('.').map(Number); return (a || 0) * 10 + (b || 0); };
  const behind = branch(versionData.wpLatest) - branch(ver);
  if (behind >= 3) return { status: 'eol', behind };
  if (behind >= 1) return { status: 'outdated', behind };
  return { status: 'current', behind: 0 };
}

// ── analyze ──
function analyze({ finalUrl, headers, body }) {
  const findings = [];
  const $ = cheerio.load(body || '');

  // Helper to parse semver-like versions
  function parseVer(str) {
    const parts = (str || '').split('.').map(Number);
    return { major: parts[0] || 0, minor: parts[1] || 0, patch: parts[2] || 0, raw: str };
  }

  // 1. HTTPS check
  if (!finalUrl.startsWith('https://')) {
    findings.push({
      tech: 'SSL/HTTPS',
      version: null,
      severity: 'critical',
      title: 'No HTTPS / SSL',
      description: 'This site is served over plain HTTP. All data is transmitted unencrypted.',
      opportunity: 'Offer SSL certificate installation and HTTPS migration',
    });
  }

  // 2. PHP
  const poweredBy = headers['x-powered-by'] || '';
  const phpMatch = poweredBy.match(/PHP\/([\d.]+)/i);
  if (phpMatch) {
    const ver = phpMatch[1];
    const s = phpStatus(ver);
    let severity, title, description;
    if (s.status === 'eol') {
      severity = 'critical';
      title = `PHP ${ver} — End of Life, no security updates`;
      description = `The server runs PHP ${ver}. PHP ${s.cycle} has not received security updates${s.eol ? ` since ${s.eol}` : ' for a long time'}, so known vulnerabilities are no longer fixed.`;
    } else if (s.status === 'security') {
      severity = 'warning';
      title = `PHP ${ver} — Security fixes only, ends ${s.eol}`;
      description = `The server runs PHP ${ver}. PHP ${s.cycle} only receives security fixes until ${s.eol}; after that it becomes unsafe. An upgrade should be planned now.`;
    } else {
      severity = 'info';
      title = `PHP ${ver} — Supported`;
      description = `The server runs PHP ${ver}, which is still fully supported.`;
    }
    findings.push({
      tech: 'PHP',
      version: ver,
      severity,
      status: s.status,
      eolDate: s.eol,
      title,
      description,
      opportunity: 'Offer PHP upgrade and server maintenance',
    });
  }

  // 3. Server header
  const serverHeader = headers['server'] || '';
  if (serverHeader) {
    const apacheMatch = serverHeader.match(/Apache\/([\d.]+)/i);
    const nginxMatch = serverHeader.match(/nginx\/([\d.]+)/i);
    const iisMatch = serverHeader.match(/Microsoft-IIS\/([\d.]+)/i);

    if (apacheMatch) {
      const ver = apacheMatch[1];
      const v = parseVer(ver);
      const outdated = v.major < 2 || (v.major === 2 && v.minor < 4);
      findings.push({
        tech: 'Apache',
        version: ver,
        severity: outdated ? 'warning' : 'info',
        title: outdated ? `Apache ${ver} — Outdated` : `Apache ${ver}`,
        description: outdated
          ? `Apache ${ver} is below the recommended 2.4.x branch and may have unpatched vulnerabilities.`
          : `Apache ${ver} detected.`,
        opportunity: 'Offer server upgrade and hardening',
      });
    } else if (nginxMatch) {
      const ver = nginxMatch[1];
      const v = parseVer(ver);
      const outdated = v.major < 1 || (v.major === 1 && v.minor < 18);
      findings.push({
        tech: 'Nginx',
        version: ver,
        severity: outdated ? 'warning' : 'info',
        title: outdated ? `Nginx ${ver} — Outdated` : `Nginx ${ver}`,
        description: outdated
          ? `Nginx ${ver} is below 1.18.0 and may be missing important security fixes.`
          : `Nginx ${ver} detected.`,
        opportunity: 'Offer server upgrade and hardening',
      });
    } else if (iisMatch) {
      const ver = iisMatch[1];
      const v = parseVer(ver);
      findings.push({
        tech: 'Microsoft IIS',
        version: ver,
        severity: v.major < 10 ? 'warning' : 'info',
        title: v.major < 10 ? `IIS ${ver} — Outdated` : `IIS ${ver}`,
        description: v.major < 10
          ? `IIS ${ver} is an older version and may have unpatched vulnerabilities.`
          : `IIS ${ver} detected.`,
        opportunity: 'Offer server upgrade and hardening',
      });
    }
  }

  // 4. ASP.NET
  const aspNetVer = headers['x-aspnet-version'] || '';
  if (aspNetVer) {
    const v = parseVer(aspNetVer);
    const outdated = v.major < 4 || (v.major === 4 && v.minor < 8);
    findings.push({
      tech: 'ASP.NET',
      version: aspNetVer,
      severity: outdated ? 'warning' : 'info',
      title: outdated ? `ASP.NET ${aspNetVer} — Outdated` : `ASP.NET ${aspNetVer}`,
      description: outdated
        ? `ASP.NET ${aspNetVer} is below 4.8 and should be upgraded to .NET Core or the latest .NET.`
        : `ASP.NET ${aspNetVer} detected.`,
      opportunity: 'Offer .NET upgrade or migration to .NET Core',
    });
  }

  // 5. WordPress
  const metaGenerator = $('meta[name="generator"]').attr('content') || '';
  const wpApiLink = $('link[rel="https://api.w.org/"]').length > 0;
  const wpMetaMatch = metaGenerator.match(/WordPress\s+([\d.]+)/i);
  const isWP = wpMetaMatch || wpApiLink;

  if (isWP) {
    if (wpMetaMatch) {
      const ver = wpMetaMatch[1];
      const s = wpStatus(ver);
      const latest = versionData.wpLatest;
      let severity, title;
      if (s.status === 'eol') {
        severity = 'critical';
        title = `WordPress ${ver} — Severely Outdated`;
      } else if (s.status === 'outdated') {
        severity = 'warning';
        title = `WordPress ${ver} — Outdated`;
      } else {
        severity = 'info';
        title = `WordPress ${ver} — Up to date`;
      }
      findings.push({
        tech: 'WordPress',
        version: ver,
        severity,
        latest,
        title,
        description: severity === 'info'
          ? `Site is running WordPress ${ver}. Keep WordPress and plugins updated regularly.`
          : `Site is running WordPress ${ver}; the latest version is ${latest}. Outdated WordPress installations are a common attack target.`,
        opportunity: 'Offer WordPress maintenance, updates, and security hardening',
      });

      // 11. WP version exposed
      findings.push({
        tech: 'WordPress',
        version: ver,
        severity: 'info',
        title: 'WordPress version exposed publicly — a security risk',
        description: `The WordPress version (${ver}) is visible in the page source via the meta generator tag. Attackers can target known vulnerabilities for this version.`,
        opportunity: 'Offer WordPress maintenance, updates, and security hardening',
      });
    } else {
      findings.push({
        tech: 'WordPress',
        version: 'detected',
        severity: 'info',
        title: 'WordPress detected (version hidden)',
        description: 'WordPress was detected via API links but the version is not exposed in the page source.',
        opportunity: 'Offer WordPress maintenance, updates, and security hardening',
      });
    }
  }

  // 6. Drupal
  const xGenerator = headers['x-generator'] || '';
  const drupalMeta = metaGenerator.match(/Drupal\s*([\d.]*)/i);
  const drupalHeader = xGenerator.match(/Drupal\s*([\d.]*)/i);
  const drupalMatch = drupalMeta || drupalHeader;
  if (drupalMatch) {
    const ver = drupalMatch[1] || '';
    const v = parseVer(ver);
    findings.push({
      tech: 'Drupal',
      version: ver || 'detected',
      severity: ver && v.major < 10 ? 'warning' : 'info',
      title: ver && v.major < 10 ? `Drupal ${ver} — Outdated` : `Drupal ${ver || 'detected'}`,
      description: ver && v.major < 10
        ? `Drupal ${ver} is below version 10 and may not receive security updates.`
        : `Drupal detected${ver ? ` (v${ver})` : ''}.`,
      opportunity: 'Offer Drupal upgrade and maintenance',
    });
  }

  // 7. Joomla
  const joomlaMatch = metaGenerator.match(/Joomla!\s*([\d.]*)/i);
  if (joomlaMatch) {
    const ver = joomlaMatch[1] || '';
    const v = parseVer(ver);
    findings.push({
      tech: 'Joomla',
      version: ver || 'detected',
      severity: ver && v.major < 5 ? 'warning' : 'info',
      title: ver && v.major < 5 ? `Joomla ${ver} — Outdated` : `Joomla ${ver || 'detected'}`,
      description: ver && v.major < 5
        ? `Joomla ${ver} is below version 5 and may be missing critical security patches.`
        : `Joomla detected${ver ? ` (v${ver})` : ''}.`,
      opportunity: 'Offer Joomla upgrade or migration',
    });
  }

  // 8. jQuery
  const jqPattern = /jquery[.\-]([\d]+\.[\d]+\.[\d]+)(?:\.min)?\.js/i;
  $('script[src]').each((_, el) => {
    const src = $(el).attr('src') || '';
    const m = src.match(jqPattern);
    if (m) {
      const ver = m[1];
      const v = parseVer(ver);
      if (v.major < 3) {
        findings.push({
          tech: 'jQuery',
          version: ver,
          severity: 'warning',
          title: `jQuery ${ver} — Legacy version`,
          description: `jQuery ${ver} is a legacy version (below 3.x) with known XSS and security vulnerabilities.`,
          opportunity: 'Offer frontend modernization and jQuery upgrade',
        });
      }
    }
  });

  // 9. Bootstrap
  const bsPattern = /bootstrap[.\-]([\d]+\.[\d]+\.[\d]+)(?:\.min)?(?:\.css|\.js)/i;
  $('link[href], script[src]').each((_, el) => {
    const src = $(el).attr('href') || $(el).attr('src') || '';
    const m = src.match(bsPattern);
    if (m) {
      const ver = m[1];
      const v = parseVer(ver);
      if (v.major < 5) {
        findings.push({
          tech: 'Bootstrap',
          version: ver,
          severity: 'info',
          title: `Bootstrap ${ver} — Legacy`,
          description: `Bootstrap ${ver} is below version 5. The latest Bootstrap 5 has better features and dropped jQuery dependency.`,
          opportunity: 'Offer frontend redesign with modern Bootstrap 5',
        });
      }
    }
  });

  // 10. Security headers
  const securityHeaders = [
    'x-frame-options',
    'x-content-type-options',
    'strict-transport-security',
    'content-security-policy',
    'x-xss-protection',
  ];
  const missingHeaders = securityHeaders.filter(h => !headers[h]);
  if (missingHeaders.length >= 3) {
    findings.push({
      tech: 'Security Headers',
      version: null,
      severity: 'warning',
      title: `${missingHeaders.length} Security Headers Missing`,
      description: `The following security headers are not set: ${missingHeaders.join(', ')}. This leaves the site vulnerable to clickjacking, MIME sniffing, and XSS attacks.`,
      opportunity: 'Offer web security hardening service',
    });
  }

  // Sort: critical first, then warning, then info
  const order = { critical: 0, warning: 1, info: 2 };
  findings.sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));

  return findings;
}

// ── Extra checks (beyond the homepage HTML/headers analysis) ──
const tls = require('tls');

// SSL certificate: invalid, expired or expiring soon
function checkCertificate(hostname) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host: hostname, port: 443, servername: hostname, rejectUnauthorized: false, timeout: 8000 }, () => {
      const cert = socket.getPeerCertificate();
      const authorized = socket.authorized;
      const reason = socket.authorizationError ? String(socket.authorizationError) : null;
      socket.end();
      if (!cert || !cert.valid_to) return resolve(null);
      const validTo = new Date(cert.valid_to);
      const days = Math.floor((validTo - Date.now()) / 864e5);
      resolve({ validTo: validTo.toISOString().slice(0, 10), days, authorized, reason });
    });
    socket.on('error', () => resolve(null));
    socket.on('timeout', () => { socket.destroy(); resolve(null); });
  });
}

function certificateFinding(cert) {
  if (!cert) return null;
  if (cert.days < 0) {
    return { tech: 'SSL Certificate', severity: 'critical', status: 'expired', days: cert.days, validTo: cert.validTo,
      title: 'SSL certificate has expired',
      description: `The SSL certificate expired on ${cert.validTo}. Browsers show a full-page security warning to every visitor.` };
  }
  if (!cert.authorized && cert.reason && !/CERT_HAS_EXPIRED/.test(cert.reason)) {
    return { tech: 'SSL Certificate', severity: 'critical', status: 'invalid', validTo: cert.validTo, reason: cert.reason,
      title: 'SSL certificate is not valid',
      description: `Browsers do not trust the SSL certificate (${cert.reason}). Visitors may see a security warning.` };
  }
  if (cert.days <= 21) {
    return { tech: 'SSL Certificate', severity: cert.days <= 7 ? 'critical' : 'warning', status: 'expiring', days: cert.days, validTo: cert.validTo,
      title: `SSL certificate expires in ${cert.days} days`,
      description: `The SSL certificate expires on ${cert.validTo}. If it is not renewed in time, visitors get a security warning.` };
  }
  return null;
}

const TRACKERS = [
  [/googletagmanager\.com|gtag\(|google-analytics\.com/i, 'Google Analytics / Tag Manager'],
  [/connect\.facebook\.net|fbq\(/i, 'Meta Pixel'],
  [/static\.hotjar\.com|hotjar/i, 'Hotjar'],
  [/snap\.licdn\.com|linkedin insight/i, 'LinkedIn Insight'],
  [/analytics\.tiktok\.com/i, 'TikTok Pixel'],
];
const CONSENT_TOOLS = /cookiebot|cookieyes|complianz|onetrust|cookie-law-info|cookielawinfo|iubenda|borlabs|cookie-notice|cookiefirst|usercentrics|termly|klaro|cookie-script|consentmanager|didomi|quantcast|osano|tarteaucitron|moove_gdpr|gdpr-cookie|cc-window|cookieconsent/i;

// Visible text with a space between every element, so "Horst" + "info@x.nl" don't merge into one word
function pageText($) {
  const parts = [];
  $('body').find('*').contents().each((_, node) => {
    if (node.type === 'text' && !['script', 'style', 'noscript'].includes(node.parent && node.parent.name)) parts.push(node.data);
  });
  return parts.join(' ').replace(/\s+/g, ' ');
}

// Content checks: copyright year, mobile, SEO basics, privacy statement, cookie consent
function contentFindings($, html) {
  const findings = [];
  const text = pageText($);

  // Copyright year in the footer: an old year signals an unmaintained site
  const thisYear = new Date().getFullYear();
  const years = [...text.matchAll(/(?:©|\(c\)|copyright)\s*(?:\d{4}\s*[-–—]\s*)?(\d{4})/gi)]
    .map(m => Number(m[1])).filter(y => y >= 1995 && y <= thisYear);
  if (years.length) {
    const year = Math.max(...years);
    const age = thisYear - year;
    if (age >= 1) {
      findings.push({ tech: 'Copyright', severity: age >= 2 ? 'warning' : 'info', year,
        title: `Copyright notice still says ${year}`,
        description: `The footer shows © ${year}. To visitors this suggests the site has not been maintained for ${age} year(s).` });
    }
  }

  // Mobile: without a viewport tag phones show a zoomed-out desktop page
  if (!$('meta[name="viewport"]').length) {
    findings.push({ tech: 'Mobile', severity: 'warning',
      title: 'Not mobile-friendly',
      description: 'The page has no viewport setting, so phones show a zoomed-out desktop version. Google ranks such pages lower in mobile search.' });
  }

  // SEO basics
  const missing = [];
  if (!$('title').first().text().trim()) missing.push('title');
  if (!($('meta[name="description"]').attr('content') || '').trim()) missing.push('meta description');
  if (!$('h1').length) missing.push('h1 heading');
  if (missing.length) {
    findings.push({ tech: 'SEO', severity: missing.includes('title') || missing.length >= 2 ? 'warning' : 'info', missing,
      title: `SEO basics missing: ${missing.join(', ')}`,
      description: `The homepage has no ${missing.join(', ')}. These help Google show the site properly in search results.` });
  }

  // Privacy statement & cookie consent (required under the GDPR / AVG)
  const links = $('a').map((_, a) => (($(a).attr('href') || '') + ' ' + $(a).text()).toLowerCase()).get().join(' ');
  if (!/privacy|privacyverklaring|privacybeleid|privacy-policy|gegevensbescherming|datenschutz/.test(links)) {
    findings.push({ tech: 'Privacy', severity: 'warning',
      title: 'No privacy statement found',
      description: 'We could not find a link to a privacy statement on the homepage. Under the GDPR (AVG) every site that collects personal data, for example through a contact form, needs one.' });
  }
  const trackers = TRACKERS.filter(([re]) => re.test(html)).map(([, name]) => name);
  if (trackers.length && !CONSENT_TOOLS.test(html)) {
    findings.push({ tech: 'Cookies', severity: 'warning', trackers,
      title: 'Tracking without a cookie banner',
      description: `The site loads ${trackers.join(', ')} but no cookie consent tool was detected. Under the GDPR (AVG) visitors must give permission first.` });
  }
  return findings;
}

// Speed: Google PageSpeed (needs a free API key) or a simple server response time
async function speedFinding(url, responseMs, pagespeedKey) {
  if (pagespeedKey) {
    try {
      const api = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed?strategy=mobile&category=performance' +
        '&url=' + encodeURIComponent(url) + '&key=' + encodeURIComponent(pagespeedKey);
      const r = await fetch(api, { signal: AbortSignal.timeout(60000) });
      const j = await r.json();
      const lr = j.lighthouseResult;
      if (lr && lr.categories && lr.categories.performance) {
        const score = Math.round(lr.categories.performance.score * 100);
        const lcp = lr.audits['largest-contentful-paint'] && lr.audits['largest-contentful-paint'].displayValue;
        if (score >= 90) return null;
        return { tech: 'Performance', severity: score < 50 ? 'warning' : 'info', score, lcp: lcp || null, source: 'pagespeed',
          title: `Slow on mobile: PageSpeed score ${score}/100`,
          description: `Google PageSpeed gives the mobile site ${score}/100${lcp ? ` (main content visible after ${lcp})` : ''}. Slow sites lose visitors and rank lower in Google.` };
      }
    } catch { /* fall back to the response time below */ }
  }
  if (responseMs > 2000) {
    const s = (responseMs / 1000).toFixed(1);
    return { tech: 'Performance', severity: 'warning', responseMs, source: 'response',
      title: `Slow server: ${s} seconds before the page starts loading`,
      description: `The server took ${s} seconds to respond before anything could load. Visitors often leave after 3 seconds.` };
  }
  return null;
}

// ── Contact details (email, phone, KvK, socials) ──
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
// Addresses that are never the business itself: image names, placeholders, tracking/CDN services
const BAD_EMAIL = /\.(png|jpe?g|gif|webp|svg|css|js)$|@(sentry|sentry-next|wixpress|example|domain|email|yourdomain|jouwdomein|domein|test|w3|schema|godaddy|cloudflare|googlegroups)\.|^(name|naam|you|your|user|gebruiker|voorbeeld|jouw|uw)@|^[0-9a-f]{20,}@/i;
// Dutch numbers, allowing spaces, dots and dashes between digits ("030 - 123 45 67", "+31 (0)20 123 4567")
const PHONE_RE = /(?:\+31|0031|\b0)\s?(?:\(0\)\s?)?[1-9](?:[\s.\-]{0,3}\d){8}\b/g;
// Pages that usually hold contact details, best first
const CONTACT_PAGE_RE = [/contact|kontakt/i, /over-?ons|over_ons|about|wie-zijn-wij|team/i, /colofon|impressum/i, /privacy|disclaimer|voorwaarden|bereikbaar|locatie|route/i];

function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);?/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&commat;/gi, '@').replace(/&period;/gi, '.').replace(/&amp;/gi, '&');
}

// Cloudflare "email protection": the address is XOR-encoded in a hex string
function decodeCfEmail(hex) {
  try {
    const key = parseInt(hex.slice(0, 2), 16);
    let out = '';
    for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
    return out;
  } catch { return ''; }
}

// Store numbers in one local format so +31 20... and 020... count as the same number
function normalizePhone(p) {
  let d = String(p).replace(/\(0\)/, '').replace(/[^\d+]/g, '');
  if (d.startsWith('+31')) d = '0' + d.slice(3);
  else if (d.startsWith('0031')) d = '0' + d.slice(4);
  return /^0[1-9]\d{8}$/.test(d) ? d : null;
}

const ONE_EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/;

function cleanEmail(e) {
  let v = String(e);
  try { v = decodeURIComponent(v); } catch { /* keep as is */ }
  v = v.trim().replace(/^mailto:/i, '').split('?')[0].replace(/[.,;:)]+$/, '').toLowerCase();
  return ONE_EMAIL_RE.test(v) && !BAD_EMAIL.test(v) ? v : null;
}

function extractContacts($, rawHtml, baseUrl) {
  const emails = new Set();
  const phones = new Set();
  const html = decodeEntities(rawHtml || '');
  const addEmail = (e) => { const v = cleanEmail(e); if (v) emails.add(v); };
  const addPhone = (p) => { const v = normalizePhone(p); if (v) phones.add(v); };

  // 1. mailto: / tel: anywhere in the source (links, buttons, onclick handlers, scripts), any capitalisation
  for (const m of html.matchAll(/mailto:([^"'<>\s?&]+)/gi)) addEmail(m[1]);
  for (const m of html.matchAll(/tel:([+\d\s().\-]{9,24})/gi)) addPhone(m[1]);

  // 2. Cloudflare-protected addresses
  for (const m of html.matchAll(/data-cfemail="([0-9a-f]+)"/gi)) addEmail(decodeCfEmail(m[1]));
  for (const m of html.matchAll(/email-protection#([0-9a-f]+)/gi)) addEmail(decodeCfEmail(m[1]));

  // 3. Structured data (schema.org JSON-LD and microdata)
  $('script[type="application/ld+json"]').each((_, s) => {
    try {
      const walk = (o) => {
        if (!o || typeof o !== 'object') return;
        if (Array.isArray(o)) return o.forEach(walk);
        for (const [k, v] of Object.entries(o)) {
          if (/^email$/i.test(k) && typeof v === 'string') addEmail(v);
          else if (/^telephone$/i.test(k) && typeof v === 'string') addPhone(v);
          else walk(v);
        }
      };
      walk(JSON.parse($(s).contents().text()));
    } catch { /* invalid JSON-LD */ }
  });
  $('[itemprop="email"]').each((_, el) => addEmail($(el).attr('content') || $(el).text()));
  $('[itemprop="telephone"]').each((_, el) => addPhone($(el).attr('content') || $(el).text()));

  // 4. Visible text, including "info [at] bedrijf [dot] nl" style obfuscation
  const text = pageText($);
  (text.match(EMAIL_RE) || []).forEach(addEmail);
  const DOT = String.raw`\[dot\]|\(dot\)|\[punt\]|\(punt\)|\s+dot\s+|\s+punt\s+`;
  const obfuscated = new RegExp(String.raw`([a-z0-9._%+-]+)\s*(?:\[at\]|\(at\)|\{at\}|\[@\]|\(@\)|\s+at\s+|\s+apenstaartje\s+)\s*([a-z0-9-]+(?:(?:\.(?=[a-z0-9])|\s*(?:${DOT})\s*)[a-z0-9-]+)+)`, 'gi');
  for (const m of text.matchAll(obfuscated)) {
    addEmail(m[1] + '@' + m[2].replace(new RegExp(String.raw`\s*(?:${DOT})\s*`, 'gi'), '.').replace(/\s+/g, ''));
  }
  (text.match(PHONE_RE) || []).forEach(addPhone);

  // 5. Addresses in the raw source (e.g. in scripts or data attributes)
  (html.match(EMAIL_RE) || []).forEach(addEmail);

  const kvkMatch = text.match(/\b(?:k\.?v\.?k\.?|kamer van koophandel|chamber of commerce|coc)(?:[\s-]*(?:nummer|nr\.?|no\.?|number))?[\s:.#-]*(\d{4}\s?\d{4})\b/i);

  const socials = {};
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href') || '';
    if (!socials.facebook && /facebook\.com\/(?!sharer|share|dialog|plugins|tr\b)/i.test(href)) socials.facebook = href;
    if (!socials.instagram && /instagram\.com\/(?!p\/|explore)/i.test(href)) socials.instagram = href;
    if (!socials.linkedin && /linkedin\.com\/(company|in)\//i.test(href)) socials.linkedin = href;
  });

  // Same-site pages worth checking for contact details, best first
  const pages = [];
  let base;
  try { base = new URL(baseUrl); } catch { base = null; }
  if (base) {
    $('a[href]').each((_, a) => {
      const href = $(a).attr('href') || '';
      const label = ($(a).text() || '').trim().toLowerCase().slice(0, 60);
      const rank = CONTACT_PAGE_RE.findIndex(re => re.test(href) || re.test(label));
      if (rank < 0) return;
      try {
        const u = new URL(href, base);
        u.hash = '';
        if (u.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '') || !/^https?:$/.test(u.protocol)) return;
        if (/\.(pdf|jpe?g|png|docx?|zip)$/i.test(u.pathname)) return;
        if (!pages.some(p => p.url === u.href)) pages.push({ url: u.href, rank });
      } catch { /* ignore bad links */ }
    });
    pages.sort((x, y) => x.rank - y.rank);
  }

  return {
    emails: [...emails],
    phones: [...phones],
    kvk: kvkMatch ? kvkMatch[1].replace(/\s/g, '') : null,
    socials,
    contactPage: (pages.find(p => p.rank === 0) || {}).url || null,
    pages: pages.map(p => p.url),
  };
}

function mergeContacts(a, b) {
  if (!b) return a;
  const uniq = (x) => [...new Set(x)];
  return {
    emails: uniq([...a.emails, ...b.emails]),
    phones: uniq([...a.phones, ...b.phones]),
    kvk: a.kvk || b.kvk,
    socials: { ...b.socials, ...a.socials },
    contactPage: a.contactPage || b.contactPage,
    pages: a.pages,
  };
}

// Prefer an address on the site's own domain, and info@/contact@ style addresses
function bestEmail(emails, siteUrl) {
  if (!emails.length) return null;
  let host = '';
  try { host = new URL(siteUrl).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
  const score = (e) => (e.endsWith('@' + host) ? 2 : 0) + (/^(info|contact|hallo|hello|mail|office|kantoor|post)@/.test(e) ? 1 : 0);
  return [...emails].sort((x, y) => score(y) - score(x))[0];
}

// Homepage + up to 5 likely contact pages (fetched in parallel)
async function findContacts($, html, siteUrl) {
  let contact = extractContacts($, html, siteUrl);
  const candidates = contact.pages.filter(u => u.replace(/\/$/, '') !== siteUrl.replace(/\/$/, '')).slice(0, 5);
  // No contact link on the homepage? Try the usual address
  if (!contact.contactPage) {
    try { candidates.unshift(new URL('/contact', siteUrl).href); } catch { /* ignore */ }
  }
  const checked = [siteUrl];
  let aboutText = null;
  const results = await Promise.allSettled(candidates.map(u => fetchURL(u)));
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled' || r.value.statusCode >= 400) return;
    checked.push(candidates[i]);
    const page$ = cheerio.load(r.value.body || '');
    contact = mergeContacts(contact, extractContacts(page$, r.value.body, candidates[i]));
    if (!contact.contactPage && /contact/i.test(candidates[i])) contact.contactPage = candidates[i];
    // The "about us" page tells the AI what the business does, so messages can be more personal
    if (!aboutText && CONTACT_PAGE_RE[1].test(candidates[i])) aboutText = mainText(page$, 1200);
  });
  contact.email = bestEmail(contact.emails, siteUrl);
  contact.phone = contact.phones[0] || null;
  contact.pagesChecked = checked.length;
  delete contact.pages;
  return { contact, aboutText };
}

// Readable text from the main content (no navigation/footer), shortened
function mainText($, max) {
  const $c = $.root().clone();
  const c$ = cheerio.load($c.html() || '');
  c$('nav, header, footer, script, style, noscript, form, [class*="cookie"], [id*="cookie"], [class*="menu"]').remove();
  const scope = c$('main').length ? c$('main') : c$('body');
  const text = scope.text().replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

// ── Logo of a website ──
// Best guess first: schema.org logo, the WordPress/theme logo, a "logo" image in the header, then the app icon.
function logoCandidates($, baseUrl) {
  const out = [];
  const add = (src) => {
    if (!src || /^data:/i.test(src)) return;
    try { const u = new URL(src, baseUrl).href; if (!out.includes(u)) out.push(u); } catch { /* ignore */ }
  };
  $('script[type="application/ld+json"]').each((_, s) => {
    try {
      const walk = (o) => {
        if (!o || typeof o !== 'object') return;
        if (Array.isArray(o)) return o.forEach(walk);
        if (o.logo) add(typeof o.logo === 'string' ? o.logo : o.logo.url || o.logo.contentUrl);
        Object.values(o).forEach(v => typeof v === 'object' && walk(v));
      };
      walk(JSON.parse($(s).contents().text()));
    } catch { /* invalid JSON-LD */ }
  });
  const src = (el) => $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src');
  // Logos of brands they sell, partners, payment methods or quality marks are not their own logo
  const foreign = (el) => /merk|brand|partner|sponsor|klant|client|keurmerk|certific|payment|betaal|ideal|trustpilot|google|review|thuiswinkel|award/i
    .test([src(el), $(el).attr('alt'), $(el).attr('class'), $(el).parents('[class]').slice(0, 3).map((_, p) => $(p).attr('class')).get().join(' ')].join(' '));
  const isLogo = (el) => /logo/i.test([$(el).attr('class'), $(el).attr('id'), $(el).attr('alt'), src(el)].join(' '));
  const header = 'header, nav, [class*="header"], [id*="header"], [class*="navbar"], [class*="topbar"]';

  $('img.custom-logo, .custom-logo-link img, .site-logo img, .logo img, #logo img, img#logo, img.logo, .navbar-brand img, .brand img')
    .filter((_, el) => !foreign(el)).each((_, el) => add(src(el)));
  $(header).find('img').filter((_, el) => isLogo(el) && !foreign(el)).each((_, el) => add(src(el)));
  // A logo is usually an image linking to the homepage
  $('a[href="/"], a[href="./"], a[href="' + baseUrl + '"], a[href="' + baseUrl.replace(/\/$/, '') + '"]').find('img').slice(0, 2)
    .filter((_, el) => !foreign(el)).each((_, el) => add(src(el)));
  add($('link[rel="apple-touch-icon"]').attr('href'));
  add($('link[rel="icon"][sizes="192x192"], link[rel="icon"][sizes="180x180"]').attr('href'));
  $('img').filter((_, el) => isLogo(el) && !foreign(el)).slice(0, 2).each((_, el) => add(src(el)));
  return out.slice(0, 6);
}

// Downloads the first usable logo: an image, not tiny, not huge
async function fetchLogo($, baseUrl) {
  for (const url of logoCandidates($, baseUrl)) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' } });
      const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!r.ok || !/^image\/(png|jpe?g|svg\+xml|webp|gif)$/.test(type)) continue;
      const buffer = Buffer.from(await r.arrayBuffer());
      if (buffer.length < 300 || buffer.length > 600 * 1024) continue;
      return { url, type, buffer };
    } catch { /* try the next candidate */ }
  }
  return null;
}

async function fetchSiteLogo(siteUrl) {
  const page = await fetchWithWwwFallback(siteUrl);
  return fetchLogo(cheerio.load(page.body || ''), page.finalUrl);
}

// Short business profile for the AI: what the site says about itself
function siteProfile($, aboutText) {
  return {
    title: $('title').first().text().trim().slice(0, 200) || null,
    description: ($('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '').trim().slice(0, 400) || null,
    intro: mainText($, 600),
    about: aboutText,
  };
}

// ── Email & DNS security (SPF / DMARC / MX) ──
// A missing SPF/DMARC record lets anyone spoof the domain and hurts deliverability.
const MULTI_TLDS = new Set(['co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.za', 'com.br', 'co.jp']);
function registrableDomain(hostname) {
  const parts = String(hostname || '').replace(/^www\./, '').toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const last2 = parts.slice(-2).join('.');
  return MULTI_TLDS.has(last2) ? parts.slice(-3).join('.') : last2;
}

async function emailSecurityFindings(hostname) {
  const domain = registrableDomain(hostname);
  if (!domain) return [];
  const flat = (recs) => (recs || []).map(r => (Array.isArray(r) ? r.join('') : String(r)));
  const [mx, txt, dmarcTxt] = await Promise.all([
    dns.resolveMx(domain).catch(() => []),
    dns.resolveTxt(domain).catch(() => []),
    dns.resolveTxt('_dmarc.' + domain).catch(() => []),
  ]);
  const hasMx = mx.length > 0;
  const hasSpf = flat(txt).some(r => /^v=spf1/i.test(r.trim()));
  const dmarcRec = flat(dmarcTxt).find(r => /^v=DMARC1/i.test(r.trim()));
  const findings = [];

  if (!dmarcRec) {
    findings.push({ tech: 'Email Security', issue: 'dmarc_missing', severity: 'warning', domain, spf: hasSpf, mx: hasMx,
      title: 'No DMARC record — the domain can be spoofed',
      description: `The domain ${domain} has no DMARC record, so anyone can send email that appears to come from this domain (spoofing / phishing) and the company's own mail is more likely to land in spam.`,
      opportunity: 'Offer email authentication setup (SPF, DKIM and DMARC)' });
  } else {
    const policy = ((dmarcRec.match(/[;\s]p\s*=\s*([a-z]+)/i) || [])[1] || 'none').toLowerCase();
    if (policy === 'none') {
      findings.push({ tech: 'Email Security', issue: 'dmarc_none', severity: 'info', domain,
        title: 'DMARC is monitoring only (p=none)',
        description: `The DMARC policy for ${domain} is "none", which only reports and does not actually block spoofed email. A quarantine or reject policy stops spoofing.`,
        opportunity: 'Offer to tighten the DMARC policy to quarantine/reject' });
    }
  }
  if (!hasSpf) {
    findings.push({ tech: 'Email Security', issue: 'spf_missing', severity: 'info', domain, mx: hasMx,
      title: 'No SPF record set',
      description: `The domain ${domain} has no SPF record. SPF lists which servers may send mail for the domain; without it, messages are more easily marked as spam and the domain is easier to spoof.`,
      opportunity: 'Offer email authentication setup (SPF, DKIM and DMARC)' });
  }
  return findings;
}

// ── Deeper look at the homepage HTML (no extra requests) ──
// WordPress plugins/themes from asset URLs
function wpPluginFindings($) {
  const plugins = new Map();
  const themes = new Set();
  $('script[src], link[href]').each((_, el) => {
    const src = $(el).attr('src') || $(el).attr('href') || '';
    const p = src.match(/\/wp-content\/plugins\/([^/?#]+)[^?#]*(?:\?[^#]*\bver=([\d.]+))?/i);
    if (p) { const slug = p[1].toLowerCase(); plugins.set(slug, p[2] || plugins.get(slug) || null); }
    const th = src.match(/\/wp-content\/themes\/([^/?#]+)/i);
    if (th) themes.add(th[1].toLowerCase());
  });
  if (!plugins.size && !themes.size) return [];
  const list = [...plugins.entries()].map(([s, v]) => (v ? `${s} ${v}` : s));
  return [{
    tech: 'WordPress Plugins', severity: 'info', pluginCount: plugins.size, themeCount: themes.size, plugins: list.slice(0, 20),
    title: `${plugins.size} WordPress plugin${plugins.size === 1 ? '' : 's'} detected`,
    description: `Detected ${plugins.size} plugin(s)${themes.size ? ` and ${themes.size} theme(s)` : ''}${list.length ? ': ' + list.slice(0, 8).join(', ') + (list.length > 8 ? '…' : '') : ''}. Every plugin is extra attack surface, and outdated plugins are the most common way WordPress sites get hacked.`,
    opportunity: 'Offer WordPress maintenance and plugin updates',
  }];
}

function deepHomepageFindings($, headers, finalUrl, html, isWP) {
  const findings = [];
  const htmlLc = (html || '').toLowerCase();

  // Mixed content: insecure (http) resources on a secure (https) page
  if (finalUrl.startsWith('https://')) {
    const insecure = new Set();
    const addIf = (url) => { if (/^http:\/\//i.test(url || '')) { try { insecure.add(new URL(url).host); } catch { /* ignore */ } } };
    $('script[src], img[src], iframe[src], source[src], video[src], audio[src], embed[src]').each((_, el) => addIf($(el).attr('src')));
    $('link[rel]').each((_, el) => { if (/stylesheet|icon|preload|manifest/i.test($(el).attr('rel') || '')) addIf($(el).attr('href')); });
    if (insecure.size) {
      const hosts = [...insecure];
      findings.push({ tech: 'Mixed Content', severity: 'warning', hosts: hosts.slice(0, 5), count: insecure.size,
        title: 'Insecure (http) content on a secure page',
        description: `The page loads resources over plain http from ${hosts.slice(0, 3).join(', ')}${insecure.size > 3 ? ' and others' : ''}. Browsers may block these or weaken the padlock, so the site can look broken or insecure.`,
        opportunity: 'Offer to fix mixed content and complete the HTTPS migration' });
    }
  }

  // Extra technology (informational): page builder, JS framework, CDN/host
  const stack = [];
  if (/elementor/.test(htmlLc)) stack.push('Elementor');
  else if (/et_pb_|\bdivi\b/.test(htmlLc)) stack.push('Divi');
  else if (/js_composer|wpbakery/.test(htmlLc)) stack.push('WPBakery');
  else if (/fl-builder|beaver builder/.test(htmlLc)) stack.push('Beaver Builder');
  if ($('[data-reactroot]').length || /__next_data__|react-dom/.test(htmlLc)) stack.push('React');
  else if (/\bng-version=|\bng-app\b/.test(htmlLc)) stack.push('Angular');
  else if ($('[data-v-app], #__nuxt').length || /__vue__|data-v-[0-9a-f]{8}/.test(htmlLc)) stack.push('Vue');
  const cdn = headers['cf-ray'] ? 'Cloudflare'
    : headers['x-vercel-id'] ? 'Vercel'
    : headers['x-nf-request-id'] ? 'Netlify'
    : headers['x-amz-cf-id'] ? 'Amazon CloudFront'
    : /fastly/i.test(headers['x-served-by'] || headers['via'] || '') ? 'Fastly'
    : headers['x-github-request-id'] ? 'GitHub Pages'
    : null;
  if (cdn) stack.push(cdn);
  if (stack.length) {
    findings.push({ tech: 'Tech Stack', severity: 'info', items: stack,
      title: 'Also detected: ' + stack.join(', '),
      description: 'Extra technology detected on the site: ' + stack.join(', ') + '.' });
  }

  if (isWP) findings.push(...wpPluginFindings($));

  // SEO extras: canonical, structured data, language attribute, favicon
  const missingSeo = [];
  if (!$('link[rel="canonical"]').length) missingSeo.push('canonical link');
  if (!$('script[type="application/ld+json"]').length && !$('[itemscope]').length) missingSeo.push('structured data');
  if (!($('html').attr('lang') || '').trim()) missingSeo.push('language attribute');
  if (!$('link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]').length) missingSeo.push('favicon');
  if (missingSeo.length) {
    findings.push({ tech: 'SEO Extras', severity: 'info', missing: missingSeo,
      title: 'SEO extras missing: ' + missingSeo.join(', '),
      description: 'The homepage is missing: ' + missingSeo.join(', ') + '. These help search engines and browsers understand and present the site correctly.' });
  }

  // Social sharing preview (Open Graph / Twitter cards)
  if (!$('meta[property^="og:"]').length && !$('meta[name^="twitter:"]').length) {
    findings.push({ tech: 'Social Sharing', severity: 'info',
      title: 'No social sharing preview (Open Graph)',
      description: 'The page has no Open Graph or Twitter Card tags, so when it is shared on social media or in chat apps it shows no title, description or image preview.',
      opportunity: 'Offer to add social sharing (Open Graph) tags' });
  }

  // Image alt-text coverage (accessibility + SEO)
  const content = $('img').toArray().filter(el => { const s = $(el).attr('src') || ''; return s && !/^data:/i.test(s); });
  const noAlt = content.filter(el => !($(el).attr('alt') || '').trim());
  if (content.length >= 5 && noAlt.length / content.length > 0.5) {
    const bad = content.length >= 8 && noAlt.length / content.length >= 0.7;
    findings.push({ tech: 'Accessibility', severity: bad ? 'warning' : 'info', total: content.length, missing: noAlt.length,
      title: `${noAlt.length} of ${content.length} images have no alt text`,
      description: `Most images on the homepage have no alt text. Screen readers cannot describe them and search engines cannot read them, which hurts accessibility and SEO.`,
      opportunity: 'Offer an accessibility pass (alt texts and the basics)' });
  }

  // Indexability: a noindex instruction keeps the page out of search engines entirely
  const metaRobots = ($('meta[name="robots"]').attr('content') || '').toLowerCase();
  const xRobots = (headers['x-robots-tag'] || '').toLowerCase();
  if (/noindex/.test(metaRobots) || /noindex/.test(xRobots)) {
    const src = /noindex/.test(metaRobots) ? 'meta' : 'header';
    findings.push({ tech: 'Indexability', severity: 'critical', source: src,
      title: 'Page is set to "noindex" — hidden from search engines',
      description: `The homepage carries a noindex instruction (${src === 'meta' ? 'a meta robots tag' : 'the X-Robots-Tag header'}), telling Google and others not to list it. The site will not appear in search results.`,
      opportunity: 'Offer to remove the noindex so the site is found in Google again' });
  }

  // Local SEO: signals that help a local business be found on the map and contacted
  const bodyText = $('body').text();
  const ldText = $('script[type="application/ld+json"]').toArray().map(el => $(el).contents().text() || '').join(' ');
  const hasLocalSchema = /"@type"\s*:\s*"?(LocalBusiness|Organization|Store|Restaurant|[A-Za-z]+(?:Business|Store|Shop))"?/i.test(ldText);
  const hasTel = $('a[href^="tel:"]').length > 0;
  const hasMaps = /google\.[a-z.]+\/maps|maps\.google|\/maps\/embed|g\.page/i.test(html || '');
  const hasHours = /openingstijd|opening hours|open(?:ing)?\s*hours|"openinghours"|\b(?:ma|di|wo|do|vr|za|zo)\s*[-–]\s*(?:ma|di|wo|do|vr|za|zo)\b|\b(?:mon|tue|wed|thu|fri|sat|sun)\s*[-–]\s*(?:mon|tue|wed|thu|fri|sat|sun)\b/i.test(bodyText + ' ' + ldText);
  const hasAddress = /\b\d{4}\s?[A-Z]{2}\b/.test(bodyText) || /"(?:streetAddress|postalCode|addressLocality)"/i.test(ldText);
  const missLocal = [];
  if (!hasLocalSchema) missLocal.push('localBusinessSchema');
  if (!hasTel) missLocal.push('telLink');
  if (!hasAddress) missLocal.push('address');
  if (!hasHours) missLocal.push('openingHours');
  if (!hasMaps) missLocal.push('mapsEmbed');
  if (missLocal.length >= 2) {
    findings.push({ tech: 'Local SEO', severity: missLocal.includes('localBusinessSchema') && missLocal.length >= 3 ? 'warning' : 'info', missing: missLocal, total: 5,
      title: `Local SEO basics missing: ${missLocal.length} of 5`,
      description: 'The homepage is missing local-business signals that help it rank in Google Maps and local search and make it easy to contact: ' + missLocal.join(', ') + '.',
      opportunity: 'Offer local SEO setup (business schema, address, opening hours, click-to-call, map)' });
  }

  // Image optimisation: modern formats and lazy loading cut page weight on mobile
  const imgEls = $('img[src]').toArray();
  const srcs = imgEls.map(el => (($(el).attr('src') || '') + ' ' + ($(el).attr('srcset') || '')));
  const legacyImgs = srcs.filter(s => /\.(?:jpe?g|png|gif)(?:[?#]|\s|$)/i.test(s)).length;
  const modernImgs = srcs.filter(s => /\.(?:webp|avif)(?:[?#]|\s|$)/i.test(s)).length;
  const lazyImgs = $('img[loading="lazy"]').length;
  const totalImgs = $('img').length;
  const noModern = legacyImgs >= 6 && modernImgs === 0;
  const noLazy = totalImgs >= 12 && lazyImgs === 0;
  if (noModern || noLazy) {
    findings.push({ tech: 'Image Optimization', severity: 'info', total: totalImgs, legacy: legacyImgs, modern: modernImgs, lazy: lazyImgs, noModern, noLazy,
      title: 'Images are not optimised for the web',
      description: `The homepage has ${totalImgs} images` +
        (noModern ? ', all in older formats (JPEG/PNG/GIF) rather than modern WebP/AVIF' : '') +
        (noLazy ? (noModern ? ', and' : ',') + ' none use lazy loading' : '') +
        '. Optimised images and lazy loading make pages load noticeably faster, especially on mobile.',
      opportunity: 'Offer image optimisation (modern formats and lazy loading)' });
  }

  // Cookie security: cookies set without the standard protective flags
  const setCookies = headers['set-cookie'] || [];
  if (setCookies.length && finalUrl.startsWith('https://')) {
    const noSecure = setCookies.filter(c => !/;\s*secure/i.test(c)).length;
    const noHttpOnly = setCookies.filter(c => !/;\s*httponly/i.test(c)).length;
    const noSameSite = setCookies.filter(c => !/;\s*samesite/i.test(c)).length;
    if (noSecure || noHttpOnly) {
      findings.push({ tech: 'Cookie Security', severity: 'info', count: setCookies.length, noSecure, noHttpOnly, noSameSite,
        title: `${Math.max(noSecure, noHttpOnly)} of ${setCookies.length} cookies set without protective flags`,
        description: `The site sets ${setCookies.length} cookie(s), some missing the Secure, HttpOnly or SameSite flags. These flags stop visitors' cookies from being read over an insecure connection or stolen by malicious scripts.`,
        opportunity: 'Offer to secure cookies (Secure, HttpOnly and SameSite flags)' });
    }
  }
  return findings;
}

// ── Deeper checks that need extra requests (robots, sitemap, WP files, links) ──
async function headStatus(url, method = 'HEAD') {
  try {
    const r = await fetch(url, { method, redirect: 'follow', signal: AbortSignal.timeout(8000), headers: { 'User-Agent': UA_BROWSER } });
    return r.status;
  } catch { return 0; }
}

// Ask for compression explicitly and read the response's content-encoding header.
// We only need the headers, so the body is discarded (never decompressed).
function checkCompression(url) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(url); } catch { return resolve(null); }
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;
    const req = transport.request({
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: (parsed.pathname || '/') + parsed.search,
      method: 'GET',
      rejectUnauthorized: false,
      headers: { 'User-Agent': UA_BROWSER, 'Accept-Encoding': 'gzip, deflate, br, zstd' },
    }, (res) => {
      const encoding = (res.headers['content-encoding'] || '').toLowerCase();
      const status = res.statusCode;
      res.destroy(); // we only wanted the headers
      resolve({ encoding, status });
    });
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function deepFetchFindings(finalUrl, $, isWP) {
  const findings = [];
  let base;
  try { base = new URL(finalUrl); } catch { return findings; }
  const origin = base.origin;

  // robots.txt and sitemap.xml
  const robots = await fetchURL(origin + '/robots.txt').catch(() => null);
  const hasRobots = robots && robots.statusCode < 400 && /(^|\n)\s*(user-agent|disallow|sitemap)\s*:/i.test(robots.body || '');
  let hasSitemap = robots ? /(^|\n)\s*sitemap\s*:/i.test(robots.body || '') : false;
  if (!hasSitemap) {
    const sm = await fetchURL(origin + '/sitemap.xml').catch(() => null);
    hasSitemap = !!(sm && sm.statusCode < 400 && /<(urlset|sitemapindex)/i.test(sm.body || ''));
  }
  const missIdx = [];
  if (!hasRobots) missIdx.push('robots.txt');
  if (!hasSitemap) missIdx.push('sitemap.xml');
  if (missIdx.length) {
    findings.push({ tech: 'Indexing', severity: 'info', missing: missIdx,
      title: 'Missing ' + missIdx.join(' and '),
      description: `The site has no ${missIdx.join(' and ')}. These help search engines crawl and index all pages efficiently.`,
      opportunity: 'Offer SEO technical setup (robots.txt and sitemap)' });
  }

  // WordPress: exposed readme.html (version leak) and enabled xmlrpc.php
  if (isWP) {
    const [readme, xr] = await Promise.all([
      fetchURL(origin + '/readme.html').catch(() => null),
      fetchURL(origin + '/xmlrpc.php').catch(() => null),
    ]);
    if (readme && readme.statusCode === 200 && /wordpress/i.test(readme.body || '')) {
      const m = (readme.body || '').match(/Version\s+(\d+\.\d+(?:\.\d+)?)/i);
      findings.push({ tech: 'Exposed Files', issue: 'readme', severity: 'warning', version: m ? m[1] : null,
        title: 'WordPress readme.html is publicly accessible' + (m ? ` (reveals version ${m[1]})` : ''),
        description: `The file /readme.html is reachable${m ? ` and shows the exact WordPress version (${m[1]})` : ''}. Attackers use it to find matching exploits; it should be blocked or removed.`,
        opportunity: 'Offer WordPress hardening (block exposed files, hide the version)' });
    }
    if (xr && (xr.statusCode === 405 || (xr.statusCode === 200 && /XML-RPC server accepts POST/i.test(xr.body || '')))) {
      findings.push({ tech: 'Exposed Files', issue: 'xmlrpc', severity: 'warning',
        title: 'WordPress XML-RPC is enabled',
        description: 'The endpoint /xmlrpc.php is enabled. It is a common target for brute-force login and DDoS amplification attacks and is rarely needed on modern sites.',
        opportunity: 'Offer WordPress hardening (disable XML-RPC)' });
    }
  }

  // Broken links (sampled) and internal pages missing a title
  const internal = [];
  const external = [];
  const seen = new Set();
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href') || '';
    if (!href || /^(#|mailto:|tel:|javascript:|data:)/i.test(href)) return;
    let u; try { u = new URL(href, base); } catch { return; }
    if (!/^https?:$/.test(u.protocol)) return;
    u.hash = '';
    if (seen.has(u.href)) return;
    seen.add(u.href);
    const sameHost = u.hostname.replace(/^www\./, '') === base.hostname.replace(/^www\./, '');
    if (sameHost) {
      if (u.href !== finalUrl && !/\.(pdf|jpe?g|png|gif|zip|docx?|xlsx?)$/i.test(u.pathname)) internal.push(u.href);
    } else {
      external.push(u.href);
    }
  });
  const intSample = internal.slice(0, 6);
  const extSample = external.slice(0, 10);
  const broken = [];
  const pagesNoTitle = [];
  await Promise.allSettled([
    ...intSample.map(async (u) => {
      const r = await fetchURL(u).catch(() => null);
      if (!r) return;
      if (r.statusCode >= 400) { broken.push(u); return; }
      const p$ = cheerio.load(r.body || '');
      if (!p$('title').first().text().trim()) pagesNoTitle.push(u);
    }),
    ...extSample.map(async (u) => {
      let st = await headStatus(u, 'HEAD');
      if (st === 0 || st === 405 || st === 501) st = await headStatus(u, 'GET');
      if (st >= 400 && st < 600) broken.push(u);
    }),
  ]);
  if (broken.length) {
    findings.push({ tech: 'Broken Links', severity: broken.length >= 3 ? 'warning' : 'info', count: broken.length, links: broken.slice(0, 6), checked: intSample.length + extSample.length,
      title: `${broken.length} broken link${broken.length === 1 ? '' : 's'} found`,
      description: `Of ${intSample.length + extSample.length} links checked from the homepage, ${broken.length} returned an error (dead link). Broken links frustrate visitors and hurt SEO.`,
      opportunity: 'Offer a link audit and fixes' });
  }
  if (pagesNoTitle.length) {
    findings.push({ tech: 'Page SEO', severity: 'info', count: pagesNoTitle.length, pages: pagesNoTitle.slice(0, 6),
      title: `${pagesNoTitle.length} page${pagesNoTitle.length === 1 ? '' : 's'} without a title tag`,
      description: 'Some internal pages have no <title>. Each page needs its own title so it shows up correctly in Google.',
      opportunity: 'Offer per-page SEO (unique titles and descriptions)' });
  }

  // HTTPS enforcement, exposed secret files, and text compression (extra requests, run together)
  const [httpProbe, gitCfg, envFile, comp] = await Promise.all([
    base.protocol === 'https:' ? fetchURL('http://' + base.hostname + '/').catch(() => null) : Promise.resolve(null),
    fetchURL(origin + '/.git/config').catch(() => null),
    fetchURL(origin + '/.env').catch(() => null),
    checkCompression(finalUrl),
  ]);
  if (httpProbe && httpProbe.statusCode < 400 && typeof httpProbe.finalUrl === 'string' && httpProbe.finalUrl.startsWith('http://')) {
    findings.push({ tech: 'HTTPS Redirect', severity: 'warning',
      title: 'Visitors on http:// are not redirected to https://',
      description: 'Opening the site over plain http does not forward to the secure https version. Visitors and search engines can land on the unencrypted site, which weakens security and can split SEO value across two addresses.',
      opportunity: 'Offer to enforce HTTPS with a permanent redirect and HSTS' });
  }
  if (gitCfg && gitCfg.statusCode === 200 && /\brepositoryformatversion\b|\[core\]/i.test(gitCfg.body || '') && !/<html/i.test(gitCfg.body || '')) {
    findings.push({ tech: 'Exposed Files', issue: 'git', severity: 'critical',
      title: 'Git repository is publicly exposed (/.git/)',
      description: 'The /.git/ folder is reachable, which lets anyone download the full source code and its history — often including passwords and keys committed in the past. This is a serious security leak.',
      opportunity: 'Offer to block access to /.git/ and audit for leaked secrets' });
  }
  if (envFile && envFile.statusCode === 200 && /^\s*[A-Z][A-Z0-9_]*\s*=/m.test(envFile.body || '') && !/<html|<!doctype/i.test(envFile.body || '')) {
    findings.push({ tech: 'Exposed Files', issue: 'env', severity: 'critical',
      title: 'Configuration file (.env) is publicly accessible',
      description: 'The /.env file is reachable. These files usually hold passwords, API keys and database credentials in plain text — a critical security exposure.',
      opportunity: 'Offer to remove/block the .env file and rotate any exposed secrets' });
  }
  if (comp && comp.status === 200 && !/gzip|br|deflate|zstd/.test(comp.encoding || '')) {
    findings.push({ tech: 'Compression', severity: 'info',
      title: 'Text compression is not enabled',
      description: 'The server sends the homepage without gzip or Brotli compression, so the HTML, CSS and JavaScript are larger and slower to load than needed. Compression typically shrinks them by 60–80%.',
      opportunity: 'Offer to enable gzip/Brotli compression on the server' });
  }
  return findings;
}

// ── Full scan: homepage + extra checks + contact page ──
class ScanBlockedError extends Error {
  constructor(status) {
    super(`The website blocked the scan (HTTP ${status})`);
    this.code = 'blocked';
    this.httpStatus = status;
  }
}

// Network errors in plain words, with a code the dashboard can translate
const NETWORK_ERRORS = {
  ENOTFOUND: ['dns', 'This domain does not exist (no DNS record found).'],
  EAI_AGAIN: ['dns', 'This domain could not be looked up (DNS did not answer).'],
  ECONNREFUSED: ['refused', 'The server refused the connection.'],
  ECONNRESET: ['refused', 'The server closed the connection.'],
  ETIMEDOUT: ['timeout', 'The website did not respond within 15 seconds.'],
  EHOSTUNREACH: ['refused', 'The server could not be reached.'],
};

function friendlyNetworkError(err) {
  const known = NETWORK_ERRORS[err && err.code];
  if (!known) return err;
  return Object.assign(new Error(known[1]), { code: known[0] });
}

// Many sites only work with or without "www." - try the other form when the domain doesn't resolve
async function fetchWithWwwFallback(targetUrl) {
  try {
    return await fetchURL(targetUrl);
  } catch (err) {
    if (err.code !== 'ENOTFOUND') throw friendlyNetworkError(err);
    const u = new URL(targetUrl);
    u.hostname = u.hostname.startsWith('www.') ? u.hostname.slice(4) : 'www.' + u.hostname;
    try {
      return await fetchURL(u.href);
    } catch (err2) {
      throw friendlyNetworkError(err2.code === 'ENOTFOUND' ? err : err2);
    }
  }
}

async function scanSite(targetUrl, { pagespeedKey } = {}) {
  const started = Date.now();
  const [result] = await Promise.all([fetchWithWwwFallback(targetUrl), refreshVersionData()]);
  const responseMs = Date.now() - started;
  const code = result.statusCode;

  // Bot protection answered instead of the site: its page says nothing about the real website
  if ([401, 403, 429].includes(code)) throw new ScanBlockedError(code);

  // The site itself is broken: that is the finding, the error page's content is not worth checking
  if (code >= 400) {
    let cert = null;
    try { cert = result.finalUrl.startsWith('https://') ? await checkCertificate(new URL(result.finalUrl).hostname) : null; } catch { /* ignore */ }
    const certFinding = certificateFinding(cert);
    return {
      finalUrl: result.finalUrl,
      statusCode: code,
      findings: [
        { tech: 'Availability', severity: 'critical', httpStatus: code,
          title: `Website shows an error page (HTTP ${code})`,
          description: code === 404
            ? 'The homepage returns "not found" (404). Visitors and Google see an error page instead of the website.'
            : `The server returns an error (HTTP ${code}). Visitors see an error page instead of the website.` },
        ...(certFinding ? [certFinding] : []),
      ],
      contact: { emails: [], phones: [], kvk: null, socials: {}, contactPage: null, email: null, phone: null },
      certificate: cert,
    };
  }

  const findings = analyze(result);
  const $ = cheerio.load(result.body || '');

  findings.push(...contentFindings($, result.body || ''));

  // Is this a WordPress site? (used to decide the WP-specific deep checks)
  const isWP = /WordPress/i.test($('meta[name="generator"]').attr('content') || '') ||
    $('link[rel="https://api.w.org/"]').length > 0 || /\/wp-content\//i.test(result.body || '');

  // Deeper look at the homepage HTML (mixed content, tech stack, plugins, SEO extras, alt text)
  findings.push(...deepHomepageFindings($, result.headers, result.finalUrl, result.body || '', isWP));

  let hostname = null;
  try { hostname = new URL(result.finalUrl).hostname; } catch { /* ignore */ }
  const [cert, speed, emailFindings, deepFindings] = await Promise.all([
    result.finalUrl.startsWith('https://') && hostname ? checkCertificate(hostname) : null,
    speedFinding(result.finalUrl, responseMs, pagespeedKey),
    hostname ? emailSecurityFindings(hostname).catch(() => []) : Promise.resolve([]),
    deepFetchFindings(result.finalUrl, $, isWP).catch(() => []),
  ]);
  const certFinding = certificateFinding(cert);
  if (certFinding) findings.push(certFinding);
  if (speed) findings.push(speed);
  findings.push(...emailFindings, ...deepFindings);

  const [{ contact, aboutText }, logo] = await Promise.all([
    findContacts($, result.body || '', result.finalUrl),
    fetchLogo($, result.finalUrl).catch(() => null),
  ]);
  const profile = siteProfile($, aboutText);

  const order = { critical: 0, warning: 1, info: 2 };
  findings.sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));

  return { finalUrl: result.finalUrl, statusCode: result.statusCode, findings, contact, profile, logo, certificate: cert };
}

module.exports = { fetchURL, analyze, refreshVersionData, scanSite, fetchSiteLogo };

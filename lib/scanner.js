const http = require('http');
const https = require('https');
const { URL } = require('url');
const cheerio = require('cheerio');

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

// Content checks: copyright year, mobile, SEO basics, privacy statement, cookie consent
function contentFindings($, html) {
  const findings = [];
  const text = $('body').text().replace(/\s+/g, ' ');

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
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const BAD_EMAIL = /\.(png|jpe?g|gif|webp|svg)$|@(sentry|wixpress|example|domain|email|yourdomain|jouwdomein)\.|^(name|naam|info@domein|you|your)@/i;
// Dutch numbers, allowing spaces, dots and dashes between digits ("030 - 123 45 67", "+31 (0)20 123 4567")
const PHONE_RE = /(?:\+31|0031|\b0)\s?(?:\(0\)\s?)?[1-9](?:[\s.\-]{0,3}\d){8}\b/g;

function extractContacts($, baseUrl) {
  const emails = new Set();
  const phones = new Set();
  $('a[href^="mailto:"]').each((_, a) => {
    const e = decodeURIComponent(($(a).attr('href') || '').slice(7).split('?')[0]).trim().toLowerCase();
    if (e) emails.add(e);
  });
  $('a[href^="tel:"]').each((_, a) => {
    const p = ($(a).attr('href') || '').slice(4).replace(/[^\d+]/g, '');
    if (p.length >= 9) phones.add(p);
  });
  const text = $('body').text().replace(/\s+/g, ' ');
  (text.match(EMAIL_RE) || []).forEach(e => emails.add(e.toLowerCase()));
  (text.match(PHONE_RE) || []).forEach(p => phones.add(p.replace(/\(0\)/, '').replace(/[^\d+]/g, '')));

  const kvkMatch = text.match(/\bk\.?v\.?k\.?(?:[\s-]*(?:nummer|nr\.?|no\.?))?[\s:.#-]*(\d{8})\b/i);
  const socials = {};
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href') || '';
    if (!socials.facebook && /facebook\.com\/(?!sharer|share)/i.test(href)) socials.facebook = href;
    if (!socials.instagram && /instagram\.com\//i.test(href)) socials.instagram = href;
    if (!socials.linkedin && /linkedin\.com\/(company|in)\//i.test(href)) socials.linkedin = href;
  });

  let contactPage = null;
  $('a[href]').each((_, a) => {
    if (contactPage) return;
    const href = $(a).attr('href') || '';
    const label = ($(a).text() || '').toLowerCase();
    if (/contact/i.test(href) || /^\s*contact/.test(label)) {
      try {
        const u = new URL(href, baseUrl);
        if (u.hostname === new URL(baseUrl).hostname) contactPage = u.href;
      } catch { /* ignore bad links */ }
    }
  });

  return {
    emails: [...emails].filter(e => !BAD_EMAIL.test(e)),
    phones: [...phones],
    kvk: kvkMatch ? kvkMatch[1] : null,
    socials,
    contactPage,
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
    contactPage: a.contactPage,
  };
}

// Prefer an address on the site's own domain, and info@/contact@ style addresses
function bestEmail(emails, siteUrl) {
  if (!emails.length) return null;
  let host = '';
  try { host = new URL(siteUrl).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
  const score = (e) => (e.endsWith('@' + host) ? 2 : 0) + (/^(info|contact|hallo|hello|mail|office|kantoor)@/.test(e) ? 1 : 0);
  return [...emails].sort((x, y) => score(y) - score(x))[0];
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

  let hostname = null;
  try { hostname = new URL(result.finalUrl).hostname; } catch { /* ignore */ }
  const [cert, speed] = await Promise.all([
    result.finalUrl.startsWith('https://') && hostname ? checkCertificate(hostname) : null,
    speedFinding(result.finalUrl, responseMs, pagespeedKey),
  ]);
  const certFinding = certificateFinding(cert);
  if (certFinding) findings.push(certFinding);
  if (speed) findings.push(speed);

  let contact = extractContacts($, result.finalUrl);
  if (contact.contactPage && contact.contactPage !== result.finalUrl) {
    try {
      const page = await fetchURL(contact.contactPage);
      contact = mergeContacts(contact, extractContacts(cheerio.load(page.body || ''), contact.contactPage));
    } catch { /* contact page is optional */ }
  }
  contact.email = bestEmail(contact.emails, result.finalUrl);
  contact.phone = contact.phones[0] || null;

  const order = { critical: 0, warning: 1, info: 2 };
  findings.sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));

  return { finalUrl: result.finalUrl, statusCode: result.statusCode, findings, contact, certificate: cert };
}

module.exports = { fetchURL, analyze, refreshVersionData, scanSite };

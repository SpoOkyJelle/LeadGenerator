const express = require('express');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const cheerio = require('cheerio');
const Database = require('better-sqlite3');
const db = new Database('leads.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    name TEXT DEFAULT '',
    status TEXT DEFAULT 'new',
    notes TEXT DEFAULT '',
    created INTEGER NOT NULL,
    scan_result TEXT DEFAULT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS quotes (
    lead_id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated INTEGER NOT NULL
  )
`);

const app = express();
const PORT = 3001;

// ── CORS ──
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

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
      reject(new Error('Request timed out after 15 seconds'));
    });

    req.on('error', reject);
    req.end();
  });
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
    const v = parseVer(ver);
    let severity, title;
    if (v.major < 7) {
      severity = 'critical';
      title = `PHP ${ver} — End of Life (severely outdated)`;
    } else if (v.major === 7 || (v.major === 8 && v.minor === 0)) {
      severity = 'warning';
      title = `PHP ${ver} — End of Life`;
    } else if (v.major === 8 && v.minor === 1) {
      severity = 'warning';
      title = `PHP 8.1 — Security Support Only`;
    } else {
      severity = 'info';
      title = `PHP ${ver} — Current`;
    }
    findings.push({
      tech: 'PHP',
      version: ver,
      severity,
      title,
      description: `Server is running PHP ${ver}. ${v.major < 8 ? 'This version no longer receives security updates.' : 'Keep the server patched and up to date.'}`,
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
      const v = parseVer(ver);
      let severity, title;
      if (v.major < 6) {
        severity = 'critical';
        title = `WordPress ${ver} — Severely Outdated`;
      } else if (parseFloat(ver) < 6.6) {
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
        title,
        description: `Site is running WordPress ${ver}. ${severity !== 'info' ? 'Outdated WordPress installations are a common attack target.' : 'Keep WordPress and plugins updated regularly.'}`,
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

// ── Serve dashboard ──
app.use(express.static(__dirname));

// ── Routes ──

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/scan', async (req, res) => {
  let targetUrl = req.query.url;

  if (!targetUrl) {
    return res.json({ success: false, error: 'Missing url parameter', findings: [] });
  }

  // Ensure protocol
  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = 'https://' + targetUrl;
  }

  try {
    const result = await fetchURL(targetUrl);
    const findings = analyze(result);

    return res.json({
      success: true,
      url: result.finalUrl,
      statusCode: result.statusCode,
      findings,
      scannedAt: new Date().toISOString(),
    });
  } catch (err) {
    return res.json({
      success: false,
      error: err.message || 'Unknown error during scan',
      findings: [],
    });
  }
});

// ── JSON body parser ──
app.use(express.json());

// ── Leads CRUD ──

// GET all leads
app.get('/api/leads', (req, res) => {
  const rows = db.prepare(`
    SELECT l.*, q.data AS quote_data
    FROM leads l LEFT JOIN quotes q ON q.lead_id = l.id
    ORDER BY l.created DESC
  `).all();
  res.json(rows.map(r => ({
    ...r,
    scanResult: r.scan_result ? JSON.parse(r.scan_result) : null,
    quote: r.quote_data ? JSON.parse(r.quote_data) : null,
    scan_result: undefined,
    quote_data: undefined,
  })));
});

// POST create lead
app.post('/api/leads', (req, res) => {
  const { id, url, name, status, notes, created } = req.body;
  db.prepare('INSERT INTO leads (id, url, name, status, notes, created) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, url, name || '', status || 'new', notes || '', created || Date.now());
  res.json({ ok: true });
});

// PUT update lead
app.put('/api/leads/:id', (req, res) => {
  const { url, name, status, notes, scanResult } = req.body;
  db.prepare('UPDATE leads SET url=?, name=?, status=?, notes=?, scan_result=? WHERE id=?')
    .run(url, name || '', status || 'new', notes || '', scanResult ? JSON.stringify(scanResult) : null, req.params.id);
  res.json({ ok: true });
});

// DELETE lead
app.delete('/api/leads/:id', (req, res) => {
  db.prepare('DELETE FROM leads WHERE id=?').run(req.params.id);
  db.prepare('DELETE FROM quotes WHERE lead_id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── Settings (key/value, values stored as JSON) ──
app.get('/api/settings', (req, res) => {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) {
    try { out[r.key] = JSON.parse(r.value); } catch { /* skip bad row */ }
  }
  res.json(out);
});

const upsertSetting = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

app.put('/api/settings', (req, res) => {
  const body = req.body || {};
  db.transaction(() => {
    for (const [key, value] of Object.entries(body)) upsertSetting.run(key, JSON.stringify(value));
  })();
  res.json({ ok: true });
});

// ── Quotes (one per lead) ──
app.put('/api/quotes/:leadId', (req, res) => {
  db.prepare(
    'INSERT INTO quotes (lead_id, data, updated) VALUES (?, ?, ?) ON CONFLICT(lead_id) DO UPDATE SET data = excluded.data, updated = excluded.updated'
  ).run(req.params.leadId, JSON.stringify(req.body || {}), Date.now());
  res.json({ ok: true });
});

app.delete('/api/quotes/:leadId', (req, res) => {
  db.prepare('DELETE FROM quotes WHERE lead_id=?').run(req.params.leadId);
  res.json({ ok: true });
});

// ── Start ──
app.listen(PORT, () => {
  console.log(`LeadGen running at http://localhost:${PORT}`);
  const { exec } = require('child_process');
  if (process.platform === 'win32') exec(`start http://localhost:${PORT}`);
  else if (process.platform === 'darwin') exec(`open http://localhost:${PORT}`);
});

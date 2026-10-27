// ── Settings ──
const SERVICE_DEFS = [
  { tech: 'SSL/HTTPS',        hours: 1.5, nl: 'SSL-certificaat installeren en HTTPS-migratie',  en: 'SSL certificate installation and HTTPS migration' },
  { tech: 'PHP',              hours: 3,   nl: 'PHP-upgrade naar een ondersteunde versie',       en: 'PHP upgrade to a supported version' },
  { tech: 'WordPress',        hours: 4,   nl: 'WordPress- en plugin-updates, beveiliging',      en: 'WordPress core & plugin updates and hardening' },
  { tech: 'Drupal',           hours: 12,  nl: 'Drupal-upgrade en onderhoud',                    en: 'Drupal upgrade and maintenance' },
  { tech: 'Joomla',           hours: 12,  nl: 'Joomla-upgrade of migratie',                     en: 'Joomla upgrade or migration' },
  { tech: 'jQuery',           hours: 4,   nl: 'jQuery-upgrade en frontend-modernisering',       en: 'jQuery upgrade and frontend modernisation' },
  { tech: 'Bootstrap',        hours: 8,   nl: 'Frontend-update naar Bootstrap 5',               en: 'Frontend update to Bootstrap 5' },
  { tech: 'Apache',           hours: 2,   nl: 'Webserver (Apache) upgraden en beveiligen',      en: 'Web server (Apache) upgrade and hardening' },
  { tech: 'Nginx',            hours: 2,   nl: 'Webserver (Nginx) upgraden en beveiligen',       en: 'Web server (Nginx) upgrade and hardening' },
  { tech: 'Microsoft IIS',    hours: 4,   nl: 'Webserver (IIS) upgraden of migreren',           en: 'Web server (IIS) upgrade or migration' },
  { tech: 'ASP.NET',          hours: 16,  nl: 'Upgrade naar een moderne .NET-versie',           en: 'Upgrade to a modern .NET version' },
  { tech: 'Security Headers', hours: 1.5, nl: 'Beveiligingsheaders configureren',               en: 'Security header configuration' },
  { tech: 'Availability',     hours: 3,   nl: 'Website weer werkend maken en monitoren',        en: 'Get the website working again and monitor it' },
  { tech: 'SSL Certificate',  hours: 1,  nl: 'SSL-certificaat vernieuwen met automatische verlenging', en: 'SSL certificate renewal with auto-renewal' },
  { tech: 'Mobile',           hours: 8,   nl: 'Website mobielvriendelijk maken',                en: 'Make the website mobile-friendly' },
  { tech: 'Performance',      hours: 6,   nl: 'Snelheid van de website verbeteren',             en: 'Website speed optimisation' },
  { tech: 'SEO',              hours: 3,   nl: 'SEO-basis op orde brengen (titels, omschrijvingen, koppen)', en: 'SEO basics (titles, descriptions, headings)' },
  { tech: 'Privacy',          hours: 2,   nl: 'Privacyverklaring opstellen en plaatsen',        en: 'Write and add a privacy statement' },
  { tech: 'Cookies',          hours: 3,   nl: 'AVG-proof cookiemelding installeren',            en: 'GDPR-compliant cookie banner' },
  { tech: 'Copyright',        hours: 1,   nl: 'Content en footer bijwerken',                    en: 'Content and footer update' },
  { tech: 'Email Security',   hours: 2,   nl: 'E-mailbeveiliging instellen (SPF, DKIM, DMARC)', en: 'Email authentication setup (SPF, DKIM, DMARC)' },
  { tech: 'Exposed Files',    hours: 2,   nl: 'WordPress hardening (bestanden afschermen)',     en: 'WordPress hardening (block exposed files)' },
  { tech: 'Mixed Content',    hours: 2,   nl: 'Mixed content oplossen (volledige HTTPS)',       en: 'Fix mixed content (complete HTTPS)' },
  { tech: 'Broken Links',     hours: 2,   nl: 'Gebroken links opsporen en repareren',           en: 'Broken link audit and fixes' },
  { tech: 'Accessibility',    hours: 4,   nl: 'Toegankelijkheid verbeteren (alt-teksten, basis)', en: 'Accessibility pass (alt texts and basics)' },
];

const DEFAULT_SETTINGS = {
  companyName: '', contactName: '', email: '', phone: '', address: '', website: '',
  kvk: '', vatNumber: '', iban: '',
  hourlyRate: 75, vatRate: 21, validDays: 30, quotePrefix: 'OFF-', nextQuoteNumber: 1,
  introText: '', termsText: '',
  smtpHost: '', smtpPort: 587, smtpSecure: false, smtpUser: '', smtpFrom: '',
  autoRescanDays: 0,
  hours: {},
};

let settings = { ...DEFAULT_SETTINGS, hours: {} };

async function apiLoadSettings() {
  try {
    const s = await (await fetch('/api/settings')).json();
    settings = { ...DEFAULT_SETTINGS, ...s, hours: { ...(s.hours || {}) } };
    if (!settingsDirty) settingsBuilt = false;
  } catch {}
}

async function apiSaveSettings() {
  await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) });
}

function hoursFor(tech) {
  const h = settings.hours[tech];
  if (h !== undefined && h !== null && h !== '') return Number(h) || 0;
  const def = SERVICE_DEFS.find(d => d.tech === tech);
  return def ? def.hours : 1;
}

function serviceName(def) { return def[lang] || def.en; }

const money = (n) => new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(n || 0);

function formatQuoteNumber(prefix, n) {
  return (prefix || '') + new Date().getFullYear() + '-' + String(n).padStart(3, '0');
}

function renderSettings() {
  if (settingsBuilt) return;
  settingsBuilt = true;
  settingsDirty = false;
  const s = settings;

  const field = (key, label, o = {}) => {
    const common = ' id="set-' + key + '" data-setting="' + key + '" placeholder="' + esc(o.ph || '') + '" oninput="markDirty()"';
    let ctl = o.textarea
      ? '<textarea' + common + ' rows="' + (o.rows || 3) + '">' + esc(s[key]) + '</textarea>'
      : '<input' + common + ' type="' + (o.num ? 'number' : (o.type || 'text')) + '"' +
        (o.num ? ' data-num min="0" step="' + (o.step || 1) + '"' : '') + ' value="' + esc(s[key]) + '">';
    if (o.pre) ctl = '<div class="input-affix"><span>' + o.pre + '</span>' + ctl + '</div>';
    if (o.suf) ctl = '<div class="input-affix suffix">' + ctl + '<span>' + esc(o.suf) + '</span></div>';
    return '<div class="field' + (o.full ? ' full' : '') + '"><label for="set-' + key + '">' + esc(label) + '</label>' + ctl +
      (o.hint !== undefined ? '<div class="hint" id="hint-' + key + '">' + esc(o.hint) + '</div>' : '') + '</div>';
  };

  const section = (title, desc, body, flush) =>
    '<div class="card"><div class="card-head"><div><div class="card-title">' + esc(title) + '</div><div class="section-desc">' + esc(desc) + '</div></div></div>' +
    (flush ? body : '<div class="card-body">' + body + '</div>') + '</div>';

  const saveBtn = '<button class="btn btn-primary" onclick="saveSettings()"><i class="fa-solid fa-check"></i>' + esc(t('saveSettings')) + '</button>';

  const svcRows = SERVICE_DEFS.map((d, i) =>
    '<tr><td><div style="font-weight:500">' + esc(serviceName(d)) + '</div><div class="site-sub">' + esc(d.tech) + '</div></td>' +
    '<td style="text-align:right"><input class="num-input" type="number" min="0" step="0.25" data-hidx="' + i + '" value="' + esc(hoursFor(d.tech)) + '" oninput="markDirty()"></td>' +
    '<td class="date" style="text-align:right;color:var(--text-2)" id="price-' + i + '"></td></tr>').join('');

  $('view-settings').innerHTML =
    '<div class="narrow fade-in">' +
    '<div class="page-head"><div><h1 class="page-title">' + esc(t('settings')) + '</h1><p class="page-sub">' + esc(t('settingsSub')) + '</p></div>' +
      '<div class="head-actions" style="align-items:center"><span class="dirty" id="settings-dirty" hidden>' + esc(t('unsaved')) + '</span>' + saveBtn + '</div></div>' +
    '<div class="stack">' +
      section(t('business'), t('businessDesc'), '<div class="form-grid">' +
        field('companyName', t('sCompanyName'), { ph: 'Jouw Webbureau' }) +
        field('contactName', t('sContactName')) +
        field('email', t('sEmail'), { type: 'email', ph: 'info@jouwbedrijf.nl' }) +
        field('phone', t('sPhone'), { type: 'tel' }) +
        field('address', t('sAddress'), { textarea: true, rows: 2, full: true, ph: 'Straat 1\n1234 AB Plaats' }) +
        field('website', t('sWebsite'), { ph: 'jouwbedrijf.nl' }) +
        field('kvk', t('sKvk')) +
        field('vatNumber', t('sVatNumber'), { ph: 'NL000000000B01' }) +
        field('iban', t('sIban'), { ph: 'NL00 BANK 0000 0000 00' }) +
      '</div>' +
      // House style for the client report
      '<div class="brand-row">' +
        '<div class="field"><label>' + esc(t('sLogo')) + '</label>' +
          '<div class="logo-box" id="logo-box">' + logoPreviewHtml(s.logoDataUrl) + '</div>' +
          '<div style="display:flex;gap:6px;margin-top:8px">' +
            '<label class="btn btn-secondary btn-sm" style="cursor:pointer"><i class="fa-solid fa-upload"></i>' + esc(t('uploadLogo')) +
              '<input type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" hidden onchange="uploadLogo(this.files[0])"></label>' +
            '<button class="btn btn-ghost btn-sm" id="logo-remove" onclick="removeLogo()"' + (s.logoDataUrl ? '' : ' hidden') + '>' + esc(t('remove')) + '</button>' +
          '</div><div class="hint" style="margin-top:6px">' + esc(t('logoHint')) + '</div></div>' +
        '<div class="field"><label for="set-brandColor">' + esc(t('sBrandColor')) + '</label>' +
          '<div style="display:flex;gap:8px;align-items:center"><input type="color" id="set-brandColor" data-setting="brandColor" value="' + esc(/^#[0-9a-f]{6}$/i.test(s.brandColor || '') ? s.brandColor : '#1f3a5f') + '" oninput="markDirty()" style="width:52px;padding:3px;cursor:pointer">' +
          '<span class="hint">' + esc(t('brandColorHint')) + '</span></div></div>' +
      '</div>') +
      section(t('rates'), t('ratesDesc'), '<div class="form-grid">' +
        field('hourlyRate', t('sHourlyRate'), { num: true, step: 1, pre: '€' }) +
        field('vatRate', t('sVatRate'), { num: true, step: 1, suf: '%' }) +
        field('validDays', t('sValidDays'), { num: true, step: 1, suf: t('days') }) +
        field('quotePrefix', t('sQuotePrefix'), { ph: 'OFF-' }) +
        field('nextQuoteNumber', t('sNextNumber'), { num: true, step: 1, hint: '' }) +
      '</div>') +
      section(t('services'), t('servicesDesc'),
        '<div class="table-scroll"><table class="svc-table" style="min-width:480px"><thead><tr><th>' + esc(t('colService')) + '</th><th style="text-align:right">' + esc(t('colHours')) +
        '</th><th style="text-align:right">' + esc(t('colPrice')) + '</th></tr></thead><tbody>' + svcRows + '</tbody></table></div>', true) +
      section(t('texts'), t('textsDesc'),
        '<div class="form-grid">' +
        field('introText', t('sIntro'), { textarea: true, rows: 4, full: true, ph: t('defaultIntro') }) +
        field('termsText', t('sTerms'), { textarea: true, rows: 4, full: true, ph: t('defaultTerms') }) +
        '</div>') +
      section(t('ai'), t('aiDesc'),
        '<div class="field"><label for="set-apiKey">' + esc(t('sApiKey')) + '</label>' +
        '<input id="set-apiKey" type="password" autocomplete="off" spellcheck="false" placeholder="' + (s.anthropicApiKeySet ? '••••••••••••' : 'sk-ant-…') + '" oninput="markDirty()">' +
        '<div class="hint">' + esc(s.anthropicApiKeySet ? t('apiKeySet') : s.aiConfigured ? t('apiKeyEnv') : t('apiKeyHint')) + '</div></div>' +
        '<div style="margin-top:14px">' + field('anthropicWorkspaceId', t('sWorkspace'), { ph: 'wrkspc_…', hint: t('workspaceHint') }) + '</div>' +
        (s.anthropicApiKeySet ? '<div style="margin-top:12px"><button class="btn btn-ghost btn-sm" onclick="removeApiKey()"><i class="fa-solid fa-trash-can"></i>' + esc(t('removeKey')) + '</button></div>' : '')) +
      section(t('emailSettings'), t('emailSettingsDesc'),
        '<div class="form-grid">' +
          field('smtpHost', t('sSmtpHost'), { ph: 'smtp.gmail.com' }) +
          field('smtpPort', t('sSmtpPort'), { num: true, step: 1 }) +
          field('smtpUser', t('sSmtpUser'), { full: true, ph: 'jij@jouwbedrijf.nl' }) +
        '</div>' +
        '<div class="field"><label for="set-smtpPass">' + esc(t('sSmtpPass')) + '</label>' +
          '<input id="set-smtpPass" type="password" autocomplete="off" spellcheck="false" placeholder="' + (s.smtpPassSet ? '••••••••••••' : '') + '" oninput="markDirty()">' +
          '<div class="hint">' + esc(s.smtpPassSet ? t('smtpPassSetHint') : t('smtpHint')) + '</div></div>' +
        '<div style="margin-top:14px">' + field('smtpFrom', t('sSmtpFrom'), { full: true, type: 'email', ph: 'info@jouwbedrijf.nl', hint: t('smtpFromHint') }) + '</div>' +
        '<label class="check-row" style="margin-top:8px"><input type="checkbox" id="set-smtpSecure"' + (s.smtpSecure ? ' checked' : '') + ' onchange="markDirty()"><span>' + esc(t('sSmtpSecure')) + '</span></label>' +
        '<div style="margin-top:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
          '<button class="btn btn-secondary" id="smtp-test-btn" onclick="testSmtp()"><i class="fa-solid fa-plug-circle-check"></i>' + esc(t('testConnection')) + '</button>' +
          (s.smtpPassSet ? '<button class="btn btn-ghost btn-sm" onclick="removeApiKey(\'smtpPass\')"><i class="fa-solid fa-trash-can"></i>' + esc(t('removeKey')) + '</button>' : '') +
        '</div>') +
      section(t('shareSettings'), t('shareSettingsDesc'),
        '<div class="form-grid">' +
          field('publicReportUrl', t('sPublicReportUrl'), { full: true, ph: 'https://rapport.jouwbedrijf.nl', hint: s.publicReportUrl ? t('publicUrlActive', s.publicReportUrl) : t('publicUrlHint', s.reportPort || 3002) }) +
          field('bookingUrl', t('sBookingUrl'), { full: true, ph: 'https://calendly.com/jouwnaam/10min', hint: t('bookingHint') }) +
        '</div>' +
        '<details class="howto"><summary>' + esc(t('tunnelTitle')) + '</summary><ol>' +
          '<li>' + esc(t('tunnelStep1')) + '<code>winget install --id Cloudflare.cloudflared</code></li>' +
          '<li>' + esc(t('tunnelStep2')) + '<code>cloudflared tunnel --url http://localhost:' + (s.reportPort || 3002) + '</code></li>' +
          '<li>' + esc(t('tunnelStep3')) + '</li>' +
          '<li>' + esc(t('tunnelStep4')) + ' <a class="link" href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/" target="_blank" rel="noopener">Cloudflare docs</a></li>' +
        '</ol><p class="hint">' + esc(t('tunnelSafe')) + '</p></details>') +
      section(t('scannerSettings'), t('scannerSettingsDesc'),
        '<label class="check-row"><input type="checkbox" id="set-screenshots"' + (s.screenshotsEnabled !== false ? ' checked' : '') + ' onchange="markDirty()"><span><b>' + esc(t('sScreenshots')) + '</b><br><span class="hint">' +
          esc(s.screenshotBrowser ? t('screenshotsHint', s.screenshotBrowser) : t('noBrowser')) + '</span></span></label>' +
        '<div style="height:16px"></div>' +
        '<div class="field"><label for="set-autoRescan">' + esc(t('sAutoRescan')) + '</label>' +
          '<select id="set-autoRescan" data-setting="autoRescanDays" data-num onchange="markDirty()">' +
            [0, 7, 14, 30].map(n => '<option value="' + n + '"' + (Number(s.autoRescanDays) === n ? ' selected' : '') + '>' +
              esc(n === 0 ? t('rescanOff') : t('everyNDays', n)) + '</option>').join('') +
          '</select><div class="hint">' + esc(t('autoRescanHint')) + '</div></div>' +
        '<div style="height:16px"></div>' +
        '<div class="field"><label for="set-pagespeedKey">' + esc(t('sPagespeedKey')) + '</label>' +
        '<input id="set-pagespeedKey" type="password" autocomplete="off" spellcheck="false" placeholder="' + (s.pagespeedApiKeySet ? '••••••••••••' : 'AIza…') + '" oninput="markDirty()">' +
        '<div class="hint">' + esc(s.pagespeedApiKeySet ? t('apiKeySet') : t('pagespeedHint')) + '</div></div>' +
        (s.pagespeedApiKeySet ? '<div style="margin-top:12px"><button class="btn btn-ghost btn-sm" onclick="removeApiKey(\'pagespeedApiKey\')"><i class="fa-solid fa-trash-can"></i>' + esc(t('removeKey')) + '</button></div>' : '')) +
      section(t('accessSettings'), t('accessDesc'),
        (s.authEnabled
          ? '<div class="alert" style="margin-bottom:14px"><i class="fa-solid fa-lock" style="color:var(--green)"></i><div style="flex:1">' + esc(t('accessProtected')) + '</div>' +
              '<button class="btn btn-secondary btn-sm" onclick="logout()"><i class="fa-solid fa-right-from-bracket"></i>' + esc(t('logOut')) + '</button></div>'
          : '<div class="alert info" style="margin-bottom:14px"><i class="fa-solid fa-lock-open"></i><div style="flex:1">' + esc(t('accessOpen')) + '</div></div>') +
        '<div class="form-grid">' +
          '<div class="field"><label for="set-authPw">' + esc(t('sNewPassword')) + '</label><input id="set-authPw" type="password" autocomplete="new-password" spellcheck="false"></div>' +
          '<div class="field"><label for="set-authPw2">' + esc(t('sConfirmPassword')) + '</label><input id="set-authPw2" type="password" autocomplete="new-password" spellcheck="false"></div>' +
        '</div>' +
        '<div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap">' +
          '<button class="btn btn-primary" onclick="setPassword(' + (s.authEnabled ? 'true' : 'false') + ')"><i class="fa-solid fa-key"></i>' + esc(s.authEnabled ? t('changePassword') : t('enablePassword')) + '</button>' +
          (s.authEnabled ? '<button class="btn btn-ghost" onclick="askDisablePassword()"><i class="fa-solid fa-trash-can"></i>' + esc(t('removePassword')) + '</button>' : '') +
        '</div>') +
      section(t('dataBackup'), t('dataBackupDesc'),
        '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
          '<button class="btn btn-secondary" onclick="exportBackup()"><i class="fa-solid fa-download"></i>' + esc(t('exportBackup')) + '</button>' +
          '<label class="btn btn-secondary" style="cursor:pointer"><i class="fa-solid fa-upload"></i>' + esc(t('importBackup')) +
            '<input type="file" accept="application/json,.json" hidden onchange="importBackup(this.files[0]); this.value=\'\'"></label>' +
        '</div>' +
        '<div class="hint" style="margin-top:10px">' + esc(t('exportBackupHint')) + '</div>' +
        '<div class="hint" style="margin-top:6px">' + esc(t('importBackupHint')) + '</div>') +
      '<div style="display:flex;justify-content:flex-end">' + saveBtn + '</div>' +
    '</div></div>';

  updateSettingsPreview();
}

function logoPreviewHtml(dataUrl) {
  return dataUrl ? '<img src="' + esc(dataUrl) + '" alt="">' : '<span class="hint">' + esc(t('noLogo')) + '</span>';
}

// Logos are scaled down in the browser and stored as a small data URL (SVG is kept as is)
function uploadLogo(file) {
  if (!file) return;
  if (file.size > 3 * 1024 * 1024) { toast(t('logoTooBig'), 'error'); return; }
  const reader = new FileReader();
  reader.onload = () => {
    const done = (dataUrl) => {
      if (dataUrl.length > 600 * 1024) { toast(t('logoTooBig'), 'error'); return; }
      settings.logoDataUrl = dataUrl;
      $('logo-box').innerHTML = logoPreviewHtml(dataUrl);
      $('logo-remove').hidden = false;
      markDirty();
    };
    if (file.type === 'image/svg+xml') return done(reader.result);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 600 / img.width, 200 / img.height);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      done(c.toDataURL('image/png'));
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function removeLogo() {
  settings.logoDataUrl = '';
  $('logo-box').innerHTML = logoPreviewHtml('');
  $('logo-remove').hidden = true;
  markDirty();
}

function markDirty() {
  settingsDirty = true;
  const d = $('settings-dirty');
  if (d) d.hidden = false;
  updateSettingsPreview();
}

function updateSettingsPreview() {
  const rateEl = $('set-hourlyRate');
  if (!rateEl) return;
  const rate = parseFloat(rateEl.value) || 0;
  document.querySelectorAll('[data-hidx]').forEach(el => {
    const c = $('price-' + el.dataset.hidx);
    if (c) c.textContent = money((parseFloat(el.value) || 0) * rate);
  });
  const n = Math.max(1, parseInt($('set-nextQuoteNumber').value, 10) || 1);
  $('hint-nextQuoteNumber').textContent = t('sNumberPreview', formatQuoteNumber($('set-quotePrefix').value.trim(), n));
}

async function saveSettings() {
  document.querySelectorAll('[data-setting]').forEach(el => {
    settings[el.dataset.setting] = el.hasAttribute('data-num') ? (parseFloat(el.value) || 0) : el.value.trim();
  });
  settings.nextQuoteNumber = Math.max(1, Math.round(settings.nextQuoteNumber || 1));
  settings.publicReportUrl = String(settings.publicReportUrl || '').trim().replace(/\/+$/, '');
  if (settings.publicReportUrl && !/^https?:\/\//i.test(settings.publicReportUrl)) settings.publicReportUrl = 'https://' + settings.publicReportUrl;
  const shotsEl = $('set-screenshots');
  if (shotsEl) settings.screenshotsEnabled = shotsEl.checked;
  const smtpSecEl = $('set-smtpSecure');
  if (smtpSecEl) settings.smtpSecure = smtpSecEl.checked;
  document.querySelectorAll('[data-hidx]').forEach(el => {
    settings.hours[SERVICE_DEFS[el.dataset.hidx].tech] = parseFloat(el.value) || 0;
  });
  // Keys are only sent when a new one was typed; the server never sends them back.
  const secrets = {};
  for (const [inputId, key] of [['set-apiKey', 'anthropicApiKey'], ['set-pagespeedKey', 'pagespeedApiKey'], ['set-smtpPass', 'smtpPass']]) {
    const el = $(inputId);
    if (el && el.value.trim()) secrets[key] = el.value.trim();
  }
  const newKey = Object.keys(secrets).length > 0;
  settingsDirty = false;
  const d = $('settings-dirty');
  if (d) d.hidden = true;
  await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...settings, ...secrets }) });
  if (newKey) {
    await apiLoadSettings();
    if (view === 'settings') render();
  }
  toast(t('toastSettingsSaved'), 'success');
  apiLoad(); // report links depend on the public address
}

// Download the whole database as one JSON file (data stays local otherwise)
function exportBackup() {
  const a = document.createElement('a');
  a.href = '/api/backup';
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast(t('toastBackupExported'), 'success');
}

// Restore from an exported file. This replaces everything, so it goes through a confirm.
function importBackup(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try { data = JSON.parse(reader.result); } catch { data = null; }
    if (!data || data.app !== 'lead-generator' || !data.tables) { toast(t('toastRestoreFail'), 'error'); return; }
    openConfirm(t('importTitle'), t('importText'), t('importConfirm'), true, async () => {
      const res = await fetch('/api/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      if (!res.ok) { toast(t('toastRestoreFail'), 'error'); return; }
      const out = await res.json();
      await apiLoadSettings();
      await apiLoad();
      settingsBuilt = false;
      if (view === 'settings') render();
      toast(t('toastRestored', (out.counts && out.counts.leads) || 0), 'success');
    });
  };
  reader.readAsText(file);
}

// ── Access / password ──
async function setPassword(change) {
  const pw = ($('set-authPw') || {}).value || '';
  const pw2 = ($('set-authPw2') || {}).value || '';
  if (pw.length < 6) { toast(t('toastPwTooShort'), 'error'); return; }
  if (pw !== pw2) { toast(t('toastPwMismatch'), 'error'); return; }
  await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ authPassword: pw }) });
  // Get a session cookie straight away so enabling (or changing) never logs you out.
  await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) });
  await apiLoadSettings();
  settingsBuilt = false;
  render();
  toast(t(change ? 'toastPwChanged' : 'toastPwEnabled'), 'success');
}

function askDisablePassword() {
  openConfirm(t('disablePwTitle'), t('disablePwText'), t('removePassword'), true, async () => {
    await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ authDisable: true }) });
    await apiLoadSettings();
    settingsBuilt = false;
    render();
    toast(t('toastPwDisabled'), '');
  });
}

async function logout() {
  try { await fetch('/api/logout', { method: 'POST' }); } catch {}
  window.location.href = '/';
}

// Save first (so the server has the latest details) then ask it to connect to the mail server.
async function testSmtp() {
  const setBtn = (html, disabled) => { const b = $('smtp-test-btn'); if (b) { b.disabled = disabled; b.innerHTML = html; } };
  setBtn('<span class="spin"></span>' + esc(t('testing')), true);
  try {
    if (settingsDirty) await saveSettings();
    const res = await fetch('/api/smtp-test', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) toast(t('toastSmtpOk'), 'success');
    else toast(t('toastSmtpFail', data.message || data.error || ''), 'error');
  } catch {
    toast(t('toastSmtpFail', ''), 'error');
  }
  setBtn('<i class="fa-solid fa-plug-circle-check"></i>' + esc(t('testConnection')), false);
}

async function removeApiKey(key = 'anthropicApiKey') {
  await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [key]: null }) });
  settingsDirty = false;
  await apiLoadSettings();
  render();
  toast(t('toastKeyRemoved'), '');
}

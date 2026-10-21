// Screenshots of a lead's website (desktop + phone) using the Edge/Chrome already installed on this computer.
const fs = require('fs');
const path = require('path');

const SHOT_DIR = path.join(__dirname, '..', 'data', 'screenshots');

function findBrowser() {
  const candidates = [process.env.CHROME_PATH];
  if (process.platform === 'win32') {
    const pf = [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA].filter(Boolean);
    for (const base of pf) {
      candidates.push(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
      candidates.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
      '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/snap/bin/chromium');
  }
  return candidates.find(p => p && fs.existsSync(p)) || null;
}

// One shared browser, closed again after a minute without work
let browserPromise = null;
let idleTimer = null;

async function getBrowser() {
  clearTimeout(idleTimer);
  if (!browserPromise) {
    const executablePath = findBrowser();
    if (!executablePath) throw new Error('No Edge or Chrome found for screenshots');
    const puppeteer = require('puppeteer-core');
    browserPromise = puppeteer.launch({
      executablePath,
      headless: true,
      args: ['--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--mute-audio'],
    }).catch(err => { browserPromise = null; throw err; });
  }
  return browserPromise;
}

function scheduleClose() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    const p = browserPromise;
    browserPromise = null;
    try { (await p).close(); } catch { /* already closed */ }
  }, 60000);
}

// Click away cookie banners so the screenshot shows the actual site
async function dismissCookieBanners(page) {
  try {
    await page.evaluate(() => {
      const selectors = ['#onetrust-accept-btn-handler', '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
        '#CybotCookiebotDialogBodyButtonAccept', '.cky-btn-accept', '.cmplz-accept', '#cookie_action_close_header',
        '.cc-allow', '.cc-dismiss', '.cookie-notice-accept', '#cn-accept-cookie', '.iubenda-cs-accept-btn',
        '[data-cookiefirst-action="accept"]', '.borlabs-cookie .cookie-accept', '#didomi-notice-agree-button'];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) { el.click(); return; }
      }
      const re = /^\s*(alles?\s+)?(cookies\s+)?(accepteren|accepteer|akkoord|toestaan|alle cookies toestaan|ik ga akkoord|accept( all)?( cookies)?|allow( all)?( cookies)?|agree|i agree|got it|ok(é|ay)?|prima)\s*!?\s*$/i;
      const buttons = [...document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]')];
      const hit = buttons.find(b => re.test(b.innerText || b.value || '') && b.offsetParent !== null);
      if (hit) hit.click();
    });
    await new Promise(r => setTimeout(r, 900));
  } catch { /* page may have navigated */ }
}

// Close announcement / newsletter pop-ups that would cover the site in the screenshot
async function closePopups(page) {
  try {
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
      const containers = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], .modal, .popup, .pum, .elementor-popup-modal, .mfp-wrap, .fancybox-container, [class*="popup"], [class*="modal"]')].filter(visible);
      for (const box of containers) {
        const close = [...box.querySelectorAll('button, a, [role="button"], span, div')]
          .filter(visible)
          .find(el => /close|sluit/i.test((el.getAttribute('aria-label') || '') + ' ' + (el.className && el.className.baseVal === undefined ? el.className : '')) ||
                      /^\s*(×|✕|x|sluiten|sluit|close)\s*$/i.test(el.textContent || ''));
        if (close) close.click();
      }
    });
    await new Promise(r => setTimeout(r, 500));
  } catch { /* ignore */ }
}

async function shoot(browser, url, file, mobile) {
  const page = await browser.newPage();
  try {
    if (mobile) {
      await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1');
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    } else {
      await page.setViewport({ width: 1366, height: 860, deviceScaleFactor: 1 });
    }
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 }).catch(() => { /* use whatever loaded */ });
    await dismissCookieBanners(page);
    await closePopups(page);
    // Does the page fit on a phone, or do visitors have to scroll sideways?
    const overflow = mobile
      ? await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth).catch(() => 0)
      : 0;
    await page.screenshot({ path: file, type: 'jpeg', quality: 72 });
    return { overflow };
  } finally {
    await page.close().catch(() => {});
  }
}

// Returns { desktop, mobile } file names (or null when no browser is available), plus the phone overflow in px
async function takeScreenshots(url, baseName) {
  if (!findBrowser()) return null;
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const safe = String(baseName).replace(/[^a-z0-9_-]/gi, '');
  try {
    const browser = await getBrowser();
    const desktop = `${safe}-desktop.jpg`;
    const mobile = `${safe}-mobile.jpg`;
    const [, m] = await Promise.all([
      shoot(browser, url, path.join(SHOT_DIR, desktop), false),
      shoot(browser, url, path.join(SHOT_DIR, mobile), true),
    ]);
    return { desktop, mobile, mobileOverflow: m.overflow, takenAt: new Date().toISOString() };
  } catch (err) {
    console.error('Screenshot failed:', err.message);
    return null;
  } finally {
    scheduleClose();
  }
}

// Saves a downloaded image (e.g. a client's logo) next to the screenshots
function saveImage(baseName, buffer, type) {
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/svg+xml': 'svg', 'image/webp': 'webp', 'image/gif': 'gif' }[type];
  if (!ext) return null;
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const safe = String(baseName).replace(/[^a-z0-9_-]/gi, '');
  // Remove an older logo with a different extension
  for (const old of fs.readdirSync(SHOT_DIR)) if (old.startsWith(safe + '.')) fs.unlinkSync(path.join(SHOT_DIR, old));
  const file = `${safe}.${ext}`;
  fs.writeFileSync(path.join(SHOT_DIR, file), buffer);
  return file;
}

function screenshotPath(file) {
  const safe = path.basename(String(file));
  const full = path.join(SHOT_DIR, safe);
  return fs.existsSync(full) ? full : null;
}

module.exports = { findBrowser, takeScreenshots, screenshotPath, saveImage };

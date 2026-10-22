const nodemailer = require('nodemailer');
const { getSetting } = require('./db');

// All SMTP details live in the normal settings table; the password is a SECRET_KEY,
// so it is never sent back to the browser (see server.js).
function mailSettings() {
  return {
    host: String(getSetting('smtpHost') || '').trim(),
    port: Number(getSetting('smtpPort')) || 587,
    secure: getSetting('smtpSecure') === true, // true for port 465, false for 587 (STARTTLS)
    user: String(getSetting('smtpUser') || '').trim(),
    pass: String(getSetting('smtpPass') || ''),
    // What recipients see as the sender. Falls back to the login user / business email.
    fromEmail: String(getSetting('smtpFrom') || getSetting('email') || getSetting('smtpUser') || '').trim(),
    fromName: String(getSetting('companyName') || getSetting('contactName') || '').trim(),
  };
}

// Enough to attempt a send: a server, a login and a from-address.
function mailConfigured() {
  const s = mailSettings();
  return Boolean(s.host && s.user && s.pass && s.fromEmail);
}

function transporter(s) {
  return nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.secure,
    auth: { user: s.user, pass: s.pass },
  });
}

class MailError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

function fromHeader(s) {
  return s.fromName ? `"${s.fromName.replace(/"/g, '')}" <${s.fromEmail}>` : s.fromEmail;
}

// Translate nodemailer's errors into a small, stable set the UI can show.
function mapError(err) {
  const code = String(err && err.code || '');
  const msg = String(err && err.message || '');
  if (code === 'EAUTH' || /invalid login|auth/i.test(msg)) return new MailError('auth', 'The mail server rejected the username or password.');
  if (code === 'ECONNECTION' || code === 'ESOCKET' || code === 'ECONNREFUSED' || code === 'EDNS' || /getaddrinfo|ENOTFOUND/i.test(msg)) {
    return new MailError('connection', 'Could not reach the mail server. Check the host and port.');
  }
  if (code === 'ETIMEDOUT' || /timeout/i.test(msg)) return new MailError('timeout', 'The mail server did not respond in time.');
  return new MailError('send_failed', msg || 'Sending failed.');
}

async function verifyMail() {
  if (!mailConfigured()) throw new MailError('not_configured', 'SMTP is not configured yet.');
  const s = mailSettings();
  try {
    await transporter(s).verify();
  } catch (err) {
    throw mapError(err);
  }
}

async function sendMail({ to, subject, text }) {
  if (!mailConfigured()) throw new MailError('not_configured', 'SMTP is not configured yet.');
  if (!to || !/.+@.+\..+/.test(String(to))) throw new MailError('no_recipient', 'This lead has no valid email address.');
  const s = mailSettings();
  try {
    const info = await transporter(s).sendMail({
      from: fromHeader(s),
      to: String(to).trim(),
      subject: String(subject || '').trim() || '(no subject)',
      text: String(text || ''),
    });
    return { messageId: info.messageId };
  } catch (err) {
    throw mapError(err);
  }
}

module.exports = { mailConfigured, verifyMail, sendMail, MailError };

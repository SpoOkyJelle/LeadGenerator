// ── Saved messages ──
const FOLLOW_UP_DAYS = 5; // contacted this long ago without an outcome → follow up
let msgTab = 'planned';
let editingMsgId = null;
let msgEditDraft = null;
const expandedMsgs = new Set();

function isoDate(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function daysSince(ts) {
  const a = new Date(ts); a.setHours(0, 0, 0, 0);
  const b = new Date(); b.setHours(0, 0, 0, 0);
  return Math.round((b - a) / 864e5);
}

function lastSent(leadId) {
  return messages.filter(m => m.leadId === leadId && m.status === 'sent').sort((a, b) => b.sentAt - a.sentAt)[0] || null;
}

function followUpContext(leadId, d) {
  if (d.kind !== 'followup') return null;
  const m = lastSent(leadId);
  return m ? { body: m.body, daysAgo: daysSince(m.sentAt) } : null;
}

function channelIcon(ch) {
  const icon = ch === 'linkedin' ? 'fa-brands fa-linkedin' : ch === 'phone' ? 'fa-solid fa-phone' : 'fa-regular fa-envelope';
  return '<i class="' + icon + '" style="color:var(--muted)"></i>';
}

function channelLabel(ch) {
  return ch === 'linkedin' ? t('chLinkedin') : ch === 'phone' ? t('chPhone') : t('chEmail');
}

function msgWhen(m) {
  if (m.status === 'sent') return t('sentOn', fmtDate(m.sentAt));
  return m.planFor ? t('plannedFor', fmtLong(parseISODate(m.planFor))) : t('grpNoDate');
}

// Planned messages without a date count as "send whenever", so they're due too
function isDue(m) {
  return m.status !== 'sent' && (!m.planFor || m.planFor <= todayISO());
}

async function apiSaveMessage(m) {
  await fetch('/api/messages/' + encodeURIComponent(m.id), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(m) });
}

function draftToMessage(leadId, d, extra) {
  return {
    id: uid(), leadId, channel: d.channel, kind: d.kind || 'first',
    subject: d.channel === 'email' ? (d.subject || '') : '', body: d.body,
    reportMode: effectiveReport(d),
    created: Date.now(), status: 'planned', planFor: '', sentAt: null,
    ...extra,
  };
}

function msgText(m) {
  return (m.channel === 'email' && m.subject ? (lang === 'nl' ? 'Onderwerp: ' : 'Subject: ') + m.subject + '\n\n' : '') + m.body;
}

// Schedule modal
function openSchedule() {
  if (!outreachDraft || !outreachDraft.body.trim()) return;
  const d = new Date();
  d.setDate(d.getDate() + 1);
  setScheduleDate(isoDate(d));
  $('schedule').classList.add('open');
}

function closeSchedule() { $('schedule').classList.remove('open'); }

function setScheduleDate(iso) {
  $('schedule-date').value = iso;
  renderScheduleChips();
}

function renderScheduleChips() {
  const toMonday = ((8 - new Date().getDay()) % 7) || 7;
  const opts = [['qToday', 0], ['qTomorrow', 1], ['qIn3', 3], ['qNextWeek', toMonday]];
  const cur = $('schedule-date').value;
  $('schedule-chips').innerHTML = opts.map(([k, n]) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    const iso = isoDate(d);
    return '<button class="chip' + (iso === cur ? ' active' : '') + '" onclick="setScheduleDate(\'' + iso + '\')">' + esc(t(k)) + '</button>';
  }).join('');
}

$('schedule-date').addEventListener('input', renderScheduleChips);

async function confirmSchedule() {
  const l = currentLead();
  if (!l || !outreachDraft) return;
  const m = draftToMessage(l.id, outreachDraft, { planFor: $('schedule-date').value || '' });
  closeSchedule();
  await apiSaveMessage(m);
  messages.unshift(m);
  render();
  toast(t('toastMsgSaved'), 'success');
}

async function sendDraftNow() {
  const l = currentLead();
  if (!l || !outreachDraft || !outreachDraft.body.trim()) return;
  const m = draftToMessage(l.id, outreachDraft, { status: 'sent', sentAt: Date.now() });
  await apiSaveMessage(m);
  messages.unshift(m);
  if (l.status === 'new') await saveLead(l.id, { status: 'contacted' });
  render();
  toast(t('toastMsgSent'), 'success');
}

async function markMsgSent(id) {
  const m = messages.find(x => x.id === id);
  if (!m) return;
  m.status = 'sent';
  m.sentAt = Date.now();
  await apiSaveMessage(m);
  const l = leads.find(x => x.id === m.leadId);
  if (l && l.status === 'new') await saveLead(l.id, { status: 'contacted' });
  render();
  toast(t('toastMsgSent'), 'success');
}

async function setMsgDate(id, iso) {
  const m = messages.find(x => x.id === id);
  if (!m) return;
  m.planFor = iso;
  await apiSaveMessage(m);
  render();
}

function askDeleteMsg(id) {
  openConfirm(t('deleteMsgTitle'), t('deleteMsgText'), t('delete'), true, async () => {
    await fetch('/api/messages/' + encodeURIComponent(id), { method: 'DELETE' });
    messages = messages.filter(m => m.id !== id);
    render();
    toast(t('toastMsgDeleted'), '');
  });
}

function copyMsg(id) {
  const m = messages.find(x => x.id === id);
  if (m) navigator.clipboard.writeText(msgText(m)).then(() => toast(t('toastCopiedMsg'), 'success'));
}

function openMsgMail(id) {
  const m = messages.find(x => x.id === id);
  if (!m) return;
  const l = leads.find(x => x.id === m.leadId);
  location.href = mailtoFor(l && l.email, m.subject, m.body);
}

function toggleMsg(id) {
  if (expandedMsgs.has(id)) expandedMsgs.delete(id); else expandedMsgs.add(id);
  render();
}

function editMsg(id) {
  const m = messages.find(x => x.id === id);
  if (!m) return;
  editingMsgId = id;
  msgEditDraft = { subject: m.subject || '', body: m.body };
  render();
  const b = $('me-body');
  if (b) b.focus();
}

function cancelMsgEdit() {
  editingMsgId = null;
  msgEditDraft = null;
  render();
}

async function saveMsgEdit(id) {
  const m = messages.find(x => x.id === id);
  if (!m || !msgEditDraft) return;
  m.subject = msgEditDraft.subject;
  m.body = msgEditDraft.body;
  editingMsgId = null;
  msgEditDraft = null;
  await apiSaveMessage(m);
  render();
  toast(t('toastSaved'), 'success');
}

function setMsgTab(tab) { msgTab = tab; render(); }

function msgCard(m) {
  const l = leads.find(x => x.id === m.leadId);
  const dom = l ? domain(l.url) : '';
  const id = esc(m.id);
  const expanded = expandedMsgs.has(m.id);
  const overdue = m.status !== 'sent' && m.planFor && m.planFor < todayISO();

  let h = '<div class="msg"><div class="msg-head">' + (l ? favicon(l.url) : '') +
    '<div class="grow"><a class="link" href="#/lead/' + encodeURIComponent(m.leadId) + '">' + esc(l ? (l.name || dom) : '—') + '</a>' +
    '<div style="font-size:12px;color:var(--muted);margin-top:1px">' + channelIcon(m.channel) + ' ' + esc(channelLabel(m.channel)) +
    (m.kind === 'followup' ? ' · ' + esc(t('kindFollow')) : '') + (dom ? ' · ' + esc(dom) : '') + '</div></div>' +
    (m.status === 'sent'
      ? '<span class="date">' + esc(t('sentOn', fmtDate(m.sentAt))) + '</span>'
      : '<input type="date" class="date-input' + (overdue ? ' overdue' : '') + '" value="' + esc(m.planFor || '') + '" onchange="setMsgDate(\'' + id + '\', this.value)" title="' + esc(t('sendOn')) + '">') +
    '</div>';

  if (editingMsgId === m.id && msgEditDraft) {
    h += (m.channel === 'email' ? '<input id="me-subject" value="' + esc(msgEditDraft.subject) + '" placeholder="' + esc(t('subjectPh')) + '" oninput="msgEditDraft.subject = this.value">' : '') +
      '<textarea id="me-body" class="doc-text" rows="10" oninput="msgEditDraft.body = this.value">' + esc(msgEditDraft.body) + '</textarea>' +
      '<div class="msg-actions"><button class="btn btn-primary btn-sm" onclick="saveMsgEdit(\'' + id + '\')"><i class="fa-solid fa-check"></i>' + esc(t('save')) + '</button>' +
      '<button class="btn btn-ghost btn-sm" onclick="cancelMsgEdit()">' + esc(t('cancel')) + '</button></div>';
  } else {
    h += (m.subject ? '<div class="msg-subject">' + esc(m.subject) + '</div>' : '') +
      '<div class="msg-body' + (expanded ? '' : ' clamp') + '">' + esc(m.body) + '</div>' +
      '<div class="msg-actions">' +
        '<button class="btn btn-ghost btn-sm" onclick="toggleMsg(\'' + id + '\')">' + esc(expanded ? t('showLess') : t('showAll')) + '</button>' +
        '<span style="flex:1"></span>' +
        '<button class="icon-btn danger" title="' + esc(t('delete')) + '" onclick="askDeleteMsg(\'' + id + '\')"><i class="fa-solid fa-trash-can"></i></button>' +
        '<button class="icon-btn" title="' + esc(t('edit')) + '" onclick="editMsg(\'' + id + '\')"><i class="fa-solid fa-pen"></i></button>' +
        '<button class="btn btn-secondary btn-sm" onclick="copyMsg(\'' + id + '\')"><i class="fa-regular fa-copy"></i>' + esc(t('copy')) + '</button>' +
        (m.reportMode === 'attach' && l && l.scanResult ? '<button class="btn btn-secondary btn-sm" onclick="downloadPdf(\'' + esc(m.leadId) + '\')" title="' + esc(t('repAttachHint')) + '"><i class="fa-solid fa-paperclip"></i>' + esc(t('downloadReport')) + '</button>' : '') +
        (m.channel === 'email' ? '<button class="btn btn-secondary btn-sm" onclick="openMsgMail(\'' + id + '\')"><i class="fa-regular fa-envelope"></i>' + esc(t('openMail')) + '</button>' : '') +
        (m.status !== 'sent'
          ? '<button class="btn btn-primary btn-sm" onclick="markMsgSent(\'' + id + '\')"><i class="fa-solid fa-paper-plane"></i>' + esc(t('markSent')) + '</button>'
          : '<a class="btn btn-secondary btn-sm" href="#/lead/' + encodeURIComponent(m.leadId) + '/outreach"><i class="fa-solid fa-reply"></i>' + esc(t('followUp')) + '</a>') +
      '</div>';
  }
  return h + '</div>';
}

function renderMessages() {
  const el = $('view-messages');
  const restore = captureFocus();
  const today = todayISO();
  const tomorrow = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return isoDate(d); })();
  const planned = messages.filter(m => m.status !== 'sent').sort((a, b) => (a.planFor || '9999').localeCompare(b.planFor || '9999'));
  const sent = messages.filter(m => m.status === 'sent').sort((a, b) => b.sentAt - a.sentAt);

  let html = '<div class="page-head"><div><h1 class="page-title">' + esc(t('messages')) + '</h1><p class="page-sub">' + esc(t('messagesSub')) + '</p></div>' +
    '<div class="seg"><button class="' + (msgTab === 'planned' ? 'active' : '') + '" onclick="setMsgTab(\'planned\')">' + esc(t('tabPlanned')) + '<span class="n">' + planned.length + '</span></button>' +
    '<button class="' + (msgTab === 'sent' ? 'active' : '') + '" onclick="setMsgTab(\'sent\')">' + esc(t('tabSent')) + '<span class="n">' + sent.length + '</span></button></div></div>';

  const emptyCard = (icon, title, hint) => '<div class="card empty"><div class="empty-icon"><i class="fa-solid ' + icon + '"></i></div><h3>' + esc(title) + '</h3><p>' + esc(hint) + '</p></div>';

  if (msgTab === 'planned') {
    if (!planned.length) {
      html += emptyCard('fa-paper-plane', t('noMessages'), t('noMessagesHint'));
    } else {
      const groups = [
        { key: 'overdue', label: t('grpOverdue'), items: planned.filter(m => m.planFor && m.planFor < today) },
        { key: 'today', label: t('grpToday'), items: planned.filter(m => m.planFor === today) },
        { key: 'tomorrow', label: t('grpTomorrow'), items: planned.filter(m => m.planFor === tomorrow) },
        { key: 'later', label: t('grpLater'), items: planned.filter(m => m.planFor && m.planFor > tomorrow) },
        { key: 'nodate', label: t('grpNoDate'), items: planned.filter(m => !m.planFor) },
      ];
      html += '<div class="card">' + groups.filter(g => g.items.length).map(g =>
        '<div class="group-label' + (g.key === 'overdue' ? ' overdue' : '') + '">' + esc(g.label) + ' · ' + g.items.length + '</div>' + g.items.map(msgCard).join('')
      ).join('') + '</div>';
    }
  } else {
    html += sent.length ? '<div class="card">' + sent.map(msgCard).join('') + '</div>' : emptyCard('fa-inbox', t('noSent'), t('noSentHint'));
  }

  el.innerHTML = '<div class="doc-stack fade-in">' + html + '</div>';
  restore();
}

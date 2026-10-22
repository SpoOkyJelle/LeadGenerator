// ── Pipeline: scan → first outreach → quote ──
function outreachDone(l) {
  return Boolean((l.outreach && l.outreach.body && l.outreach.body.trim()) || messages.some(m => m.leadId === l.id));
}

function nextStepFor(l) {
  if (scanState(l) !== 'done') return 'scan';
  if (!outreachDone(l) && l.status === 'new') return 'outreach';
  return 'quote';
}

function stepsCard(l) {
  const id = encodeURIComponent(l.id);
  const next = nextStepFor(l);
  const steps = [
    { key: 'scan', label: t('stepScan'), done: scanState(l) === 'done', action: scanState(l) === 'done' ? '' : 'onclick="scanLead(\'' + esc(l.id) + '\')"' },
    { key: 'outreach', label: t('stepOutreach'), done: outreachDone(l) || l.status !== 'new', action: 'onclick="location.hash=\'#/lead/' + id + '/outreach\'"' },
    { key: 'quote', label: t('stepQuote'), done: Boolean(l.quote), action: 'onclick="location.hash=\'#/lead/' + id + '/quote\'"' },
  ];
  return '<div class="card"><div class="card-head"><div class="card-title">' + esc(t('nextSteps')) + '</div></div><div class="steps">' +
    steps.map((s, i) => {
      const current = s.key === next && !s.done;
      return '<button class="step' + (s.done ? ' done' : '') + (current ? ' current' : '') + '" ' + s.action + '>' +
        '<span class="bullet">' + (s.done ? '<i class="fa-solid fa-check"></i>' : i + 1) + '</span>' + esc(s.label) +
        '<i class="fa-solid fa-chevron-right go"></i></button>';
    }).join('') + '</div></div>';
}

// ── First outreach ──
let outreachDraft = null;
let outreachLeadId = null;
let outreachGeneratingId = null;
let outreachError = null;
let outreachSaveTimer = null;
let outreachPending = null;
let outreachSaveState = 'saved';

function defaultOutreach() {
  // Once the report pages are online, sharing a link (with "opened" tracking) is the best default
  return { channel: 'email', tone: 'friendly', length: 'normal', formality: 'u', extra: '', subject: '', body: '', source: null, kind: 'first', report: settings.publicReportUrl ? 'link' : 'offer' };
}

// How the scan report is used: offer it, share a link, attach it as a PDF (email only) or summarise it
function effectiveReport(d) {
  if (d.channel === 'phone') return 'offer';
  if (d.channel === 'linkedin' && d.report === 'attach') return 'link';
  return d.report || 'offer';
}

// Make sure the online report exists before a message links to it
async function ensureReportLink(leadId) {
  const lead = leads.find(l => l.id === leadId);
  if (!lead) return null;
  if (lead.report) return lead.report.url;
  return publishReport(leadId, { silent: true });
}

function leadSocial(l, key) {
  return l && l.scanResult && l.scanResult.contact && l.scanResult.contact.socials ? l.scanResult.contact.socials[key] || null : null;
}

function mailtoFor(email, subject, body) {
  return 'mailto:' + encodeURIComponent(email || '').replace(/%40/g, '@') + '?subject=' + encodeURIComponent(subject || '') + '&body=' + encodeURIComponent(body || '');
}

function stateHtml(s) {
  return s === 'saving' ? '<span class="spin"></span>' + esc(t('saving')) : '<i class="fa-solid fa-check"></i>' + esc(t('saved'));
}

async function saveOutreachNow(leadId, d) {
  d.updated = Date.now();
  await fetch('/api/outreach/' + encodeURIComponent(leadId), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) });
  const l = leads.find(x => x.id === leadId);
  if (l) l.outreach = JSON.parse(JSON.stringify(d));
}

function setOutreachSaveState(s) {
  outreachSaveState = s;
  const el = $('o-save-state');
  if (el) el.innerHTML = stateHtml(s);
}

function scheduleOutreachSave() {
  const leadId = outreachLeadId, d = outreachDraft;
  setOutreachSaveState('saving');
  clearTimeout(outreachSaveTimer);
  outreachPending = async () => {
    outreachPending = null;
    await saveOutreachNow(leadId, d);
    setOutreachSaveState('saved');
  };
  outreachSaveTimer = setTimeout(() => outreachPending && outreachPending(), 600);
}

async function flushOutreachSave() {
  clearTimeout(outreachSaveTimer);
  if (outreachPending) await outreachPending();
}

function wordCount(s) {
  return (String(s || '').trim().match(/\S+/g) || []).length;
}

function renderOutreach() {
  const el = $('view-outreach');
  const l = currentLead();
  if (!l) {
    el.innerHTML = loaded
      ? '<div class="card empty fade-in"><div class="empty-icon"><i class="fa-solid fa-ghost"></i></div><h3>' + esc(t('notFound')) + '</h3><p>' + esc(t('notFoundHint')) + '</p>' +
        '<a class="btn btn-secondary" href="#/"><i class="fa-solid fa-arrow-left"></i>' + esc(t('backToLeads')) + '</a></div>'
      : '';
    return;
  }
  if (outreachLeadId !== l.id) {
    outreachDraft = { ...defaultOutreach(), ...(l.outreach ? JSON.parse(JSON.stringify(l.outreach)) : {}) };
    // Already sent something before? Then the next message is a follow-up by default.
    if (!l.outreach || !l.outreach.kind) outreachDraft.kind = lastSent(l.id) ? 'followup' : 'first';
    outreachLeadId = l.id;
    outreachError = null;
  }

  const d = outreachDraft;
  const restore = captureFocus();
  const st = scanState(l);
  const findings = st === 'done' ? l.scanResult.findings.filter(f => f.severity !== 'info') : [];
  const generating = outreachGeneratingId === l.id;
  const hasBody = Boolean(d.body && d.body.trim());
  const canSendEmail = hasBody && d.channel === 'email' && settings.mailConfigured && l.email;

  let html = '<div class="hero fade-in"><div class="hero-left">' + favicon(l.url, true) + '<div style="min-width:0">' +
    '<h1 class="hero-title">' + esc(t('outreach')) + '</h1>' +
    '<div class="hero-meta"><span><i class="fa-solid fa-building"></i>' + esc(l.name || domain(l.url)) + '</span>' + badge(l.status) + '</div></div></div>' +
    '<div class="head-actions" style="align-items:center">' +
      '<span class="save-state" id="o-save-state">' + stateHtml(outreachSaveState) + '</span>' +
      (hasBody ? '<button class="btn btn-secondary" onclick="copyOutreach()"><i class="fa-regular fa-copy"></i>' + esc(t('copy')) + '</button>' : '') +
      (hasBody && d.channel === 'email' ? '<button class="btn btn-secondary" onclick="openOutreachMail()"><i class="fa-regular fa-envelope"></i>' + esc(t('openMail')) + '</button>' : '') +
      (d.channel === 'linkedin' && leadSocial(l, 'linkedin') ? '<a class="btn btn-secondary" href="' + esc(leadSocial(l, 'linkedin')) + '" target="_blank" rel="noopener"><i class="fa-brands fa-linkedin"></i>' + esc(t('openLinkedin')) + '</a>' : '') +
      (d.channel === 'phone' && l.phone ? '<a class="btn btn-secondary" href="tel:' + esc(l.phone) + '"><i class="fa-solid fa-phone"></i>' + esc(t('callNow')) + ' ' + esc(l.phone) + '</a>' : '') +
      (hasBody
        ? '<button class="btn btn-secondary" onclick="openSchedule()"><i class="fa-regular fa-bookmark"></i>' + esc(t('saveForLater')) + '</button>' +
          (canSendEmail ? '<button class="btn btn-primary" onclick="sendEmailNow()"><i class="fa-solid fa-paper-plane"></i>' + esc(t('sendEmail')) + '</button>' : '') +
          '<button class="btn btn-' + (canSendEmail ? 'secondary' : 'primary') + '" onclick="sendDraftNow()"><i class="fa-solid fa-check"></i>' + esc(t('markSent')) + '</button>'
        : '<a class="btn btn-secondary" href="#/lead/' + encodeURIComponent(l.id) + '/quote"><i class="fa-solid fa-file-invoice"></i>' + esc(l.quote ? t('openQuote') : t('createQuote')) + '</a>') +
    '</div></div>';

  html += '<p class="page-sub" style="margin:-12px 0 20px">' + esc(t('outreachSub')) + '</p>';

  if (!settings.aiConfigured) {
    html += '<div class="alert info"><i class="fa-solid fa-circle-info"></i><div style="flex:1">' + esc(t('aiNotConfigured')) + '</div>' +
      '<a class="btn btn-secondary btn-sm" href="#/settings">' + esc(t('goSettings')) + '</a></div>';
  }
  if (outreachError) {
    html += '<div class="alert err" style="margin-bottom:16px"><i class="fa-solid fa-circle-exclamation" style="margin-top:3px"></i><div>' + esc(outreachError) + '</div></div>';
  }

  // Main: the message
  let main;
  if (generating) {
    main = '<div class="card"><div class="summary"><div class="empty-icon" style="margin:0;color:var(--accent-2)"><span class="spin lg"></span></div>' +
      '<div class="summary-text"><div class="h">' + esc(t('generatingTitle')) + '</div><div class="s">' + esc(t('generatingHint')) + '</div></div></div>' +
      '<div class="card-body" style="display:flex;flex-direction:column;gap:14px;border-top:1px solid var(--border)">' +
      [92, 78, 85, 60, 70].map(w => '<div class="skel" style="width:' + w + '%"></div>').join('') + '</div></div>';
  } else if (!hasBody) {
    main = '<div class="card empty"><div class="empty-icon" style="color:var(--accent-2)"><i class="fa-solid fa-wand-magic-sparkles"></i></div>' +
      '<h3>' + esc(t('outreachEmpty')) + '</h3><p>' + esc(t('outreachEmptyHint')) + '</p>' +
      '<button class="btn btn-primary" onclick="generateOutreach()"><i class="fa-solid fa-wand-magic-sparkles"></i>' + esc(t('generateAi')) + '</button></div>';
  } else {
    const attach = effectiveReport(d) === 'attach';
    main = '<div class="card"><div class="card-head"><div class="card-title">' + esc(d.channel === 'phone' ? t('script') : t('message')) + '</div>' +
        (d.channel === 'email'
          ? '<span class="hint">' + esc(t('to')) + ': ' + (l.email ? esc(l.email)
              : esc(t('noEmailYet')) + ' · <a class="link" href="javascript:void(0)" onclick="openEdit(\'' + esc(l.id) + '\')">' + esc(t('addEmail')) + '</a>') + '</span>'
          : '') +
      '</div>' +
      (attach && st === 'done'
        ? '<div class="alert info" style="margin:12px 18px 0;padding:10px 12px"><i class="fa-solid fa-paperclip"></i><div style="flex:1">' + esc(t('repAttachHint')) + '</div>' +
          '<button class="btn btn-secondary btn-sm" onclick="downloadPdf()"><i class="fa-solid fa-file-pdf"></i>' + esc(t('downloadReport')) + '</button></div>'
        : '') +
      (d.channel === 'email' ? '<input class="subject-input" id="o-subject" placeholder="' + esc(t('subjectPh')) + '" value="' + esc(d.subject) + '" oninput="oText(\'subject\', this.value)">' : '') +
      '<textarea class="doc-text tall bare" id="o-body" oninput="oText(\'body\', this.value)">' + esc(d.body) + '</textarea>' +
      '<div class="msg-foot"><span>' + (d.source === 'ai' ? '<span class="ai-badge"><i class="fa-solid fa-wand-magic-sparkles"></i>' + esc(t('aiBadge')) + '</span>'
                                                       : d.source === 'template' ? esc(t('templateBadge')) : '') + '</span>' +
      '<span id="o-words">' + esc(t('wordsCount', wordCount(d.body))) + '</span></div></div>';
  }

  // Side: options + what the message is based on
  const seg = (key, opts) => '<div class="seg full">' + opts.map(([v, label]) =>
    '<button class="' + (d[key] === v ? 'active' : '') + '" onclick="oSet(\'' + key + '\', \'' + v + '\')">' + esc(label) + '</button>').join('') + '</div>';
  const group = (label, ctl) => '<div class="opt-group"><label>' + esc(label) + '</label>' + ctl + '</div>';

  let side = '<div class="card"><div class="card-head"><div class="card-title">' + esc(t('options')) + '</div></div>' +
    '<div class="card-body" style="display:flex;flex-direction:column;gap:14px">' +
      (lastSent(l.id) ? group(t('kind'), seg('kind', [['first', t('kindFirst')], ['followup', t('kindFollow')]])) : '') +
      group(t('channel'), seg('channel',[['email', t('chEmail')], ['linkedin', t('chLinkedin')], ['phone', t('chPhone')]])) +
      group(t('tone'), seg('tone', [['friendly', t('toneFriendly')], ['professional', t('toneProfessional')], ['direct', t('toneDirect')]])) +
      group(t('length'), seg('length', [['short', t('lenShort')], ['normal', t('lenNormal')]])) +
      (d.channel === 'email' ? group(t('repLabel'), seg('report', [['offer', t('repOffer')], ['link', t('repLink')], ['attach', t('repAttach')], ['summary', t('repSummary')]]).replace('seg full', 'seg full grid2'))
        : d.channel === 'linkedin' ? group(t('repLabel'), '<div class="seg full">' + [['offer', t('repOffer')], ['link', t('repLink')], ['summary', t('repSummary')]].map(([v, label]) =>
            '<button class="' + (effectiveReport(d) === v ? 'active' : '') + '" onclick="oSet(\'report\', \'' + v + '\')">' + esc(label) + '</button>').join('') + '</div>')
        : '') +
      (lang === 'nl' ? group(t('formality'), seg('formality', [['u', 'u'], ['je', 'je']])) : '') +
      group(t('extraInstr'), '<textarea id="o-extra" rows="3" placeholder="' + esc(t('extraPh')) + '" oninput="oText(\'extra\', this.value)">' + esc(d.extra) + '</textarea>') +
      '<div style="display:flex;flex-direction:column;gap:6px">' +
        '<button class="btn btn-primary btn-block" onclick="generateOutreach()"' + (generating ? ' disabled' : '') + '>' +
          (generating ? '<span class="spin"></span>' + esc(t('generating')) : '<i class="fa-solid fa-wand-magic-sparkles"></i>' + esc(hasBody ? t('regenerate') : t('generateAi'))) + '</button>' +
        '<button class="btn btn-ghost btn-sm btn-block" onclick="useTemplate()"' + (generating ? ' disabled' : '') + '>' + esc(t('useTemplate')) + '</button>' +
      '</div>' +
    '</div></div>';

  const sevColor = { critical: 'var(--red)', warning: 'var(--amber)' };
  side += '<div class="card"><div class="card-head"><div class="card-title">' + esc(t('basedOn')) + '</div></div><div class="card-body">' +
    (st !== 'done' ? '<div class="muted-note">' + esc(t('notScannedOutreach')) + '</div>'
      : findings.length ? '<ul class="find-list">' + findings.map(f => '<li><span class="dot" style="background:' + sevColor[f.severity] + '"></span><span>' + esc(findingText(f, lang).title) + '</span></li>').join('') + '</ul>'
      : '<div class="muted-note">' + esc(t('noFindingsOutreach')) + '</div>') +
    '</div></div>';

  const mine = messages.filter(m => m.leadId === l.id).sort((a, b) => (b.sentAt || b.created) - (a.sentAt || a.created));
  if (mine.length) {
    side += '<div class="card"><div class="card-head"><div class="card-title">' + esc(t('savedMessages')) + ' <span class="n">' + mine.length + '</span></div>' +
      '<a class="btn btn-ghost btn-sm" href="#/messages">' + esc(t('allMessages')) + '</a></div><div class="rows">' +
      mine.slice(0, 5).map(m => '<div class="row-item" style="padding:10px 18px"><div class="grow" style="min-width:0">' +
        '<div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(m.subject || m.body.split('\n')[0]) + '</div>' +
        '<div class="meta">' + channelIcon(m.channel) + ' ' + esc(msgWhen(m)) + '</div></div></div>').join('') +
      '</div></div>';
  }

  el.innerHTML = html + '<div class="detail-grid"><div class="stack">' + main + '</div><div class="stack">' + side + '</div></div>';
  restore();
}

function oSet(key, value) {
  if (!outreachDraft) return;
  outreachDraft[key] = value;
  renderOutreach();
  scheduleOutreachSave();
}

function oText(key, value) {
  if (!outreachDraft) return;
  outreachDraft[key] = value;
  if (key === 'body') {
    const w = $('o-words');
    if (w) w.textContent = t('wordsCount', wordCount(value));
  }
  scheduleOutreachSave();
}

function confirmReplace(fn) {
  if (outreachDraft && outreachDraft.body && outreachDraft.body.trim()) openConfirm(t('replaceTitle'), t('replaceText'), t('replaceOk'), false, fn);
  else fn();
}

function generateOutreach() {
  if (outreachGeneratingId) return;
  confirmReplace(runGenerateOutreach);
}

async function runGenerateOutreach() {
  const leadId = outreachLeadId, d = outreachDraft;
  if (!leadId || !d) return;
  outreachGeneratingId = leadId;
  outreachError = null;
  render();
  try {
    if (effectiveReport(d) === 'link' && !(await ensureReportLink(leadId))) {
      outreachError = t('reportNeedsScan');
      outreachGeneratingId = null;
      render();
      return;
    }
    const res = await fetch('/api/outreach/' + encodeURIComponent(leadId) + '/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: d.channel, tone: d.tone, length: d.length, formality: d.formality, extra: d.extra, language: lang,
        followUp: followUpContext(leadId, d),
        reportMode: effectiveReport(d),
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      outreachError = data.error === 'no_key' ? t('noKey') : data.error === 'no_workspace' ? t('noWorkspace') : (data.error || t('toastGenFail'));
    } else {
      d.subject = d.channel === 'email' ? data.subject : '';
      d.body = data.body;
      d.source = 'ai';
      await saveOutreachNow(leadId, d);
    }
  } catch {
    outreachError = t('toastGenFail');
  }
  outreachGeneratingId = null;
  render();
}

function useTemplate() {
  const l = currentLead();
  if (!l || !outreachDraft) return;
  confirmReplace(async () => {
    if (effectiveReport(outreachDraft) === 'link' && !(await ensureReportLink(l.id))) {
      outreachError = t('reportNeedsScan');
      renderOutreach();
      return;
    }
    const tpl = templateOutreach(l, outreachDraft);
    outreachDraft.subject = tpl.subject;
    outreachDraft.body = tpl.body;
    outreachDraft.source = 'template';
    outreachError = null;
    renderOutreach();
    scheduleOutreachSave();
  });
}

// Simple fill-in-the-blanks version for when there's no AI key
function templateOutreach(l, d) {
  const nl = lang === 'nl';
  const je = nl && d.formality === 'je';
  const U = (u, j) => (je ? j : u);
  const s = settings;
  const dom = domain(l.url);
  const items = scanState(l) === 'done'
    ? l.scanResult.findings.filter(f => f.severity !== 'info').slice(0, 3).map(f => '- ' + findingText(f, lang).title)
    : [];
  const sig = [s.contactName, s.companyName, s.phone, s.email].filter(Boolean).join('\n');
  const me = s.contactName || (nl ? '[je naam]' : '[your name]');
  const co = s.companyName || (nl ? '[bedrijf]' : '[company]');

  // The closing part depends on what happens with the scan report
  const report = effectiveReport(d);
  const allItems = scanState(l) === 'done'
    ? l.scanResult.findings.filter(f => f.severity !== 'info').slice(0, 5).map(f => '- ' + findingText(f, lang).title)
    : [];
  const summaryBlock = allItems.length
    ? (nl ? '\n\nKorte samenvatting van de scan:\n' : '\n\nShort summary of the scan:\n') + allItems.join('\n')
    : '';
  const booking = s.bookingUrl ? (nl ? ` Kies hier zelf een moment:\n${s.bookingUrl}` : ` Pick a time that suits you:\n${s.bookingUrl}`) : '';
  const callCta = (nl ? 'Zullen we 10 minuten bellen om het samen door te nemen?' : 'Shall we have a 10-minute call to go through it?') + booking;
  const reportUrl = l.report ? l.report.url : '';
  const cta = report === 'attach'
    ? (nl ? `In de bijlage ${U('vindt u', 'vind je')} het volledige scanrapport. ` : 'You will find the full scan report attached. ') + callCta
    : report === 'summary' ? summaryBlock + '\n\n' + callCta
    : report === 'link' && reportUrl ? (nl ? `Ik heb de bevindingen voor ${U('u', 'je')} op een overzichtelijke pagina gezet:\n${reportUrl}\n\n` : `I put the findings on a clear page for you:\n${reportUrl}\n\n`) + callCta
    : null;
  const ctaText = cta ? cta.trim() : null;

  if (d.kind === 'followup' && d.channel !== 'phone') {
    const prev = lastSent(l.id);
    const when = prev ? t('daysAgo', daysSince(prev.sentAt)) : (nl ? 'onlangs' : 'recently');
    const hi = nl ? (l.name ? `Beste team van ${l.name},` : 'Goedendag,') : (l.name ? `Hi ${l.name} team,` : 'Hello,');
    return {
      subject: d.channel === 'email' ? (prev && prev.subject ? 'Re: ' + prev.subject.replace(/^re:\s*/i, '') : (nl ? `Nog even over ${dom}` : `Following up on ${dom}`)) : '',
      body: nl
        ? `${hi}\n\nIk stuurde ${U('u', 'je')} ${when} een bericht over de scan van ${dom}. Ik begrijp dat het druk kan zijn, dus ik wilde het nog even onder ${U('uw', 'je')} aandacht brengen.` +
          (items.length && report !== 'summary' ? `\n\nKort samengevat: ${items[0].slice(2).toLowerCase()} is het belangrijkste punt.` : '') +
          `\n\n${report === 'attach' ? 'Ik heb het scanrapport voor het gemak nogmaals bijgevoegd. ' + callCta : ctaText || 'Zal ik het scanrapport alsnog kosteloos toesturen?'}\n\nMet vriendelijke groet,\n${sig || me}`
        : `${hi}\n\nI sent you a message ${when} about the scan of ${dom}. I know things get busy, so I wanted to bring it back to your attention.` +
          (items.length && report !== 'summary' ? `\n\nIn short: ${items[0].slice(2)} is the most important point.` : '') +
          `\n\n${report === 'attach' ? 'I have attached the scan report again for convenience. ' + callCta : ctaText || 'Shall I still send you the free scan report?'}\n\nBest regards,\n${sig || me}`,
    };
  }

  if (d.channel === 'phone') {
    return {
      subject: '',
      body: nl ? [
        'OPENING',
        `Goedendag, ${U('u spreekt', 'je spreekt')} met ${me} van ${co}. Spreek ik met degene die over de website gaat?`,
        '',
        'REDEN VAN BELLEN',
        `Ik heb een korte, openbare scan gedaan van ${dom}` + (items.length ? ' en zag een paar punten die aandacht verdienen:' : ' en wilde even kennismaken.'),
        ...items,
        '',
        'VRAGEN',
        `- Wie onderhoudt de website op dit moment?`,
        `- Wanneer is de site voor het laatst bijgewerkt?`,
        `- Is de website belangrijk voor het binnenhalen van klanten?`,
        '',
        'GEEN INTERESSE?',
        `Helemaal prima. Mag ik ${U('u', 'je')} het gratis scanrapport mailen, zodat ${U('u', 'je')} het later rustig kunt bekijken?`,
        '',
        'AFSLUITING',
        `Zal ik het rapport sturen en volgende week even terugbellen om het kort door te nemen?`,
      ].join('\n') : [
        'OPENING',
        `Hi, this is ${me} from ${co}. Am I speaking with the person who looks after the website?`,
        '',
        'REASON FOR CALLING',
        `I ran a quick public scan of ${dom}` + (items.length ? ' and noticed a few things worth a look:' : ' and wanted to introduce myself.'),
        ...items,
        '',
        'QUESTIONS',
        '- Who maintains the website at the moment?',
        '- When was the site last updated?',
        '- How important is the website for winning new customers?',
        '',
        'NOT INTERESTED?',
        'No problem at all. Can I email you the free scan report so you can look at it later?',
        '',
        'CLOSE',
        'Shall I send the report and give you a quick call next week to go through it?',
      ].join('\n'),
    };
  }

  if (d.channel === 'linkedin') {
    return {
      subject: '',
      body: nl
        ? `Hoi${l.name ? ' ' + l.name : ''},\n\nIk keek naar ${dom} en zag ${items.length ? 'een paar technische punten (o.a. ' + items[0].slice(2) + ') die makkelijk op te lossen zijn' : 'een mooie site'}. ${ctaText || `Zal ik ${U('u', 'je')} het gratis scanrapport sturen?`}\n\nGroet,\n${me}`
        : `Hi${l.name ? ' ' + l.name : ''},\n\nI had a look at ${dom} and noticed ${items.length ? 'a few technical points (incl. ' + items[0].slice(2) + ') that are easy to fix' : 'a nicely built site'}. ${ctaText || 'Shall I send you the free scan report?'}\n\nBest,\n${me}`,
    };
  }

  const greeting = nl ? (l.name ? `Beste team van ${l.name},` : 'Goedendag,') : (l.name ? `Hi ${l.name} team,` : 'Hello,');
  const body = nl
    ? `${greeting}\n\nIk kwam ${U('uw', 'jullie')} website ${dom} tegen en heb er een korte, openbare scan op gedaan.` +
      (items.length
        ? (report === 'summary'
            ? ` Daarbij vielen me een paar punten op die aandacht verdienen voor de veiligheid en vindbaarheid van ${U('uw', 'jullie')} site.`
            : ` Daarbij vielen me een paar punten op:\n\n${items.join('\n')}\n\nDit zijn vaak kleine aanpassingen, maar ze maken verschil voor de veiligheid en vindbaarheid van ${U('uw', 'jullie')} site.`)
        : ' De site staat er technisch goed op — mooi werk.') +
      (cta ? (report === 'summary' ? cta : '\n\n' + cta)
           : `\n\nZal ik ${U('u', 'je')} het volledige scanrapport kosteloos toesturen? Dan ${U('kunt u', 'kun je')} zelf beoordelen of het de moeite waard is.`) +
      `\n\nMet vriendelijke groet,\n${sig || me}`
    : `${greeting}\n\nI came across ${dom} and ran a quick public scan of the site.` +
      (items.length
        ? (report === 'summary'
            ? ' A few things stood out that deserve attention for your site\'s security and search ranking.'
            : ` A few things stood out:\n\n${items.join('\n')}\n\nThese are usually small fixes, but they make a real difference for your site's security and search ranking.`)
        : ' Technically it looks in good shape — nice work.') +
      (cta ? (report === 'summary' ? cta : '\n\n' + cta)
           : `\n\nShall I send you the full scan report, free of charge? Then you can judge for yourself whether it's worth acting on.`) +
      `\n\nBest regards,\n${sig || me}`;
  return { subject: nl ? `Korte vraag over ${dom}` : `Quick question about ${dom}`, body };
}

function outreachText() {
  const d = outreachDraft;
  if (!d) return '';
  return (d.channel === 'email' && d.subject ? (lang === 'nl' ? 'Onderwerp: ' : 'Subject: ') + d.subject + '\n\n' : '') + d.body;
}

function copyOutreach() {
  navigator.clipboard.writeText(outreachText()).then(() => toast(t('toastCopiedMsg'), 'success'));
}

function openOutreachMail() {
  const d = outreachDraft;
  if (!d) return;
  const l = currentLead();
  location.href = mailtoFor(l && l.email, d.subject, d.body);
}

// Send the current draft by email through the configured mail server, then log it as sent.
async function sendEmailNow() {
  const l = currentLead(), d = outreachDraft;
  if (!l || !d || !d.body.trim()) return;
  if (!settings.mailConfigured) { toast(t('toastSmtpNotSet'), 'error'); return; }
  if (!l.email) { toast(t('toastNoEmailAddr'), 'error'); return; }
  openConfirm(t('sendEmailTitle'), t('sendEmailText', l.email), t('sendEmailConfirm'), false, async () => {
    const res = await fetch('/api/send-email', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leadId: l.id, subject: d.subject, body: d.body }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) { toast(t('toastEmailFail', data.message || data.error || ''), 'error'); return; }
    const m = draftToMessage(l.id, d, { status: 'sent', sentAt: Date.now() });
    await apiSaveMessage(m);
    messages.unshift(m);
    if (l.status === 'new') await saveLead(l.id, { status: 'contacted' });
    render();
    toast(t('toastEmailSent', data.to || l.email), 'success');
  });
}

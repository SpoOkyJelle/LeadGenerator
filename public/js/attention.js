// ── Needs attention: the action list ──
const moneyRound = (n) => new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n || 0);

// Rough value of a lead: its quote if there is one, otherwise the estimated hours for its issues
function estimateValue(l) {
  if (l.quote) return quoteTotals(l.quote).sub;
  if (scanState(l) !== 'done') return 0;
  const seen = new Set();
  let total = 0;
  l.scanResult.findings.forEach(f => {
    if (f.severity === 'info' || seen.has(f.tech) || !SERVICE_DEFS.find(d => d.tech === f.tech)) return;
    seen.add(f.tech);
    total += hoursFor(f.tech) * (Number(settings.hourlyRate) || 0);
  });
  return total;
}

function priority(l) {
  const c = countFindings(l.scanResult.findings);
  return c.critical * 3 + c.warning;
}

function attentionData() {
  const plannedLeadIds = new Set(messages.filter(m => m.status !== 'sent').map(m => m.leadId));
  const due = messages.filter(isDue).sort((a, b) => (a.planFor || '').localeCompare(b.planFor || ''));
  const ready = leads
    .filter(l => l.status === 'new' && hasIssues(l) && !lastSent(l.id) && !plannedLeadIds.has(l.id))
    .sort((a, b) => priority(b) - priority(a) || estimateValue(b) - estimateValue(a));
  const followUp = leads.filter(l => {
    if (l.status !== 'contacted' || l.quote || plannedLeadIds.has(l.id)) return false;
    const m = lastSent(l.id);
    return !m || daysSince(m.sentAt) >= FOLLOW_UP_DAYS;
  });
  const openQuotes = leads.filter(l => l.quote && (l.status === 'new' || l.status === 'contacted'));
  const unscanned = leads.filter(l => ['none', 'error'].includes(scanState(l))).length;
  // Opened their report in the last week and no outcome yet: the warmest moment to call
  const weekAgo = Date.now() - 7 * 864e5;
  const viewed = leads
    .filter(l => l.report && l.report.lastViewAt > weekAgo && (l.status === 'new' || l.status === 'contacted'))
    .sort((a, b) => b.report.lastViewAt - a.report.lastViewAt);
  return { viewed, due, ready, followUp, openQuotes, unscanned };
}

function statCard(label, value, sub, icon, tone) {
  return '<div class="card stat"><div class="stat-top"><span class="stat-label">' + esc(label) + '</span><span class="stat-icon ' + tone + '"><i class="fa-solid ' + icon + '"></i></span></div>' +
    '<div class="stat-value">' + value + '</div><div class="stat-sub">' + esc(sub) + '</div></div>';
}

function sectionHead(title, n, hint, action) {
  return '<div class="section-head"><div><h2>' + esc(title) + (n !== null ? ' <span class="n">' + n + '</span>' : '') + '</h2>' +
    (hint ? '<p>' + esc(hint) + '</p>' : '') + '</div>' + (action || '') + '</div>';
}

function leadLink(l) {
  return '<a class="link" href="#/lead/' + encodeURIComponent(l.id) + '">' + esc(l.name || domain(l.url)) + '</a>';
}

function oppCard(l) {
  const id = encodeURIComponent(l.id);
  const score = healthScore(l.scanResult.findings);
  const top = l.scanResult.findings.filter(f => f.severity !== 'info').slice(0, 3);
  const sevColor = { critical: 'var(--red)', warning: 'var(--amber)' };
  return '<div class="card opp">' +
    '<div class="opp-top">' + favicon(l.url) +
      '<div class="grow">' + leadLink(l) + '<div class="site-sub">' + esc(domain(l.url)) + '</div></div>' +
      '<div class="ring sm" style="--p:' + score + ';--c:' + healthColor(score) + '" title="' + esc(t('healthScoreShort')) + ' ' + score + '/100"><div class="ring-inner"><span class="ring-val">' + score + '</span></div></div>' +
      '<div class="opp-value"><div class="v">' + moneyRound(estimateValue(l)) + '</div><div class="l">' + esc(t('estimate')) + '</div></div>' +
    '</div>' +
    '<ul class="find-list">' + top.map(f => '<li><span class="dot" style="background:' + sevColor[f.severity] + '"></span><span>' + esc(findingText(f, lang).title) + '</span></li>').join('') + '</ul>' +
    '<div class="opp-actions">' +
      '<a class="btn btn-primary btn-sm" href="#/lead/' + id + '/outreach"><i class="fa-solid fa-wand-magic-sparkles"></i>' + esc(t('writeOutreach')) + '</a>' +
      '<a class="btn btn-secondary btn-sm" href="#/lead/' + id + '">' + esc(t('viewLead')) + '</a>' +
      '<span style="flex:1"></span>' +
      '<button class="btn btn-ghost btn-sm" onclick="setStatus(\'' + esc(l.id) + '\', \'rejected\')">' + esc(t('notInterested')) + '</button>' +
    '</div></div>';
}

function renderAttention(a) {
  const el = $('view-attention');
  if (!loaded) { el.innerHTML = ''; return; }

  const value = a.ready.concat(a.followUp, a.openQuotes).reduce((s, l) => s + estimateValue(l), 0);
  let html = '<div class="page-head"><div><h1 class="page-title">' + esc(t('needsAttention')) + '</h1><p class="page-sub">' + esc(t('attentionSub')) + '</p></div></div>';

  html += '<div class="stats">' +
    statCard(t('kpiDue'), a.due.length, t('kpiDueSub'), 'fa-paper-plane', 'tone-accent') +
    statCard(t('kpiReady'), a.ready.length, t('kpiReadySub'), 'fa-fire', 'tone-amber') +
    statCard(t('kpiFollow'), a.followUp.length, t('kpiFollowSub', FOLLOW_UP_DAYS), 'fa-reply', 'tone-blue') +
    statCard(t('kpiValue'), moneyRound(value), t('kpiValueSub'), 'fa-euro-sign', 'tone-green') +
    '</div>';

  const nothing = !a.viewed.length && !a.due.length && !a.ready.length && !a.followUp.length && !a.openQuotes.length;

  // 0. Opened their report recently: call while it's fresh
  if (a.viewed.length) {
    html += sectionHead(t('secViewed'), a.viewed.length, t('secViewedHint'));
    html += '<div class="card rows">' + a.viewed.map(l => {
      const r = l.report;
      const id = esc(l.id);
      return '<div class="row-item">' + favicon(l.url) +
        '<div class="grow">' + leadLink(l) + '<div class="meta"><span class="viewed-badge"><i class="fa-solid fa-eye"></i>' + esc(t('viewedTimes', r.views)) + '</span> · ' +
          esc(t('lastViewed', timeAgo(r.lastViewAt))) + ' · ' + esc(t('readingTime', fmtDuration(r.totalSeconds))) + '</div></div>' +
        '<div class="row-actions-static">' +
          (l.phone ? '<a class="btn btn-primary btn-sm" href="tel:' + esc(l.phone) + '"><i class="fa-solid fa-phone"></i>' + esc(t('callNow')) + ' ' + esc(l.phone) + '</a>' : '') +
          '<a class="btn btn-secondary btn-sm" href="#/lead/' + encodeURIComponent(l.id) + '/outreach"><i class="fa-solid fa-reply"></i>' + esc(t('followUpMsg')) + '</a>' +
          '<button class="btn btn-ghost btn-sm" onclick="setStatus(\'' + id + '\', \'qualified\')"><i class="fa-solid fa-thumbs-up"></i>' + esc(t('interested')) + '</button>' +
        '</div></div>';
    }).join('') + '</div>';
  }
  if (nothing) {
    html += '<div class="card empty"><div class="empty-icon" style="color:var(--green)"><i class="fa-solid fa-mug-hot"></i></div><h3>' + esc(t('allDone')) + '</h3><p>' + esc(t('allDoneHint')) + '</p></div>';
  }

  // 1. Messages due today (or overdue)
  if (a.due.length) {
    html += sectionHead(t('secDue'), a.due.length, t('secDueHint'), '<a class="btn btn-ghost btn-sm" href="#/messages">' + esc(t('allMessages')) + '</a>');
    html += '<div class="card rows">' + a.due.map(m => {
      const l = leads.find(x => x.id === m.leadId);
      if (!l) return '';
      const overdue = m.planFor && m.planFor < todayISO();
      const mid = esc(m.id);
      return '<div class="row-item">' + favicon(l.url) +
        '<div class="grow">' + leadLink(l) + '<div class="meta">' + channelIcon(m.channel) + ' ' + esc(m.subject || channelLabel(m.channel)) +
          ' · <span class="' + (overdue ? 'overdue' : '') + '">' + esc(msgWhen(m)) + '</span></div></div>' +
        '<div class="row-actions-static">' +
          '<button class="btn btn-secondary btn-sm" onclick="copyMsg(\'' + mid + '\')"><i class="fa-regular fa-copy"></i>' + esc(t('copy')) + '</button>' +
          (m.channel === 'email' ? '<button class="btn btn-secondary btn-sm" onclick="openMsgMail(\'' + mid + '\')"><i class="fa-regular fa-envelope"></i>' + esc(t('openMail')) + '</button>' : '') +
          '<button class="btn btn-primary btn-sm" onclick="markMsgSent(\'' + mid + '\')"><i class="fa-solid fa-paper-plane"></i>' + esc(t('markSent')) + '</button>' +
        '</div></div>';
    }).join('') + '</div>';
  }

  // 2. New opportunities
  if (!nothing) {
    html += sectionHead(t('secReady'), a.ready.length, t('secReadyHint'));
    html += a.ready.length
      ? '<div class="opp-grid">' + a.ready.map(oppCard).join('') + '</div>'
      : '<div class="card card-body muted-note">' + esc(t('noReady')) + '</div>';
  }

  // 3. Follow-ups
  if (a.followUp.length) {
    html += sectionHead(t('secFollow'), a.followUp.length, t('secFollowHint', FOLLOW_UP_DAYS));
    html += '<div class="card rows">' + a.followUp.map(l => {
      const m = lastSent(l.id);
      const id = esc(l.id);
      return '<div class="row-item">' + favicon(l.url) +
        '<div class="grow">' + leadLink(l) + '<div class="meta">' + (m ? channelIcon(m.channel) + ' ' + esc(t('contactedAgo', t('daysAgo', daysSince(m.sentAt)))) : esc(t('dateUnknown'))) + '</div></div>' +
        '<div class="row-actions-static">' +
          '<button class="btn btn-ghost btn-sm" onclick="setStatus(\'' + id + '\', \'rejected\')">' + esc(t('notInterested')) + '</button>' +
          '<button class="btn btn-secondary btn-sm" onclick="setStatus(\'' + id + '\', \'qualified\')"><i class="fa-solid fa-thumbs-up"></i>' + esc(t('interested')) + '</button>' +
          '<a class="btn btn-primary btn-sm" href="#/lead/' + encodeURIComponent(l.id) + '/outreach"><i class="fa-solid fa-reply"></i>' + esc(t('followUpMsg')) + '</a>' +
        '</div></div>';
    }).join('') + '</div>';
  }

  // 4. Open quotes
  if (a.openQuotes.length) {
    html += sectionHead(t('secQuotes'), a.openQuotes.length, t('secQuotesHint'));
    html += '<div class="card rows">' + a.openQuotes.map(l => {
      const id = esc(l.id);
      return '<div class="row-item">' + favicon(l.url) +
        '<div class="grow">' + leadLink(l) + '<div class="meta"><i class="fa-solid fa-file-invoice" style="color:var(--muted)"></i> ' + esc(t('quoteLabel', l.quote.number)) +
          ' · ' + money(quoteTotals(l.quote).total) + ' · ' + esc(fmtLong(parseISODate(l.quote.date))) + '</div></div>' +
        '<div class="row-actions-static">' +
          '<button class="btn btn-ghost btn-sm" onclick="setStatus(\'' + id + '\', \'rejected\')">' + esc(t('lost')) + '</button>' +
          '<button class="btn btn-secondary btn-sm" onclick="setStatus(\'' + id + '\', \'qualified\')"><i class="fa-solid fa-trophy"></i>' + esc(t('won')) + '</button>' +
          '<a class="btn btn-secondary btn-sm" href="#/lead/' + encodeURIComponent(l.id) + '/quote">' + esc(t('openQuote')) + '</a>' +
        '</div></div>';
    }).join('') + '</div>';
  }

  // 5. Unscanned leads hint
  if (a.unscanned) {
    html += '<div class="card banner"><i class="fa-solid fa-satellite-dish" style="color:var(--blue)"></i><div class="grow">' + esc(t('unscannedBanner', a.unscanned)) + '</div>' +
      '<button class="btn btn-secondary btn-sm" onclick="scanAllLeads(true)"' + (scanAllRunning ? ' disabled' : '') + '>' +
        (scanAllProgress ? '<span class="spin"></span>' + esc(t('scanProgress', scanAllProgress.done, scanAllProgress.total)) : '<i class="fa-solid fa-satellite-dish"></i>' + esc(t('scanNew'))) + '</button></div>';
  }

  el.innerHTML = '<div class="fade-in">' + html + '</div>';
}

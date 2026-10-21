// ── Init ──
window.addEventListener('hashchange', route);
window.addEventListener('beforeunload', e => { if (settingsDirty) { e.preventDefault(); e.returnValue = ''; } });
applyTranslations();
route();
apiLoadSettings().then(apiLoad);
refreshServerPill();
setInterval(refreshServerPill, 15000);

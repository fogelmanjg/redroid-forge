'use strict';

// "Local scrcpy" (1.0.0-beta.5): open an instance in the real scrcpy on THIS computer from a link,
// through the local launcher (launcher/linux, handler of scrcpy-redroid:// links).
//
// A browser cannot tell whether a URL scheme has a handler installed, so nothing here guesses by
// user agent (except Android/iOS, where scrcpy does not exist). The toolbar button runs a real test
// instead: the backend opens a temporary fake ADB device and hands out a one-time code, this page
// opens scrcpy-redroid://test/<host>:<port>/<code>, the launcher answers through adb, and only when
// the backend sees that answer is the feature turned on -- in THIS browser only (localStorage: it is
// a per-browser fact, "this computer has the launcher"). A failed test shows the install guide.
const ScrcpyLauncher = (() => {
  const STORE_KEY = 'scrcpyLauncher';
  const WAIT_MS = 25000; // includes the time to answer the browser's "open with...?" prompt
  const POLL_MS = 1000;
  const GUIDE = {
    en: 'https://github.com/fogelmanjg/redroid-forge/blob/main/docs/HOWTO.md#open-an-instance-in-scrcpy-on-your-computer',
    es: 'https://github.com/fogelmanjg/redroid-forge/blob/main/docs/HOWTO.es.md#abrir-una-instancia-en-scrcpy-en-tu-computadora',
  };
  const t = (k, p) => I18n.t(k, p);
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  let saved = load();
  let onChange = () => {};
  let testing = false;

  function load() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null') || {}; } catch (e) { return {}; }
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(saved)); } catch (e) { /* no storage: lasts this page only */ }
  }

  const isTested = () => !!saved.testedAt;
  const isEnabled = () => !isMobile && isTested() && saved.enabled !== false;

  // The link carries host:port only -- the launcher validates it and never takes free arguments.
  function linkFor(inst) {
    return `scrcpy-redroid://connect/${location.hostname}:${inst.adbPort}/${encodeURIComponent(inst.name || '')}`;
  }

  function guideUrl() { return GUIDE[I18n.lang] || GUIDE.en; }

  // --- toolbar button + dialog ---
  let btn; let dialog; let statusEl; let detailEl; let testBtn; let toggleBtn; let installEl;

  function renderButton() {
    if (!btn) return;
    if (isMobile) {
      btn.textContent = t('scrcpyLauncher.button.untested');
      btn.disabled = true;
      btn.title = t('scrcpyLauncher.mobileHint');
      return;
    }
    btn.disabled = false;
    btn.title = t('scrcpyLauncher.buttonHint');
    if (!isTested()) btn.textContent = t('scrcpyLauncher.button.untested');
    else btn.textContent = t(isEnabled() ? 'scrcpyLauncher.button.on' : 'scrcpyLauncher.button.off');
  }

  function renderDialog() {
    if (!dialog) return;
    if (testing) return; // the test writes its own progress
    if (isTested()) {
      statusEl.textContent = t(isEnabled() ? 'scrcpyLauncher.status.on' : 'scrcpyLauncher.status.off');
      detailEl.textContent = t('scrcpyLauncher.status.tested', {
        when: new Date(saved.testedAt).toLocaleString(), scrcpy: saved.scrcpyVersion || '?', launcher: saved.launcherVersion || '?',
      });
    } else {
      statusEl.textContent = t('scrcpyLauncher.status.untested');
      detailEl.textContent = t('scrcpyLauncher.status.untestedDetail');
    }
    toggleBtn.hidden = !isTested();
    toggleBtn.textContent = t(isEnabled() ? 'scrcpyLauncher.turnOff' : 'scrcpyLauncher.turnOn');
    testBtn.textContent = t(isTested() ? 'scrcpyLauncher.retest' : 'scrcpyLauncher.test');
    testBtn.disabled = false;
    installEl.hidden = isTested() && isEnabled();
  }

  function showInstall(show) {
    installEl.hidden = !show;
    const base = `${location.origin}/launcher/linux`;
    installEl.querySelector('code').textContent = [
      'mkdir -p ~/redroid-forge-launcher && cd ~/redroid-forge-launcher',
      `curl -fsSLO ${base}/scrcpy-redroid-launcher -O ${base}/install.sh -O ${base}/config.example`,
      'bash install.sh',
    ].join('\n');
    installEl.querySelector('a').href = guideUrl();
  }

  async function runTest() {
    if (testing) return;
    testing = true;
    testBtn.disabled = true;
    toggleBtn.hidden = true;
    showInstall(false);
    detailEl.textContent = '';
    let started;
    try {
      started = await api('/scrcpy-launcher/test', { method: 'POST' });
    } catch (e) {
      testing = false;
      statusEl.textContent = t('scrcpyLauncher.result.serverError', { error: e.message });
      testBtn.disabled = false;
      return;
    }
    statusEl.textContent = t('scrcpyLauncher.result.waiting');
    detailEl.textContent = t('scrcpyLauncher.result.waitingDetail');
    // A link click, not location.assign: if no handler exists most browsers just do nothing (or show
    // their own "no application" notice) instead of navigating away from the page.
    const a = document.createElement('a');
    a.href = `scrcpy-redroid://test/${location.hostname}:${started.port}/${started.code}`;
    document.body.appendChild(a);
    a.click();
    a.remove();

    const deadline = Date.now() + Math.min(WAIT_MS, started.expiresInMs || WAIT_MS);
    let r = { state: 'pending' };
    while (Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, POLL_MS));
      try { r = await api(`/scrcpy-launcher/test/${started.code}`); } catch (e) { /* keep waiting */ }
      if (r.state !== 'pending') break;
      const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      statusEl.textContent = t('scrcpyLauncher.result.waitingLeft', { s: left });
    }
    testing = false;

    if (r.state === 'ok') {
      saved = {
        enabled: true, testedAt: Date.now(), launcherVersion: r.launcherVersion, scrcpyVersion: r.scrcpyVersion, adbVersion: r.adbVersion,
      };
      save();
      renderDialog();
      if (!r.scrcpyVersion || r.scrcpyVersion === 'none') {
        statusEl.textContent = t('scrcpyLauncher.result.noScrcpy');
        showInstall(true);
      } else {
        statusEl.textContent = t('scrcpyLauncher.result.ok', { scrcpy: r.scrcpyVersion });
      }
    } else {
      // Not confirmed: the feature stays off in this browser whatever it was before.
      saved = { ...saved, enabled: false };
      if (!isTested()) saved = {};
      save();
      renderDialog();
      statusEl.textContent = t('scrcpyLauncher.result.failed');
      detailEl.textContent = t(r.firewall === 'unavailable' ? 'scrcpyLauncher.result.failedDetailNoFw' : 'scrcpyLauncher.result.failedDetail', { port: started.port });
      showInstall(true);
    }
    renderButton();
    onChange();
  }

  function toggle() {
    if (!isTested()) return;
    saved.enabled = !isEnabled();
    save();
    renderButton();
    renderDialog();
    onChange();
  }

  function init({ button, dialogEl, changed }) {
    btn = button;
    dialog = dialogEl;
    onChange = changed || onChange;
    statusEl = dialog.querySelector('#scrcpy-launcher-status');
    detailEl = dialog.querySelector('#scrcpy-launcher-detail');
    testBtn = dialog.querySelector('#btn-scrcpy-launcher-test');
    toggleBtn = dialog.querySelector('#btn-scrcpy-launcher-toggle');
    installEl = dialog.querySelector('#scrcpy-launcher-install');
    btn.addEventListener('click', () => {
      if (isMobile) return;
      renderDialog();
      showInstall(!isTested());
      dialog.showModal();
    });
    testBtn.addEventListener('click', runTest);
    toggleBtn.addEventListener('click', toggle);
    dialog.querySelector('#btn-scrcpy-launcher-close').addEventListener('click', () => dialog.close());
    document.addEventListener('langchange', () => { renderButton(); renderDialog(); });
    renderButton();
  }

  return { init, isEnabled, linkFor };
})();

'use strict';

// aurora-store module (stage 6 only -- see manifest.json, lib/moduleRunner.js and
// docs/ARCHITECTURE.md). Unlike every other module with real integration logic, it needs no
// /system write before boot (stage 4): it is installed after the instance has already booted,
// like any other user app would be, from an APK this project downloads and verifies itself
// (see fetch.js -- GPLv3, this project CAN redistribute it, unlike gapps/arm-translation).
//
// Complementary to gapps, not an alternative to it (see docs/ROADMAP.md, 23/10/2026): Aurora
// only downloads APKs legitimately from the same Play catalog backend the Play Store app itself
// uses -- it does not provide Play Services at runtime, so any app that actually needs those
// still needs gapps too.

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { execAndroidWithRetry } = require('../../lib/androidExec');
const fetchApk = require('./fetch');

function log(msg) { console.log(`[aurora-store-integrate] ${msg}`); }

// Same fix gapps/bundle.js applies for its own sign-in WebView, needed here independently:
// Aurora's own login screen opens a WebView too and crashes the exact same way without it
// (validated by hand, 23/10/2026 -- same native SIGSEGV in the sandboxed renderer). Kept as its
// own constant instead of importing gapps/bundle.js: the two modules are meant to work with or
// without each other, not depend on one another.
const WEBVIEW_COMMAND_LINE = '_ --no-sandbox --single-process --disable-features=WebViewSandboxedRenderer';
const WEBVIEW_COMMAND_LINE_PATH = '/data/local/tmp/webview-command-line';
const REMOTE_APK_PATH = '/data/local/tmp/aurora-store.apk';

async function isInstalled(containerId, opts = {}) {
  try {
    const { stdout } = await execAndroidWithRetry(containerId, ['pm', 'list', 'packages', fetchApk.PACKAGE_ID], opts);
    return stdout.includes(`package:${fetchApk.PACKAGE_ID}`);
  } catch {
    return false;
  }
}

// Stage 6: after every start (see moduleRunner.js). Installing is skipped once the app is
// already there -- `pm install -r` would also work on a reinstall, but there is no reason to
// push ~9MB into the container on every restart of an instance that already has it. The check
// uses the same retry/patience as everything else here: right after a start, Android may not
// have answered `pm` yet, so a quick single-shot check would wrongly conclude "not installed"
// on every restart.
async function ensureRuntimeReady(containerId, {
  exec, dir, fetchImpl, url, sha256, copy, install,
} = {}) {
  const opts = exec ? { exec, delayMs: 1 } : {};

  if (!(await isInstalled(containerId, opts))) {
    const apk = await fetchApk.ensureCached(dir, fetchImpl, url, sha256);
    const doCopy = copy || ((src, dest) => execFileAsync('docker', ['cp', src, `${containerId}:${dest}`]));
    const doInstall = install || ((argv) => execAndroidWithRetry(containerId, argv, opts));
    await doCopy(apk, REMOTE_APK_PATH);
    await doInstall(['pm', 'install', '-r', REMOTE_APK_PATH]);
    log(`installed Aurora Store ${fetchApk.VERSION} into ${containerId}`);
  }

  // Idempotent WebView fix, see the comment above -- applied every time regardless of whether
  // the install above just ran, same as gapps does for its own sign-in screen.
  await execAndroidWithRetry(containerId, [
    'sh', '-c',
    `test -d /data/local/tmp || exit 3; echo '${WEBVIEW_COMMAND_LINE}' > ${WEBVIEW_COMMAND_LINE_PATH} && chmod 0644 ${WEBVIEW_COMMAND_LINE_PATH}`,
  ], opts);
}

module.exports = {
  ensureRuntimeReady, isInstalled, WEBVIEW_COMMAND_LINE, WEBVIEW_COMMAND_LINE_PATH, REMOTE_APK_PATH,
};

'use strict';

// gapps module (stages 4 and 6 -- see manifest.json, lib/moduleRunner.js and
// docs/ARCHITECTURE.md): it injects Google Play services, the Play Store and the Google
// Services Framework into a freshly created instance while it is still stopped, and
// leaves the sign-in usable at runtime.
//
// Unlike hwenc this is NON-FREE third-party software (section 6 of REQUIREMENTS.md):
// redroid-forge neither includes, hosts nor downloads it. The files come from a folder of
// the host that the USER provides (REDROID_FORGE_GAPPS_DIR, by default backend/data/gapps;
// backend/scripts/gapps-extract-sdk.js fills it from the Google Play system image that
// Google publishes for the Android SDK emulator), and EVERY file is verified against its
// sha256 before anything is injected.
//
// Why a coherent modern set (validated 09/10/2026, see docs/ROADMAP.md): GApps of different
// generations do not mix. GMS 22 with a GSF 15 crashes at start (the provider
// com.google.android.gsf.gservices does not exist), and GMS 21 with a GSF 12 starts but its
// update from Google fails with INSTALL_FAILED_CONFLICTING_PROVIDER (the old GSF owns
// com.google.settings). The set GmsCore 24 + Phonesky 41 + GSF 15 of the Android 15 image
// boots, signs in, and Play updates itself to GMS 26 without errors.

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const bundle = require('./bundle');
const { execAndroidWithRetry } = require('../../lib/androidExec');
const execFileAsync = promisify(execFile);

const GAPPS_DIR = process.env.REDROID_FORGE_GAPPS_DIR
  || path.join(__dirname, '..', '..', '..', 'data', 'gapps');

function log(msg) { console.log(`[gapps-integrate] ${msg}`); }
function warn(msg) { console.warn(`[gapps-integrate] ${msg}`); }

function readLocalPackage(dir) {
  const file = path.join(dir, 'package.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new Error(`${file} is not valid JSON: ${e.message}`);
  }
}

// Packages of the known-combinations database. A broken database must not make the
// module unusable -- the local definition is used (unsupported tier).
function dbPackages() {
  try {
    return require('../../lib/knownDbStore').loadCurrent().db.paquetes;
  } catch (e) {
    warn(`the known-combinations database could not be read (${e.message}): only the local package.json is used`);
    return [];
  }
}

// -> { pkg, source: 'db'|'local' }, throws with a message that tells the user what to do.
async function resolveAndVerify(dir = GAPPS_DIR, packages = dbPackages()) {
  const local = readLocalPackage(dir);
  if (!local) {
    throw new Error(
      `GApps: there are no files in ${dir}. This project does not download Google software: `
      + 'put it there yourself (backend/scripts/gapps-extract-sdk.js extracts it from the Google Play '
      + 'system image of the Android SDK) and try again.',
    );
  }
  const chosen = bundle.choosePackage(packages, local);
  if (chosen.error) throw new Error(`GApps: ${chosen.error}`);

  const verdict = await bundle.verifyBundle(dir, chosen.pkg.archivos);
  if (!verdict.ok) {
    const shown = verdict.problems.slice(0, 6).join('; ');
    const more = verdict.problems.length > 6 ? ` (+${verdict.problems.length - 6} more)` : '';
    throw new Error(`GApps: the files in ${dir} do not match the package definition, nothing was injected: ${shown}${more}`);
  }
  return chosen;
}

// Stage 4 (see moduleRunner.js): between runtime.create() and runtime.start(), the
// moment at which /system of the instance can be written with `docker cp` and Android has
// not scanned its packages yet (patching an already-booted volume often keeps the old
// version active: the PackageManager caches its scan).
async function integrate(containerId, ctx = {}, { dir = GAPPS_DIR, packages, copy } = {}) {
  const { pkg, source } = await resolveAndVerify(dir, packages);
  if (source === 'local') {
    warn(`package "${pkg.id || '(no id)'}" is not in the known-combinations database: it is injected, but this combination is UNSUPPORTED`);
  }
  const doCopy = copy || ((src, dest) => execFileAsync('docker', ['cp', `${src}/.`, `${containerId}:${dest}/`]));
  for (const unit of bundle.planCopies(pkg.archivos)) {
    // eslint-disable-next-line no-await-in-loop
    await doCopy(path.join(dir, unit.src), unit.dest);
  }
  log(`injected "${pkg.id || 'gapps'}" (${pkg.archivos.length} files, ${source}) into ${containerId}`);
}

// Stage 6: after every start. Both settings live in /data (per instance) and are
// idempotent. The WebView line has to be there BEFORE the user tries to sign in: without
// it the sandboxed renderer of the sign-in screen dies with SIGSYS inside the container.
async function ensureRuntimeReady(containerId, { exec } = {}) {
  const opts = exec ? { exec, delayMs: 1 } : {};
  // /data/local/tmp is created by Android's init during the first boot, with the owner and
  // mode that `adb`/scrcpy need (shell:shell 0771). It is NOT created here: if it is not
  // there yet the command fails (exit 3) and execAndroidWithRetry tries again later.
  await execAndroidWithRetry(containerId, [
    'sh', '-c',
    `test -d /data/local/tmp || exit 3; echo '${bundle.WEBVIEW_COMMAND_LINE}' > ${bundle.WEBVIEW_COMMAND_LINE_PATH} && chmod 0644 ${bundle.WEBVIEW_COMMAND_LINE_PATH}`,
  ], opts);
  await execAndroidWithRetry(containerId, ['settings', 'put', 'global', 'device_provisioned', '1'], opts);
  await execAndroidWithRetry(containerId, ['settings', 'put', 'secure', 'user_setup_complete', '1'], opts);
  log(`WebView command line and provisioning flags applied in ${containerId}`);
}

module.exports = { integrate, ensureRuntimeReady, resolveAndVerify, GAPPS_DIR };

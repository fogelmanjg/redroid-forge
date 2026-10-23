const fs = require('fs');
const cp = require('child_process');
const runtime = require('./dockerRuntime');

// See hwsimWifi.js for why this is not promisify(execFile).
function execFileAsync(file, args) {
  return new Promise((resolve, reject) => {
    cp.execFile(file, args, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve({ stdout, stderr });
    });
  });
}

function log(msg) { console.log(`[virtWifi] ${msg}`); }
function warn(msg) { console.warn(`[virtWifi] ${msg}`); }

// EXPERIMENTAL, not wired into the "wifi-interno" module/instances.js yet -- see
// docs/ROADMAP.md and the project's memory (project_redroid_wifi_interno). This is the
// alternative backend for the same fake-wifi HAL (SupplicantStaIfaceHalHidlImplExt),
// using the kernel/virt_wifi/ driver instead of mac80211_hwsim: no shared pool of
// phys to claim/move (hwsimWifi.js's whole runHwsimClaim queue), each instance just
// wraps its own `eth0` directly inside its own netns. Deliberately kept as its own
// module (wifi-interno-virtwifi) rather than touching wifi-interno.json/hwsimWifi.js --
// the production path (jg-dashboard, pvz2-tv) stays on hwsim until this is proven
// equally solid on a real app.
//
// The .ko is NOT shipped in the repo (it is built against the exact running kernel of
// whichever host loads it, see kernel/virt_wifi/README.md) -- same reasoning as
// REDROID_HWENC_ARTIFACTS_DIR for hwenc's AOSP-built artifacts.
const KO_PATH = process.env.REDROID_FORGE_VIRTWIFI_KO_PATH || '';

function isModuleLoaded() {
  return fs.existsSync('/sys/module/virt_wifi');
}

// Stage 5 (ensureHostInfraReady): idempotent, called before every create/start/restart.
async function ensureHostInfraReady() {
  if (isModuleLoaded()) return;
  if (!KO_PATH) {
    throw new Error(
      'wifi-interno-virtwifi requires REDROID_FORGE_VIRTWIFI_KO_PATH to point at a virt_wifi.ko '
      + 'built for this host\'s exact running kernel (see kernel/virt_wifi/README.md) -- the module '
      + 'is not loaded and there is no path configured to load it from',
    );
  }
  try {
    await execFileAsync('insmod', [KO_PATH]);
    log('virt_wifi.ko loaded');
  } catch (e) {
    // Lost a race with another create/start also calling this concurrently.
    if (isModuleLoaded()) return;
    throw new Error(`insmod ${KO_PATH} failed: ${e.message || e}`);
  }
}

// Stage 6 (ensureRuntimeReady), against an already-started container: wraps its own
// `eth0` with a `wlan0` net_device of type virt_wifi -- no host-side move, no shared
// pool, each instance's wiphy is born already scoped to its own netns (the creating
// process's netns IS the container's, via `docker exec`). Idempotent: a restart that
// keeps the same container (and so the same netns) hits "File exists" on the second
// call, which is the expected steady state, not a failure.
async function ensureVirtWifiIface(containerId) {
  try {
    await runtime.exec(containerId, ['ip', 'link', 'add', 'link', 'eth0', 'name', 'wlan0', 'type', 'virt_wifi']);
  } catch (e) {
    if (!/File exists/.test(e.output || e.message || '')) {
      warn(`could not create wlan0 for ${containerId}: ${e.message || e}`);
      return;
    }
  }
  try {
    await runtime.exec(containerId, ['ip', 'link', 'set', 'wlan0', 'up']);
  } catch (e) {
    warn(`could not bring wlan0 up for ${containerId}: ${e.message || e}`);
  }
}

// Same shape as hwsimWifi.js's ensureWifiConnected (forces the framework to pick up
// the fake HAL once wlan0 exists) -- kept as its own small copy instead of sharing code
// with hwsimWifi.js, which is live production logic for jg-dashboard/pvz2-tv and is not
// to be touched or coupled to for this experimental path.
async function ensureWifiConnected(containerId) {
  const MAX_ATTEMPTS = 6;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    let status = '';
    try {
      status = await runtime.exec(containerId, ['su', '0', 'sh', '-c', 'cmd wifi status']);
    } catch (e) {
      warn(`status check failed for ${containerId}: ${e}`);
    }
    if (status.includes('Wifi is connected')) return;

    try {
      await runtime.exec(containerId, ['su', '0', 'sh', '-c', 'svc wifi enable']);
      await new Promise((r) => setTimeout(r, 3000));
      await runtime.exec(containerId, ['su', '0', 'sh', '-c', 'cmd wifi connect-network jg-wifi open']);
    } catch (e) {
      warn(`attempt ${i + 1} failed for ${containerId}: ${e}`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  warn(`attempts exhausted for ${containerId} -- it may need a manual reconnection`);
}

// wlan0 is created right away (it is a plain netns-level `ip` op, needs nothing from
// Android) -- the earlier it exists, the better the odds that the framework's own
// first WiFi-enable at boot already sees it. The connect retry loop needs Android's
// shell/`cmd` dispatch alive first, same reasoning as hwsimWifi.js's own 20s delay
// before its scheduleWifiConnectedFix.
const WIFI_CONNECT_DELAY_MS = 20000;

async function ensureRuntimeReady(containerId) {
  await ensureVirtWifiIface(containerId);
  await new Promise((r) => setTimeout(r, WIFI_CONNECT_DELAY_MS));
  await ensureWifiConnected(containerId);
}

module.exports = {
  ensureHostInfraReady, ensureVirtWifiIface, ensureWifiConnected, ensureRuntimeReady,
};

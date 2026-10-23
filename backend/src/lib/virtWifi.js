const fs = require('fs');
const path = require('path');
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

// Stage 4 (integrate): the fake WiFi HAL overlay (patched com.android.wifi.apex +
// com.android.tethering.apex + framework-res.apk, built 23/10/2026 against
// android-15.0.0_r36 -- see redroid-wifi-patches/README.md for the 3 patches: the
// virt_wifi-backed HAL itself, plus the two EthernetTracker fixes that stop eth0 from
// showing up as a parallel ETHERNET transport next to the fake wlan0). Found missing
// the hard way (23/10/2026, first instance created through the real API): stage 5/6
// alone only wire the KERNEL side (the wlan0 net_device) -- without this, the plain
// official image has no supplicant/HAL at all behind it, so `svc wifi enable` reports
// success but the framework never actually leaves "disabled" (nothing above the
// net_device to drive it). Not from any third party (this is our own AOSP build, same
// Apache-2.0 license as the rest of the project) -- no package/hash verification
// needed, a straight overlay like redroid-gralloc-fix's, not like gapps/arm-translation.
const OVERLAY_DIR = process.env.REDROID_FORGE_VIRTWIFI_OVERLAY_DIR
  || path.join(__dirname, '..', '..', 'data', 'virtwifi-overlay');

async function integrate(containerId) {
  const dir = OVERLAY_DIR;
  if (!fs.existsSync(path.join(dir, 'system'))) {
    throw new Error(
      `wifi-interno-virtwifi: no overlay at ${dir} (expected <dir>/system/apex/{com.android.wifi.apex,`
      + 'com.android.tethering.apex} + <dir>/system/framework/framework-res.apk, built from an AOSP tree '
      + 'with redroid-wifi-patches/Wifi-virtwifi.patch + Connectivity.patch + frameworks-base.patch applied) '
      + '-- set REDROID_FORGE_VIRTWIFI_OVERLAY_DIR or place it at the default path',
    );
  }
  for (const unit of ['apex', 'framework']) {
    // eslint-disable-next-line no-await-in-loop
    await execFileAsync('docker', ['cp', `${path.join(dir, 'system', unit)}/.`, `${containerId}:/system/${unit}/`]);
  }
  log(`overlay (wifi apex + tethering apex + framework-res.apk) injected into ${containerId}`);
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
//
// Found for real creating the first instance through the actual API (23/10/2026): `ip` is
// `/system/bin/ip` -- part of Android's OWN rootfs (toybox), not something available the
// instant the container starts. Calling this right after `start()` raced Android's own
// mount/boot sequence and failed with "no such file or directory" (not "File exists", a
// completely different error than the idempotency case above) -- same family of problem
// hwsimWifi.js's `ensureEth0Routing` already retries for. Retried the same way here.
const IFACE_MAX_ATTEMPTS = 8;
const IFACE_RETRY_DELAY_MS = 2000;

async function ensureVirtWifiIface(containerId) {
  let created = false;
  for (let attempt = 1; attempt <= IFACE_MAX_ATTEMPTS && !created; attempt++) {
    try {
      await runtime.exec(containerId, ['ip', 'link', 'add', 'link', 'eth0', 'name', 'wlan0', 'type', 'virt_wifi']);
      created = true;
    } catch (e) {
      if (/File exists/.test(e.output || e.message || '')) { created = true; break; }
      if (attempt === IFACE_MAX_ATTEMPTS) {
        warn(`could not create wlan0 for ${containerId} after ${attempt} attempts: ${e.message || e}`);
        return;
      }
      await new Promise((r) => setTimeout(r, IFACE_RETRY_DELAY_MS));
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
//
// Unlike hwsimWifi.js, this does NOT wrap commands in `su 0 sh -c`: found for real
// (23/10/2026, first instance created through the actual API) that the PLAIN official
// image (what this module targets) ships no `/system/bin/su` at all -- jg-dashboard's
// own images have it only because `su` there is a Magisk symlink
// (`/system/bin/su -> ./magisk`), which `wifi-interno-virtwifi` has no dependency on and
// must not require. `docker exec` already runs as root (confirmed earlier by hand:
// `svc wifi enable`/`cmd wifi connect-network` work directly, no su needed at all).
async function ensureWifiConnected(containerId) {
  const MAX_ATTEMPTS = 6;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    let status = '';
    try {
      status = await runtime.exec(containerId, ['cmd', 'wifi', 'status']);
    } catch (e) {
      warn(`status check failed for ${containerId}: ${e}`);
    }
    if (status.includes('Wifi is connected')) return;

    try {
      await runtime.exec(containerId, ['svc', 'wifi', 'enable']);
      await new Promise((r) => setTimeout(r, 3000));
      await runtime.exec(containerId, ['cmd', 'wifi', 'connect-network', 'jg-wifi', 'open']);
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
  integrate, ensureHostInfraReady, ensureVirtWifiIface, ensureWifiConnected, ensureRuntimeReady,
};

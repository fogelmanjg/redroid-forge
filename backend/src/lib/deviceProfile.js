const runtime = require('./dockerRuntime');

function log(msg) { console.log(`[deviceProfile] ${msg}`); }

// Ports DEVICE_PROFILES/buildDeviceProfileScript from jg-dashboard
// (redroid.service.ts) -- see docs/ROADMAP.md Phase 3 step 1. The Play Store
// filters which apps/games to show according to the self-reported device
// identity (brand/manufacturer/model/fingerprint); some reject the generic
// "redroid" identity. 'samsung' mimics a real, accepted Galaxy A55.
// ro.hardware/ro.boot.hardware are never touched -- they are the ones that load
// the GPU HAL, touching them breaks rendering.
const DEFAULT_PROFILE = 'redroid';

const DEVICE_PROFILES = {
  samsung: {
    brand: 'samsung', manufacturer: 'samsung', device: 'a55x', name: 'a55x', model: 'SM-A5560',
  },
};

// Two path conventions depending on the image generation: Android 15 adds /etc/
// under product and system_ext, Android 11 does not -- all of them are tried, the
// script skips with `[ -f ]` the ones that do not exist in the particular image
// (the same criterion as jg-dashboard, confirmed there with `find / -iname
// build.prop`).
const BUILD_PROP_FILES = [
  '/system/build.prop',
  '/system/system_ext/build.prop',
  '/system/system_ext/etc/build.prop',
  '/system/product/build.prop',
  '/system/product/etc/build.prop',
  '/vendor/build.prop',
  '/vendor/odm/etc/build.prop',
  '/vendor/vendor_dlkm/etc/build.prop',
  '/vendor/odm_dlkm/etc/build.prop',
];

const BACKUP_SUFFIX = '.rf-pre-spoof.bak';

// Hybrid: the profile's identity (brand/device/model) + the image's real build
// id/version -- copying a real device's literal fingerprint would create an
// internal inconsistency between the image's real SDK and the one the fingerprint
// declares (see the originating project's notes).
function androidFingerprint(profile, androidVersion) {
  return `${profile.brand}/${profile.device}/${profile.device}:${androidVersion}`
    + '/BP1A.250505.005.D1/eng.redroid-forge:userdebug/test-keys';
}

// Builds the shell script that edits (profile != null) or reverts (profile ==
// null) build.prop. Before the first mutation of each file it backs it up to
// <file>.rf-pre-spoof.bak inside the container itself -- so reverting to the
// 'redroid' profile restores the real original instead of rebuilding default
// values (which vary per image/architecture).
//
// The final exit code has to reflect whether something could really be written,
// not just "the script did not crash" -- runtime.exec() already rejects if the
// exit code is != 0 (see dockerRuntime.js), so applyDeviceProfile() really
// throwing an error depends on this. The previous version ended every line with
// "; true" so that an ABSENT file (legitimate, not every image has every
// partition) would not bring the script down -- but that also neutralized a
// `sed` that really failed (e.g. the remount above failed and the filesystem is
// still read-only): the script ended in exit 0 anyway, and the caller reported it
// as successfully applied without having touched anything (a real code-review
// finding, PR #3). Now the real result is accumulated in the shell variable `ok`,
// and only the "absent file" is tolerated without touching it.
function buildDeviceProfileScript(profile, androidVersion) {
  const lines = ['ok=1', 'mount -o remount,rw / || ok=0'];
  for (const file of BUILD_PROP_FILES) {
    const backup = `${file}${BACKUP_SUFFIX}`;
    if (profile) {
      const fingerprint = androidFingerprint(profile, androidVersion);
      const subs = [
        `-e 's/^(ro\\.[a-zA-Z0-9_.]*\\.brand)=.*/\\1=${profile.brand}/'`,
        `-e 's/^(ro\\.[a-zA-Z0-9_.]*\\.manufacturer)=.*/\\1=${profile.manufacturer}/'`,
        `-e 's/^(ro\\.[a-zA-Z0-9_.]*\\.device)=.*/\\1=${profile.device}/'`,
        `-e 's/^(ro\\.[a-zA-Z0-9_.]*\\.name)=.*/\\1=${profile.name}/'`,
        `-e 's/^(ro\\.[a-zA-Z0-9_.]*\\.model)=.*/\\1=${profile.model}/'`,
        // delimiter # (not /): the fingerprint carries unescaped slashes
        `-e 's#^(ro\\.[a-zA-Z0-9_.]*\\.fingerprint)=.*#\\1=${fingerprint}#'`,
      ].join(' ');
      // If the file does not exist: it is skipped without touching `ok`
      // (legitimate). If it exists: the backup and the sed both have to succeed,
      // otherwise `ok=0` -- a real failure no longer stays hidden behind a ";true".
      lines.push(`[ -f '${file}' ] && { { [ -f '${backup}' ] || cp '${file}' '${backup}'; } && sed -i -E ${subs} '${file}' || ok=0; }`);
    } else {
      // Without a backup there is nothing to revert for this file -- it is not a
      // failure (that partition may never have had a spoof applied).
      lines.push(`[ -f '${backup}' ] && { cp '${backup}' '${file}' || ok=0; }`);
    }
  }
  // Final exit code = whether `ok` is still 1 -- the only thing that can have
  // lowered it to 0 is a remount/cp/sed that really failed with the file present,
  // never an absent file.
  lines.push('[ "$ok" = "1" ]');
  return lines.join('\n');
}

function resolveProfile(profileKey) {
  const key = profileKey || DEFAULT_PROFILE;
  if (key === DEFAULT_PROFILE) return { key, profile: null };
  const profile = DEVICE_PROFILES[key];
  if (!profile) throw new Error(`Unknown device profile: "${key}"`);
  return { key, profile };
}

// Applies (a named profile) or reverts (profileKey=undefined/'redroid') a device
// profile inside an ALREADY RUNNING instance -- "mount -o remount,rw /" needs the
// overlay that Android's init sets up, it cannot be done with the container still
// stopped (stage 4 of ARCHITECTURE.md does not apply here). It follows the same
// pattern as ensureWifiConnected/ensureEth0Routing in hwsimWifi.js: 'su -c' to
// act as root inside the privileged container.
async function applyDeviceProfile(containerId, androidVersion, profileKey) {
  const { key, profile } = resolveProfile(profileKey);
  const script = buildDeviceProfileScript(profile, androidVersion);
  await runtime.exec(containerId, ['su', '-c', script]);
  log(`profile "${key}" applied in container ${containerId}`);
  return key;
}

module.exports = {
  DEFAULT_PROFILE, DEVICE_PROFILES, BUILD_PROP_FILES,
  buildDeviceProfileScript, applyDeviceProfile,
};

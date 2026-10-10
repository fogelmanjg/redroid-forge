#!/usr/bin/env node
'use strict';

// Extracts from the x86_64 system image of the Android SDK -- a .zip that Google publishes and that
// YOU download (this project does not download Google software) -- the files that a module injects:
//
//   https://dl.google.com/android/repository/sys-img/google_apis_playstore/x86_64-35_r09.zip
//
//   node backend/scripts/sdk-extract.js <gapps|arm-translation> <x86_64-35_r09.zip> [outDir]
//
//   gapps            Google Play services, Play Store and GSF  -> backend/data/gapps (REDROID_FORGE_GAPPS_DIR)
//   arm-translation  the ndk_translation native bridge         -> backend/data/arm-translation (REDROID_FORGE_ARM_DIR)
//
// It leaves in outDir the files laid out as the module expects, and a package.json with the sha256 of
// each. It needs Docker (it runs in an alpine container where it installs erofs-utils, so the host
// needs no extra tools) and network access for that `apk add`.
//
// Using that image outside the development of Android apps is a gray area of Google's SDK license:
// reading it, and deciding, is up to you. See the manifest of each module.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// The sha1 that Google publishes for this file in its repository index
// (sys-img2-1.xml). It is only a sanity check of the download, not of what is injected:
// every extracted file is verified one by one against package.json.
const IMAGES = {
  'x86_64-35_r09.zip': {
    sha1: '2f0054868e6aab3c098acd3decba17a82aed4176',
    version: 'Android 15 (API 35) Google Play x86_64, r09',
    origen: 'https://dl.google.com/android/repository/sys-img/google_apis_playstore/x86_64-35_r09.zip',
    ids: { gapps: 'gapps-sdk35-r09-x86_64', 'arm-translation': 'arm-translation-sdk35-r09-x86_64' },
  },
};
const PROFILES = {
  gapps: { env: 'REDROID_FORGE_GAPPS_DIR', dir: 'gapps' },
  'arm-translation': { env: 'REDROID_FORGE_ARM_DIR', dir: 'arm-translation' },
};

function sha1File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(file).on('error', reject).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}

async function main() {
  const [profile, zip, outArg] = process.argv.slice(2);
  if (!PROFILES[profile] || !zip || !fs.existsSync(zip)) {
    console.error(`Usage: node sdk-extract.js <${Object.keys(PROFILES).join('|')}> <x86_64-35_r09.zip> [outDir]`);
    process.exit(1);
  }
  const out = path.resolve(outArg
    || process.env[PROFILES[profile].env]
    || path.join(__dirname, '..', 'data', PROFILES[profile].dir));

  const image = IMAGES[path.basename(zip)];
  const known = image ? { sha1: image.sha1, version: image.version, origen: image.origen, id: image.ids[profile] } : undefined;
  const sha1 = await sha1File(zip);
  if (!known) {
    console.warn(`WARNING: ${path.basename(zip)} is not an image this tool was validated with (${Object.keys(IMAGES).join(', ')}). It will be tried anyway; the package will be reported as unsupported.`);
  } else if (known.sha1 !== sha1) {
    console.error(`The sha1 of the zip (${sha1}) is not the one Google publishes (${known.sha1}): the download is corrupt or it is another build. Nothing was extracted.`);
    process.exit(1);
  } else {
    console.log('sha1 of the zip OK');
  }

  fs.mkdirSync(out, { recursive: true });
  const meta = JSON.stringify({ ...(known || {}), origenSha1: sha1 });
  const r = spawnSync('docker', [
    'run', '--rm',
    '-e', `PKG_META=${meta}`,
    '-e', `PROFILE=${profile}`,
    '-e', `HOST_UID=${process.getuid()}`,
    '-e', `HOST_GID=${process.getgid()}`,
    '-v', `${path.resolve(zip)}:/in/sdk.zip:ro`,
    '-v', `${out}:/out`,
    '-v', `${path.join(__dirname, 'sdk-extract', 'extract.py')}:/extract.py:ro`,
    'alpine:3.20',
    'sh', '-c', 'apk add --no-cache python3 erofs-utils unzip >/dev/null && python3 /extract.py',
  ], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
  console.log(`\nFiles and package.json in ${out}. The ${profile} module verifies them before injecting.`);
}

main().catch((e) => { console.error(e); process.exit(1); });

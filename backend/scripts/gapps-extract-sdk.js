#!/usr/bin/env node
'use strict';

// Extracts the GApps files that the gapps module injects from the Google Play x86_64
// system image of the Android SDK -- a .zip that Google publishes and that YOU download
// (this project does not download Google software):
//
//   https://dl.google.com/android/repository/sys-img/google_apis_playstore/x86_64-35_r09.zip
//
//   node backend/scripts/gapps-extract-sdk.js <x86_64-35_r09.zip> [outDir]
//
// outDir defaults to backend/data/gapps (REDROID_FORGE_GAPPS_DIR if set). It leaves there
// the files laid out as the module expects, and a package.json with the sha256 of each.
// It needs Docker (it runs in an alpine container where it installs erofs-utils, so the
// host needs no extra tools) and network access for that `apk add`.
//
// Using that image outside the development of Android apps is a gray area of Google's SDK
// license: reading it, and deciding, is up to you. See the manifest of the gapps module.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// The sha1 that Google publishes for this file in its repository index
// (sys-img2-1.xml). It is only a sanity check of the download, not of what is injected:
// every extracted file is verified one by one against package.json.
const KNOWN = {
  'x86_64-35_r09.zip': {
    sha1: '2f0054868e6aab3c098acd3decba17a82aed4176',
    id: 'gapps-sdk35-r09-x86_64',
    version: 'Android 15 (API 35) Google Play x86_64, r09',
    origen: 'https://dl.google.com/android/repository/sys-img/google_apis_playstore/x86_64-35_r09.zip',
  },
};

function sha1File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(file).on('error', reject).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}

async function main() {
  const zip = process.argv[2];
  if (!zip || !fs.existsSync(zip)) {
    console.error('Usage: node gapps-extract-sdk.js <x86_64-35_r09.zip> [outDir]');
    process.exit(1);
  }
  const out = path.resolve(process.argv[3]
    || process.env.REDROID_FORGE_GAPPS_DIR
    || path.join(__dirname, '..', 'data', 'gapps'));

  const known = KNOWN[path.basename(zip)];
  const sha1 = await sha1File(zip);
  if (!known) {
    console.warn(`WARNING: ${path.basename(zip)} is not an image this tool was validated with (${Object.keys(KNOWN).join(', ')}). It will be tried anyway; the package will be reported as unsupported.`);
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
    '-e', `HOST_UID=${process.getuid()}`,
    '-e', `HOST_GID=${process.getgid()}`,
    '-v', `${path.resolve(zip)}:/in/sdk.zip:ro`,
    '-v', `${out}:/out`,
    '-v', `${path.join(__dirname, 'gapps-extract-sdk', 'extract.py')}:/extract.py:ro`,
    'alpine:3.20',
    'sh', '-c', 'apk add --no-cache python3 erofs-utils unzip >/dev/null && python3 /extract.py',
  ], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
  console.log(`\nFiles and package.json in ${out}. The gapps module verifies them before injecting.`);
}

main().catch((e) => { console.error(e); process.exit(1); });

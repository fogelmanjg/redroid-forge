'use strict';

// Pure core of the aurora-store module: where its APK comes from and how it is verified,
// kept separate from integrate.js (which touches Docker) so it can be tested without
// containers -- same split as modules/gapps/bundle.js.
//
// Unlike gapps, Aurora Store is GPLv3 (https://github.com/whyorean/AuroraStore): this project
// CAN redistribute it, so there is no "you provide the files" step for the user. It is
// downloaded once per host from its official F-Droid mirror and cached -- pinned to a specific
// version/sha256 here, not "latest", for the same reason the known-combinations database is
// signed and anti-rollback: an APK that silently changes out from under a pinned manifest
// version would defeat the point of pinning.
//
// Why 4.8.3 and not a newer release (validated by hand, 23/10/2026, see docs/ROADMAP.md): 4.8.4
// crashes on its own app-list screens (a Jetpack Compose LazyColumn duplicate-key bug introduced
// by that version's UI rewrite, confirmed against the official changelog).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERSION = '4.8.3';
// F-Droid serves APKs as com.aurora.store_<versionCode>.apk, not by versionName -- 75 is the
// versionCode of 4.8.3 (confirmed against https://f-droid.org/api/v1/packages/com.aurora.store).
const FDROID_VERSION_CODE = 75;
const SHA256 = 'c4ce0df0bbb0e82be4e4bd7d8a3e000f08e04457187d560fe2ca3ae52941bf49';
const URL = `https://f-droid.org/repo/com.aurora.store_${FDROID_VERSION_CODE}.apk`;
const MAX_BYTES = 32 * 1024 * 1024;
const TIMEOUT_MS = 30000;
const PACKAGE_ID = 'com.aurora.store';

const AURORA_STORE_DIR = process.env.REDROID_FORGE_AURORA_STORE_DIR
  || path.join(__dirname, '..', '..', '..', 'data', 'aurora-store');

function cachedApkPath(dir = AURORA_STORE_DIR) {
  return path.join(dir, `aurora-store-${VERSION}.apk`);
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')));
  });
}

function writeAtomic(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
}

async function download(url = URL, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow' });
  } catch (e) {
    throw new Error(`could not connect to ${url}: ${e.message}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} requesting ${url}`);
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > MAX_BYTES) throw new Error(`${url} exceeds ${MAX_BYTES} bytes`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error(`${url} exceeds ${MAX_BYTES} bytes`);
  return buf;
}

// -> absolute path of a verified APK, downloading it first if it is not cached yet (or if what
// is cached does not match the pinned sha256 -- a half-written file from a previous crashed run
// must never be treated as good). Nothing is ever installed into an instance without this check.
// `sha256`/`url` are overridable (tests only, see test/auroraStore.test.js): production code
// never calls this with anything but the pinned constants.
async function ensureCached(dir = AURORA_STORE_DIR, fetchImpl = fetch, url = URL, sha256 = SHA256) {
  const file = cachedApkPath(dir);
  if (fs.existsSync(file) && (await sha256File(file)) === sha256) return file;
  const buf = await download(url, fetchImpl);
  const got = crypto.createHash('sha256').update(buf).digest('hex');
  if (got !== sha256) {
    throw new Error(
      `downloaded Aurora Store ${VERSION} does not match the pinned sha256 `
      + `(expected ${sha256.slice(0, 12)}…, got ${got.slice(0, 12)}…) -- discarded, nothing installed`,
    );
  }
  writeAtomic(file, buf);
  return file;
}

module.exports = {
  VERSION, FDROID_VERSION_CODE, SHA256, URL, MAX_BYTES, PACKAGE_ID, AURORA_STORE_DIR,
  cachedApkPath, sha256File, download, ensureCached,
};

'use strict';

// Pure core + small fs helpers of the gapps module: what a "GApps package" is, how it
// is verified and where each file goes inside the instance. No Docker here, so it can
// be tested without containers (see test/gappsBundle.test.js).
//
// A GApps package is a set of FILES with a sha256 each (not one archive): the files that
// the user extracts from the Google Play system image of the Android SDK (see
// backend/scripts/gapps-extract-sdk.js) into a folder, laid out exactly as they have to
// end up in the instance:
//   product/priv-app/<App>/<App>.apk
//   product/etc/{permissions,default-permissions,sysconfig}/*.xml
//   system_ext/priv-app/<App>/<App>.apk
//   system_ext/etc/permissions/*.xml
// plus a package.json (written by the extraction tool) that describes it.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  ALLOWED_PARTITIONS, ALLOWED_SUBDIRS, RULES, validateFiles, bundleDigest,
} = require('../../lib/fileBundle');

// WebView command line that makes the Google sign-in screen work inside the container
// (validated on 09/10/2026: without it the sandboxed renderer dies with SIGSYS and the
// Google account flow ends in addaccount.ErrorActivity).
const WEBVIEW_COMMAND_LINE = '_ --no-sandbox --single-process --disable-features=WebViewSandboxedRenderer';
const WEBVIEW_COMMAND_LINE_PATH = '/data/local/tmp/webview-command-line';

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')));
  });
}

// Verifies every file of `dir` against the definition. It also reports files that are
// in the folders the module would copy but that the definition does NOT list: they would
// be injected without having been verified, so they are a problem too.
// -> { ok, problems: [string] }
async function verifyBundle(dir, files, rules = RULES.gapps) {
  const problems = validateFiles(files, rules);
  if (problems.length > 0) return { ok: false, problems };

  for (const f of files) {
    const abs = path.join(dir, f.path);
    let st;
    try { st = fs.statSync(abs); } catch { problems.push(`${f.path}: missing`); continue; }
    if (!st.isFile()) { problems.push(`${f.path}: is not a file`); continue; }
    if (Number.isFinite(f.tamano) && st.size !== f.tamano) {
      problems.push(`${f.path}: size ${st.size} != ${f.tamano}`);
      continue;
    }
    // The mode matters for what has to be executable; docker cp keeps the one of the host's file.
    if (Number.isInteger(f.modo) && (st.mode & 0o777) !== f.modo) {
      problems.push(`${f.path}: mode ${(st.mode & 0o777).toString(8)} != ${f.modo.toString(8)}`);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const got = await sha256File(abs);
    if (got !== f.sha256) problems.push(`${f.path}: sha256 mismatch (expected ${f.sha256.slice(0, 12)}…, got ${got.slice(0, 12)}…)`);
  }

  const known = new Set(files.map((f) => f.path));
  for (const extra of listFiles(dir, rules.partitions)) {
    if (extra === 'package.json') continue;
    if (!known.has(extra)) problems.push(`${extra}: present in the folder but not in the package definition (it would be injected unverified)`);
  }
  return { ok: problems.length === 0, problems };
}

// Relative paths of all the files under the allowed partitions of `dir`.
function listFiles(dir, partitions = ALLOWED_PARTITIONS) {
  const out = [];
  const walk = (rel) => {
    const abs = path.join(dir, rel);
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else out.push(r);
    }
  };
  for (const partition of partitions) walk(partition);
  // package.json at the root is the only non-partition file that is expected.
  if (fs.existsSync(path.join(dir, 'package.json'))) out.push('package.json');
  return out;
}

// The `docker cp` operations that inject the package: one per "<partition>/<subdir>"
// that appears in the files. `docker cp <src>/. <container>:<dest>/` merges the content
// into the (already existing) folder of the instance. Pure.
function planCopies(files) {
  const units = new Set();
  for (const f of files) {
    const [partition, sub] = f.path.split('/');
    units.add(`${partition}/${sub}`);
  }
  return [...units].sort().map((u) => ({ src: u, dest: `/system/${u}` }));
}

// Chooses the package definition. `dbPackages`: the `paquetes` of the known-combinations
// database; `localPackage`: the package.json written by the extraction tool (or null).
//   - If the database knows a gapps package with `archivos` that matches the local
//     folder's definition (same list), the database's one is used -> source 'db' (the
//     combination can be official).
//   - If the database has no such package, the local definition is used -> source
//     'local' (unsupported tier: the project cannot vouch for those hashes).
//   - If both exist but DIFFER, nothing is injected: the folder is not the package the
//     database vouches for.
// -> { pkg, source } | { error }
function choosePackage(dbPackages, localPackage, tipo = 'gapps') {
  const dbGapps = (dbPackages || []).filter((p) => p.tipo === tipo && Array.isArray(p.archivos));
  if (!localPackage || !Array.isArray(localPackage.archivos)) {
    return { error: 'there is no package.json in the GApps folder (it is written by the extraction tool, backend/scripts/sdk-extract.js)' };
  }
  const localDigest = bundleDigest(localPackage.archivos);
  const match = dbGapps.find((p) => bundleDigest(p.archivos) === localDigest);
  if (match) return { pkg: match, source: 'db' };
  if (dbGapps.length > 0 && localPackage.id && dbGapps.some((p) => p.id === localPackage.id)) {
    return { error: `the folder claims to be package "${localPackage.id}" but its files differ from the ones the database vouches for` };
  }
  return { pkg: localPackage, source: 'local' };
}

module.exports = {
  ALLOWED_PARTITIONS,
  ALLOWED_SUBDIRS,
  WEBVIEW_COMMAND_LINE,
  WEBVIEW_COMMAND_LINE_PATH,
  sha256File,
  validateFiles,
  bundleDigest,
  verifyBundle,
  listFiles,
  planCopies,
  choosePackage,
};

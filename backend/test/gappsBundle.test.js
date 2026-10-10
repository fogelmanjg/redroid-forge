'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const bundle = require('../src/modules/gapps/bundle');
const gapps = require('../src/modules/gapps/integrate');
const moduleGate = require('../src/lib/moduleGate');
const { execAndroidWithRetry } = require('../src/lib/androidExec');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// A tiny package laid out like the real one (the files' content is irrelevant here).
function makeFolder(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gapps-test-'));
  const content = {
    'product/priv-app/Phonesky/Phonesky.apk': 'phonesky',
    'product/etc/permissions/privapp-permissions-google-p.xml': '<permissions/>',
    'system_ext/priv-app/GoogleServicesFramework/GoogleServicesFramework.apk': 'gsf',
    ...extra,
  };
  const archivos = [];
  for (const [rel, data] of Object.entries(content)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), data);
    archivos.push({ path: rel, sha256: sha(data), tamano: Buffer.byteLength(data) });
  }
  const pkg = { id: 'gapps-test', tipo: 'gapps', archivos };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  return { dir, pkg };
}
const rm = (dir) => fs.rmSync(dir, { recursive: true, force: true });

test('validateFiles: accepts the allowed layout and rejects unsafe or out-of-scope paths', () => {
  const ok = { path: 'product/priv-app/X/X.apk', sha256: 'a'.repeat(64) };
  assert.deepEqual(bundle.validateFiles([ok]), []);
  for (const bad of ['../etc/passwd', '/system/bin/su', 'product/../x/y/z', 'vendor/lib64/x.so', 'product/bin/x', 'product/priv-app', 'a\\b/c/d']) {
    assert.ok(bundle.validateFiles([{ ...ok, path: bad }]).length > 0, `must reject ${bad}`);
  }
  assert.ok(bundle.validateFiles([{ path: ok.path, sha256: 'xyz' }]).length > 0, 'sha256 is mandatory');
  assert.ok(bundle.validateFiles([ok, ok]).some((p) => /duplicated/.test(p)));
  assert.ok(bundle.validateFiles([]).length > 0);
});

test('bundleDigest: independent of the order of the files, sensitive to any change', () => {
  const a = { path: 'product/priv-app/A/A.apk', sha256: '1'.repeat(64) };
  const b = { path: 'product/priv-app/B/B.apk', sha256: '2'.repeat(64) };
  assert.strictEqual(bundle.bundleDigest([a, b]), bundle.bundleDigest([b, a]));
  assert.notStrictEqual(bundle.bundleDigest([a, b]), bundle.bundleDigest([a, { ...b, sha256: '3'.repeat(64) }]));
  assert.notStrictEqual(bundle.bundleDigest([a, b]), bundle.bundleDigest([a]));
});

test('verifyBundle: ok for an intact folder', async () => {
  const { dir, pkg } = makeFolder();
  try {
    const r = await bundle.verifyBundle(dir, pkg.archivos);
    assert.deepStrictEqual(r, { ok: true, problems: [] });
  } finally { rm(dir); }
});

test('verifyBundle: detects a tampered file, a missing file and an unlisted extra file', async () => {
  const { dir, pkg } = makeFolder();
  try {
    fs.writeFileSync(path.join(dir, 'product/priv-app/Phonesky/Phonesky.apk'), 'TAMPERED!');
    fs.unlinkSync(path.join(dir, 'product/etc/permissions/privapp-permissions-google-p.xml'));
    fs.mkdirSync(path.join(dir, 'product/priv-app/Evil'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'product/priv-app/Evil/Evil.apk'), 'x');
    const r = await bundle.verifyBundle(dir, pkg.archivos);
    assert.strictEqual(r.ok, false);
    const text = r.problems.join('\n');
    assert.match(text, /Phonesky\.apk: (size|sha256 mismatch)/);
    assert.match(text, /privapp-permissions-google-p\.xml: missing/);
    assert.match(text, /Evil\.apk: present in the folder but not in the package definition/);
  } finally { rm(dir); }
});

test('planCopies: one docker cp per partition/subdir, always inside /system', () => {
  const plan = bundle.planCopies([
    { path: 'product/priv-app/A/A.apk' }, { path: 'product/priv-app/B/B.apk' },
    { path: 'product/etc/permissions/p.xml' }, { path: 'system_ext/priv-app/G/G.apk' },
  ]);
  assert.deepStrictEqual(plan, [
    { src: 'product/etc', dest: '/system/product/etc' },
    { src: 'product/priv-app', dest: '/system/product/priv-app' },
    { src: 'system_ext/priv-app', dest: '/system/system_ext/priv-app' },
  ]);
});

test('choosePackage: the database wins when it knows the same files; otherwise local (unsupported); a lookalike is refused', () => {
  const files = [{ path: 'product/priv-app/A/A.apk', sha256: '1'.repeat(64) }];
  const dbPkg = { id: 'gapps-sdk35', tipo: 'gapps', archivos: files };
  assert.strictEqual(bundle.choosePackage([dbPkg], { id: 'whatever', archivos: files }).source, 'db');
  assert.strictEqual(bundle.choosePackage([], { id: 'mine', archivos: files }).source, 'local');
  const other = [{ path: 'product/priv-app/A/A.apk', sha256: '9'.repeat(64) }];
  const impostor = bundle.choosePackage([dbPkg], { id: 'gapps-sdk35', archivos: other });
  assert.match(impostor.error, /differ from the ones the database vouches for/);
  assert.match(bundle.choosePackage([], null).error, /no package\.json/);
});

test('integrate: verifies, then copies each unit to /system; nothing is copied if a hash does not match', async () => {
  const { dir, pkg } = makeFolder();
  try {
    const calls = [];
    await gapps.integrate('cid', {}, { dir, packages: [], copy: async (src, dest) => calls.push([path.relative(dir, src), dest]) });
    assert.deepStrictEqual(calls, [
      ['product/etc', '/system/product/etc'],
      ['product/priv-app', '/system/product/priv-app'],
      ['system_ext/priv-app', '/system/system_ext/priv-app'],
    ]);

    fs.writeFileSync(path.join(dir, pkg.archivos[0].path), 'changed after extraction');
    const calls2 = [];
    await assert.rejects(
      () => gapps.integrate('cid', {}, { dir, packages: [], copy: async (s, d) => calls2.push([s, d]) }),
      /do not match the package definition, nothing was injected/,
    );
    assert.deepStrictEqual(calls2, []);
  } finally { rm(dir); }
});

test('integrate: an empty folder explains that the user has to provide the files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gapps-empty-'));
  try {
    await assert.rejects(() => gapps.integrate('cid', {}, { dir, packages: [] }), /does not download Google software/);
  } finally { rm(dir); }
});

test('moduleGate.requiredModuleIds: gapps can be requested per instance, nothing else can', () => {
  const img = { id: 'x', androidVersion: 15, gpuMode: 'host' };
  assert.deepStrictEqual(moduleGate.requiredModuleIds(img, ['gapps']), ['gapps']);
  assert.deepStrictEqual(moduleGate.requiredModuleIds(img, undefined), []);
  assert.deepStrictEqual(moduleGate.requiredModuleIds({ ...img, hasGapps: true }, ['gapps']), ['gapps']);
  assert.throws(() => moduleGate.requiredModuleIds(img, ['hwenc']), (e) => e.httpStatus === 400);
  assert.throws(() => moduleGate.requiredModuleIds(img, 'gapps'), (e) => e.httpStatus === 400);
  assert.throws(() => moduleGate.requiredModuleIds(img, [42]), (e) => e.httpStatus === 400);
});

test('execAndroidWithRetry: retries until Android answers, gives up after the attempts', async () => {
  let n = 0;
  const flaky = async () => { n += 1; if (n < 3) throw Object.assign(new Error('not booted'), { code: 255 }); return { stdout: 'ok' }; };
  assert.deepStrictEqual(await execAndroidWithRetry('c', ['x'], { delayMs: 1, exec: flaky }), { stdout: 'ok' });
  assert.strictEqual(n, 3);

  let m = 0;
  const dead = async () => { m += 1; throw Object.assign(new Error('nope'), { code: 255 }); };
  await assert.rejects(() => execAndroidWithRetry('c', ['x'], { attempts: 4, delayMs: 1, exec: dead }), /nope/);
  assert.strictEqual(m, 4);

  let k = 0;
  const definitive = async () => { k += 1; throw Object.assign(new Error('no'), { code: 1 }); };
  await assert.rejects(() => execAndroidWithRetry('c', ['x'], { delayMs: 1, noRetryCodes: [1], exec: definitive }));
  assert.strictEqual(k, 1);
});

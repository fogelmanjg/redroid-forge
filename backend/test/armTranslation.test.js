'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const arm = require('../src/modules/arm-translation/integrate');
const moduleGate = require('../src/lib/moduleGate');
const moduleRunner = require('../src/lib/moduleRunner');
const { validateFiles, RULES } = require('../src/lib/fileBundle');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function makeFolder(content = {
  'system/lib64/libndk_translation.so': 'translator',
  'system/lib64/libberberis_exec_region.so': 'region',
  'system/lib64/libndk_translation_proxy_libc.so': 'proxy',
  'system/lib64/arm64/libc.so': 'arm libc',
  'system/bin/arm64/linker64': 'arm linker',
  'system/etc/cpuinfo.arm64.txt': 'cpu',
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arm-test-'));
  const archivos = [];
  for (const [rel, data] of Object.entries(content)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), data);
    if (rel.startsWith('system/bin/')) fs.chmodSync(path.join(dir, rel), 0o755);
    archivos.push({
      path: rel, sha256: sha(data), tamano: Buffer.byteLength(data), ...(rel.startsWith('system/bin/') ? { modo: 0o755 } : {}),
    });
  }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ id: 'arm-local', tipo: 'arm-translation', archivos }));
  return { dir, archivos };
}

test('a valid folder verifies and is reported as local (unsupported) when the database does not know it', async () => {
  const { dir } = makeFolder();
  const r = await arm.resolveAndVerify(dir, []);
  assert.strictEqual(r.source, 'local');
  assert.strictEqual(r.pkg.archivos.length, 6);
});

test('the database package is used when its files are the folder\'s', async () => {
  const { dir, archivos } = makeFolder();
  const r = await arm.resolveAndVerify(dir, [{ id: 'arm-db', tipo: 'arm-translation', archivos }]);
  assert.strictEqual(r.source, 'db');
});

test('a tampered file is refused and nothing is injected', async () => {
  const { dir } = makeFolder();
  fs.writeFileSync(path.join(dir, 'system/lib64/libndk_translation.so'), 'evil');
  await assert.rejects(() => arm.resolveAndVerify(dir, []), /do not match/);
});

test('an extra file in the folder is refused (it would be injected unverified)', async () => {
  const { dir } = makeFolder();
  fs.writeFileSync(path.join(dir, 'system/lib64/extra.so'), 'x');
  await assert.rejects(() => arm.resolveAndVerify(dir, []), /not in the package definition/);
});

test('a package that lists another library of /system/lib64 is refused, whatever its hashes say', async () => {
  const { dir } = makeFolder({ 'system/lib64/libc.so': 'replace bionic' });
  await assert.rejects(() => arm.resolveAndVerify(dir, []), /never injects/);
});

test('a file whose mode is not the one of the definition is refused (the linker has to be executable)', async () => {
  const { dir } = makeFolder();
  fs.chmodSync(path.join(dir, 'system/bin/arm64/linker64'), 0o644);
  await assert.rejects(() => arm.resolveAndVerify(dir, []), /mode 644 != 755/);
});

test('only the names of the translation may be injected, even in the folders it writes to', () => {
  for (const ok of ['system/bin/arm64/linker64', 'system/lib64/arm64/libc++.so', 'system/etc/ld.config.arm64.txt']) {
    assert.ok(arm.ALLOWED_FILE.test(ok), ok);
  }
  for (const bad of ['system/bin/sh', 'system/bin/arm64/su', 'system/etc/hosts', 'system/lib64/libc.so', 'system/lib64/arm64/../libc.so']) {
    assert.ok(!arm.ALLOWED_FILE.test(bad), bad);
  }
});

test('the path rules: this kind of package writes only lib64, bin and etc of /system', () => {
  const ok = { sha256: 'a'.repeat(64) };
  assert.deepStrictEqual(validateFiles([{ path: 'system/lib64/x.so', ...ok }], RULES['arm-translation']), []);
  assert.deepStrictEqual(validateFiles([{ path: 'system/bin/arm64/x', ...ok }], RULES['arm-translation']), []);
  assert.ok(validateFiles([{ path: 'system/framework/x.jar', ...ok }], RULES['arm-translation']).length > 0);
  assert.ok(validateFiles([{ path: 'product/priv-app/x/x.apk', ...ok }], RULES['arm-translation']).length > 0);
});

test('stage 3 adds the boot properties; stage 4 copies lib64, bin and etc of the folder', async () => {
  const { dir } = makeFolder();
  const req = await arm.prepareCreate({ dir, packages: [] });
  assert.ok(req.cmd.includes('ro.dalvik.vm.native.bridge=libndk_translation.so'));
  assert.ok(req.cmd.includes('ro.dalvik.vm.isa.arm64=x86_64'));
  assert.ok(!req.cmd.some((c) => /binfmt|native.bridge.exec/.test(c)), 'it must not touch the host\'s binfmt_misc');
  const calls = [];
  await arm.integrate('cid', {}, { dir, packages: [], copy: async (src, dest) => calls.push([src, dest]) });
  assert.deepStrictEqual(calls, ['lib64', 'bin', 'etc'].map((u) => [path.join(dir, 'system', u), `/system/${u}`]));
});

test('the module can be requested per instance and takes part in stages 3 and 4', async () => {
  assert.ok(moduleGate.OPTIONAL_PER_INSTANCE.includes('arm-translation'));
  const img = { id: 'x', hwEncCapable: false };
  assert.ok(moduleGate.requiredModuleIds(img, ['arm-translation']).includes('arm-translation'));
  assert.ok(typeof moduleRunner.prepareCreate === 'function');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const fix = require('../src/modules/redroid-gralloc-fix/integrate');
const moduleGate = require('../src/lib/moduleGate');
const images = require('../images.json');

// A file that is zeros except for the bytes around the change, as they are in the official image.
function fakeGralloc(middle = '31c9') {
  const buf = Buffer.alloc(0x6000, 0xcc);
  Buffer.from('7c24107507b901000000eb09', 'hex').copy(buf, fix.OFFSET - 12);
  Buffer.from(middle, 'hex').copy(buf, fix.OFFSET);
  Buffer.from('eb05b90300000031d2f7', 'hex').copy(buf, fix.OFFSET + 2);
  return buf;
}

test('patchGralloc changes exactly the two bytes and nothing else', () => {
  const src = fakeGralloc();
  const r = fix.patchGralloc(src);
  assert.strictEqual(r.status, 'patched');
  assert.strictEqual(r.buffer.subarray(fix.OFFSET, fix.OFFSET + 2).toString('hex'), 'b104');
  const diff = [...r.buffer].map((b, i) => (b !== src[i] ? i : -1)).filter((i) => i >= 0);
  assert.deepStrictEqual(diff, [fix.OFFSET, fix.OFFSET + 1]);
  assert.strictEqual(src.subarray(fix.OFFSET, fix.OFFSET + 2).toString('hex'), '31c9', 'the input is not modified');
});

test('an already patched file is recognised and left alone', () => {
  assert.strictEqual(fix.patchGralloc(fakeGralloc('b104')).status, 'already');
});

test('any other version of the file is not touched', () => {
  const other = fakeGralloc();
  other[fix.OFFSET - 3] ^= 0xff;
  assert.strictEqual(fix.patchGralloc(other).status, 'unknown');
  assert.strictEqual(fix.patchGralloc(Buffer.alloc(100)).status, 'unknown');
  assert.strictEqual(fix.patchGralloc(fakeGralloc('9090')).status, 'unknown');
});

test('integrate installs the init script, then copies the file out, patches it and copies it back with the same mode', async () => {
  const calls = [];
  await fix.integrate('cid', {}, {
    gpuVendor: 'amd',
    copyOut: async (src, dest) => { calls.push(['out', src]); fs.writeFileSync(dest, fakeGralloc(), { mode: 0o644 }); },
    copyIn: async (src, dest) => {
      calls.push(['in', dest]);
      if (dest === fix.TARGET) {
        assert.strictEqual(fs.readFileSync(src).subarray(fix.OFFSET, fix.OFFSET + 2).toString('hex'), 'b104');
        assert.strictEqual(fs.statSync(src).mode & 0o777, 0o644);
      }
    },
  });
  assert.deepStrictEqual(calls, [['in', fix.RC_TARGET], ['out', fix.TARGET], ['in', fix.TARGET]]);
});

test('the init script sets the Mesa option that stops EGL from offering 10-bit configurations', () => {
  const rc = fs.readFileSync(fix.RC_SOURCE, 'utf8');
  assert.match(rc, /^on early-init$/m);
  assert.match(rc, /^\s+export allow_rgb10_configs false$/m);
  assert.strictEqual(fix.RC_TARGET, '/vendor/etc/init/redroid-no-rgb10.rc');
});

test('integrate does not copy anything back when the file is unknown or already fixed', async () => {
  for (const content of [Buffer.alloc(500), fakeGralloc('b104')]) {
    const copiedBack = [];
    // eslint-disable-next-line no-await-in-loop
    await fix.integrate('cid', {}, {
      gpuVendor: 'intel',
      copyOut: async (src, dest) => fs.writeFileSync(dest, content),
      copyIn: async (src, dest) => { copiedBack.push(dest); },
    });
    assert.deepStrictEqual(copiedBack, [fix.RC_TARGET], 'only the init script, never the library');
  }
});

test('the official image is bound to the module', () => {
  const official = images.find((i) => i.id === 'android-15-official');
  assert.strictEqual(official.needsGrallocFix, true);
  assert.ok(moduleGate.requiredModuleIds(official, []).includes('redroid-gralloc-fix'));
  assert.ok(!moduleGate.OPTIONAL_PER_INSTANCE.includes('redroid-gralloc-fix'), 'it is not an option: the image always gets it');
});

test('on a host that is neither AMD nor Intel it does not even look at the file', async () => {
  for (const gpuVendor of ['nvidia', 'unknown']) {
    let touched = false;
    // eslint-disable-next-line no-await-in-loop
    await fix.integrate('cid', {}, { gpuVendor, copyOut: async () => { touched = true; }, copyIn: async () => { touched = true; } });
    assert.strictEqual(touched, false, gpuVendor);
  }
});

test('the manifest says it is a workaround of a known redroid bug and where it was reported', () => {
  const m = require('../src/modules/redroid-gralloc-fix/manifest.json');
  assert.match(m.descripcion, /KNOWN BUG OF REDROID/);
  assert.ok(m.referencias.includes('https://github.com/remote-android/redroid-doc/issues/930'));
  assert.match(m.i18n.es.descripcion, /BUG CONOCIDO DE REDROID/);
  assert.deepStrictEqual(m.compatibleCon.androidVersion, [15]);
});

// ---- the doctor check ----
const { checkGrallocFix } = require('../src/lib/doctor');
const { firstFileFromTar } = require('../src/lib/tarFile');

function tarOf(name, content) {
  const header = Buffer.alloc(512);
  header.write(name);
  header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124);
  header[156] = 48;
  const pad = Buffer.alloc((512 - (content.length % 512)) % 512);
  return Buffer.concat([header, content, pad, Buffer.alloc(1024)]);
}

test('tarFile reads the first regular file of a tar archive', () => {
  const content = Buffer.from('hello world');
  assert.deepStrictEqual(firstFileFromTar(tarOf('x', content)), content);
  assert.strictEqual(firstFileFromTar(Buffer.alloc(1024)), null);
});

test('doctor: it flags the instances that still have the bug and says it is a known redroid bug', async () => {
  const files = { old: fakeGralloc(), new: fakeGralloc('b104') };
  const r = await checkGrallocFix({
    vendorOf: async () => 'amd',
    list: () => [{ name: 'a-old', containerId: 'old' }, { name: 'a-new', containerId: 'new' }],
    readFile: async (id, p) => { if (p === fix.RC_TARGET) return Buffer.from('rc'); return files[id]; },
  });
  assert.strictEqual(r[0].status, 'warn');
  assert.match(r[0].detail, /a-old/);
  assert.doesNotMatch(r[0].detail, /a-new/);
  assert.match(r[0].detail, /known bug of redroid/);
  assert.match(r[0].detail, /redroid-doc\/issues\/930/);
});

test('doctor: ok when every instance has the fix, and not applicable on other GPUs', async () => {
  const ok = await checkGrallocFix({ vendorOf: async () => 'intel', list: () => [{ name: 'n', containerId: 'c' }], readFile: async (id, p) => (p === fix.RC_TARGET ? Buffer.from('rc') : fakeGralloc('b104')) });
  assert.strictEqual(ok[0].status, 'ok');
  const na = await checkGrallocFix({ vendorOf: async () => 'nvidia', list: () => { throw new Error('must not be asked'); }, readFile: async () => null });
  assert.strictEqual(na[0].status, 'ok');
  assert.match(na[0].detail, /nothing to check/);
});

test('doctor: a file it does not recognise is a warning, never a pass', async () => {
  const r = await checkGrallocFix({ vendorOf: async () => 'amd', list: () => [{ name: 'x', containerId: 'c' }], readFile: async () => Buffer.alloc(100) });
  assert.strictEqual(r[0].status, 'warn');
});

test('doctor: an instance with only the 2-byte patch (no init script) is a warning that says the picture can be garbled', async () => {
  const r = await checkGrallocFix({
    vendorOf: async () => 'amd',
    list: () => [{ name: 'half', containerId: 'h' }],
    readFile: async (id, p) => { if (p === fix.RC_TARGET) throw new Error('no such file'); return fakeGralloc('b104'); },
  });
  assert.strictEqual(r[0].status, 'warn');
  assert.match(r[0].detail, /half/);
  assert.match(r[0].detail, /garbled picture/);
});

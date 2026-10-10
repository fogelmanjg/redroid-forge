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

test('integrate copies the file out, patches it and copies it back with the same mode', async () => {
  const calls = [];
  await fix.integrate('cid', {}, {
    gpuVendor: 'amd',
    copyOut: async (src, dest) => { calls.push(['out', src]); fs.writeFileSync(dest, fakeGralloc(), { mode: 0o644 }); },
    copyIn: async (src, dest) => {
      calls.push(['in', dest]);
      assert.strictEqual(fs.readFileSync(src).subarray(fix.OFFSET, fix.OFFSET + 2).toString('hex'), 'b104');
      assert.strictEqual(fs.statSync(src).mode & 0o777, 0o644);
    },
  });
  assert.deepStrictEqual(calls, [['out', fix.TARGET], ['in', fix.TARGET]]);
});

test('integrate does not copy anything back when the file is unknown or already fixed', async () => {
  for (const content of [Buffer.alloc(500), fakeGralloc('b104')]) {
    let copiedBack = false;
    // eslint-disable-next-line no-await-in-loop
    await fix.integrate('cid', {}, {
      gpuVendor: 'intel',
      copyOut: async (src, dest) => fs.writeFileSync(dest, content),
      copyIn: async () => { copiedBack = true; },
    });
    assert.strictEqual(copiedBack, false);
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

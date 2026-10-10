'use strict';

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

const moduleGate = require('../src/lib/moduleGate');
const { parseDisplay, DEFAULTS } = require('../src/lib/instanceParams');
const hwAccel = require('../src/lib/hwAccel');

const imgHw = { id: 'img-hw', androidVersion: 15, gpuMode: 'host', hwEncCapable: true };
const imgNoHw = { id: 'img-nohw', androidVersion: 15, gpuMode: 'host', hwEncCapable: false };

// ---- which modules an instance gets ----

test('modules omitted: the image defaults (hwenc if it supports it)', () => {
  assert.deepStrictEqual(moduleGate.requiredModuleIds(imgHw), ['hwenc']);
  assert.deepStrictEqual(moduleGate.requiredModuleIds(imgHw, null), ['hwenc']);
  assert.deepStrictEqual(moduleGate.requiredModuleIds(imgNoHw), []);
});

test('modules given: EXACTLY those -- an instance can opt out of hwenc by not listing it', () => {
  assert.deepStrictEqual(moduleGate.requiredModuleIds(imgHw, []), []);
  assert.deepStrictEqual(moduleGate.requiredModuleIds(imgHw, ['gapps']), ['gapps']);
  assert.deepStrictEqual(moduleGate.requiredModuleIds(imgHw, ['gapps', 'hwenc']), ['gapps', 'hwenc']);
  assert.deepStrictEqual(moduleGate.requiredModuleIds(imgHw, ['hwenc', 'hwenc']), ['hwenc'], 'no duplicates');
});

test('hwenc cannot be requested on an image that does not support it', () => {
  assert.throws(() => moduleGate.requiredModuleIds(imgNoHw, ['hwenc']), (e) => e.httpStatus === 400 && /does not support hardware video acceleration/.test(e.message));
});

test('the modules bound to the image stay on whatever is requested', () => {
  const img = { ...imgHw, hasGapps: true, needsHwsimWifi: true };
  assert.deepStrictEqual(moduleGate.requiredModuleIds(img, []), ['gapps', 'wifi-falso']);
  assert.deepStrictEqual(moduleGate.requiredModuleIds(img, ['gapps', 'hwenc']), ['gapps', 'wifi-falso', 'hwenc']);
});

test('only the optional modules can be requested', () => {
  for (const bad of [['magisk'], ['wifi-falso'], ['device-profile'], ['nope']]) {
    assert.throws(() => moduleGate.requiredModuleIds(imgHw, bad), (e) => e.httpStatus === 400, bad.join());
  }
});

// ---- display parameters ----

test('parseDisplay: defaults for what is missing, integers for what is given', () => {
  assert.deepStrictEqual(parseDisplay({}), DEFAULTS);
  assert.deepStrictEqual(parseDisplay(), DEFAULTS);
  assert.deepStrictEqual(parseDisplay({ width: 1920, height: '1080', dpi: 240, fps: '30' }), { width: 1920, height: 1080, dpi: 240, fps: 30 });
  assert.deepStrictEqual(parseDisplay({ width: '', fps: null }), DEFAULTS);
});

test('parseDisplay: rejects anything that is not a plain integer in range (they go into the kernel command line)', () => {
  const bad = [
    { width: '720 androidboot.redroid_gpu_mode=guest' }, { width: '7.5' }, { width: '-1' }, { width: '+720' },
    { width: 720.5 }, { width: 100 }, { width: 99999 }, { height: 'abc' }, { dpi: 10 }, { dpi: 9999 },
    { fps: 0 }, { fps: 500 }, { fps: [60] }, { fps: { n: 60 } }, { width: true }, { width: '1e3' },
  ];
  for (const b of bad) {
    assert.throws(() => parseDisplay(b), (e) => e.httpStatus === 400, JSON.stringify(b));
  }
});

// ---- the module list tells whether the host can run each module ----

async function withModulesServer(fn) {
  const app = express();
  app.use('/api/modules', require('../src/routes/modules'));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

test('GET /api/modules: hwenc reports whether this host\'s GPU is compatible, with the reason', async (t) => {
  t.mock.method(hwAccel, 'detectGpuVendor', async () => 'nvidia');
  await withModulesServer(async (base) => {
    const list = await (await fetch(`${base}/api/modules`)).json();
    const hwenc = list.find((m) => m.id === 'hwenc');
    assert.strictEqual(hwenc.hostGpuVendor, 'nvidia');
    assert.strictEqual(hwenc.hostCompatible, false);
    assert.match(hwenc.hostIncompatibilityReason, /"nvidia" GPU \(compatible with: amd, intel\)/);
    // modules that do not depend on the host's hardware carry no such fields
    assert.strictEqual(list.find((m) => m.id === 'gapps').hostCompatible, undefined);
  });
});

test('GET /api/modules: compatible on AMD', async (t) => {
  t.mock.method(hwAccel, 'detectGpuVendor', async () => 'amd');
  await withModulesServer(async (base) => {
    const hwenc = (await (await fetch(`${base}/api/modules/hwenc`)).json());
    assert.strictEqual(hwenc.hostCompatible, true);
    assert.strictEqual(hwenc.hostIncompatibilityReason, null);
  });
});

test('GET /api/modules: if the GPU cannot be detected it says so instead of failing', async (t) => {
  t.mock.method(hwAccel, 'detectGpuVendor', async () => { throw new Error('lspci missing'); });
  await withModulesServer(async (base) => {
    const hwenc = (await (await fetch(`${base}/api/modules/hwenc`)).json());
    assert.strictEqual(hwenc.hostCompatible, false);
    assert.match(hwenc.hostIncompatibilityReason, /undetected/);
  });
});

// Coverage of Phase 4 (the module contract system). It does not start Docker
// or real redroid containers -- everything this layer touches is design and
// pure code (schema, acceptance record, gating), see docs/ROADMAP.md.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const manifests = require('../src/lib/moduleManifests');
const acceptance = require('../src/lib/moduleAcceptance');
const moduleGate = require('../src/lib/moduleGate');
const hwAccel = require('../src/lib/hwAccel');

// Isolates the acceptance record in a temporary file per test, so as not to
// overwrite the real backend/data/module-acceptances.json nor depend on state
// left by a previous run.
//
// Async (it was not before): moduleGate.check can now call
// hwAccel.detectGpuVendor() inside (hwenc's hostGpuVendor), so `fn` may return a
// promise -- if the finally ran before that promise resolved, the temporary store
// would be restored to the real one halfway through the test.
async function withTempAcceptanceStore(fn) {
  const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rf-acceptance-')), 'module-acceptances.json');
  acceptance._setStoreFileForTests(tmpFile);
  try {
    return await fn();
  } finally {
    acceptance._setStoreFileForTests(null);
  }
}

// Image fixtures -- they do not depend on backend/images.json so as not to couple
// the tests to the real catalog, which may change.
const imgOfficialWithGappsAndMagisk = { id: 'fixture-15-full', androidVersion: 15, gpuMode: 'host', hasGapps: true, hasMagisk: true, needsHwsimWifi: false };
const imgWithoutModules = { id: 'fixture-15-plain', androidVersion: 15, gpuMode: 'host', hasGapps: false, hasMagisk: false, needsHwsimWifi: false };
const imgGappsAndroid11 = { id: 'fixture-11-gapps', androidVersion: 11, gpuMode: 'host', hasGapps: true, hasMagisk: false, needsHwsimWifi: false };
const imgGappsGuestUnsupported = { id: 'fixture-99-gapps-guest', androidVersion: 99, gpuMode: 'guest', hasGapps: true, hasMagisk: false, needsHwsimWifi: false };
const imgHwEncCapable = {
  id: 'fixture-15-hwenc', androidVersion: 15, gpuMode: 'host', hasGapps: false, hasMagisk: false, needsHwsimWifi: false, hwEncCapable: true,
};

test('moduleManifests: the catalog has the 6 modules of section 5 of REQUIREMENTS.md + hwenc', () => {
  // hwenc (Phase 5) lives in its own folder (backend/src/modules/hwenc/
  // manifest.json), not in backend/src/modules/manifests/ like the other
  // six -- this test also covers that moduleManifests.loadAll() discovers
  // both sources (see the comment there).
  const ids = manifests.list().map((m) => m.id).sort();
  assert.deepEqual(ids, ['cpu-ram', 'device-profile', 'gapps', 'gpu-mode', 'hwenc', 'magisk', 'wifi-falso']);
});

test('moduleManifests: hwenc is discovered from its own folder, with etapa/entry', () => {
  const hwenc = manifests.get('hwenc');
  assert.ok(hwenc, 'the hwenc manifest should exist');
  assert.deepEqual(hwenc.etapa, [3, 4, 5, 6]);
  assert.equal(hwenc.entry, './integrate.js');
});

test('moduleManifests.moduleDir: resolves the folder of a flat module and of one with its own folder', () => {
  assert.match(manifests.moduleDir('gapps'), /modules[/\\]manifests$/);
  assert.match(manifests.moduleDir('hwenc'), /modules[/\\]hwenc$/);
  assert.equal(manifests.moduleDir('does-not-exist'), null);
});

test('moduleManifests: rejects a manifest without the required fields', () => {
  assert.throws(() => manifests.validateManifest({ id: 'x' }, 'fixture'), /Invalid module manifest/);
});

test('moduleManifests: a non-free third-party module requires license and source', () => {
  assert.throws(
    () => manifests.validateManifest({
      id: 'x', nombre: 'X', descripcion: 'd', esTerceroNoLibre: true,
      queToca: ['a'], compatibleCon: { androidVersion: [15], gpuMode: ['host'] }, version: 1,
    }, 'fixture'),
    /require "licencia"/,
  );
});

test('moduleManifests: accepts an own manifest (non-free=false) without license/source', () => {
  assert.doesNotThrow(() => manifests.validateManifest({
    id: 'x', nombre: 'X', descripcion: 'd', esTerceroNoLibre: false,
    queToca: ['a'], compatibleCon: { androidVersion: [15], gpuMode: ['host'] }, version: 1,
  }, 'fixture'));
});

test('moduleManifests.isCompatible: compares androidVersion and gpuMode against compatibleCon', () => {
  const manifest = manifests.get('gapps');
  assert.equal(manifests.isCompatible(manifest, imgOfficialWithGappsAndMagisk), true);
  assert.equal(manifests.isCompatible(manifest, imgGappsGuestUnsupported), false);
});

test('moduleManifests.incompatibilityReason: explains why, it does not break silently', () => {
  const manifest = manifests.get('gapps');
  const reason = manifests.incompatibilityReason(manifest, imgGappsGuestUnsupported);
  assert.match(reason, /Android 99/);
});

test('moduleAcceptance: with no previous record, a module is not accepted', () => withTempAcceptanceStore(() => {
  assert.equal(acceptance.isAccepted('gapps', 1), false);
  assert.equal(acceptance.latestFor('gapps'), null);
}));

test('moduleAcceptance: accepting the current version makes it current', () => withTempAcceptanceStore(() => {
  acceptance.record({ moduleId: 'gapps', version: 1, instanceName: 'my-instance' });
  assert.equal(acceptance.isAccepted('gapps', 1), true);
  const latest = acceptance.latestFor('gapps');
  assert.equal(latest.instanceName, 'my-instance');
  assert.equal(latest.userId, 'local');
}));

test('moduleAcceptance: if the manifest goes up a version, the old acceptance stops counting', () => withTempAcceptanceStore(() => {
  acceptance.record({ moduleId: 'gapps', version: 1 });
  assert.equal(acceptance.isAccepted('gapps', 1), true);
  assert.equal(acceptance.isAccepted('gapps', 2), false); // the manifest went up to v2 at some point
}));

test('moduleGate.check: blocks (428) if the image requires a module that is not accepted', () => withTempAcceptanceStore(async () => {
  const result = await moduleGate.check(imgOfficialWithGappsAndMagisk);
  assert.equal(result.ok, false);
  assert.equal(result.httpStatus, 428);
  const ids = result.modules.map((m) => m.id).sort();
  assert.deepEqual(ids, ['gapps', 'magisk']);
}));

test('moduleGate.check: allows creating/starting once all the required modules are accepted', () => withTempAcceptanceStore(async () => {
  acceptance.record({ moduleId: 'gapps', version: manifests.get('gapps').version });
  acceptance.record({ moduleId: 'magisk', version: manifests.get('magisk').version });
  const result = await moduleGate.check(imgOfficialWithGappsAndMagisk);
  assert.equal(result.ok, true);
}));

test('moduleGate.check: an image without required modules is never blocked', () => withTempAcceptanceStore(async () => {
  const result = await moduleGate.check(imgWithoutModules);
  assert.equal(result.ok, true);
}));

test('moduleGate.check: it does not offer/allow the module if the image does not meet compatibleCon', () => withTempAcceptanceStore(async () => {
  // Accepting the contract is not enough if the image is incompatible -- the gate
  // has to reject for compatibility (409) before looking at acceptance.
  acceptance.record({ moduleId: 'gapps', version: manifests.get('gapps').version });
  const result = await moduleGate.check(imgGappsGuestUnsupported);
  assert.equal(result.ok, false);
  assert.equal(result.httpStatus, 409);
  assert.match(result.error, /cannot be used/i);
}));

// Phase 4 gate (docs/ROADMAP.md): activating GApps has to require reading and
// accepting a contract generated from its manifest before the backend runs
// anything. This test reproduces that flow end to end at the level of the pure
// logic (without real Docker, see the note above).
test('Phase 4 gate: GApps stays blocked until its manifest is accepted, then it is enabled', () => withTempAcceptanceStore(async () => {
  const beforeAccepting = await moduleGate.check(imgGappsAndroid11);
  assert.equal(beforeAccepting.ok, false);
  assert.equal(beforeAccepting.httpStatus, 428);
  assert.equal(beforeAccepting.modules[0].id, 'gapps');

  acceptance.record({ moduleId: 'gapps', version: beforeAccepting.modules[0].version, instanceName: 'my-gapps-instance' });

  const afterAccepting = await moduleGate.check(imgGappsAndroid11);
  assert.equal(afterAccepting.ok, true);
}));

// Phase 5: hwenc becomes required just like gapps/magisk/wifi-falso when the
// image declares hwEncCapable=true (see moduleGate.requiredModuleIdsForImage)
// -- the same generic consent flow, even though hwenc is an own module
// (esTerceroNoLibre=false) and not a third-party one.
test('moduleGate.requiredModuleIdsForImage: adds "hwenc" when the image declares hwEncCapable', () => {
  assert.deepEqual(moduleGate.requiredModuleIdsForImage(imgHwEncCapable), ['hwenc']);
  assert.deepEqual(moduleGate.requiredModuleIdsForImage(imgWithoutModules), []);
});

test('moduleGate.check: hwenc stays blocked until its manifest is accepted, just like gapps/magisk', (t) => withTempAcceptanceStore(async () => {
  // hwenc declares compatibleCon.hostGpuVendor: ["amd","intel"] -- without
  // mocking this, check() would trigger a real lspci against the machine running
  // the tests.
  t.mock.method(hwAccel, 'detectGpuVendor', async () => 'amd');

  const beforeAccepting = await moduleGate.check(imgHwEncCapable);
  assert.equal(beforeAccepting.ok, false);
  assert.equal(beforeAccepting.httpStatus, 428);
  assert.equal(beforeAccepting.modules[0].id, 'hwenc');

  acceptance.record({ moduleId: 'hwenc', version: beforeAccepting.modules[0].version });

  const afterAccepting = await moduleGate.check(imgHwEncCapable);
  assert.equal(afterAccepting.ok, true);
}));

// Regression of the real code-review finding: before this fix, hwenc did not
// validate compatibleCon.hostGpuVendor at all (isCompatible/
// incompatibilityReason only look at androidVersion/gpuMode, which are
// attributes of the IMAGE, not of the host) -- hwenc could be "accepted" and the
// runner would still start the VA-API daemon (AMD/Intel-only) on an NVIDIA host.
test('moduleGate.check: rejects (409) a module with hostGpuVendor if the host does not match, even if already accepted', (t) => withTempAcceptanceStore(async () => {
  t.mock.method(hwAccel, 'detectGpuVendor', async () => 'nvidia');
  acceptance.record({ moduleId: 'hwenc', version: manifests.get('hwenc').version });

  const result = await moduleGate.check(imgHwEncCapable);
  assert.equal(result.ok, false);
  assert.equal(result.httpStatus, 409);
  assert.match(result.error, /"nvidia" GPU/);
}));

test('moduleGate.check: an image without modules with hostGpuVendor never calls detectGpuVendor', (t) => withTempAcceptanceStore(async () => {
  const spy = t.mock.method(hwAccel, 'detectGpuVendor', async () => 'nvidia');
  await moduleGate.check(imgWithoutModules);
  assert.equal(spy.mock.calls.length, 0);
}));

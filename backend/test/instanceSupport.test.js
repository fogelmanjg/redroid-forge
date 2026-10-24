const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const runtime = require('../src/lib/dockerRuntime');
const hwAccel = require('../src/lib/hwAccel');
const knownDbStore = require('../src/lib/knownDbStore');
const moduleManifests = require('../src/lib/moduleManifests');
const { resolveForInstance, attachSupport, localGappsId, localMagiskId } = require('../src/lib/instanceSupport');

const DIGEST = `sha256:${'a'.repeat(64)}`;

function fakeDb(modulos, vendor = 'amd') {
  return {
    schemaVersion: 1,
    serial: 1,
    generatedAt: '2026-01-01T00:00:00Z',
    minForgeVersion: '0.1.0',
    bases: [{
      id: 'base', digest: DIGEST, androidVersion: 15, imagen: 'redroid/redroid',
      tag: 'x', arch: 'amd64', construidaEn: '2026-01-01T00:00:00Z', estado: 'vigente',
    }],
    paquetes: [],
    combinaciones: [{
      id: 'combo', base: 'base', gapps: null, magisk: null, modulos, soporte: 'oficial',
      validaciones: [{
        hardware: { vendor, gpu: 'x', driver: 'x' }, fecha: '2026-01-01', forgeVersion: '0.1.0',
        resultado: 'ok', chequeos: [{ id: 'x', resultado: 'ok', detalle: 'x' }],
      }],
    }],
  };
}

test('resolveForInstance: a real instance matching a known combination resolves to oficial', async (t) => {
  // Reads the module's REAL current version, not a hardcoded one, so this test stays
  // correct across module version bumps instead of silently drifting (the exact bug
  // found comparing the bundled db/snapshot.json against the live hwenc manifest).
  const version = moduleManifests.get('wifi-interno').version;
  t.mock.method(knownDbStore, 'loadCurrent', () => (
    { db: fakeDb({ 'wifi-interno': version }), source: 'snapshot', warnings: [] }));
  t.mock.method(runtime, 'getImageDigest', async () => DIGEST);
  t.mock.method(hwAccel, 'detectGpuVendor', async () => 'amd');

  const instance = { dockerImage: 'redroid/redroid:15.0.0-latest', hasGapps: false, requiredModuleIds: ['wifi-interno'] };
  const r = await resolveForInstance(instance);
  assert.deepStrictEqual({ nivel: r.nivel, combinacion: r.combinacion }, { nivel: 'oficial', combinacion: 'combo' });
  assert.deepStrictEqual(r.input.modulos, { 'wifi-interno': version });
});

test('resolveForInstance: an extra module the combo does not declare falls to comunidad', async (t) => {
  const version = moduleManifests.get('wifi-interno').version;
  t.mock.method(knownDbStore, 'loadCurrent', () => (
    { db: fakeDb({ 'wifi-interno': version }), source: 'snapshot', warnings: [] }));
  t.mock.method(runtime, 'getImageDigest', async () => DIGEST);
  t.mock.method(hwAccel, 'detectGpuVendor', async () => 'amd');

  const instance = {
    dockerImage: 'redroid/redroid:15.0.0-latest', hasGapps: false, requiredModuleIds: ['wifi-interno', 'gapps'],
  };
  const r = await resolveForInstance(instance);
  assert.strictEqual(r.nivel, 'comunidad');
});

test('resolveForInstance: unrecognized base image digest -> sin-soporte', async (t) => {
  const version = moduleManifests.get('wifi-interno').version;
  t.mock.method(knownDbStore, 'loadCurrent', () => (
    { db: fakeDb({ 'wifi-interno': version }), source: 'snapshot', warnings: [] }));
  t.mock.method(runtime, 'getImageDigest', async () => `sha256:${'b'.repeat(64)}`);
  t.mock.method(hwAccel, 'detectGpuVendor', async () => 'amd');

  const instance = { dockerImage: 'custom:local', hasGapps: false, requiredModuleIds: ['wifi-interno'] };
  const r = await resolveForInstance(instance);
  assert.strictEqual(r.nivel, 'sin-soporte');
});

test('resolveForInstance: wrong host GPU vendor falls to comunidad', async (t) => {
  const version = moduleManifests.get('wifi-interno').version;
  t.mock.method(knownDbStore, 'loadCurrent', () => (
    { db: fakeDb({ 'wifi-interno': version }, 'amd'), source: 'snapshot', warnings: [] }));
  t.mock.method(runtime, 'getImageDigest', async () => DIGEST);
  t.mock.method(hwAccel, 'detectGpuVendor', async () => 'nvidia');

  const instance = { dockerImage: 'redroid/redroid:15.0.0-latest', hasGapps: false, requiredModuleIds: ['wifi-interno'] };
  const r = await resolveForInstance(instance);
  assert.strictEqual(r.nivel, 'comunidad');
});

test('resolveForInstance: a failed digest/vendor lookup degrades to sin-soporte instead of throwing', async (t) => {
  const version = moduleManifests.get('wifi-interno').version;
  t.mock.method(knownDbStore, 'loadCurrent', () => (
    { db: fakeDb({ 'wifi-interno': version }), source: 'snapshot', warnings: [] }));
  t.mock.method(runtime, 'getImageDigest', async () => { throw new Error('no such image'); });
  t.mock.method(hwAccel, 'detectGpuVendor', async () => { throw new Error('lspci missing'); });

  const instance = { dockerImage: 'redroid/redroid:15.0.0-latest', hasGapps: false, requiredModuleIds: ['wifi-interno'] };
  const r = await resolveForInstance(instance);
  assert.strictEqual(r.nivel, 'sin-soporte');
});

test('attachSupport: resolves each instance and calls getImageDigest only once per DISTINCT image', async (t) => {
  const version = moduleManifests.get('wifi-interno').version;
  t.mock.method(knownDbStore, 'loadCurrent', () => (
    { db: fakeDb({ 'wifi-interno': version }), source: 'snapshot', warnings: [] }));
  const digestMock = t.mock.method(runtime, 'getImageDigest', async (image) => (image === 'redroid/redroid:15.0.0-latest' ? DIGEST : null));
  const vendorMock = t.mock.method(hwAccel, 'detectGpuVendor', async () => 'amd');

  const instances = [
    { id: 'a', dockerImage: 'redroid/redroid:15.0.0-latest', hasGapps: false, requiredModuleIds: ['wifi-interno'] },
    { id: 'b', dockerImage: 'redroid/redroid:15.0.0-latest', hasGapps: false, requiredModuleIds: ['wifi-interno', 'gapps'] },
    { id: 'c', dockerImage: 'other:local', hasGapps: false, requiredModuleIds: ['wifi-interno'] },
  ];
  const out = await attachSupport(instances);

  assert.strictEqual(out[0].soporte.nivel, 'oficial');
  assert.strictEqual(out[1].soporte.nivel, 'comunidad'); // extra module not in the combo
  assert.strictEqual(out[2].soporte.nivel, 'sin-soporte'); // DIGEST only returned for the real image
  // one shared db load / vendor detection, one digest lookup per distinct dockerImage (2, not 3)
  assert.strictEqual(vendorMock.mock.callCount(), 1);
  assert.strictEqual(digestMock.mock.callCount(), 2);
  // the original instance fields survive untouched alongside the new `soporte` field
  assert.strictEqual(out[0].id, 'a');
});

test('localGappsId: reads the id from the local package.json', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gapps-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ id: 'gapps-sdk35-r09-x86_64' }));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.strictEqual(localGappsId(dir), 'gapps-sdk35-r09-x86_64');
});

test('localGappsId: missing folder/file -> null, does not throw', () => {
  assert.strictEqual(localGappsId('/no/such/dir'), null);
});

test('localMagiskId: always null (no Magisk module exists yet)', () => {
  assert.strictEqual(localMagiskId(), null);
});

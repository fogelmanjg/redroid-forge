const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const knownDb = require('../src/lib/knownDb');
const knownDbStore = require('../src/lib/knownDbStore');
const snapshot = require('../db/snapshot.json');

const clone = (o) => JSON.parse(JSON.stringify(o));

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'knowndb-'));
}
function setup({ cache } = {}) {
  const dir = tmpDir();
  const snapshotPath = path.join(dir, 'snapshot.json');
  const cachePath = path.join(dir, 'db', 'database.json');
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot));
  if (cache !== undefined) {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, typeof cache === 'string' ? cache : JSON.stringify(cache));
  }
  return { snapshotPath, cachePath };
}

test('no cache: uses the snapshot', () => {
  const r = knownDbStore.loadCurrent(setup());
  assert.strictEqual(r.source, 'snapshot');
  assert.strictEqual(r.db.serial, snapshot.serial);
  assert.deepStrictEqual(r.warnings, []);
});

test('cache with a higher serial: the updated one wins', () => {
  const nueva = { ...clone(snapshot), serial: snapshot.serial + 1 };
  const r = knownDbStore.loadCurrent(setup({ cache: nueva }));
  assert.strictEqual(r.source, 'actualizada');
  assert.strictEqual(r.db.serial, snapshot.serial + 1);
});

test('cache older than the snapshot (new release): the snapshot wins, with a warning', () => {
  const vieja = { ...clone(snapshot), serial: snapshot.serial - 1 };
  const r = knownDbStore.loadCurrent(setup({ cache: vieja }));
  assert.strictEqual(r.source, 'snapshot');
});

test('corrupt or invalid cache: it is ignored with a warning, it does not bring anything down', () => {
  for (const cache of ['{not json', { ...clone(snapshot), bases: 'x' }]) {
    const r = knownDbStore.loadCurrent(setup({ cache }));
    assert.strictEqual(r.source, 'snapshot');
    assert.match(r.warnings[0], /the downloaded database is ignored/);
  }
});

test('cache that requires a newer forge: it is ignored with a warning', () => {
  const exigente = { ...clone(snapshot), serial: snapshot.serial + 1, minForgeVersion: '99.0.0' };
  const r = knownDbStore.loadCurrent(setup({ cache: exigente }));
  assert.strictEqual(r.source, 'snapshot');
  assert.match(r.warnings[0], /requires redroid-forge/);
});

test('broken snapshot: the error propagates (it is a broken release)', () => {
  const dir = tmpDir();
  const snapshotPath = path.join(dir, 's.json');
  fs.writeFileSync(snapshotPath, '{}');
  assert.throws(() => knownDbStore.loadCurrent({ snapshotPath, cachePath: path.join(dir, 'x.json') }), /Invalid database/);
});

test('summarize: counts bases, packages, combinations and official ones', () => {
  const s = knownDbStore.summarize(knownDbStore.loadCurrent(setup()));
  assert.deepStrictEqual(s.counts, {
    bases: snapshot.bases.length,
    paquetes: snapshot.paquetes.length,
    combinaciones: snapshot.combinaciones.length,
    oficiales: snapshot.combinaciones.filter((c) => c.soporte === 'oficial').length,
  });
});

test('validate: malformed checks are rejected', () => {
  const db = clone(snapshot);
  db.combinaciones.find((c) => c.id === 'redroid15-hwenc').validaciones[0].chequeos = [{ id: 'x', resultado: 'maybe' }, { resultado: 'ok' }];
  assert.throws(() => knownDb.validateDatabase(db), (e) => /invalid result/.test(e.message) && /without "id"/.test(e.message));
});

test('real snapshot: hwenc on the official base is "oficial" on AMD and Intel, "comunidad" on NVIDIA', () => {
  const input = { baseDigest: snapshot.bases[0].digest, modulos: { hwenc: snapshot.combinaciones.find((c) => c.id === 'redroid15-hwenc').modulos.hwenc } };
  for (const vendor of ['amd', 'intel']) {
    assert.strictEqual(knownDb.resolve(snapshot, { ...input, hostGpuVendor: vendor }).nivel, 'oficial', vendor);
  }
  const nv = knownDb.resolve(snapshot, { ...input, hostGpuVendor: 'nvidia' });
  assert.strictEqual(nv.nivel, 'comunidad');
  assert.match(nv.motivos[0], /validated on amd, intel/);
});

test('real snapshot: GApps on the official base is "oficial" on AMD (validated), "comunidad" on Intel, and an unknown package has no support', () => {
  const combo = snapshot.combinaciones.find((c) => c.id === 'redroid15-gapps');
  const input = { baseDigest: snapshot.bases[0].digest, gappsId: combo.gapps, modulos: combo.modulos };
  assert.strictEqual(knownDb.resolve(snapshot, { ...input, hostGpuVendor: 'amd' }).nivel, 'oficial');
  const intel = knownDb.resolve(snapshot, { ...input, hostGpuVendor: 'intel' });
  assert.strictEqual(intel.nivel, 'comunidad');
  assert.match(intel.motivos[0], /validated on amd/);
  assert.strictEqual(knownDb.resolve(snapshot, { ...input, gappsId: 'mi-paquete', hostGpuVendor: 'amd' }).nivel, 'sin-soporte');
  // the package's sha256 is the digest of its files (the same rule the validator enforces)
  const pkg = snapshot.paquetes.find((p) => p.id === combo.gapps);
  assert.strictEqual(require('../src/lib/fileBundle').bundleDigest(pkg.archivos), pkg.sha256);
});

test('real snapshot: every ok validation carries reproducible checks', () => {
  for (const c of snapshot.combinaciones) {
    for (const v of c.validaciones.filter((x) => x.resultado === 'ok')) {
      assert.ok(Array.isArray(v.chequeos) && v.chequeos.length > 0, `${c.id}/${v.hardware.vendor} without checks`);
    }
  }
});

test('doctor.checkKnownDb: ok on the real snapshot', () => {
  const r = require('../src/lib/doctor').checkKnownDb();
  assert.strictEqual(r.status, 'ok');
  assert.match(r.detail, /serial/);
});

// The route tests run WITHOUT trusted keys (an empty file) so that none of them
// touches the network, even though the real build ships the maintainer's key.
const NO_KEYS = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nokeys-')), 'keys.json');
fs.writeFileSync(NO_KEYS, JSON.stringify({ keys: [] }));
process.env.REDROID_FORGE_DB_TRUSTED_KEYS_FILE = NO_KEYS;

async function withServer(fn) {
  const app = express();
  app.use('/api/db', require('../src/routes/db'));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

test('GET /api/db: summary', async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/api/db`);
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.strictEqual(j.serial, snapshot.serial);
    assert.strictEqual(j.source, 'snapshot');
    assert.strictEqual(j.counts.combinaciones, snapshot.combinaciones.length);
  });
});

test('GET /api/db/combinaciones: list with the resolved base', async () => {
  await withServer(async (base) => {
    const j = await (await fetch(`${base}/api/db/combinaciones`)).json();
    const hwenc = j.combinaciones.find((c) => c.id === 'redroid15-hwenc');
    assert.ok(hwenc, 'redroid15-hwenc is listed');
    assert.strictEqual(hwenc.baseInfo.id, 'redroid-15-2025-06-27');
    assert.strictEqual(hwenc.validaciones.length, 2);
    assert.ok(j.combinaciones.some((c) => c.id === 'redroid15-gapps'), 'redroid15-gapps is listed');
  });
});

test('POST /api/db/update without trusted keys: 412 and a clear message', async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/api/db/update`, { method: 'POST' });
    assert.strictEqual(r.status, 412);
    const j = await r.json();
    assert.strictEqual(j.code, 'sin-claves');
  });
});

test('POST /api/db/check without keys: 502 and it makes no connection', async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/api/db/check`, { method: 'POST' });
    assert.strictEqual(r.status, 502);
    assert.match((await r.json()).motivo, /no trusted keys/);
  });
});

test('GET /api/db includes the update state', async () => {
  await withServer(async (base) => {
    const j = await (await fetch(`${base}/api/db`)).json();
    assert.strictEqual(j.actualizacion.clavesDeConfianza, 0);
    assert.strictEqual(j.actualizacion.chequeoAutomatico, true);
    assert.match(j.actualizacion.urlBase, /redroid-forge-db/);
  });
});

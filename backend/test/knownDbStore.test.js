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

test('sin cache: usa el snapshot', () => {
  const r = knownDbStore.loadCurrent(setup());
  assert.strictEqual(r.source, 'snapshot');
  assert.strictEqual(r.db.serial, snapshot.serial);
  assert.deepStrictEqual(r.warnings, []);
});

test('cache con serial mayor: gana la actualizada', () => {
  const nueva = { ...clone(snapshot), serial: snapshot.serial + 1 };
  const r = knownDbStore.loadCurrent(setup({ cache: nueva }));
  assert.strictEqual(r.source, 'actualizada');
  assert.strictEqual(r.db.serial, snapshot.serial + 1);
});

test('cache mas vieja que el snapshot (release nueva): gana el snapshot, con aviso', () => {
  const vieja = { ...clone(snapshot), serial: snapshot.serial - 1 };
  const r = knownDbStore.loadCurrent(setup({ cache: vieja }));
  assert.strictEqual(r.source, 'snapshot');
});

test('cache corrupta o invalida: se ignora con aviso, no tumba', () => {
  for (const cache of ['{no es json', { ...clone(snapshot), bases: 'x' }]) {
    const r = knownDbStore.loadCurrent(setup({ cache }));
    assert.strictEqual(r.source, 'snapshot');
    assert.match(r.warnings[0], /se ignora la base descargada/);
  }
});

test('cache que exige un forge mas nuevo: se ignora con aviso', () => {
  const exigente = { ...clone(snapshot), serial: snapshot.serial + 1, minForgeVersion: '99.0.0' };
  const r = knownDbStore.loadCurrent(setup({ cache: exigente }));
  assert.strictEqual(r.source, 'snapshot');
  assert.match(r.warnings[0], /exige redroid-forge/);
});

test('snapshot roto: el error se propaga (es un release roto)', () => {
  const dir = tmpDir();
  const snapshotPath = path.join(dir, 's.json');
  fs.writeFileSync(snapshotPath, '{}');
  assert.throws(() => knownDbStore.loadCurrent({ snapshotPath, cachePath: path.join(dir, 'x.json') }), /Base invalida/);
});

test('summarize: cuenta bases, paquetes, combinaciones y oficiales', () => {
  const s = knownDbStore.summarize(knownDbStore.loadCurrent(setup()));
  assert.deepStrictEqual(s.counts, { bases: 1, paquetes: 0, combinaciones: 1, oficiales: 1 });
});

test('validate: chequeos mal formados se rechazan', () => {
  const db = clone(snapshot);
  db.combinaciones[0].validaciones[0].chequeos = [{ id: 'x', resultado: 'quizas' }, { resultado: 'ok' }];
  assert.throws(() => knownDb.validateDatabase(db), (e) => /resultado invalido/.test(e.message) && /sin "id"/.test(e.message));
});

test('snapshot real: hwenc sobre la base oficial es "oficial" en AMD e Intel, "comunidad" en NVIDIA', () => {
  const input = { baseDigest: snapshot.bases[0].digest, modulos: { hwenc: 3 } };
  for (const vendor of ['amd', 'intel']) {
    assert.strictEqual(knownDb.resolve(snapshot, { ...input, hostGpuVendor: vendor }).nivel, 'oficial', vendor);
  }
  const nv = knownDb.resolve(snapshot, { ...input, hostGpuVendor: 'nvidia' });
  assert.strictEqual(nv.nivel, 'comunidad');
  assert.match(nv.motivos[0], /validada en amd, intel/);
});

test('snapshot real: toda validacion ok lleva chequeos reproducibles', () => {
  for (const c of snapshot.combinaciones) {
    for (const v of c.validaciones.filter((x) => x.resultado === 'ok')) {
      assert.ok(Array.isArray(v.chequeos) && v.chequeos.length > 0, `${c.id}/${v.hardware.vendor} sin chequeos`);
    }
  }
});

test('doctor.checkKnownDb: ok sobre el snapshot real', () => {
  const r = require('../src/lib/doctor').checkKnownDb();
  assert.strictEqual(r.status, 'ok');
  assert.match(r.detail, /serial/);
});

async function withServer(fn) {
  const app = express();
  app.use('/api/db', require('../src/routes/db'));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

test('GET /api/db: resumen', async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/api/db`);
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.strictEqual(j.serial, snapshot.serial);
    assert.strictEqual(j.source, 'snapshot');
    assert.strictEqual(j.counts.combinaciones, 1);
  });
});

test('GET /api/db/combinaciones: lista con la base resuelta', async () => {
  await withServer(async (base) => {
    const j = await (await fetch(`${base}/api/db/combinaciones`)).json();
    assert.strictEqual(j.combinaciones[0].id, 'redroid15-hwenc');
    assert.strictEqual(j.combinaciones[0].baseInfo.id, 'redroid-15-2025-06-27');
    assert.strictEqual(j.combinaciones[0].validaciones.length, 2);
  });
});

test('POST /api/db/update sin claves de confianza: 412 y mensaje claro', async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/api/db/update`, { method: 'POST' });
    assert.strictEqual(r.status, 412);
    const j = await r.json();
    assert.strictEqual(j.code, 'sin-claves');
  });
});

test('POST /api/db/check sin claves: 502 y no hace ninguna conexion', async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/api/db/check`, { method: 'POST' });
    assert.strictEqual(r.status, 502);
    assert.match((await r.json()).motivo, /sin claves/);
  });
});

test('GET /api/db incluye el estado de la actualizacion', async () => {
  await withServer(async (base) => {
    const j = await (await fetch(`${base}/api/db`)).json();
    assert.strictEqual(j.actualizacion.clavesDeConfianza, 0);
    assert.strictEqual(j.actualizacion.chequeoAutomatico, true);
    assert.match(j.actualizacion.urlBase, /redroid-forge-db/);
  });
});

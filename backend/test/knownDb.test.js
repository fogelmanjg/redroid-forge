const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const k = require('../src/lib/knownDb');
const snapshot = require('../db/snapshot.json');

const clone = (o) => JSON.parse(JSON.stringify(o));
const DIGEST = snapshot.bases[0].digest;
// The hwenc module version that the snapshot's combination declares as validated (it changes with every database release).
// Combinations are found by id, not by position: the order follows the file names of redroid-forge-db.
const HWENC_COMBO = snapshot.combinaciones.find((c) => c.id === 'redroid15-hwenc');
const HWENC = HWENC_COMBO.modulos.hwenc;
const base = { baseDigest: DIGEST, modulos: { hwenc: HWENC } };

test('the seed snapshot is valid', () => {
  assert.doesNotThrow(() => k.validateDatabase(snapshot));
});

test('validate: collects errors and detects broken references / official without a validation', () => {
  const db = clone(snapshot);
  const combo = db.combinaciones.find((c) => c.id === 'redroid15-hwenc');
  combo.base = 'no-existe';
  combo.validaciones = [];
  db.paquetes.push({ id: 'g', tipo: 'gapps', origen: 'https://x', sha256: 'abc' });
  assert.throws(() => k.validateDatabase(db), (e) =>
    /does not exist/.test(e.message) && /oficial.*requires/.test(e.message) && /sha256/.test(e.message));
});

test('validate: digest must be sha256:<64 hex> and id unique', () => {
  const db = clone(snapshot);
  db.bases[0].digest = 'latest';
  db.bases.push({ ...db.bases[0] });
  assert.throws(() => k.validateDatabase(db), /digest/);
});

test('resolve: exact combination validated on the host vendor -> official', () => {
  const r = k.resolve(snapshot, { ...base, hostGpuVendor: 'amd' });
  assert.deepStrictEqual(r, { nivel: 'oficial', combinacion: 'redroid15-hwenc', motivos: [] });
});

test('resolve: vendor different from the validated ones -> community with a reason', () => {
  const r = k.resolve(snapshot, { ...base, hostGpuVendor: 'nvidia' });
  assert.strictEqual(r.nivel, 'comunidad');
  assert.match(r.motivos[0], /validated on amd, intel.*nvidia/);
});

test('resolve: unknown digest -> sin-soporte', () => {
  const r = k.resolve(snapshot, { ...base, baseDigest: 'sha256:' + '0'.repeat(64) });
  assert.strictEqual(r.nivel, 'sin-soporte');
  assert.ok(r.motivos.length > 0);
});

test('resolve: image without a digest (local build) -> sin-soporte', () => {
  assert.strictEqual(k.resolve(snapshot, { ...base, baseDigest: null }).nivel, 'sin-soporte');
});

test('resolve: known pieces but combination not validated -> comunidad', () => {
  const r = k.resolve(snapshot, { baseDigest: DIGEST, modulos: {} });
  assert.strictEqual(r.nivel, 'comunidad');
  assert.strictEqual(r.combinacion, null);
});

test('resolve: module version different from the validated one -> comunidad', () => {
  assert.strictEqual(k.resolve(snapshot, { baseDigest: DIGEST, modulos: { hwenc: HWENC - 1 } }).nivel, 'comunidad');
});

// 29/10/2026: a third tier between 'comunidad' and 'oficial' -- every piece has its own 'ok'
// validation somewhere in the database, just never together as the exact mix requested.
test('resolve: every piece individually ok elsewhere, combination never tried together -> piezas-validadas', () => {
  const r = k.resolve(snapshot, {
    baseDigest: DIGEST, gappsId: 'gapps-sdk35-r09-x86_64', modulos: { hwenc: HWENC }, hostGpuVendor: 'amd',
  });
  assert.strictEqual(r.nivel, 'piezas-validadas');
  assert.strictEqual(r.combinacion, null);
});

test('resolve: one piece never validated anywhere -> stays comunidad, not promoted', () => {
  const r = k.resolve(snapshot, {
    baseDigest: DIGEST, gappsId: 'gapps-sdk35-r09-x86_64', modulos: { 'modulo-jamas-validado': 1 }, hostGpuVendor: 'amd',
  });
  assert.strictEqual(r.nivel, 'comunidad');
});

test('resolve: piece only validated on a different vendor -> stays comunidad for this host', () => {
  const r = k.resolve(snapshot, {
    baseDigest: DIGEST, gappsId: 'gapps-sdk35-r09-x86_64', modulos: { hwenc: HWENC }, hostGpuVendor: 'nvidia',
  });
  assert.strictEqual(r.nivel, 'comunidad');
});

test('resolve: no pieces requested at all (bare base) -> never promoted vacuously', () => {
  const r = k.resolve(snapshot, { baseDigest: DIGEST, modulos: {}, hostGpuVendor: 'amd' });
  assert.strictEqual(r.nivel, 'comunidad');
});

test('resolve: unknown GApps package -> sin-soporte', () => {
  const r = k.resolve(snapshot, { ...base, gappsId: 'gapps-raro' });
  assert.strictEqual(r.nivel, 'sin-soporte');
  assert.match(r.motivos[0], /GApps/);
});

test('resolve: withdrawn base -> sin-soporte; replaced -> comunidad', () => {
  const retirada = clone(snapshot);
  retirada.bases[0].estado = 'retirada';
  assert.strictEqual(k.resolve(retirada, base).nivel, 'sin-soporte');
  const reemp = clone(snapshot);
  reemp.bases[0].estado = 'reemplazada';
  assert.strictEqual(k.resolve(reemp, base).nivel, 'comunidad');
});

test('pickNewest: the highest serial wins, a tie goes to the first', () => {
  const a = { serial: 3 }, b = { serial: 5 }, c = { serial: 5, x: 1 };
  assert.strictEqual(k.pickNewest(a, b), b);
  assert.strictEqual(k.pickNewest(b, c), b);
  assert.strictEqual(k.pickNewest(null, a), a);
});

test('checkUpdateAcceptable: rollback, old forge and invalid database are rejected', () => {
  const nueva = { ...clone(snapshot), serial: snapshot.serial + 1 };
  assert.deepStrictEqual(k.checkUpdateAcceptable(nueva, snapshot, '0.1.0'), { ok: true });
  assert.match(k.checkUpdateAcceptable(snapshot, snapshot, '0.1.0').motivo, /is not greater/);
  assert.match(k.checkUpdateAcceptable({ ...nueva, minForgeVersion: '0.2.0' }, snapshot, '0.1.0').motivo, /requires redroid-forge/);
  assert.strictEqual(k.checkUpdateAcceptable({ ...nueva, bases: 'x' }, snapshot, '0.1.0').ok, false);
});

test('verifySignature: valid signature, tampered, another key, list for rotating', () => {
  const gen = () => crypto.generateKeyPairSync('ed25519');
  const pem = (kp) => kp.publicKey.export({ type: 'spki', format: 'pem' });
  const k1 = gen(), k2 = gen();
  const data = Buffer.from(JSON.stringify(snapshot));
  const sig = crypto.sign(null, data, k1.privateKey).toString('base64');
  assert.strictEqual(k.verifySignature(data, sig, [pem(k1)]), true);
  assert.strictEqual(k.verifySignature(Buffer.from(data.toString() + ' '), sig, [pem(k1)]), false);
  assert.strictEqual(k.verifySignature(data, sig, [pem(k2)]), false);
  assert.strictEqual(k.verifySignature(data, sig, [pem(k2), pem(k1)]), true);
  assert.strictEqual(k.verifySignature(data, 'not-valid-base64!!', [pem(k1)]), false);
});

test('validate: "arm-translation" is an accepted package tipo (found 22/10/2026: only gapps/magisk were allowed, silently forcing every real arm-translation package into "invalid tipo")', () => {
  const db = clone(snapshot);
  const archivos = [{ path: 'system/lib64/libndk_translation.so', sha256: 'a'.repeat(64), tamano: 1 }];
  db.paquetes.push({
    id: 'fx-arm', tipo: 'arm-translation', origen: 'https://x',
    sha256: require('../src/lib/fileBundle').bundleDigest(archivos),
    archivos,
  });
  assert.doesNotThrow(() => k.validateDatabase(db));
});

test('validate: a package\'s "archivos" are checked against ITS OWN tipo\'s rules, not always gapps\' (found 22/10/2026 alongside the bug above: validateFiles was never given a rules argument, so it silently defaulted to RULES.gapps for every tipo)', () => {
  const db = clone(snapshot);
  // arm-translation's files legitimately live under system/lib64 -- gapps' rules only allow
  // product/system_ext, so this would be wrongly rejected as "outside of..." if the lookup
  // bug were still there.
  const archivos = [{ path: 'system/lib64/libndk_translation.so', sha256: 'a'.repeat(64), tamano: 1 }];
  db.paquetes.push({
    id: 'fx-arm', tipo: 'arm-translation', origen: 'https://x',
    sha256: require('../src/lib/fileBundle').bundleDigest(archivos),
    archivos,
  });
  assert.doesNotThrow(() => k.validateDatabase(db));

  // And the inverse must still hold: a gapps-tipo package with an arm-translation-shaped path
  // (under system/, not product/system_ext) is correctly rejected -- the fix must not have
  // just disabled the check.
  const dbBroken = clone(snapshot);
  dbBroken.paquetes.push({
    id: 'fx-gapps-wrong-path', tipo: 'gapps', origen: 'https://x',
    sha256: require('../src/lib/fileBundle').bundleDigest(archivos),
    archivos,
  });
  assert.throws(() => k.validateDatabase(dbBroken), /outside of/);
});

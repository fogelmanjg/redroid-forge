const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const k = require('../src/lib/knownDb');
const snapshot = require('../db/snapshot.json');

const clone = (o) => JSON.parse(JSON.stringify(o));
const DIGEST = snapshot.bases[0].digest;
const base = { baseDigest: DIGEST, modulos: { hwenc: 3 } };

test('el snapshot semilla es valido', () => {
  assert.doesNotThrow(() => k.validateDatabase(snapshot));
});

test('validate: junta errores y detecta referencias rotas / oficial sin validacion', () => {
  const db = clone(snapshot);
  db.combinaciones[0].base = 'no-existe';
  db.combinaciones[0].validaciones = [];
  db.paquetes.push({ id: 'g', tipo: 'gapps', origen: 'https://x', sha256: 'abc' });
  assert.throws(() => k.validateDatabase(db), (e) =>
    /no existe/.test(e.message) && /oficial.*exige/.test(e.message) && /sha256/.test(e.message));
});

test('validate: digest debe ser sha256:<64 hex> y id unico', () => {
  const db = clone(snapshot);
  db.bases[0].digest = 'latest';
  db.bases.push({ ...db.bases[0] });
  assert.throws(() => k.validateDatabase(db), /digest/);
});

test('resolve: combinacion exacta validada en el vendor del host -> oficial', () => {
  const r = k.resolve(snapshot, { ...base, hostGpuVendor: 'amd' });
  assert.deepStrictEqual(r, { nivel: 'oficial', combinacion: 'redroid15-hwenc', motivos: [] });
});

test('resolve: vendor distinto a los validados -> comunidad con motivo', () => {
  const r = k.resolve(snapshot, { ...base, hostGpuVendor: 'nvidia' });
  assert.strictEqual(r.nivel, 'comunidad');
  assert.match(r.motivos[0], /validada en amd, intel.*nvidia/);
});

test('resolve: digest desconocido -> sin-soporte', () => {
  const r = k.resolve(snapshot, { ...base, baseDigest: 'sha256:' + '0'.repeat(64) });
  assert.strictEqual(r.nivel, 'sin-soporte');
  assert.ok(r.motivos.length > 0);
});

test('resolve: imagen sin digest (build local) -> sin-soporte', () => {
  assert.strictEqual(k.resolve(snapshot, { ...base, baseDigest: null }).nivel, 'sin-soporte');
});

test('resolve: piezas conocidas pero combinacion no validada -> comunidad', () => {
  const r = k.resolve(snapshot, { baseDigest: DIGEST, modulos: {} });
  assert.strictEqual(r.nivel, 'comunidad');
  assert.strictEqual(r.combinacion, null);
});

test('resolve: version de modulo distinta a la validada -> comunidad', () => {
  assert.strictEqual(k.resolve(snapshot, { baseDigest: DIGEST, modulos: { hwenc: 4 } }).nivel, 'comunidad');
});

test('resolve: paquete GApps desconocido -> sin-soporte', () => {
  const r = k.resolve(snapshot, { ...base, gappsId: 'gapps-raro' });
  assert.strictEqual(r.nivel, 'sin-soporte');
  assert.match(r.motivos[0], /GApps/);
});

test('resolve: base retirada -> sin-soporte; reemplazada -> comunidad', () => {
  const retirada = clone(snapshot);
  retirada.bases[0].estado = 'retirada';
  assert.strictEqual(k.resolve(retirada, base).nivel, 'sin-soporte');
  const reemp = clone(snapshot);
  reemp.bases[0].estado = 'reemplazada';
  assert.strictEqual(k.resolve(reemp, base).nivel, 'comunidad');
});

test('pickNewest: gana el mayor serial, empate al primero', () => {
  const a = { serial: 3 }, b = { serial: 5 }, c = { serial: 5, x: 1 };
  assert.strictEqual(k.pickNewest(a, b), b);
  assert.strictEqual(k.pickNewest(b, c), b);
  assert.strictEqual(k.pickNewest(null, a), a);
});

test('checkUpdateAcceptable: rollback, forge viejo y base invalida se rechazan', () => {
  const nueva = { ...clone(snapshot), serial: snapshot.serial + 1 };
  assert.deepStrictEqual(k.checkUpdateAcceptable(nueva, snapshot, '0.1.0'), { ok: true });
  assert.match(k.checkUpdateAcceptable(snapshot, snapshot, '0.1.0').motivo, /no es mayor/);
  assert.match(k.checkUpdateAcceptable({ ...nueva, minForgeVersion: '0.2.0' }, snapshot, '0.1.0').motivo, /exige redroid-forge/);
  assert.strictEqual(k.checkUpdateAcceptable({ ...nueva, bases: 'x' }, snapshot, '0.1.0').ok, false);
});

test('verifySignature: firma valida, alterada, otra clave, lista para rotar', () => {
  const gen = () => crypto.generateKeyPairSync('ed25519');
  const pem = (kp) => kp.publicKey.export({ type: 'spki', format: 'pem' });
  const k1 = gen(), k2 = gen();
  const data = Buffer.from(JSON.stringify(snapshot));
  const sig = crypto.sign(null, data, k1.privateKey).toString('base64');
  assert.strictEqual(k.verifySignature(data, sig, [pem(k1)]), true);
  assert.strictEqual(k.verifySignature(Buffer.from(data.toString() + ' '), sig, [pem(k1)]), false);
  assert.strictEqual(k.verifySignature(data, sig, [pem(k2)]), false);
  assert.strictEqual(k.verifySignature(data, sig, [pem(k2), pem(k1)]), true);
  assert.strictEqual(k.verifySignature(data, 'no-es-base64-valida!!', [pem(k1)]), false);
});

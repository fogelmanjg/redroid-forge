const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const knownDb = require('../src/lib/knownDb');
const store = require('../src/lib/knownDbStore');
const upd = require('../src/lib/knownDbUpdate');
const snapshot = require('../db/snapshot.json');

const clone = (o) => JSON.parse(JSON.stringify(o));
const pem = (kp) => kp.publicKey.export({ type: 'spki', format: 'pem' });
const sign = (buf, kp) => crypto.sign(null, buf, kp.privateKey).toString('base64');
const newKey = () => crypto.generateKeyPairSync('ed25519');

// Servidor HTTP local que sirve lo que le pidan (mapa path -> {status, body}).
async function serve(files, fn) {
  const server = http.createServer((req, res) => {
    const f = files[req.url];
    if (!f) { res.statusCode = 404; return res.end('no'); }
    res.statusCode = f.status || 200;
    res.end(f.body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

function published(db, kp) {
  const body = Buffer.from(JSON.stringify(db));
  return {
    '/database.json': { body },
    '/database.json.sig': { body: sign(body, kp) + '\n' },
    '/latest.json': { body: JSON.stringify({ serial: db.serial, generatedAt: db.generatedAt }) },
  };
}
const tmpCache = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dbupd-')), 'db', 'database.json');
const next = (n = 1) => ({ ...clone(snapshot), serial: snapshot.serial + n });

test('sin claves de confianza: no aplica nada', async () => {
  await assert.rejects(upd.applyUpdate({ baseUrl: 'http://x', trustedKeys: [], current: snapshot, cachePath: tmpCache() }),
    (e) => e.code === 'sin-claves');
});

test('flujo feliz: firma valida -> se escribe y pasa a ser la base vigente', async () => {
  const kp = newKey();
  const cachePath = tmpCache();
  await serve(published(next(), kp), async (baseUrl) => {
    const r = await upd.applyUpdate({ baseUrl, trustedKeys: [pem(kp)], current: snapshot, cachePath });
    assert.deepStrictEqual(r, { aplicada: true, serial: snapshot.serial + 1, serialAnterior: snapshot.serial });
  });
  const cur = store.loadCurrent({ snapshotPath: store.SNAPSHOT_PATH, cachePath });
  assert.strictEqual(cur.source, 'actualizada');
  assert.strictEqual(cur.db.serial, snapshot.serial + 1);
});

test('segunda actualizacion: la anterior queda como database.prev.json', async () => {
  const kp = newKey();
  const cachePath = tmpCache();
  const keys = [pem(kp)];
  await serve(published(next(1), kp), (baseUrl) => upd.applyUpdate({ baseUrl, trustedKeys: keys, current: snapshot, cachePath }));
  await serve(published(next(2), kp), (baseUrl) => upd.applyUpdate({ baseUrl, trustedKeys: keys, current: next(1), cachePath }));
  const prev = JSON.parse(fs.readFileSync(path.join(path.dirname(cachePath), 'database.prev.json'), 'utf-8'));
  assert.strictEqual(prev.serial, snapshot.serial + 1);
  assert.strictEqual(JSON.parse(fs.readFileSync(cachePath, 'utf-8')).serial, snapshot.serial + 2);
});

test('firma de OTRA clave: se rechaza y no se escribe nada', async () => {
  const bueno = newKey(), atacante = newKey();
  const cachePath = tmpCache();
  await serve(published(next(), atacante), async (baseUrl) => {
    await assert.rejects(upd.applyUpdate({ baseUrl, trustedKeys: [pem(bueno)], current: snapshot, cachePath }),
      (e) => e.code === 'firma');
  });
  assert.strictEqual(fs.existsSync(cachePath), false);
});

test('contenido alterado despues de firmar: se rechaza', async () => {
  const kp = newKey();
  const files = published(next(), kp);
  files['/database.json'] = { body: Buffer.from(files['/database.json'].body.toString().replace('redroid15-hwenc', 'redroid15-malo')) };
  await serve(files, async (baseUrl) => {
    await assert.rejects(upd.applyUpdate({ baseUrl, trustedKeys: [pem(kp)], current: snapshot, cachePath: tmpCache() }),
      (e) => e.code === 'firma');
  });
});

test('rotacion: vale la firma de cualquier clave de la lista', async () => {
  const vieja = newKey(), nueva = newKey();
  await serve(published(next(), nueva), async (baseUrl) => {
    const r = await upd.applyUpdate({ baseUrl, trustedKeys: [pem(vieja), pem(nueva)], current: snapshot, cachePath: tmpCache() });
    assert.strictEqual(r.aplicada, true);
  });
});

test('rollback (serial igual o menor) con firma valida: se rechaza', async () => {
  const kp = newKey();
  await serve(published(clone(snapshot), kp), async (baseUrl) => {
    await assert.rejects(upd.applyUpdate({ baseUrl, trustedKeys: [pem(kp)], current: snapshot, cachePath: tmpCache() }),
      (e) => e.code === 'rechazada' && /no es mayor/.test(e.message));
  });
});

test('base que exige un forge mas nuevo: se rechaza', async () => {
  const kp = newKey();
  await serve(published({ ...next(), minForgeVersion: '99.0.0' }, kp), async (baseUrl) => {
    await assert.rejects(upd.applyUpdate({ baseUrl, trustedKeys: [pem(kp)], current: snapshot, cachePath: tmpCache() }),
      (e) => e.code === 'rechazada' && /exige redroid-forge/.test(e.message));
  });
});

test('firma valida pero base invalida: se rechaza y no se escribe', async () => {
  const kp = newKey();
  const cachePath = tmpCache();
  await serve(published({ ...next(), bases: 'x' }, kp), async (baseUrl) => {
    await assert.rejects(upd.applyUpdate({ baseUrl, trustedKeys: [pem(kp)], current: snapshot, cachePath }), (e) => e.code === 'rechazada');
  });
  assert.strictEqual(fs.existsSync(cachePath), false);
});

test('errores de red: 404 -> http, servidor caido -> red, archivo enorme -> tamano', async () => {
  await serve({}, async (baseUrl) => {
    await assert.rejects(upd.applyUpdate({ baseUrl, trustedKeys: ['x'], current: snapshot, cachePath: tmpCache() }), (e) => e.code === 'http');
  });
  await assert.rejects(upd.applyUpdate({ baseUrl: 'http://127.0.0.1:1', trustedKeys: ['x'], current: snapshot, cachePath: tmpCache() }), (e) => e.code === 'red');
  await serve({ '/database.json': { body: Buffer.alloc(9 * 1024 * 1024) }, '/database.json.sig': { body: 'x' } }, async (baseUrl) => {
    await assert.rejects(upd.applyUpdate({ baseUrl, trustedKeys: ['x'], current: snapshot, cachePath: tmpCache() }), (e) => e.code === 'tamano');
  });
});

test('checkForUpdate: detecta si hay una base mas nueva, sin descargarla', async () => {
  const kp = newKey();
  await serve(published(next(), kp), async (baseUrl) => {
    assert.deepStrictEqual(
      await upd.checkForUpdate({ baseUrl, current: snapshot }),
      { disponible: true, serialRemoto: snapshot.serial + 1, generatedAt: snapshot.generatedAt },
    );
    assert.strictEqual((await upd.checkForUpdate({ baseUrl, current: next() })).disponible, false);
  });
});

test('runCheck: sin claves no consulta; con claves guarda el resultado', async () => {
  const sin = await upd.runCheck({ trustedKeys: [], config: { baseUrl: 'http://127.0.0.1:1' } });
  assert.strictEqual(sin.ok, false);
  assert.match(sin.motivo, /sin claves/);
  const caido = await upd.runCheck({ trustedKeys: ['x'], config: { baseUrl: 'http://127.0.0.1:1' } });
  assert.strictEqual(caido.ok, false);
  assert.strictEqual(upd.getLastCheck(), caido);
});

test('startScheduler: no arranca si esta desactivado o no hay claves', () => {
  assert.strictEqual(upd.startScheduler({ config: { chequeoAutomatico: false, baseUrl: 'x' }, trustedKeys: ['k'] }), null);
  assert.strictEqual(upd.startScheduler({ config: { chequeoAutomatico: true, baseUrl: 'x' }, trustedKeys: [] }), null);
  const t = upd.startScheduler({ config: { chequeoAutomatico: true, baseUrl: 'http://127.0.0.1:1' }, trustedKeys: ['k'], fetchImpl: () => Promise.reject(new Error('x')) });
  assert.ok(t);
  clearTimeout(t.first); clearInterval(t.every);
});

test('getConfig: URL por defecto, override y desactivar el chequeo', () => {
  assert.strictEqual(upd.getConfig({}).baseUrl, upd.DEFAULT_URL);
  assert.strictEqual(upd.getConfig({}).chequeoAutomatico, true);
  assert.strictEqual(upd.getConfig({ REDROID_FORGE_DB_URL: 'https://espejo.example/db/' }).baseUrl, 'https://espejo.example/db');
  assert.strictEqual(upd.getConfig({ REDROID_FORGE_DB_CHECK: '0' }).chequeoAutomatico, false);
});

test('el build trae la clave publica del mantenedor y es una ed25519 valida', () => {
  const keys = upd.loadTrustedKeys();
  assert.strictEqual(keys.length, 1);
  assert.strictEqual(crypto.createPublicKey(keys[0]).asymmetricKeyType, 'ed25519');
});

test('REDROID_FORGE_DB_TRUSTED_KEYS_FILE reemplaza la lista (forks/espejos)', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tk-')), 'keys.json');
  fs.writeFileSync(f, JSON.stringify({ keys: [] }));
  process.env.REDROID_FORGE_DB_TRUSTED_KEYS_FILE = f;
  try { assert.deepStrictEqual(upd.loadTrustedKeys(), []); } finally { delete process.env.REDROID_FORGE_DB_TRUSTED_KEYS_FILE; }
  assert.strictEqual(upd.loadTrustedKeys().length, 1);
});

test('scripts/db-sign.js: keygen (con passphrase) -> sign -> verify, y detecta alteraciones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbsign-'));
  const script = path.join(__dirname, '..', 'scripts', 'db-sign.js');
  const env = { ...process.env, DB_PASS: 'frase-de-prueba' };
  const run = (...a) => execFileSync('node', [script, ...a], { env, encoding: 'utf-8' });
  run('keygen', dir, '--passphrase-env', 'DB_PASS');
  assert.strictEqual(fs.statSync(path.join(dir, 'db-signing.key')).mode & 0o777, 0o600);
  const data = path.join(dir, 'database.json');
  fs.writeFileSync(data, JSON.stringify(snapshot));
  run('sign', data, path.join(dir, 'db-signing.key'), '--passphrase-env', 'DB_PASS');
  assert.match(run('verify', data, path.join(dir, 'db-signing.pub')), /FIRMA VALIDA/);
  // La firma que produce la herramienta es la que acepta el nucleo.
  assert.strictEqual(knownDb.verifySignature(fs.readFileSync(data), fs.readFileSync(`${data}.sig`, 'utf-8').trim(), [fs.readFileSync(path.join(dir, 'db-signing.pub'), 'utf-8')]), true);
  // Sin la passphrase correcta no firma.
  assert.throws(() => execFileSync('node', [script, 'sign', data, path.join(dir, 'db-signing.key')], { env, stdio: 'pipe' }));
  fs.appendFileSync(data, ' ');
  assert.throws(() => run('verify', data, path.join(dir, 'db-signing.pub')));
});

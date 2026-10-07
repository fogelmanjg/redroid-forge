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

// Local HTTP server that serves whatever it is asked for (a path -> {status, body} map).
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

test('without trusted keys: it applies nothing', async () => {
  await assert.rejects(upd.applyUpdate({ baseUrl: 'http://x', trustedKeys: [], current: snapshot, cachePath: tmpCache() }),
    (e) => e.code === 'sin-claves');
});

test('happy path: valid signature -> it is written and becomes the current database', async () => {
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

test('second update: the previous one stays as database.prev.json', async () => {
  const kp = newKey();
  const cachePath = tmpCache();
  const keys = [pem(kp)];
  await serve(published(next(1), kp), (baseUrl) => upd.applyUpdate({ baseUrl, trustedKeys: keys, current: snapshot, cachePath }));
  await serve(published(next(2), kp), (baseUrl) => upd.applyUpdate({ baseUrl, trustedKeys: keys, current: next(1), cachePath }));
  const prev = JSON.parse(fs.readFileSync(path.join(path.dirname(cachePath), 'database.prev.json'), 'utf-8'));
  assert.strictEqual(prev.serial, snapshot.serial + 1);
  assert.strictEqual(JSON.parse(fs.readFileSync(cachePath, 'utf-8')).serial, snapshot.serial + 2);
});

test('signature from ANOTHER key: it is rejected and nothing is written', async () => {
  const bueno = newKey(), atacante = newKey();
  const cachePath = tmpCache();
  await serve(published(next(), atacante), async (baseUrl) => {
    await assert.rejects(upd.applyUpdate({ baseUrl, trustedKeys: [pem(bueno)], current: snapshot, cachePath }),
      (e) => e.code === 'firma');
  });
  assert.strictEqual(fs.existsSync(cachePath), false);
});

test('content tampered with after signing: it is rejected', async () => {
  const kp = newKey();
  const files = published(next(), kp);
  files['/database.json'] = { body: Buffer.from(files['/database.json'].body.toString().replace('redroid15-hwenc', 'redroid15-malo')) };
  await serve(files, async (baseUrl) => {
    await assert.rejects(upd.applyUpdate({ baseUrl, trustedKeys: [pem(kp)], current: snapshot, cachePath: tmpCache() }),
      (e) => e.code === 'firma');
  });
});

test('rotation: the signature of any key in the list is valid', async () => {
  const vieja = newKey(), nueva = newKey();
  await serve(published(next(), nueva), async (baseUrl) => {
    const r = await upd.applyUpdate({ baseUrl, trustedKeys: [pem(vieja), pem(nueva)], current: snapshot, cachePath: tmpCache() });
    assert.strictEqual(r.aplicada, true);
  });
});

test('rollback (LOWER serial) with a valid signature: it is rejected', async () => {
  const kp = newKey();
  await serve(published({ ...clone(snapshot), serial: snapshot.serial - 1 }, kp), async (baseUrl) => {
    await assert.rejects(upd.applyUpdate({ baseUrl, trustedKeys: [pem(kp)], current: snapshot, cachePath: tmpCache() }),
      (e) => e.code === 'rechazada' && /is not greater/.test(e.message));
  });
});

test('same serial with a valid signature: not an error, already up to date (and it writes nothing)', async () => {
  const kp = newKey();
  const cachePath = tmpCache();
  await serve(published(clone(snapshot), kp), async (baseUrl) => {
    const r = await upd.applyUpdate({ baseUrl, trustedKeys: [pem(kp)], current: snapshot, cachePath });
    assert.strictEqual(r.aplicada, false);
    assert.match(r.motivo, /latest published/);
  });
  assert.strictEqual(fs.existsSync(cachePath), false);
});

test('database that requires a newer forge: it is rejected', async () => {
  const kp = newKey();
  await serve(published({ ...next(), minForgeVersion: '99.0.0' }, kp), async (baseUrl) => {
    await assert.rejects(upd.applyUpdate({ baseUrl, trustedKeys: [pem(kp)], current: snapshot, cachePath: tmpCache() }),
      (e) => e.code === 'rechazada' && /requires redroid-forge/.test(e.message));
  });
});

test('valid signature but invalid database: it is rejected and nothing is written', async () => {
  const kp = newKey();
  const cachePath = tmpCache();
  await serve(published({ ...next(), bases: 'x' }, kp), async (baseUrl) => {
    await assert.rejects(upd.applyUpdate({ baseUrl, trustedKeys: [pem(kp)], current: snapshot, cachePath }), (e) => e.code === 'rechazada');
  });
  assert.strictEqual(fs.existsSync(cachePath), false);
});

test('network errors: 404 -> http, server down -> red, huge file -> tamano', async () => {
  await serve({}, async (baseUrl) => {
    await assert.rejects(upd.applyUpdate({ baseUrl, trustedKeys: ['x'], current: snapshot, cachePath: tmpCache() }), (e) => e.code === 'http');
  });
  await assert.rejects(upd.applyUpdate({ baseUrl: 'http://127.0.0.1:1', trustedKeys: ['x'], current: snapshot, cachePath: tmpCache() }), (e) => e.code === 'red');
  await serve({ '/database.json': { body: Buffer.alloc(9 * 1024 * 1024) }, '/database.json.sig': { body: 'x' } }, async (baseUrl) => {
    await assert.rejects(upd.applyUpdate({ baseUrl, trustedKeys: ['x'], current: snapshot, cachePath: tmpCache() }), (e) => e.code === 'tamano');
  });
});

test('checkForUpdate: detects whether there is a newer database, without downloading it', async () => {
  const kp = newKey();
  await serve(published(next(), kp), async (baseUrl) => {
    assert.deepStrictEqual(
      await upd.checkForUpdate({ baseUrl, current: snapshot }),
      { disponible: true, serialRemoto: snapshot.serial + 1, generatedAt: snapshot.generatedAt },
    );
    assert.strictEqual((await upd.checkForUpdate({ baseUrl, current: next() })).disponible, false);
  });
});

test('runCheck: without keys it does not query; with keys it stores the result', async () => {
  const sin = await upd.runCheck({ trustedKeys: [], config: { baseUrl: 'http://127.0.0.1:1' } });
  assert.strictEqual(sin.ok, false);
  assert.match(sin.motivo, /no trusted keys/);
  const caido = await upd.runCheck({ trustedKeys: ['x'], config: { baseUrl: 'http://127.0.0.1:1' } });
  assert.strictEqual(caido.ok, false);
  assert.strictEqual(upd.getLastCheck(), caido);
});

test('startScheduler: it does not start if disabled or if there are no keys', () => {
  assert.strictEqual(upd.startScheduler({ config: { chequeoAutomatico: false, baseUrl: 'x' }, trustedKeys: ['k'] }), null);
  assert.strictEqual(upd.startScheduler({ config: { chequeoAutomatico: true, baseUrl: 'x' }, trustedKeys: [] }), null);
  const t = upd.startScheduler({ config: { chequeoAutomatico: true, baseUrl: 'http://127.0.0.1:1' }, trustedKeys: ['k'], fetchImpl: () => Promise.reject(new Error('x')) });
  assert.ok(t);
  clearTimeout(t.first); clearInterval(t.every);
});

test('getConfig: default URL, override and turning off the check', () => {
  assert.strictEqual(upd.getConfig({}).baseUrl, upd.DEFAULT_URL);
  assert.strictEqual(upd.getConfig({}).chequeoAutomatico, true);
  assert.strictEqual(upd.getConfig({ REDROID_FORGE_DB_URL: 'https://mirror.example/db/' }).baseUrl, 'https://mirror.example/db');
  assert.strictEqual(upd.getConfig({ REDROID_FORGE_DB_CHECK: '0' }).chequeoAutomatico, false);
});

test('the build ships the maintainer\'s public key and it is a valid ed25519', () => {
  const keys = upd.loadTrustedKeys();
  assert.strictEqual(keys.length, 1);
  assert.strictEqual(crypto.createPublicKey(keys[0]).asymmetricKeyType, 'ed25519');
});

test('REDROID_FORGE_DB_TRUSTED_KEYS_FILE replaces the list (forks/mirrors)', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tk-')), 'keys.json');
  fs.writeFileSync(f, JSON.stringify({ keys: [] }));
  process.env.REDROID_FORGE_DB_TRUSTED_KEYS_FILE = f;
  try { assert.deepStrictEqual(upd.loadTrustedKeys(), []); } finally { delete process.env.REDROID_FORGE_DB_TRUSTED_KEYS_FILE; }
  assert.strictEqual(upd.loadTrustedKeys().length, 1);
});

test('scripts/db-sign.js: keygen (with a passphrase) -> sign -> verify, and it detects tampering', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbsign-'));
  const script = path.join(__dirname, '..', 'scripts', 'db-sign.js');
  const env = { ...process.env, DB_PASS: 'test-passphrase' };
  const run = (...a) => execFileSync('node', [script, ...a], { env, encoding: 'utf-8' });
  run('keygen', dir, '--passphrase-env', 'DB_PASS');
  assert.strictEqual(fs.statSync(path.join(dir, 'db-signing.key')).mode & 0o777, 0o600);
  const data = path.join(dir, 'database.json');
  fs.writeFileSync(data, JSON.stringify(snapshot));
  run('sign', data, path.join(dir, 'db-signing.key'), '--passphrase-env', 'DB_PASS');
  assert.match(run('verify', data, path.join(dir, 'db-signing.pub')), /VALID SIGNATURE/);
  // The signature the tool produces is the one the core accepts.
  assert.strictEqual(knownDb.verifySignature(fs.readFileSync(data), fs.readFileSync(`${data}.sig`, 'utf-8').trim(), [fs.readFileSync(path.join(dir, 'db-signing.pub'), 'utf-8')]), true);
  // Without the correct passphrase it does not sign.
  assert.throws(() => execFileSync('node', [script, 'sign', data, path.join(dir, 'db-signing.key')], { env, stdio: 'pipe' }));
  fs.appendFileSync(data, ' ');
  assert.throws(() => run('verify', data, path.join(dir, 'db-signing.pub')));
});

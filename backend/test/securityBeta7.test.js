// 1.0.0-beta.7 security fixes: cross-site request refusal (lib/originCheck.js), login attempt limit
// (lib/loginThrottle.js) and who accepts a module contract (routes/modules.js).
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const originCheck = require('../src/lib/originCheck');
const { createThrottle, clientKey } = require('../src/lib/loginThrottle');

const req = (headers, method = 'POST') => ({ method, headers, socket: {} });

test('origin: no Origin (curl, local tools) and same origin pass; another site or "null" does not', () => {
  assert.strictEqual(originCheck.isAllowedOrigin(req({ host: 'forge.lan:8080' })), true);
  assert.strictEqual(originCheck.isAllowedOrigin(req({ host: 'forge.lan:8080', origin: 'http://forge.lan:8080' })), true);
  assert.strictEqual(originCheck.isAllowedOrigin(req({ host: 'FORGE.lan:8080', origin: 'http://forge.LAN:8080' })), true, 'case-insensitive');
  assert.strictEqual(originCheck.isAllowedOrigin(req({ host: 'forge.lan:8080', origin: 'https://evil.example' })), false);
  assert.strictEqual(originCheck.isAllowedOrigin(req({ host: 'forge.lan:8080', origin: 'http://forge.lan:9999' })), false, 'other port = other origin');
  assert.strictEqual(originCheck.isAllowedOrigin(req({ host: 'forge.lan', origin: 'null' })), false);
  assert.strictEqual(originCheck.isAllowedOrigin(req({ host: 'forge.lan', origin: 'not a url' })), false);
});

test('origin: a proxy that rewrote Host but sent X-Forwarded-Host, and REDROID_FORGE_ALLOWED_ORIGINS', () => {
  assert.strictEqual(originCheck.isAllowedOrigin(req({ host: '127.0.0.1:8080', 'x-forwarded-host': 'forge.example.org', origin: 'https://forge.example.org' })), true);
  const env = { REDROID_FORGE_ALLOWED_ORIGINS: 'https://dashboard.example.org/, https://other.example' };
  assert.strictEqual(originCheck.isAllowedOrigin(req({ host: 'forge.example.org', origin: 'https://dashboard.example.org' }), env), true);
  assert.strictEqual(originCheck.isAllowedOrigin(req({ host: 'forge.example.org', origin: 'https://evil.example' }), env), false);
});

test('origin middleware: GET always passes; a cross-site POST gets 403', () => {
  let nexted = 0;
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  originCheck.middleware(req({ host: 'f', origin: 'https://evil.example' }, 'GET'), res, () => { nexted++; });
  assert.strictEqual(nexted, 1);
  originCheck.middleware(req({ host: 'f', origin: 'https://evil.example' }), res, () => { nexted++; });
  assert.strictEqual(nexted, 1);
  assert.strictEqual(res.statusCode, 403);
});

test('login throttle: 10 failures in the window block, success clears, the window expires', () => {
  let clock = 0;
  const th = createThrottle({ now: () => clock, windowMs: 1000, maxFailures: 3 });
  for (let i = 0; i < 3; i++) { assert.ok(th.check('a').allowed); th.fail('a'); }
  const blocked = th.check('a');
  assert.strictEqual(blocked.allowed, false);
  assert.ok(blocked.retryAfterS >= 1);
  assert.ok(th.check('b').allowed, 'another client is not affected');
  clock = 1001;
  assert.ok(th.check('a').allowed, 'window passed');
  th.fail('a'); th.fail('a'); th.succeed('a'); th.fail('a');
  assert.ok(th.check('a').allowed, 'a success reset the count');
});

test('login throttle: the client behind the same-host proxy is the LAST X-Forwarded-For entry', () => {
  const r = (peer, xff) => ({ socket: { remoteAddress: peer }, headers: xff ? { 'x-forwarded-for': xff } : {} });
  assert.strictEqual(clientKey(r('100.64.0.9')), '100.64.0.9');
  assert.strictEqual(clientKey(r('100.64.0.9', '1.2.3.4')), '100.64.0.9', 'XFF from a non-loopback peer is ignored');
  assert.strictEqual(clientKey(r('127.0.0.1', 'spoofed, 100.64.0.7')), '100.64.0.7');
});

// --- POST /api/modules/:id/accept ---
function serve(user) {
  const app = express();
  app.use(express.json());
  app.use((rq, rs, next) => { rq.user = user; next(); });
  app.use('/api/modules', require('../src/routes/modules'));
  return new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
}
function post(server, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = http.request({ port: server.address().port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }));
    });
    r.on('error', reject); r.end(data);
  });
}

test('module contract acceptance: records the logged-in user, ignores a userId in the body, refuses a viewer', async (t) => {
  const manifests = require('../src/lib/moduleManifests');
  const acceptance = require('../src/lib/moduleAcceptance');
  const manifest = manifests.get('hwenc');
  const recorded = [];
  t.mock.method(acceptance, 'record', (e) => { recorded.push(e); return e; });

  const admin = await serve({ id: 'u1', username: 'ana', role: 'admin' });
  try {
    const r = await post(admin, '/api/modules/hwenc/accept', { version: manifest.version, userId: 'someone-else' });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(recorded[0].userId, 'ana');
  } finally { admin.close(); }

  const viewer = await serve({ id: 'u2', username: 'vic', role: 'viewer' });
  try {
    const r = await post(viewer, '/api/modules/hwenc/accept', { version: manifest.version });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(recorded.length, 1, 'nothing recorded for the viewer');
  } finally { viewer.close(); }
});

// --- GET /api/settings (admin only, secrets redacted) and GET /api/settings/client ---
test('settings: redaction keeps OIDC client secrets out; the client view only carries adbHost', () => {
  const routes = require('../src/routes/settings');
  const red = routes.redactSettings({ backupDir: '/b', oidcProviders: [{ id: 'kc', clientId: 'x', clientSecret: 's3cret' }, { id: 'pub', clientId: 'y' }] });
  assert.deepStrictEqual(red.oidcProviders, [{ id: 'kc', clientId: 'x', hasClientSecret: true }, { id: 'pub', clientId: 'y', hasClientSecret: false }]);
  assert.ok(!JSON.stringify(red).includes('s3cret'));
  assert.deepStrictEqual(routes.clientSettings({ adbHost: 'forge.lan', backupDir: '/b' }, {}), { adbHost: 'forge.lan' });
  assert.deepStrictEqual(routes.clientSettings({ adbHost: null }, { REDROID_FORGE_ADB_HOST: '100.64.0.5' }), { adbHost: '100.64.0.5' });
  assert.deepStrictEqual(routes.clientSettings({ adbHost: null }, {}), { adbHost: null });
});

test('settings: adbHost accepts a host name or IP, nothing with a port, scheme or spaces', () => {
  const { ADB_HOST_RE } = require('../src/routes/settings');
  for (const ok of ['forge.lan', '100.73.0.50', 'jgustavo-server01', 'fd7a:115c::1']) assert.ok(ADB_HOST_RE.test(ok), ok);
  for (const bad of ['forge.lan:5555', 'http://forge', 'a b', 'x;rm', '-lead', '']) assert.ok(!ADB_HOST_RE.test(bad), bad);
});

test('settings: GET /api/settings is admin only; /client answers any logged-in account', async () => {
  const get = (server, path) => new Promise((resolve, reject) => {
    http.get({ port: server.address().port, path }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', reject);
  });
  const mk = (user) => {
    const app = express();
    app.use((rq, rs, next) => { rq.user = user; next(); });
    app.use('/api/settings', require('../src/routes/settings'));
    return new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  };
  const viewer = await mk({ id: 'v', username: 'vic', role: 'viewer' });
  try {
    assert.strictEqual((await get(viewer, '/api/settings')).status, 403);
    const c = await get(viewer, '/api/settings/client');
    assert.strictEqual(c.status, 200);
    assert.deepStrictEqual(Object.keys(JSON.parse(c.body)), ['adbHost']);
  } finally { viewer.close(); }
  const admin = await mk({ id: 'a', username: 'ana', role: 'admin' });
  try {
    assert.strictEqual((await get(admin, '/api/settings')).status, 200);
  } finally { admin.close(); }
});

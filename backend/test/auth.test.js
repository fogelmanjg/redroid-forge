// Coverage of src/lib/auth.js. AUTH_MODE is read once at require time (by design -- it is an
// env var meant to be fixed per process, see auth.js's own comment), so each mode is tested
// against a fresh require() with the env var set first, same pattern as oidc.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

// Nonexistent-but-writable (os.tmpdir() itself always exists) -- settings.get() treats a
// missing file as {} (DEFAULTS), so this reliably means "authMode was never set through the
// UI" without ever touching this host's real backend/data/settings.json.
const NONEXISTENT_SETTINGS_FILE = path.join(os.tmpdir(), `redroid-forge-test-settings-${process.pid}.json`);

// auth.js's self-lockout guard (26/10/2026, see test/auth.lockout.test.js for its own direct
// coverage) downgrades "local"/"both" to "none" at require time when no local account exists
// AND these two are unset -- every test below wants the mode it actually asked for, regardless
// of whatever happens to be in the real backend/data/users.json on whatever machine runs this
// suite, so set them here unconditionally rather than depending on that file's live content.
// REDROID_FORGE_SETTINGS_FILE (settings.js's own test-only escape hatch) points auth.js's
// settings.get().authMode read at a nonexistent tmp path, not this host's real
// backend/data/settings.json -- without it, this suite's require-time mode would silently be
// overridden by whatever a real redroid-forge instance running on the same machine (this one
// included) has actually been switched to through PUT /api/auth/mode.
function freshAuth(mode) {
  const prev = {
    REDROID_FORGE_AUTH: process.env.REDROID_FORGE_AUTH,
    REDROID_FORGE_LOCAL_ADMIN_USER: process.env.REDROID_FORGE_LOCAL_ADMIN_USER,
    REDROID_FORGE_LOCAL_ADMIN_PASSWORD: process.env.REDROID_FORGE_LOCAL_ADMIN_PASSWORD,
    REDROID_FORGE_SETTINGS_FILE: process.env.REDROID_FORGE_SETTINGS_FILE,
  };
  process.env.REDROID_FORGE_AUTH = mode;
  process.env.REDROID_FORGE_LOCAL_ADMIN_USER = 'test-admin';
  process.env.REDROID_FORGE_LOCAL_ADMIN_PASSWORD = 'test-password';
  process.env.REDROID_FORGE_SETTINGS_FILE = NONEXISTENT_SETTINGS_FILE;
  delete require.cache[require.resolve('../src/lib/auth')];
  const auth = require('../src/lib/auth');
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return auth;
}

function mockRes() {
  const calls = { status: null, json: null, cookieSet: null, cookieCleared: false };
  return {
    status(code) { calls.status = code; return this; },
    json(body) { calls.json = body; return this; },
    cookie(name, value, opts) { calls.cookieSet = { name, value, opts }; },
    clearCookie(name) { calls.cookieCleared = name; },
    _calls: calls,
  };
}

test('an invalid REDROID_FORGE_AUTH value throws at require time, not silently falls back', () => {
  const prev = { REDROID_FORGE_AUTH: process.env.REDROID_FORGE_AUTH, REDROID_FORGE_SETTINGS_FILE: process.env.REDROID_FORGE_SETTINGS_FILE };
  process.env.REDROID_FORGE_AUTH = 'bogus';
  process.env.REDROID_FORGE_SETTINGS_FILE = NONEXISTENT_SETTINGS_FILE;
  delete require.cache[require.resolve('../src/lib/auth')];
  assert.throws(() => require('../src/lib/auth'), /REDROID_FORGE_AUTH/);
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  delete require.cache[require.resolve('../src/lib/auth')];
});

test('mode "none": attachUser always sets the fixed admin-bypass user, no cookie involved', () => {
  const auth = freshAuth('none');
  const req = { headers: {} };
  let called = false;
  auth.attachUser(req, {}, () => { called = true; });
  assert.equal(called, true);
  assert.deepEqual(req.user, { id: null, role: 'admin', username: null });
});

test('mode "none": requireAuth always passes through', () => {
  const auth = freshAuth('none');
  let called = false;
  auth.requireAuth({}, mockRes(), () => { called = true; });
  assert.equal(called, true);
});

test('readCookie: parses a single cookie, among several, with surrounding whitespace', () => {
  const auth = freshAuth('local');
  const req = { headers: { cookie: 'a=1; redroid_forge_session=abc.def; other=2' } };
  assert.equal(auth.readCookie(req, 'redroid_forge_session'), 'abc.def');
  assert.equal(auth.readCookie(req, 'missing'), undefined);
  assert.equal(auth.readCookie({ headers: {} }, 'x'), undefined);
});

test('mode "local": attachUser with no cookie -> no req.user set, requireAuth rejects with 401', () => {
  const auth = freshAuth('local');
  const req = { headers: {} };
  auth.attachUser(req, {}, () => {});
  assert.equal(req.user, undefined);
  const res = mockRes();
  let called = false;
  auth.requireAuth(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res._calls.status, 401);
});

test('mode "local": a valid session cookie round-trips into req.user, requireAuth then passes', () => {
  const auth = freshAuth('local');
  const res = mockRes();
  auth.setSessionCookie(res, { id: 'u1', role: 'operator', username: 'alice' });
  const cookieHeader = `${res._calls.cookieSet.name}=${res._calls.cookieSet.value}`;
  const req = { headers: { cookie: cookieHeader } };
  auth.attachUser(req, {}, () => {});
  assert.deepEqual(req.user, { id: 'u1', role: 'operator', username: 'alice' });
  let called = false;
  auth.requireAuth(req, mockRes(), () => { called = true; });
  assert.equal(called, true);
});

test('mode "local": a loopback request bypasses auth entirely, same fixed user as "none" mode', () => {
  const auth = freshAuth('local');
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    const req = { headers: {}, ip };
    auth.attachUser(req, {}, () => {});
    assert.deepEqual(req.user, { id: null, role: 'admin', username: null });
    let called = false;
    auth.requireAuth(req, mockRes(), () => { called = true; });
    assert.equal(called, true);
  }
});

test('mode "local": a non-loopback request with no cookie still needs one (the bypass is not just "no cookie")', () => {
  const auth = freshAuth('local');
  const req = { headers: {}, ip: '192.168.1.50' };
  auth.attachUser(req, {}, () => {});
  assert.equal(req.user, undefined);
});

test('mode "local": a tampered/garbage cookie is treated the same as no cookie', () => {
  const auth = freshAuth('local');
  const req = { headers: { cookie: `${require('../src/lib/session').COOKIE_NAME}=garbage` } };
  auth.attachUser(req, {}, () => {});
  assert.equal(req.user, undefined);
});

test('clearSessionCookie: calls res.clearCookie with the session cookie name', () => {
  const auth = freshAuth('local');
  const res = mockRes();
  auth.clearSessionCookie(res);
  assert.equal(res._calls.cookieCleared, require('../src/lib/session').COOKIE_NAME);
});

test('"both" mode: LOCAL_ENABLED and OIDC_ENABLED are both true, and sessions work the same as either single mode', () => {
  const auth = freshAuth('both');
  assert.equal(auth.LOCAL_ENABLED, true);
  assert.equal(auth.OIDC_ENABLED, true);
  const req = { headers: {} };
  auth.attachUser(req, {}, () => {});
  assert.equal(req.user, undefined);
});

test('"local" mode: LOCAL_ENABLED true, OIDC_ENABLED false', () => {
  const auth = freshAuth('local');
  assert.equal(auth.LOCAL_ENABLED, true);
  assert.equal(auth.OIDC_ENABLED, false);
});

test('"oidc" mode: OIDC_ENABLED true, LOCAL_ENABLED false', () => {
  const auth = freshAuth('oidc');
  assert.equal(auth.LOCAL_ENABLED, false);
  assert.equal(auth.OIDC_ENABLED, true);
});

test('"none" mode: neither LOCAL_ENABLED nor OIDC_ENABLED', () => {
  const auth = freshAuth('none');
  assert.equal(auth.LOCAL_ENABLED, false);
  assert.equal(auth.OIDC_ENABLED, false);
});

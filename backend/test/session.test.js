// Coverage of the stateless signed session cookie (src/lib/session.js). Uses a temp secret
// file like settings.test.js, never the real backend/data/session-secret.json.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const session = require('../src/lib/session');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-'));
  return path.join(dir, 'session-secret.json');
}

test('sign/verify: round-trips a payload', () => {
  const file = tmpFile();
  const cookie = session.sign({ uid: 'u1', role: 'admin' }, file);
  assert.deepEqual(session.verify(cookie, file), { uid: 'u1', role: 'admin' });
});

test('verify: a cookie signed with a different secret (different file) fails', () => {
  const cookie = session.sign({ uid: 'u1', role: 'admin' }, tmpFile());
  assert.equal(session.verify(cookie, tmpFile()), null);
});

test('verify: tampered payload (body changed, mac stays the same) fails', () => {
  const file = tmpFile();
  const cookie = session.sign({ uid: 'u1', role: 'viewer' }, file);
  const [body, mac] = cookie.split('.');
  const tampered = `${body}x.${mac}`;
  assert.equal(session.verify(tampered, file), null);
});

test('verify: garbage/missing input never throws, just returns null', () => {
  const file = tmpFile();
  assert.equal(session.verify(undefined, file), null);
  assert.equal(session.verify('', file), null);
  assert.equal(session.verify('not-a-valid-cookie', file), null);
  assert.equal(session.verify('a.b.c', file), null);
});

test('verify: an expired payload is rejected', () => {
  const file = tmpFile();
  const crypto = require('crypto');
  const fakeNow = Date.now() - 1000;
  const body = Buffer.from(JSON.stringify({ uid: 'u1', exp: fakeNow })).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  // Re-derive the secret the same way session.js does, by forcing it to be created first.
  session.sign({ uid: 'bootstrap' }, file);
  const stored = JSON.parse(fs.readFileSync(file, 'utf-8')).secret;
  const mac = crypto.createHmac('sha256', stored).update(body).digest().toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(session.verify(`${body}.${mac}`, file), null);
});

test('sign: secret is generated once and persisted (same file -> same secret across calls)', () => {
  const file = tmpFile();
  const cookieA = session.sign({ uid: 'a' }, file);
  const cookieB = session.sign({ uid: 'b' }, file);
  // Both verify against the SAME persisted secret (a fresh module-level cache per process, but
  // the file on disk is what actually matters across restarts).
  assert.deepEqual(session.verify(cookieA, file), { uid: 'a' });
  assert.deepEqual(session.verify(cookieB, file), { uid: 'b' });
  assert.equal(fs.existsSync(file), true);
});

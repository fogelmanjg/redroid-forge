// Coverage of the local user store (src/lib/userStore.js, "local" auth backend -- docs/
// ROADMAP.md Phase 7): password hashing, validation, bootstrap admin. Uses a temp file like
// settings.test.js, never the real backend/data/users.json.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const userStore = require('../src/lib/userStore');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'userstore-'));
  return path.join(dir, 'users.json');
}

test('hashPassword/verifyPasswordHash: round-trips, rejects a wrong password', () => {
  const hash = userStore.hashPassword('correct horse battery staple');
  assert.equal(userStore.verifyPasswordHash('correct horse battery staple', hash), true);
  assert.equal(userStore.verifyPasswordHash('wrong password', hash), false);
});

test('hashPassword: two hashes of the same password differ (random salt)', () => {
  const a = userStore.hashPassword('same-password');
  const b = userStore.hashPassword('same-password');
  assert.notEqual(a, b);
  assert.equal(userStore.verifyPasswordHash('same-password', a), true);
  assert.equal(userStore.verifyPasswordHash('same-password', b), true);
});

test('verifyPasswordHash: a corrupt/foreign stored value never throws, just fails', () => {
  assert.equal(userStore.verifyPasswordHash('x', 'not-a-valid-hash'), false);
  assert.equal(userStore.verifyPasswordHash('x', ''), false);
  assert.equal(userStore.verifyPasswordHash('x', undefined), false);
});

test('createUser: validates username, password length and role', () => {
  const file = tmpFile();
  assert.throws(() => userStore.createUser({ username: 'Bad Name', password: 'longenough', role: 'admin' }, file), /username/);
  assert.throws(() => userStore.createUser({ username: 'ok', password: 'short', role: 'admin' }, file), /password/);
  assert.throws(() => userStore.createUser({ username: 'ok', password: 'longenough', role: 'bogus' }, file), /role/);
});

test('createUser: rejects a duplicate username', () => {
  const file = tmpFile();
  userStore.createUser({ username: 'alice', password: 'longenough', role: 'operator' }, file);
  assert.throws(() => userStore.createUser({ username: 'alice', password: 'longenough2', role: 'viewer' }, file), /already exists/);
});

test('createUser: returns the user without passwordHash, never persists it in plaintext', () => {
  const file = tmpFile();
  const user = userStore.createUser({ username: 'alice', password: 'longenough', role: 'operator' }, file);
  assert.equal(user.username, 'alice');
  assert.equal(user.role, 'operator');
  assert.equal('passwordHash' in user, false);
  assert.equal('password' in user, false);
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.notEqual(raw[0].passwordHash, 'longenough');
});

test('listUsers/findByUsername/findById: never leak passwordHash', () => {
  const file = tmpFile();
  const created = userStore.createUser({ username: 'alice', password: 'longenough', role: 'admin' }, file);
  assert.equal('passwordHash' in userStore.listUsers(file)[0], false);
  assert.equal('passwordHash' in userStore.findByUsername('alice', file), true); // internal lookup, used by verifyCredentials
  assert.equal(userStore.findById(created.id, file).username, 'alice');
});

test('verifyCredentials: correct credentials -> the safe user; wrong ones -> null, never throws', () => {
  const file = tmpFile();
  userStore.createUser({ username: 'alice', password: 'longenough', role: 'viewer' }, file);
  const ok = userStore.verifyCredentials('alice', 'longenough', file);
  assert.equal(ok.username, 'alice');
  assert.equal('passwordHash' in ok, false);
  assert.equal(userStore.verifyCredentials('alice', 'wrong', file), null);
  assert.equal(userStore.verifyCredentials('nobody', 'whatever', file), null);
});

test('ensureBootstrapAdmin: no-op if the store already has a user', () => {
  const file = tmpFile();
  userStore.createUser({ username: 'existing', password: 'longenough', role: 'viewer' }, file);
  userStore.ensureBootstrapAdmin(file);
  assert.equal(userStore.listUsers(file).length, 1);
  assert.equal(userStore.listUsers(file)[0].username, 'existing');
});

test('ensureBootstrapAdmin: seeds an admin from env vars when the store is empty', () => {
  const file = tmpFile();
  const prevUser = process.env.REDROID_FORGE_LOCAL_ADMIN_USER;
  const prevPass = process.env.REDROID_FORGE_LOCAL_ADMIN_PASSWORD;
  process.env.REDROID_FORGE_LOCAL_ADMIN_USER = 'bootadmin';
  process.env.REDROID_FORGE_LOCAL_ADMIN_PASSWORD = 'longenoughpassword';
  try {
    userStore.ensureBootstrapAdmin(file);
    const users = userStore.listUsers(file);
    assert.equal(users.length, 1);
    assert.equal(users[0].username, 'bootadmin');
    assert.equal(users[0].role, 'admin');
    assert.equal(userStore.verifyCredentials('bootadmin', 'longenoughpassword', file).username, 'bootadmin');
  } finally {
    if (prevUser === undefined) delete process.env.REDROID_FORGE_LOCAL_ADMIN_USER; else process.env.REDROID_FORGE_LOCAL_ADMIN_USER = prevUser;
    if (prevPass === undefined) delete process.env.REDROID_FORGE_LOCAL_ADMIN_PASSWORD; else process.env.REDROID_FORGE_LOCAL_ADMIN_PASSWORD = prevPass;
  }
});

test('ensureBootstrapAdmin: without the env vars set, does nothing (does not throw)', () => {
  const file = tmpFile();
  const prevUser = process.env.REDROID_FORGE_LOCAL_ADMIN_USER;
  const prevPass = process.env.REDROID_FORGE_LOCAL_ADMIN_PASSWORD;
  delete process.env.REDROID_FORGE_LOCAL_ADMIN_USER;
  delete process.env.REDROID_FORGE_LOCAL_ADMIN_PASSWORD;
  try {
    userStore.ensureBootstrapAdmin(file);
    assert.equal(userStore.listUsers(file).length, 0);
  } finally {
    if (prevUser !== undefined) process.env.REDROID_FORGE_LOCAL_ADMIN_USER = prevUser;
    if (prevPass !== undefined) process.env.REDROID_FORGE_LOCAL_ADMIN_PASSWORD = prevPass;
  }
});

test('deleteUser: removes it, no error if it does not exist', () => {
  const file = tmpFile();
  const user = userStore.createUser({ username: 'alice', password: 'longenough', role: 'viewer' }, file);
  userStore.deleteUser(user.id, file);
  assert.equal(userStore.listUsers(file).length, 0);
  assert.doesNotThrow(() => userStore.deleteUser('not-an-id', file));
});

test('createUser: email is optional, stored and returned, never required', () => {
  const file = tmpFile();
  const withEmail = userStore.createUser({ username: 'alice', password: 'longenough', role: 'viewer', email: 'alice@example.invalid' }, file);
  assert.equal(withEmail.email, 'alice@example.invalid');
  const withoutEmail = userStore.createUser({ username: 'bob', password: 'longenough', role: 'viewer' }, file);
  assert.equal(withoutEmail.email, null);
});

test('setRole: updates role, rejects an invalid one, 404s on an unknown id', () => {
  const file = tmpFile();
  const user = userStore.createUser({ username: 'alice', password: 'longenough', role: 'viewer' }, file);
  const updated = userStore.setRole(user.id, 'operator', file);
  assert.equal(updated.role, 'operator');
  assert.equal(userStore.findById(user.id, file).role, 'operator');
  assert.throws(() => userStore.setRole(user.id, 'superadmin', file), /role/);
  assert.throws(() => userStore.setRole('not-an-id', 'admin', file), (e) => e.httpStatus === 404);
});

test('resetPassword: changes the hash so the new password verifies and the old one does not', () => {
  const file = tmpFile();
  const user = userStore.createUser({ username: 'alice', password: 'originalpass', role: 'viewer' }, file);
  userStore.resetPassword(user.id, 'brandnewpass', file);
  assert.equal(userStore.verifyCredentials('alice', 'originalpass', file), null);
  assert.equal(userStore.verifyCredentials('alice', 'brandnewpass', file).username, 'alice');
  assert.throws(() => userStore.resetPassword(user.id, 'short', file), /8 characters/);
  assert.throws(() => userStore.resetPassword('not-an-id', 'longenough', file), (e) => e.httpStatus === 404);
});

test('setEmail: updates it, accepts null to clear it, 404s on an unknown id', () => {
  const file = tmpFile();
  const user = userStore.createUser({ username: 'alice', password: 'longenough', role: 'viewer', email: 'a@example.invalid' }, file);
  assert.equal(userStore.setEmail(user.id, 'b@example.invalid', file).email, 'b@example.invalid');
  assert.equal(userStore.setEmail(user.id, null, file).email, null);
  assert.throws(() => userStore.setEmail('not-an-id', 'x@example.invalid', file), (e) => e.httpStatus === 404);
});

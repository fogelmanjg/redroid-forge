// Coverage of src/lib/accountLinks.js (26/10/2026): explicit account linking -- an OIDC
// externalId pointed AT a local account, created only while the person was already logged in as
// that local account (see routes/auth.js's /me/links/:providerId/start). Uses a temp file like
// userStore.test.js/roleAssignments.test.js, never the real backend/data/account-links.json.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const accountLinks = require('../src/lib/accountLinks');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accountlinks-'));
  return path.join(dir, 'account-links.json');
}

test('findByExternalId/findByLocalUserId: empty store -> nothing found', () => {
  const file = tmpFile();
  assert.equal(accountLinks.findByExternalId('google:123', file), undefined);
  assert.deepEqual(accountLinks.findByLocalUserId('user-1', file), []);
});

test('link: creates a row, found by both externalId and localUserId', () => {
  const file = tmpFile();
  const row = accountLinks.link({
    externalId: 'google:123', localUserId: 'user-1', username: 'alice@example.invalid', providerId: 'google', providerLabel: 'Google',
  }, file);
  assert.equal(row.externalId, 'google:123');
  assert.equal(row.localUserId, 'user-1');
  assert.equal(accountLinks.findByExternalId('google:123', file).localUserId, 'user-1');
  assert.deepEqual(accountLinks.findByLocalUserId('user-1', file).map((l) => l.externalId), ['google:123']);
});

test('link: re-linking the same pair refreshes username/providerLabel/lastLinkedAt without erroring', () => {
  const file = tmpFile();
  accountLinks.link({ externalId: 'google:123', localUserId: 'user-1', username: 'alice', providerId: 'google', providerLabel: 'Google' }, file);
  const updated = accountLinks.link({ externalId: 'google:123', localUserId: 'user-1', username: 'alice2', providerId: 'google', providerLabel: 'Google Workspace' }, file);
  assert.equal(updated.username, 'alice2');
  assert.equal(updated.providerLabel, 'Google Workspace');
  assert.equal(accountLinks.listLinks(file).length, 1);
});

test('link: linking an externalId already linked to a DIFFERENT local user throws 409, never re-points it', () => {
  const file = tmpFile();
  accountLinks.link({ externalId: 'google:123', localUserId: 'user-1', username: 'alice', providerId: 'google', providerLabel: 'Google' }, file);
  assert.throws(
    () => accountLinks.link({ externalId: 'google:123', localUserId: 'user-2', username: 'alice', providerId: 'google', providerLabel: 'Google' }, file),
    (e) => e.httpStatus === 409,
  );
  assert.equal(accountLinks.findByExternalId('google:123', file).localUserId, 'user-1');
});

test('one local user can have several linked identities at once', () => {
  const file = tmpFile();
  accountLinks.link({ externalId: 'google:123', localUserId: 'user-1', username: 'alice', providerId: 'google', providerLabel: 'Google' }, file);
  accountLinks.link({ externalId: 'kctest:456', localUserId: 'user-1', username: 'alice', providerId: 'kctest', providerLabel: 'Keycloak Test' }, file);
  const links = accountLinks.findByLocalUserId('user-1', file);
  assert.equal(links.length, 2);
});

test('unlink: removes it, no error if it does not exist', () => {
  const file = tmpFile();
  accountLinks.link({ externalId: 'google:123', localUserId: 'user-1', username: 'alice', providerId: 'google', providerLabel: 'Google' }, file);
  accountLinks.unlink('google:123', file);
  assert.equal(accountLinks.findByExternalId('google:123', file), undefined);
  assert.doesNotThrow(() => accountLinks.unlink('not-linked', file));
});

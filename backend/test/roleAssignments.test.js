// Coverage of src/lib/roleAssignments.js (docs/ROADMAP.md Phase 7, redesigned 25/10/2026): the
// local "permissions backend" an OIDC identity's role is looked up in, now that oidc.js itself
// only ever hands back identity. Uses a temp file like userStore.test.js, never the real
// backend/data/role-assignments.json.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roleassignments-'));
  return path.join(dir, 'role-assignments.json');
}

function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) { prev[k] = process.env[k]; process.env[k] = v; }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

delete require.cache[require.resolve('../src/lib/roleAssignments')];
const roleAssignments = require('../src/lib/roleAssignments');

test('resolveRole: null for an identity that has never logged in', () => {
  const file = tmpFile();
  assert.equal(roleAssignments.resolveRole('sub-123', file), null);
});

test('upsertSeen: first login creates a pending row (role null), does not grant anything', () => {
  const file = tmpFile();
  const row = roleAssignments.upsertSeen({ externalId: 'sub-123', username: 'alice' }, file);
  assert.equal(row.role, null);
  assert.equal(row.username, 'alice');
  assert.equal(roleAssignments.resolveRole('sub-123', file), null);
});

test('upsertSeen: a second login refreshes username/lastSeenAt but never touches an already-granted role', () => {
  const file = tmpFile();
  roleAssignments.upsertSeen({ externalId: 'sub-123', username: 'alice' }, file);
  roleAssignments.setRole('sub-123', 'operator', file);
  const row = roleAssignments.upsertSeen({ externalId: 'sub-123', username: 'alice-renamed' }, file);
  assert.equal(row.role, 'operator');
  assert.equal(row.username, 'alice-renamed');
});

test('setRole: validates the role, 404s on an identity that has never logged in', () => {
  const file = tmpFile();
  assert.throws(() => roleAssignments.setRole('sub-123', 'bogus', file), /role/);
  assert.throws(() => roleAssignments.setRole('never-seen', 'admin', file), /has never logged in/);
});

test('setRole: null revokes back to pending without deleting the row', () => {
  const file = tmpFile();
  roleAssignments.upsertSeen({ externalId: 'sub-123', username: 'alice' }, file);
  roleAssignments.setRole('sub-123', 'admin', file);
  roleAssignments.setRole('sub-123', null, file);
  assert.equal(roleAssignments.resolveRole('sub-123', file), null);
  assert.ok(roleAssignments.findByExternalId('sub-123', file)); // row survives the revoke
});

test('deleteAssignment: removes the row entirely -- the next login treats it as brand new', () => {
  const file = tmpFile();
  roleAssignments.upsertSeen({ externalId: 'sub-123', username: 'alice' }, file);
  roleAssignments.deleteAssignment('sub-123', file);
  assert.equal(roleAssignments.findByExternalId('sub-123', file), undefined);
});

test('listAssignments: every known identity, regardless of role state', () => {
  const file = tmpFile();
  roleAssignments.upsertSeen({ externalId: 'sub-1', username: 'alice' }, file);
  roleAssignments.upsertSeen({ externalId: 'sub-2', username: 'bob' }, file);
  roleAssignments.setRole('sub-2', 'viewer', file);
  const all = roleAssignments.listAssignments(file);
  assert.equal(all.length, 2);
});

test('bootstrap admin: a first-ever login matching REDROID_FORGE_OIDC_BOOTSTRAP_ADMIN_ID is admin immediately, others stay pending', () => {
  const file = tmpFile();
  withEnv({ REDROID_FORGE_OIDC_BOOTSTRAP_ADMIN_ID: 'sub-the-admin' }, () => {
    delete require.cache[require.resolve('../src/lib/roleAssignments')];
    const fresh = require('../src/lib/roleAssignments');
    const adminRow = fresh.upsertSeen({ externalId: 'sub-the-admin', username: 'boss' }, file);
    const otherRow = fresh.upsertSeen({ externalId: 'sub-someone-else', username: 'rando' }, file);
    assert.equal(adminRow.role, 'admin');
    assert.equal(otherRow.role, null);
  });
  delete require.cache[require.resolve('../src/lib/roleAssignments')];
});

test('bootstrap admin: re-checked on every login, not just creation -- works even if the var is set AFTER the first (pending) login', () => {
  const file = tmpFile();
  delete require.cache[require.resolve('../src/lib/roleAssignments')];
  const before = require('../src/lib/roleAssignments');
  before.upsertSeen({ externalId: 'sub-late-admin', username: 'boss' }, file);
  assert.equal(before.resolveRole('sub-late-admin', file), null);

  withEnv({ REDROID_FORGE_OIDC_BOOTSTRAP_ADMIN_ID: 'sub-late-admin' }, () => {
    delete require.cache[require.resolve('../src/lib/roleAssignments')];
    const after = require('../src/lib/roleAssignments');
    const row = after.upsertSeen({ externalId: 'sub-late-admin', username: 'boss' }, file);
    assert.equal(row.role, 'admin');
  });
  delete require.cache[require.resolve('../src/lib/roleAssignments')];
});

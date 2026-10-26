// Coverage of src/lib/quotas.js -- the per-operator + shared-pool resource quota model (docs/
// ROADMAP.md Phase 7, 25/10/2026). Store-level functions (getQuota/setQuota/deleteQuota/
// listQuotas) take a `file` just like roleAssignments.js's tests do. `assertWithinQuota` is
// exercised with explicit `operatorIdSet`/`pool` objects passed in directly (not through
// auth.js/settings.js) so most of this file never touches real env vars or the real data/
// directory -- only the dedicated `operatorIds()` tests at the bottom need the withEnv/
// require.cache dance, same pattern as oidc.test.js/roleAssignments.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quotas-'));
  return path.join(dir, name);
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

const quotas = require('../src/lib/quotas');

test('getQuota: no row for this user -> null (unlimited)', () => {
  const file = tmpFile('quotas.json');
  assert.equal(quotas.getQuota('u1', file), null);
});

test('setQuota: validates both fields are positive integers or null', () => {
  const file = tmpFile('quotas.json');
  assert.throws(() => quotas.setQuota('u1', { maxVcpus: 0 }, file), /maxVcpus/);
  assert.throws(() => quotas.setQuota('u1', { maxVcpus: -1 }, file), /maxVcpus/);
  assert.throws(() => quotas.setQuota('u1', { maxVcpus: 1.5 }, file), /maxVcpus/);
  assert.throws(() => quotas.setQuota('u1', { maxMemoryMb: 'lots' }, file), /maxMemoryMb/);
});

test('setQuota/getQuota/listQuotas: round-trip, one or both dimensions', () => {
  const file = tmpFile('quotas.json');
  quotas.setQuota('u1', { maxVcpus: 4, maxMemoryMb: 16384 }, file);
  assert.deepEqual(
    { maxVcpus: quotas.getQuota('u1', file).maxVcpus, maxMemoryMb: quotas.getQuota('u1', file).maxMemoryMb },
    { maxVcpus: 4, maxMemoryMb: 16384 },
  );
  quotas.setQuota('u2', { maxVcpus: 2 }, file);
  assert.equal(quotas.getQuota('u2', file).maxMemoryMb, null);
  assert.equal(quotas.listQuotas(file).length, 2);
});

test('setQuota: setting both dimensions to null removes the row entirely (back to unlimited)', () => {
  const file = tmpFile('quotas.json');
  quotas.setQuota('u1', { maxVcpus: 4, maxMemoryMb: 16384 }, file);
  const result = quotas.setQuota('u1', { maxVcpus: null, maxMemoryMb: null }, file);
  assert.equal(result, null);
  assert.equal(quotas.getQuota('u1', file), null);
  assert.equal(quotas.listQuotas(file).length, 0);
});

test('deleteQuota: removes the row, no error if it never existed', () => {
  const file = tmpFile('quotas.json');
  quotas.setQuota('u1', { maxVcpus: 4 }, file);
  quotas.deleteQuota('u1', file);
  assert.equal(quotas.getQuota('u1', file), null);
  assert.doesNotThrow(() => quotas.deleteQuota('nonexistent', file));
});

// assertWithinQuota -- pure given operatorIdSet/pool, except the one quotas.json file read.
const quotaFile = () => tmpFile('quotas.json');

test('assertWithinQuota: admin actor always bypasses, regardless of createdId or how configured the limits are', () => {
  const file = quotaFile();
  quotas.setQuota('op1', { maxVcpus: 1 }, file);
  assert.doesNotThrow(() => quotas.assertWithinQuota({
    actorRole: 'admin', createdId: 'op1', instances: [], thisVcpus: 999, thisMemoryMb: 999999,
    operatorIdSet: new Set(['op1']), pool: { operatorPoolMaxVcpus: 1 }, quotasFile: file,
  }));
});

test('assertWithinQuota: createdId not in operatorIdSet (e.g. attributed to an admin) -> no limit applies', () => {
  const file = quotaFile();
  assert.doesNotThrow(() => quotas.assertWithinQuota({
    actorRole: 'operator', createdId: 'some-admin', instances: [], thisVcpus: 999, thisMemoryMb: 999999,
    operatorIdSet: new Set(['op1']), pool: { operatorPoolMaxVcpus: 1 }, quotasFile: file,
  }));
});

test('assertWithinQuota: no quota configured at all (own or pool) -> never throws', () => {
  const file = quotaFile();
  assert.doesNotThrow(() => quotas.assertWithinQuota({
    actorRole: 'operator', createdId: 'op1', instances: [], thisVcpus: 999, thisMemoryMb: 999999,
    operatorIdSet: new Set(['op1']), pool: {}, quotasFile: file,
  }));
});

test('assertWithinQuota: per-operator quota blocks once this operator\'s OWN total would exceed it', () => {
  const file = quotaFile();
  quotas.setQuota('op1', { maxVcpus: 4, maxMemoryMb: 8192 }, file);
  const instances = [
    { id: 'i1', createdId: 'op1', cpusetCpus: '0,1', memoryMb: 4096 }, // 2 vcpus, 4096MB already
    { id: 'i2', createdId: 'op2', cpusetCpus: '0-7', memoryMb: 32768 }, // someone else's, irrelevant
  ];
  // Creating a brand new instance (no excludeInstanceId) using 3 more vcpus: 2+3=5 > 4 -> blocked.
  assert.throws(() => quotas.assertWithinQuota({
    actorRole: 'operator', createdId: 'op1', instances, thisVcpus: 3, thisMemoryMb: 0,
    operatorIdSet: new Set(['op1', 'op2']), pool: {}, quotasFile: file,
  }), (e) => e.httpStatus === 403 && /vCPUs/.test(e.message));
  // 2 more vcpus (2+2=4) fits exactly -> allowed.
  assert.doesNotThrow(() => quotas.assertWithinQuota({
    actorRole: 'operator', createdId: 'op1', instances, thisVcpus: 2, thisMemoryMb: 0,
    operatorIdSet: new Set(['op1', 'op2']), pool: {}, quotasFile: file,
  }));
  // RAM: 4096 already + 4097 new = 8193 > 8192 -> blocked.
  assert.throws(() => quotas.assertWithinQuota({
    actorRole: 'operator', createdId: 'op1', instances, thisVcpus: 0, thisMemoryMb: 4097,
    operatorIdSet: new Set(['op1', 'op2']), pool: {}, quotasFile: file,
  }), (e) => e.httpStatus === 403 && /RAM/.test(e.message));
});

test('assertWithinQuota: excludeInstanceId leaves out that instance\'s OWN current usage (resizing it, not adding a new one)', () => {
  const file = quotaFile();
  quotas.setQuota('op1', { maxVcpus: 4 }, file);
  const instances = [{ id: 'i1', createdId: 'op1', cpusetCpus: '0,1,2,3', memoryMb: 0 }]; // already at the cap, 4 vcpus
  // Without excluding it, any further vcpus would double-count i1's own 4 on top of the new total.
  assert.throws(() => quotas.assertWithinQuota({
    actorRole: 'operator', createdId: 'op1', instances, thisVcpus: 4, thisMemoryMb: 0,
    operatorIdSet: new Set(['op1']), pool: {}, quotasFile: file,
  }), (e) => e.httpStatus === 403);
  // Resizing i1 itself DOWN to the same 4 is fine once excluded -- it is not "4 (i1) + 4 (new i1)".
  assert.doesNotThrow(() => quotas.assertWithinQuota({
    actorRole: 'operator', createdId: 'op1', instances, excludeInstanceId: 'i1', thisVcpus: 4, thisMemoryMb: 0,
    operatorIdSet: new Set(['op1']), pool: {}, quotasFile: file,
  }));
});

test('assertWithinQuota: shared pool quota blocks across ALL operators combined, even with no per-operator limit set', () => {
  const file = quotaFile();
  const instances = [
    { id: 'i1', createdId: 'op1', cpusetCpus: '0-3', memoryMb: 0 }, // 4 vcpus
    { id: 'i2', createdId: 'op2', cpusetCpus: '4-7', memoryMb: 0 }, // 4 vcpus, different operator
  ];
  // Pool cap of 10: 4+4=8 already, 3 more = 11 > 10 -> blocked, even though op1 has no own quota row at all.
  assert.throws(() => quotas.assertWithinQuota({
    actorRole: 'operator', createdId: 'op1', instances, thisVcpus: 3, thisMemoryMb: 0,
    operatorIdSet: new Set(['op1', 'op2']), pool: { operatorPoolMaxVcpus: 10 }, quotasFile: file,
  }), (e) => e.httpStatus === 403 && /pool/.test(e.message));
  // 2 more fits (8+2=10, exactly at the cap).
  assert.doesNotThrow(() => quotas.assertWithinQuota({
    actorRole: 'operator', createdId: 'op1', instances, thisVcpus: 2, thisMemoryMb: 0,
    operatorIdSet: new Set(['op1', 'op2']), pool: { operatorPoolMaxVcpus: 10 }, quotasFile: file,
  }));
});

test('assertWithinQuota: both a per-operator AND a pool limit configured -- whichever is hit first blocks', () => {
  const file = quotaFile();
  quotas.setQuota('op1', { maxVcpus: 4 }, file); // generous individually
  const instances = [{ id: 'i1', createdId: 'op2', cpusetCpus: '0-7', memoryMb: 0 }]; // 8 vcpus, fills most of the pool
  // op1 alone would be fine (0+3=3 <= 4), but the shared pool (8+3=11 > 10) is not.
  assert.throws(() => quotas.assertWithinQuota({
    actorRole: 'operator', createdId: 'op1', instances, thisVcpus: 3, thisMemoryMb: 0,
    operatorIdSet: new Set(['op1', 'op2']), pool: { operatorPoolMaxVcpus: 10 }, quotasFile: file,
  }), (e) => e.httpStatus === 403 && /pool/.test(e.message));
});

// operatorIds() -- the one function that actually reads auth.js/userStore.js/roleAssignments.js,
// so it needs the withEnv + require.cache dance (same reasoning as oidc.test.js/
// roleAssignments.test.js: AUTH_MODE is read once, at require time).
test('operatorIds: "none" mode -> always empty, regardless of what the stores contain', () => {
  withEnv({ REDROID_FORGE_AUTH: 'none' }, () => {
    delete require.cache[require.resolve('../src/lib/auth')];
    delete require.cache[require.resolve('../src/lib/quotas')];
    const freshQuotas = require('../src/lib/quotas');
    assert.deepEqual(freshQuotas.operatorIds(), new Set());
  });
});

test('operatorIds: "local" mode -> every local user with role operator, by id', () => {
  const usersFile = tmpFile('users.json');
  withEnv({ REDROID_FORGE_AUTH: 'local' }, () => {
    delete require.cache[require.resolve('../src/lib/auth')];
    delete require.cache[require.resolve('../src/lib/quotas')];
    delete require.cache[require.resolve('../src/lib/userStore')];
    const freshQuotas = require('../src/lib/quotas');
    const userStore = require('../src/lib/userStore');
    const op1 = userStore.createUser({ username: 'op1', password: 'password123', role: 'operator' }, usersFile);
    userStore.createUser({ username: 'adm1', password: 'password123', role: 'admin' }, usersFile);
    const ids = freshQuotas.operatorIds({ usersFile });
    assert.equal(ids.size, 1);
    assert.equal(ids.has(op1.id), true);
  });
});

test('operatorIds: "oidc" mode -> every identity with role operator, by external id', () => {
  const file = tmpFile('role-assignments.json');
  withEnv({ REDROID_FORGE_AUTH: 'oidc' }, () => {
    delete require.cache[require.resolve('../src/lib/auth')];
    delete require.cache[require.resolve('../src/lib/quotas')];
    delete require.cache[require.resolve('../src/lib/roleAssignments')];
    const freshQuotas = require('../src/lib/quotas');
    const roleAssignments = require('../src/lib/roleAssignments');
    roleAssignments.upsertSeen({ externalId: 'google:123', username: 'alice' }, file);
    roleAssignments.setRole('google:123', 'operator', file);
    roleAssignments.upsertSeen({ externalId: 'google:456', username: 'bob' }, file);
    roleAssignments.setRole('google:456', 'viewer', file);
    const ids = freshQuotas.operatorIds({ roleAssignmentsFile: file });
    assert.deepEqual(ids, new Set(['google:123']));
  });
});

test('operatorIds: "both" mode -> the union of local operators and OIDC operators', () => {
  const usersFile = tmpFile('users.json');
  const roleAssignmentsFile = tmpFile('role-assignments.json');
  withEnv({ REDROID_FORGE_AUTH: 'both' }, () => {
    delete require.cache[require.resolve('../src/lib/auth')];
    delete require.cache[require.resolve('../src/lib/quotas')];
    delete require.cache[require.resolve('../src/lib/userStore')];
    delete require.cache[require.resolve('../src/lib/roleAssignments')];
    const freshQuotas = require('../src/lib/quotas');
    const userStore = require('../src/lib/userStore');
    const roleAssignments = require('../src/lib/roleAssignments');
    const op1 = userStore.createUser({ username: 'op1', password: 'password123', role: 'operator' }, usersFile);
    userStore.createUser({ username: 'adm1', password: 'password123', role: 'admin' }, usersFile);
    roleAssignments.upsertSeen({ externalId: 'google:123', username: 'alice' }, roleAssignmentsFile);
    roleAssignments.setRole('google:123', 'operator', roleAssignmentsFile);
    const ids = freshQuotas.operatorIds({ usersFile, roleAssignmentsFile });
    assert.deepEqual(ids, new Set([op1.id, 'google:123']));
  });
});

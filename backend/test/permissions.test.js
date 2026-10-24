// Coverage of the fixed role x capability x ownership model (see src/lib/permissions.js and
// docs/ROADMAP.md Phase 7). Pure, no I/O.
const test = require('node:test');
const assert = require('node:assert/strict');

const { can, canManageSettings, visibleInstances, isValidRole, assertCan } = require('../src/lib/permissions');

const admin = { id: 'u-admin', role: 'admin' };
const operatorA = { id: 'u-op-a', role: 'operator' };
const operatorB = { id: 'u-op-b', role: 'operator' };
const viewerA = { id: 'u-view-a', role: 'viewer' };
const ownedByA = { id: 'i1', ownerId: 'u-op-a' };
const ownedByB = { id: 'i2', ownerId: 'u-op-b' };

test('isValidRole: only the three fixed roles', () => {
  assert.equal(isValidRole('admin'), true);
  assert.equal(isValidRole('operator'), true);
  assert.equal(isValidRole('viewer'), true);
  assert.equal(isValidRole('superadmin'), false);
  assert.equal(isValidRole(undefined), false);
});

test('can: no user, or a user with an unknown role, has no capabilities', () => {
  assert.equal(can(null, 'view', ownedByA), false);
  assert.equal(can({ id: 'x', role: 'bogus' }, 'view', ownedByA), false);
});

test('can: admin bypasses ownership entirely', () => {
  assert.equal(can(admin, 'view', ownedByA), true);
  assert.equal(can(admin, 'delete', ownedByB), true);
  assert.equal(can(admin, 'configure', ownedByB), true);
});

test('can: operator has every per-instance capability, but only on instances it owns', () => {
  assert.equal(can(operatorA, 'view', ownedByA), true);
  assert.equal(can(operatorA, 'delete', ownedByA), true);
  assert.equal(can(operatorA, 'configure', ownedByA), true);
  assert.equal(can(operatorA, 'backup-restore', ownedByA), true);
  assert.equal(can(operatorA, 'view', ownedByB), false);
  assert.equal(can(operatorA, 'delete', ownedByB), false);
});

test('can: viewer only has view/start-stop, and only on instances it owns', () => {
  assert.equal(can(viewerA, 'view', ownedByA), false); // owned by operatorA, not viewerA
  const ownedByViewer = { id: 'i3', ownerId: 'u-view-a' };
  assert.equal(can(viewerA, 'view', ownedByViewer), true);
  assert.equal(can(viewerA, 'start-stop', ownedByViewer), true);
  assert.equal(can(viewerA, 'create', ownedByViewer), false);
  assert.equal(can(viewerA, 'delete', ownedByViewer), false);
  assert.equal(can(viewerA, 'configure', ownedByViewer), false);
});

test('can: "create" is never ownership-scoped (the instance does not exist yet)', () => {
  assert.equal(can(operatorA, 'create'), true);
  assert.equal(can(viewerA, 'create'), false);
});

test('can: a capability check with no instance given, for a non-admin, is true only to let the caller re-check once it has one', () => {
  assert.equal(can(operatorA, 'configure'), true);
  assert.equal(can(viewerA, 'configure'), false); // role itself never has this capability, instance or not
});

test('canManageSettings: admin only', () => {
  assert.equal(canManageSettings(admin), true);
  assert.equal(canManageSettings(operatorA), false);
  assert.equal(canManageSettings(viewerA), false);
  assert.equal(canManageSettings(null), false);
});

test('visibleInstances: admin sees everything, everyone else only their own', () => {
  const all = [ownedByA, ownedByB];
  assert.deepEqual(visibleInstances(admin, all), all);
  assert.deepEqual(visibleInstances(operatorA, all), [ownedByA]);
  assert.deepEqual(visibleInstances(operatorB, all), [ownedByB]);
  assert.deepEqual(visibleInstances(viewerA, all), []);
});

test('visibleInstances: no user, or unknown role -> sees nothing', () => {
  assert.deepEqual(visibleInstances(null, [ownedByA]), []);
  assert.deepEqual(visibleInstances({ id: 'x', role: 'bogus' }, [ownedByA]), []);
});

test('assertCan: 404 (not 403) for an instance invisible to this user -- cannot be told apart from nonexistent', () => {
  assert.throws(() => assertCan(operatorA, 'view', ownedByB), (e) => e.httpStatus === 404);
  assert.throws(() => assertCan(viewerA, 'view', ownedByA), (e) => e.httpStatus === 404);
});

test('assertCan: 403 once the instance IS visible but the capability itself is missing', () => {
  const ownedByViewer = { id: 'i3', ownerId: 'u-view-a' };
  assert.throws(() => assertCan(viewerA, 'delete', ownedByViewer), (e) => e.httpStatus === 403);
  assert.throws(() => assertCan(viewerA, 'configure', ownedByViewer), (e) => e.httpStatus === 403);
});

test('assertCan: passes silently (no throw) when allowed', () => {
  assert.doesNotThrow(() => assertCan(admin, 'delete', ownedByB));
  assert.doesNotThrow(() => assertCan(operatorA, 'configure', ownedByA));
  assert.doesNotThrow(() => assertCan(operatorA, 'create'));
});

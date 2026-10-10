const test = require('node:test');
const assert = require('node:assert');
const { binderBinds, useLegacyBinder } = require('../src/lib/binder');

test('useLegacyBinder: legacy when binder-control does not exist', () => {
  assert.strictEqual(useLegacyBinder(() => false), true);
  assert.strictEqual(useLegacyBinder(() => true), false);
});

test('binderBinds legacy: uses the host\'s /dev/binderN', () => {
  const binds = binderBinds(1, { legacy: true, exists: () => true });
  assert.deepStrictEqual(binds, [
    '/dev/binder1:/dev/binder',
    '/dev/hwbinder1:/dev/hwbinder',
    '/dev/vndbinder1:/dev/vndbinder',
  ]);
});

test('binderBinds legacy: a clear error if the slot is not in devices=', () => {
  assert.throws(() => binderBinds(3, { legacy: true, exists: () => false }), /\/dev\/binder3.* missing/);
});

test('binderBinds legacy: slot 0 uses the nodes without a suffix', () => {
  assert.deepStrictEqual(binderBinds(0, { legacy: true, exists: () => true }), [
    '/dev/binder:/dev/binder',
    '/dev/hwbinder:/dev/hwbinder',
    '/dev/vndbinder:/dev/vndbinder',
  ]);
});

const store = require('../src/lib/store');
const { nextFreeSlot } = require('../src/lib/binder');

function withInstances(list, fn) {
  const orig = store.readAll;
  store.readAll = () => list;
  try { fn(); } finally { store.readAll = orig; }
}
const nodes = (...present) => (p) => present.includes(p);

test('nextFreeSlot legacy: only nodes without a suffix -> slot 0', () => {
  withInstances([], () => {
    const exists = nodes('/dev/binder', '/dev/hwbinder', '/dev/vndbinder');
    assert.strictEqual(nextFreeSlot({ legacy: true, exists }), 0);
  });
});

test('nextFreeSlot legacy: prefers the numbered ones and skips the used ones', () => {
  const exists = () => true;
  withInstances([{ binderSlot: 1 }], () => assert.strictEqual(nextFreeSlot({ legacy: true, exists }), 2));
});

test('nextFreeSlot legacy: slot 0 taken and nothing else -> a clear error', () => {
  withInstances([{ binderSlot: 0 }], () => {
    const exists = nodes('/dev/binder', '/dev/hwbinder', '/dev/vndbinder');
    assert.throws(() => nextFreeSlot({ legacy: true, exists }), /no free slot/);
  });
});

test('nextFreeSlot binderfs: it is still the next integer >= 1 (0 counts as used)', () => {
  withInstances([{ binderSlot: 1 }, { binderSlot: 0 }], () => assert.strictEqual(nextFreeSlot({ legacy: false }), 2));
});

// Slots reserved to coexist with another orchestrator on the same host (REDROID_FORGE_BINDER_RESERVED).
const { reservedSlots } = require('../src/lib/binder');

test('reservedSlots: reads a comma-separated list and ignores what is not a number', () => {
  assert.deepStrictEqual(reservedSlots({ REDROID_FORGE_BINDER_RESERVED: '1, 2,3,x,50,,-4' }), [1, 2, 3, 50]);
  assert.deepStrictEqual(reservedSlots({}), []);
});

test('nextFreeSlot binderfs: skips the slots reserved by another orchestrator', () => {
  const slot = nextFreeSlot({ legacy: false, reserved: [1, 2, 3, 4] });
  assert.strictEqual(slot, 5);
});

test('nextFreeSlot legacy: it also respects the reserved ones', () => {
  const slot = nextFreeSlot({ legacy: true, exists: () => true, reserved: [1, 2] });
  assert.strictEqual(slot, 3);
});

// ---- legacyDevicesParam: the `devices=` line that creates N slots ----

test('legacyDevicesParam(3) is exactly what the Waydroid package configures (slots 0, 1 and 2)', () => {
  const { legacyDevicesParam } = require('../src/lib/binder');
  assert.strictEqual(
    legacyDevicesParam(3),
    'binder,hwbinder,vndbinder,binder1,hwbinder1,vndbinder1,binder2,hwbinder2,vndbinder2',
  );
});

test('legacyDevicesParam(N): 3 nodes per slot, unique, slot 0 first and without suffix', () => {
  const { legacyDevicesParam } = require('../src/lib/binder');
  const list = legacyDevicesParam(12).split(',');
  assert.strictEqual(list.length, 36);
  assert.strictEqual(new Set(list).size, 36);
  assert.deepStrictEqual(list.slice(0, 3), ['binder', 'hwbinder', 'vndbinder']);
  assert.deepStrictEqual(list.slice(-3), ['binder11', 'hwbinder11', 'vndbinder11']);
});

test('legacyDevicesParam: what it declares is exactly what nextFreeSlot can then use', () => {
  const { legacyDevicesParam, nextFreeSlot } = require('../src/lib/binder');
  const present = new Set(legacyDevicesParam(5).split(',').map((n) => `/dev/${n}`));
  const exists = (p) => present.has(p);
  // Slots 1..4 exist and slot 0 is the fallback; with slot 0 reserved (Waydroid) and 1..4 used there is none left.
  const taken = [1, 2, 3, 4];
  assert.throws(() => nextFreeSlot({ legacy: true, exists, reserved: [0, ...taken] }), /no free slot/);
  assert.strictEqual(nextFreeSlot({ legacy: true, exists, reserved: [0, 1, 2, 3] }), 4);
});

test('legacyDevicesParam: rejects a slot count that makes no sense', () => {
  const { legacyDevicesParam } = require('../src/lib/binder');
  for (const bad of [0, -1, 1.5, 65, '3', NaN, undefined]) {
    assert.throws(() => legacyDevicesParam(bad), /between 1 and 64/, String(bad));
  }
});

test('reserving slot 0 keeps redroid-forge away from it even when it is the only one free', () => {
  const { nextFreeSlot } = require('../src/lib/binder');
  const exists = (p) => ['/dev/binder', '/dev/hwbinder', '/dev/vndbinder'].includes(p); // a host with only slot 0
  assert.strictEqual(nextFreeSlot({ legacy: true, exists, reserved: [] }), 0);
  assert.throws(() => nextFreeSlot({ legacy: true, exists, reserved: [0] }), /no free slot/);
});

// ---- permissions: a root-only node kills the instance (found with slot 0 of the Polaris, 10/10/2026) ----

test('worldAccessible: only a node that every user can open for read and write counts', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { worldAccessible } = require('../src/lib/binder');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binder-perm-'));
  try {
    const f = path.join(dir, 'node');
    fs.writeFileSync(f, '');
    fs.chmodSync(f, 0o600);
    assert.strictEqual(worldAccessible(f), false, '0600');
    fs.chmodSync(f, 0o660);
    assert.strictEqual(worldAccessible(f), false, '0660');
    fs.chmodSync(f, 0o664);
    assert.strictEqual(worldAccessible(f), false, '0664 (others can only read)');
    fs.chmodSync(f, 0o666);
    assert.strictEqual(worldAccessible(f), true, '0666');
    assert.strictEqual(worldAccessible(path.join(dir, 'does-not-exist')), true, 'a missing node is reported on its own');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('nextFreeSlot skips a slot whose nodes are root-only and takes the next usable one', () => {
  const { nextFreeSlot, legacyDevicesParam } = require('../src/lib/binder');
  const present = new Set(legacyDevicesParam(4).split(',').map((n) => `/dev/${n}`));
  const exists = (p) => present.has(p);
  const rootOnly = (p) => !/(binder|hwbinder|vndbinder)1$/.test(p); // slot 1 is root-only, the others are 0666
  assert.strictEqual(nextFreeSlot({ legacy: true, exists, accessible: rootOnly, reserved: [] }), 2);
});

test('nextFreeSlot: when the only free slots are root-only it says how to fix it, not "no free slot"', () => {
  const { nextFreeSlot } = require('../src/lib/binder');
  const exists = (p) => ['/dev/binder', '/dev/hwbinder', '/dev/vndbinder'].includes(p);
  assert.throws(
    () => nextFreeSlot({ legacy: true, exists, accessible: () => false, reserved: [] }),
    /not world-accessible[\s\S]*chmod 0666/,
  );
});

test('binderBinds refuses a slot with root-only nodes (the instance would die after a few seconds)', () => {
  const { binderBinds } = require('../src/lib/binder');
  const exists = () => true;
  assert.throws(() => binderBinds(0, { legacy: true, exists, accessible: () => false }), /not world-accessible[\s\S]*servicemanager/);
  assert.deepStrictEqual(binderBinds(0, { legacy: true, exists, accessible: () => true }), [
    '/dev/binder:/dev/binder', '/dev/hwbinder:/dev/hwbinder', '/dev/vndbinder:/dev/vndbinder',
  ]);
});

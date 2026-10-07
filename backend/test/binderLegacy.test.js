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

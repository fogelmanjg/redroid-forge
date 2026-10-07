const test = require('node:test');
const assert = require('node:assert');
const { binderBinds, useLegacyBinder } = require('../src/lib/binder');

test('useLegacyBinder: legacy cuando no existe binder-control', () => {
  assert.strictEqual(useLegacyBinder(() => false), true);
  assert.strictEqual(useLegacyBinder(() => true), false);
});

test('binderBinds legacy: usa /dev/binderN del host', () => {
  const binds = binderBinds(1, { legacy: true, exists: () => true });
  assert.deepStrictEqual(binds, [
    '/dev/binder1:/dev/binder',
    '/dev/hwbinder1:/dev/hwbinder',
    '/dev/vndbinder1:/dev/vndbinder',
  ]);
});

test('binderBinds legacy: error claro si el slot no esta en devices=', () => {
  assert.throws(() => binderBinds(3, { legacy: true, exists: () => false }), /faltan \/dev\/binder3/);
});

test('binderBinds legacy: slot 0 usa los nodos sin sufijo', () => {
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

test('nextFreeSlot legacy: solo nodos sin sufijo -> slot 0', () => {
  withInstances([], () => {
    const exists = nodes('/dev/binder', '/dev/hwbinder', '/dev/vndbinder');
    assert.strictEqual(nextFreeSlot({ legacy: true, exists }), 0);
  });
});

test('nextFreeSlot legacy: prefiere los numerados y salta los usados', () => {
  const exists = () => true;
  withInstances([{ binderSlot: 1 }], () => assert.strictEqual(nextFreeSlot({ legacy: true, exists }), 2));
});

test('nextFreeSlot legacy: slot 0 ocupado y nada mas -> error claro', () => {
  withInstances([{ binderSlot: 0 }], () => {
    const exists = nodes('/dev/binder', '/dev/hwbinder', '/dev/vndbinder');
    assert.throws(() => nextFreeSlot({ legacy: true, exists }), /ningun slot libre/);
  });
});

test('nextFreeSlot binderfs: sigue siendo el proximo entero >= 1 (el 0 cuenta como usado)', () => {
  withInstances([{ binderSlot: 1 }, { binderSlot: 0 }], () => assert.strictEqual(nextFreeSlot({ legacy: false }), 2));
});

// Slots reservados para convivir con otro orquestador en el mismo host (REDROID_FORGE_BINDER_RESERVED).
const { reservedSlots } = require('../src/lib/binder');

test('reservedSlots: lee una lista separada por comas e ignora lo que no es un numero', () => {
  assert.deepStrictEqual(reservedSlots({ REDROID_FORGE_BINDER_RESERVED: '1, 2,3,x,50,,-4' }), [1, 2, 3, 50]);
  assert.deepStrictEqual(reservedSlots({}), []);
});

test('nextFreeSlot binderfs: salta los slots reservados por otro orquestador', () => {
  const slot = nextFreeSlot({ legacy: false, reserved: [1, 2, 3, 4] });
  assert.strictEqual(slot, 5);
});

test('nextFreeSlot legacy: tambien respeta los reservados', () => {
  const slot = nextFreeSlot({ legacy: true, exists: () => true, reserved: [1, 2] });
  assert.strictEqual(slot, 3);
});

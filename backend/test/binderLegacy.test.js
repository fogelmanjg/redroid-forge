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

// Espera entre reinicios del daemon VA-API.
const test = require('node:test');
const assert = require('node:assert');
const { nextRestartDelay } = require('../src/lib/hwAccel');

test('la primera espera es de 1 s y se duplica en cada muerte seguida', () => {
  let prev = 1000;
  const waits = [];
  for (let i = 0; i < 4; i += 1) {
    const r = nextRestartDelay(prev, 500); // vivio medio segundo: muere apenas arranca
    waits.push(r.wait);
    prev = r.next;
  }
  assert.deepStrictEqual(waits, [1000, 2000, 4000, 8000]);
});

test('la espera tiene un tope de 30 s', () => {
  let prev = 1000;
  let last = 0;
  for (let i = 0; i < 12; i += 1) {
    const r = nextRestartDelay(prev, 100);
    last = r.wait;
    prev = r.next;
  }
  assert.strictEqual(last, 30000);
});

test('si el daemon vivio un buen rato, la proxima espera vuelve a 1 s', () => {
  const r = nextRestartDelay(16000, 5 * 60 * 1000);
  assert.strictEqual(r.wait, 1000);
  assert.strictEqual(r.next, 2000);
});

// Wait between restarts of the VA-API daemon.
const test = require('node:test');
const assert = require('node:assert');
const { nextRestartDelay } = require('../src/lib/hwAccel');

test('the first wait is 1 s and it doubles on every consecutive death', () => {
  let prev = 1000;
  const waits = [];
  for (let i = 0; i < 4; i += 1) {
    const r = nextRestartDelay(prev, 500); // it lived half a second: it dies as soon as it starts
    waits.push(r.wait);
    prev = r.next;
  }
  assert.deepStrictEqual(waits, [1000, 2000, 4000, 8000]);
});

test('the wait has a cap of 30 s', () => {
  let prev = 1000;
  let last = 0;
  for (let i = 0; i < 12; i += 1) {
    const r = nextRestartDelay(prev, 100);
    last = r.wait;
    prev = r.next;
  }
  assert.strictEqual(last, 30000);
});

test('if the daemon lived for a good while, the next wait goes back to 1 s', () => {
  const r = nextRestartDelay(16000, 5 * 60 * 1000);
  assert.strictEqual(r.wait, 1000);
  assert.strictEqual(r.next, 2000);
});

// lib/captureHub.js (21/11/2026): one capture per instance per tick, however many viewers.
const test = require('node:test');
const assert = require('node:assert');
const { createRegistry, MAX_CONSECUTIVE_ERRORS } = require('../src/lib/captureHub');

const INTERVAL = 20;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeDeps({ fail = () => false } = {}) {
  const calls = { capture: 0, shrink: [] };
  return {
    calls,
    deps: {
      capture: async () => {
        calls.capture += 1;
        if (fail(calls.capture)) throw new Error('device offline');
        return Buffer.from(`png${calls.capture}`);
      },
      shrink: async (png, size) => { calls.shrink.push(size); return Buffer.from(`${png}@${size}`); },
      clampSize: (n) => (Number.isFinite(Number(n)) ? Number(n) : 160),
    },
  };
}

function sub(reg, id, size, extra = {}) {
  const frames = [];
  const handle = reg.subscribe(id, { host: 'h', adbPort: 5800, intervalMs: INTERVAL, size, onFrame: (f) => frames.push(f.toString()), ...extra });
  return { frames, handle };
}

test('three viewers of the same instance share ONE capture per tick', async () => {
  const { calls, deps } = fakeDeps();
  const reg = createRegistry(deps);
  const a = sub(reg, 'i1', 160);
  const b = sub(reg, 'i1', 160);
  const c = sub(reg, 'i1', 300);
  await wait(INTERVAL * 4.5);
  for (const s of [a, b, c]) s.handle.unsubscribe();
  const ticks = calls.capture;
  assert.ok(ticks >= 3 && ticks <= 6, `ticks=${ticks}`);
  // One shrink per distinct size per tick, not per viewer.
  assert.ok(calls.shrink.length <= ticks * 2, `shrinks=${calls.shrink.length} for ${ticks} ticks`);
  assert.ok(a.frames.length >= 3 && b.frames.length >= 3 && c.frames.length >= 3);
  assert.match(c.frames.at(-1), /@300$/);
  assert.match(a.frames.at(-1), /@160$/);
});

test('the loop stops when the last viewer leaves', async () => {
  const { calls, deps } = fakeDeps();
  const reg = createRegistry(deps);
  const a = sub(reg, 'i1', 160);
  await wait(INTERVAL * 2.5);
  a.handle.unsubscribe();
  await wait(INTERVAL);
  const after = calls.capture;
  await wait(INTERVAL * 4);
  assert.strictEqual(calls.capture, after, 'kept capturing with nobody watching');
  assert.deepStrictEqual(reg.stats(), []);
});

// No timing race (21/11/2026: it waited 5 ms and flaked under the parallel full-suite load): a
// long interval, so there is no second tick to race; wait for the first capture, then join and
// poll for the late joiner's frame. try/finally so a failure never leaves the hub ticking.
test('a late joiner gets the last frame right away, at its own size', async () => {
  const { calls, deps } = fakeDeps();
  const reg = createRegistry(deps);
  const a = reg.subscribe('i1', { host: 'h', adbPort: 5800, intervalMs: 60000, size: 160, onFrame: () => {} });
  let b;
  try {
    for (let i = 0; i < 100 && calls.capture === 0; i++) await wait(5);
    const frames = [];
    b = reg.subscribe('i1', { host: 'h', adbPort: 5800, intervalMs: 60000, size: 240, onFrame: (f) => frames.push(f.toString()) });
    for (let i = 0; i < 100 && frames.length === 0; i++) await wait(5);
    assert.deepStrictEqual(frames, ['png1@240']);
    assert.strictEqual(calls.capture, 1, 'served from the last capture, not a new one');
  } finally {
    a.unsubscribe();
    if (b) b.unsubscribe();
  }
});

test('after N failures in a row every viewer is told to give up, and capturing stops', async () => {
  const { calls, deps } = fakeDeps({ fail: () => true });
  const reg = createRegistry(deps);
  const gaveUp = [];
  sub(reg, 'i1', 160, { onGiveUp: () => gaveUp.push('a') });
  sub(reg, 'i1', 160, { onGiveUp: () => gaveUp.push('b') });
  await wait(INTERVAL * (MAX_CONSECUTIVE_ERRORS + 3));
  assert.deepStrictEqual(gaveUp.sort(), ['a', 'b']);
  assert.strictEqual(calls.capture, MAX_CONSECUTIVE_ERRORS, 'one capture per tick for both viewers, then stop');
  assert.deepStrictEqual(reg.stats(), []);
});

test('one failure is not fatal; the counter resets on success', async () => {
  const { deps } = fakeDeps({ fail: (n) => n === 2 });
  const reg = createRegistry(deps);
  let gaveUp = false;
  const a = sub(reg, 'i1', 160, { onGiveUp: () => { gaveUp = true; } });
  await wait(INTERVAL * 5);
  a.handle.unsubscribe();
  assert.strictEqual(gaveUp, false);
  assert.ok(a.frames.length >= 3);
});

test('setSize applies from the next tick', async () => {
  const { deps } = fakeDeps();
  const reg = createRegistry(deps);
  const a = sub(reg, 'i1', 160);
  await wait(INTERVAL / 2);
  a.handle.setSize(400);
  await wait(INTERVAL * 2);
  a.handle.unsubscribe();
  assert.match(a.frames.at(-1), /@400$/);
});

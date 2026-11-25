'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWatch, parseProbe, MAX_RESTARTS } = require('../src/lib/androidRestartWatch');

const inst = { id: 'i1', name: 'retrato', containerId: 'c1' };

function harness({ startedAt = 'S1' } = {}) {
  const state = { out: '1\n100\n', startedAt, running: true, restarts: 0, recorded: [], t: 0, failRestart: false };
  const watch = createWatch({
    listRunning: async () => (state.running ? [{ instance: inst, startedAt: state.startedAt }] : []),
    restart: async () => {
      if (state.failRestart) throw new Error('boom');
      state.restarts += 1;
    },
    onRestarted: (i, at) => state.recorded.push(at),
    probe: async () => {
      if (state.out instanceof Error) throw state.out;
      return state.out;
    },
    now: () => state.t,
    log: () => {},
  });
  return { state, watch };
}

test('parseProbe reads boot flag and pid', () => {
  assert.deepEqual(parseProbe('1\n1234\n'), { booted: true, pid: '1234' });
  assert.deepEqual(parseProbe('\n'), { booted: false, pid: null });
  assert.deepEqual(parseProbe('0\n'), { booted: false, pid: null });
});

test('same system_server pid: nothing happens', async () => {
  const { state, watch } = harness();
  await watch.tick();
  await watch.tick();
  assert.equal(state.restarts, 0);
});

test('a new system_server pid in the same container start restarts the instance', async () => {
  const { state, watch } = harness();
  await watch.tick();
  state.out = '1\n200\n';
  await watch.tick();
  assert.equal(state.restarts, 1);
  assert.equal(state.recorded.length, 1);
});

test('a new container start only sets a new baseline', async () => {
  const { state, watch } = harness();
  await watch.tick();
  state.startedAt = 'S2';
  state.out = '1\n300\n';
  await watch.tick();
  assert.equal(state.restarts, 0);
});

test('not booted yet, or probe failing, never counts as a restart', async () => {
  const { state, watch } = harness();
  await watch.tick();
  state.out = '0\n';
  await watch.tick();
  state.out = new Error('container is not running');
  await watch.tick();
  state.out = '1\n100\n';
  await watch.tick();
  assert.equal(state.restarts, 0);
});

test(`gives up after ${MAX_RESTARTS} restarts in an hour`, async () => {
  const { state, watch } = harness();
  let pid = 100;
  let started = 1;
  await watch.tick();
  for (let i = 0; i < MAX_RESTARTS + 2; i++) {
    state.t += 60 * 1000;
    state.out = `1\n${++pid}\n`;
    await watch.tick(); // detects the crash
    state.startedAt = `S${++started}`; // our restart = a new container start
    await watch.tick(); // new baseline
  }
  assert.equal(state.restarts, MAX_RESTARTS);
});

test('a failed restart is not retried for the same event', async () => {
  const { state, watch } = harness();
  await watch.tick();
  state.failRestart = true;
  state.out = '1\n200\n';
  await watch.tick();
  await watch.tick();
  assert.equal(state.restarts, 0);
  assert.equal(state.recorded.length, 0);
});

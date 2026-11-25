// routes/viewer.js: a live preview is only opened against a running container (1.0.0-rc.5).
const test = require('node:test');
const assert = require('node:assert/strict');

const { isContainerRunning } = require('../src/routes/viewer');

test('running container -> true', async () => {
  assert.equal(await isContainerRunning({ containerId: 'c1' }, async () => ({ State: { Status: 'running' } })), true);
});

test('stopped (exited) container -> false', async () => {
  assert.equal(await isContainerRunning({ containerId: 'c1' }, async () => ({ State: { Status: 'exited' } })), false);
});

test('container gone (inspect throws) -> false, never throws', async () => {
  assert.equal(await isContainerRunning({ containerId: 'c1' }, async () => { throw new Error('no such container'); }), false);
});

test('no instance or no containerId -> false without inspecting', async () => {
  let called = false;
  const inspect = async () => { called = true; return { State: { Status: 'running' } }; };
  assert.equal(await isContainerRunning(undefined, inspect), false);
  assert.equal(await isContainerRunning({}, inspect), false);
  assert.equal(called, false);
});

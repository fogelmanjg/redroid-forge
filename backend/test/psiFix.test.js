// psiFix.js: the .rc that binds the instance's own cgroup memory.pressure over /proc/pressure/memory.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const psiFix = require('../src/lib/psiFix');

test('the .rc binds the cgroup memory.pressure over /proc/pressure/memory at post-fs-data', () => {
  const rc = fs.readFileSync(psiFix.RC_SOURCE, 'utf8');
  assert.match(rc, /^on post-fs-data$/m);
  assert.match(rc, /^\s+mount none \/sys\/fs\/cgroup\/memory\.pressure \/proc\/pressure\/memory bind$/m);
});

test('ensure copies the .rc into /vendor/etc/init', async () => {
  const puts = [];
  await psiFix.ensure({ name: 'x', containerId: 'abc' }, { copyIn: async (content, dest) => puts.push({ content, dest }) });
  assert.equal(puts.length, 1);
  assert.equal(puts[0].dest, '/vendor/etc/init/redroid-forge-psi.rc');
  assert.match(puts[0].content, /memory\.pressure/);
});

test('ensure never throws: a failed copy only warns', async () => {
  await psiFix.ensure({ name: 'x', containerId: 'abc' }, { copyIn: async () => { throw new Error('docker cp failed'); } });
});

test('ensure without a container does nothing', async () => {
  let called = false;
  await psiFix.ensure({ name: 'x' }, { copyIn: async () => { called = true; } });
  assert.equal(called, false);
});

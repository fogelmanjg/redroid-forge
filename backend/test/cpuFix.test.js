'use strict';

const test = require('node:test');
const assert = require('node:assert');
const cpuFix = require('../src/lib/cpuFix');

test('toCpuList: Docker cpuset -> kernel cpulist', () => {
  assert.strictEqual(cpuFix.toCpuList('6,7,14,15'), '6-7,14-15');
  assert.strictEqual(cpuFix.toCpuList('0-3'), '0-3');
  assert.strictEqual(cpuFix.toCpuList('3,1,2,8'), '1-3,8');
  assert.strictEqual(cpuFix.toCpuList('6,14'), '6,14');
  assert.throws(() => cpuFix.toCpuList('a,b'));
});

test('cpuListFor: the cpuset when pinned, the host online list otherwise', () => {
  assert.strictEqual(cpuFix.cpuListFor({ cpusetCpus: '6,7,14,15' }), '6-7,14-15');
  assert.strictEqual(cpuFix.cpuListFor({ cpusetCpus: null }, { readHostOnline: () => '0-15\n' }), '0-15');
});

test('ensure copies the CPU list and the .rc, and never throws', async () => {
  const copies = [];
  await cpuFix.ensure({ name: 'cifi-nuevo', containerId: 'c1', cpusetCpus: '6,7,14,15' },
    { copyIn: async (content, dest) => copies.push([dest, content]) });
  assert.deepStrictEqual(copies[0], [cpuFix.LIST_TARGET, '6-7,14-15\n']);
  assert.strictEqual(copies[1][0], cpuFix.RC_TARGET);
  assert.match(copies[1][1], /mount none \/vendor\/etc\/redroid-forge-cpus \/sys\/devices\/system\/cpu\/possible bind/);
  await assert.doesNotReject(cpuFix.ensure({ name: 'x', containerId: 'c2', cpusetCpus: '1' },
    { copyIn: async () => { throw new Error('docker cp failed'); } }));
  await cpuFix.ensure({ name: 'no container' }, { copyIn: async () => copies.push('no') });
  assert.strictEqual(copies.length, 2);
});


// applyLive (1.0.0-rc.5): a live cpuset change rewrites the list in place so Android sees it now.
test('applyLive: bind present -> rewrites the list in place, returns "now"', async () => {
  const calls = [];
  const exec = async (id, cmd) => { calls.push({ id, cmd }); return 'live\n'; };
  const r = await cpuFix.applyLive({ name: 'x', containerId: 'c1', cpusetCpus: '5,13' }, { exec });
  assert.equal(r, 'now');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].cmd.slice(0, 2), ['sh', '-c']);
  assert.match(calls[0].cmd[2], /grep -q ' \/sys\/devices\/system\/cpu\/online ' \/proc\/mounts/);
  assert.match(calls[0].cmd[2], /printf '%s\\n' '5,13' > \/vendor\/etc\/redroid-forge-cpus/);
});

test('applyLive: no bind (booted without the fix) -> "next-start"', async () => {
  const r = await cpuFix.applyLive({ name: 'x', containerId: 'c1', cpusetCpus: '4,12' }, { exec: async () => '' });
  assert.equal(r, 'next-start');
});

test('applyLive: exec fails (stopped) -> "next-start", never throws', async () => {
  const r = await cpuFix.applyLive({ name: 'x', containerId: 'c1', cpusetCpus: '4,12' }, { exec: async () => { throw new Error('not running'); } });
  assert.equal(r, 'next-start');
});

test('applyLive: a bad cpuset never reaches the shell', async () => {
  let called = false;
  const r = await cpuFix.applyLive({ name: 'x', containerId: 'c1', cpusetCpus: "1;rm -rf /" }, { exec: async () => { called = true; return 'live'; } });
  assert.equal(r, 'next-start');
  assert.equal(called, false);
});

// removedCpus (1.0.0-rc.5): cores a cpuset change takes away, for the "restart suggested" note.
test('removedCpus: swapping cores reports the ones taken away, even when others are added', () => {
  assert.deepStrictEqual(cpuFix.removedCpus('4,12', '5,13'), [4, 12]);
  assert.deepStrictEqual(cpuFix.removedCpus('6-7,14-15', '6,7'), [14, 15]);
});

test('removedCpus: only adding cores -> nothing removed', () => {
  assert.deepStrictEqual(cpuFix.removedCpus('5,13', '4,5,12,13'), []);
});

test('removedCpus: no old cpuset means every host core', () => {
  assert.deepStrictEqual(cpuFix.removedCpus(null, '0-1', { readHostOnline: () => '0-3\n' }), [2, 3]);
});

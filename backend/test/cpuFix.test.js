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


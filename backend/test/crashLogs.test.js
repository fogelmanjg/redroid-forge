'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crashLogs = require('../src/lib/crashLogs');
const { createWatch } = require('../src/lib/androidRestartWatch');

const H = 60 * 60 * 1000;
const D = 24 * H;

test('prune keeps the last 10, and everything from the last day', () => {
  const now = 100 * D;
  // 15 captures in the last day (a crash chain): none removed, the first one included
  const chain = Array.from({ length: 15 }, (_, i) => ({ name: `c${i}`, mtimeMs: now - (i + 1) * H }));
  assert.deepEqual(crashLogs.selectToPrune(chain, { now }), []);
  // 15 old captures: only the 10 newest stay
  const old = Array.from({ length: 15 }, (_, i) => ({ name: `o${i}`, mtimeMs: now - 2 * D - i * H }));
  assert.deepEqual(crashLogs.selectToPrune(old, { now }), ['o10', 'o11', 'o12', 'o13', 'o14']);
  // mixed: 12 recent keep, the old ones beyond position 10 go
  const mixed = [...chain.slice(0, 12), ...old.slice(0, 3)];
  assert.deepEqual(crashLogs.selectToPrune(mixed, { now }), ['o0', 'o1', 'o2']);
});

test('stamp sorts by time and has no colons', () => {
  assert.equal(crashLogs.stamp(Date.UTC(2026, 10, 26, 13, 43, 1, 500)), '2026-11-26T13-43-01Z');
});

test('capture saves info, logcat and recent tombstones (not .pb)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crashlogs-'));
  const calls = [];
  const exec = async (cid, argv) => {
    calls.push(argv.join(' '));
    if (argv[0] === 'logcat') return Buffer.from('F surfaceflinger: Failed to create a valid texture\n');
    if (argv[0] === 'find') return Buffer.from('/data/tombstones/tombstone_39\n/data/tombstones/tombstone_39.pb\n');
    if (argv[0] === 'cat') return Buffer.from(`contents of ${argv[1]}`);
    throw new Error('unexpected');
  };
  const inst = { id: 'abc', name: 'retrato', containerId: 'c1' };
  const target = await crashLogs.capture(inst, { 'system_server pid': '401 -> 40514' }, { dir, exec, now: Date.UTC(2026, 10, 26, 13, 43, 1), log: () => {} });
  assert.equal(target, path.join(dir, 'abc', '2026-11-26T13-43-01Z'));
  assert.match(fs.readFileSync(path.join(target, 'info.txt'), 'utf8'), /401 -> 40514/);
  assert.match(zlib.gunzipSync(fs.readFileSync(path.join(target, 'logcat.txt.gz'))).toString(), /valid texture/);
  assert.equal(fs.readFileSync(path.join(target, 'tombstone_39'), 'utf8'), 'contents of /data/tombstones/tombstone_39');
  assert.ok(!fs.existsSync(path.join(target, 'tombstone_39.pb')));
  assert.ok(calls.includes('logcat -d -b all -v threadtime'));
  crashLogs.cleanup('abc', { dir });
  assert.ok(!fs.existsSync(path.join(dir, 'abc')));
});

test('capture never throws, even when docker exec fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crashlogs-'));
  const exec = async () => { throw new Error('container gone'); };
  const target = await crashLogs.capture({ id: 'x', name: 'x', containerId: 'c' }, {}, { dir, exec, log: () => {} });
  assert.ok(fs.existsSync(path.join(target, 'logcat.error.txt')));
});

test('the watch saves the logs before restarting, and also when it gives up', async () => {
  const inst = { id: 'i1', name: 'retrato', containerId: 'c1' };
  const st = { out: '1\n100\n', t: 0, order: [] };
  const watch = createWatch({
    listRunning: async () => [{ instance: inst, startedAt: 'S1' }],
    restart: async () => { st.order.push('restart'); },
    beforeRestart: async (i, info) => { st.order.push(`save ${info['system_server pid']}`); },
    onBaseline: async () => { st.order.push('baseline'); },
    probe: async () => st.out,
    now: () => st.t,
    log: () => {},
  });
  await watch.tick();
  assert.deepEqual(st.order, ['baseline']);
  for (let i = 1; i <= 4; i++) {
    st.out = `1\n${100 + i}\n`;
    st.t += 60 * 1000;
    // eslint-disable-next-line no-await-in-loop
    await watch.tick();
  }
  // (the fake restart keeps the same container start, so the baseline pid stays 100)
  assert.deepEqual(st.order.map((x) => x.split(' ')[0]), [
    'baseline',
    'save', 'restart',
    'save', 'restart',
    'save', 'restart',
    'save', // gave up: no restart, but the logs are kept
  ]);
});

test('a failing save does not stop the restart', async () => {
  const inst = { id: 'i1', name: 'r', containerId: 'c1' };
  let out = '1\n1\n';
  let restarts = 0;
  const watch = createWatch({
    listRunning: async () => [{ instance: inst, startedAt: 'S1' }],
    restart: async () => { restarts += 1; },
    beforeRestart: async () => { throw new Error('disk full'); },
    probe: async () => out,
    log: () => {},
  });
  await watch.tick();
  out = '1\n2\n';
  await watch.tick();
  assert.equal(restarts, 1);
});

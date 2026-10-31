'use strict';

// Coverage for the /proc/meminfo cgroup-visibility workaround (see the file comment in
// meminfoFix.js and the memory note it links to). store.js has no test-root override (same
// caveat as moduleScheduler.test.js) -- get/upsert/remove are mocked with an in-memory map for
// the duration of each test instead of touching the real backend/data/instances.json.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meminfo-fix-data-'));
const cgroupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'meminfo-fix-cgroup-'));
process.env.REDROID_FORGE_MEMINFO_FIX_DIR = dataDir;
process.env.REDROID_FORGE_CGROUP_ROOT = cgroupRoot;

// eslint-disable-next-line global-require -- the env vars above must be set before this loads.
const meminfoFix = require('../src/lib/meminfoFix');
// eslint-disable-next-line global-require
const store = require('../src/lib/store');
// eslint-disable-next-line global-require
const runtime = require('../src/lib/dockerRuntime');

function withMockExec(impl, fn) {
  const restore = runtime.exec;
  runtime.exec = impl;
  return Promise.resolve(fn()).finally(() => { runtime.exec = restore; });
}

function withFakeStore(fn) {
  const fakeStore = new Map();
  const getRestore = store.get;
  const upsertRestore = store.upsert;
  const removeRestore = store.remove;
  store.get = (id) => fakeStore.get(id);
  store.upsert = (instance) => { fakeStore.set(instance.id, instance); return instance; };
  store.remove = (id) => fakeStore.delete(id);
  try {
    return fn(fakeStore);
  } finally {
    store.get = getRestore;
    store.upsert = upsertRestore;
    store.remove = removeRestore;
  }
}

test('render clamps so free+cached never exceeds total, and MemAvailable is their sum', () => {
  const out = meminfoFix.render({ totalKb: 4096 * 1024, freeKb: 1000 * 1024, cachedKb: 500 * 1024 });
  assert.match(out, /MemTotal:\s+4194304 kB/);
  assert.match(out, /MemFree:\s+1024000 kB/);
  assert.match(out, /Cached:\s+512000 kB/);
  assert.match(out, /MemAvailable:\s+1536000 kB/);
});

test('render clamps an over-budget cached value instead of reporting more than total', () => {
  const out = meminfoFix.render({ totalKb: 1000, freeKb: 900, cachedKb: 900 });
  assert.match(out, /MemFree:\s+900 kB/);
  assert.match(out, /Cached:\s+100 kB/); // clamped to totalKb - freeKb, not the full 900
  assert.match(out, /MemAvailable:\s+1000 kB/);
});

test('render never goes negative on a momentarily inconsistent read', () => {
  const out = meminfoFix.render({ totalKb: 1000, freeKb: -50, cachedKb: 10 });
  assert.match(out, /MemFree:\s+0 kB/);
});

test('prepareBinds returns nothing for an instance with no memory cap', () => {
  assert.deepStrictEqual(meminfoFix.prepareBinds('no-cap-instance', null), []);
  assert.deepStrictEqual(meminfoFix.prepareBinds('no-cap-instance', undefined), []);
  assert.deepStrictEqual(meminfoFix.prepareBinds('no-cap-instance', 0), []);
});

test('prepareBinds writes the host file sized to the cap and binds it onto the stable in-container path', () => {
  const binds = meminfoFix.prepareBinds('capped-instance', 4096);
  assert.strictEqual(binds.length, 1);
  const [bind] = binds;
  // NOT bound directly onto /proc/meminfo -- see the file comment on why that bind alone gets
  // shadowed by Android's own boot-time /proc remount.
  assert.strictEqual(bind, `${meminfoFix.hostFilePath('capped-instance')}:${meminfoFix.IN_CONTAINER_SRC}`);
  const content = fs.readFileSync(meminfoFix.hostFilePath('capped-instance'), 'utf8');
  assert.match(content, /MemTotal:\s+4194304 kB/);
  assert.match(content, /MemFree:\s+4194304 kB/); // a brand-new container: nothing used yet
});

test('cgroupPath finds the systemd-driver layout, then the cgroupfs one, then neither', () => {
  const systemdDir = path.join(cgroupRoot, 'system.slice', 'docker-abc123.scope');
  fs.mkdirSync(systemdDir, { recursive: true });
  assert.strictEqual(meminfoFix.cgroupPath('abc123'), systemdDir);

  const cgroupfsDir = path.join(cgroupRoot, 'docker', 'def456');
  fs.mkdirSync(cgroupfsDir, { recursive: true });
  assert.strictEqual(meminfoFix.cgroupPath('def456'), cgroupfsDir);

  assert.strictEqual(meminfoFix.cgroupPath('does-not-exist'), null);
});

test("refresh reads the container's real cgroup usage and rewrites the host file", () => {
  withFakeStore(() => {
    const containerId = 'refresh-container';
    const cg = path.join(cgroupRoot, 'docker', containerId);
    fs.mkdirSync(cg, { recursive: true });
    fs.writeFileSync(path.join(cg, 'memory.current'), '1073741824\n'); // 1 GiB used
    fs.writeFileSync(path.join(cg, 'memory.stat'), 'anon 536870912\nfile 268435456\nkernel_stack 1000\n');

    const instance = { id: 'inst-1', name: 'refresh-instance', volumeName: 'redroid-forge-refresh-instance', memoryMb: 4096, containerId };
    store.upsert(instance);
    meminfoFix.prepareBinds(instance.volumeName, instance.memoryMb);

    meminfoFix.refresh(instance.id);

    const content = fs.readFileSync(meminfoFix.hostFilePath(instance.volumeName), 'utf8');
    assert.match(content, /MemTotal:\s+4194304 kB/);
    assert.match(content, /MemFree:\s+3145728 kB/); // 4096MB - 1GB used, in kB
    assert.match(content, /Cached:\s+262144 kB/); // the "file" line of memory.stat, in kB
  });
});

test('refresh is a no-op for an instance with no cap, no container, or an unknown cgroup', () => {
  withFakeStore(() => {
    assert.doesNotThrow(() => meminfoFix.refresh('no-such-instance'));

    store.upsert({ id: 'inst-2', name: 'uncapped', memoryMb: null, containerId: 'whatever' });
    assert.doesNotThrow(() => meminfoFix.refresh('inst-2'));

    store.upsert({ id: 'inst-3', name: 'gone', memoryMb: 2048, containerId: 'no-cgroup-for-this-one' });
    assert.doesNotThrow(() => meminfoFix.refresh('inst-3'));
  });
});

test('scheduleRefresh/release never throw and are idempotent to call repeatedly', () => {
  const instance = { id: 'inst-4', name: 'sched-test', memoryMb: null, containerId: null };
  meminfoFix.scheduleRefresh(instance);
  meminfoFix.scheduleRefresh(instance);
  meminfoFix.release(instance.id);
  meminfoFix.release(instance.id); // releasing twice must not throw
});

test('bindOnce runs the bind-mount command and succeeds on the first try', () => withMockExec(
  async (containerId, cmd) => {
    assert.strictEqual(containerId, 'c1');
    assert.deepStrictEqual(cmd, ['mount', '--bind', meminfoFix.IN_CONTAINER_SRC, '/proc/meminfo']);
    return '';
  },
  async () => {
    const ok = await meminfoFix.bindOnce('c1', { retries: 3, delayMs: 1 });
    assert.strictEqual(ok, true);
  },
));

test('bindOnce retries while the container is not ready yet, then succeeds', () => {
  let calls = 0;
  return withMockExec(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error('container not ready');
      return '';
    },
    async () => {
      const ok = await meminfoFix.bindOnce('c2', { retries: 5, delayMs: 1 });
      assert.strictEqual(ok, true);
      assert.strictEqual(calls, 3);
    },
  );
});

test('bindOnce gives up after exhausting its retries', () => withMockExec(
  async () => { throw new Error('always fails'); },
  async () => {
    const ok = await meminfoFix.bindOnce('c3', { retries: 3, delayMs: 1 });
    assert.strictEqual(ok, false);
  },
));

test('scheduleBindMount is a no-op for an instance with no memory cap (never execs)', () => withMockExec(
  async () => { throw new Error('exec must not be called'); },
  () => {
    assert.doesNotThrow(() => meminfoFix.scheduleBindMount({ id: 'x', memoryMb: null, containerId: 'c4' }));
  },
));

// Regression (30/10/2026): renaming an instance (routes/instances.js's PUT /:id/name) used to
// also rename this module's on-disk directory to match the new `name`, reasoning that a bind
// mount follows the inode, not the path -- true only while that exact mount stays continuously
// active. The container's HostConfig.Binds is a path STRING frozen at create time; the next time
// Docker has to (re)mount it (any stop/restart after the rename), it re-resolves that frozen old
// path, finds nothing there any more, and silently creates a DIRECTORY in its place -- which then
// fails to bind-mount onto a file target and the container can never start again. Found for real
// on a live instance. Fixed by keying everything off volumeName (immutable once set at creation,
// never re-derived from the renamable `name`) instead, so a rename has nothing to keep in sync.
test("prepareBinds/hostFilePath are keyed by volumeName, which an instance rename never touches -- renaming `name` alone can't orphan the bind", () => {
  const instance = { id: 'inst-5', name: 'original-name', volumeName: 'redroid-forge-original-name', memoryMb: 2048, containerId: null };
  meminfoFix.prepareBinds(instance.volumeName, instance.memoryMb);
  const fileBeforeRename = meminfoFix.hostFilePath(instance.volumeName);
  assert.ok(fs.existsSync(fileBeforeRename));

  // Simulate the rename route: only `name` changes, volumeName (and therefore every meminfoFix
  // path) stays exactly as it was -- nothing here needs renaming or moving.
  const renamed = { ...instance, name: 'renamed-name' };
  assert.strictEqual(meminfoFix.hostFilePath(renamed.volumeName), fileBeforeRename);
  assert.ok(fs.existsSync(meminfoFix.hostFilePath(renamed.volumeName)), 'still the same file, nothing moved');
});

test("cleanup removes the instance's generated directory", () => {
  meminfoFix.prepareBinds('to-delete', 2048);
  assert.ok(fs.existsSync(meminfoFix.hostFilePath('to-delete')));
  meminfoFix.cleanup('to-delete');
  assert.ok(!fs.existsSync(path.dirname(meminfoFix.hostFilePath('to-delete'))));
});

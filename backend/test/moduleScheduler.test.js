// Coverage of the periodic-watchdog scheduler (Phase 5, stage 7 -- see
// docs/ROADMAP.md and moduleRunner.js). Uses node:test's fake timers so the
// tests run instantly instead of waiting on real intervals, and mocks store.js
// (get/upsert) with an in-memory map instead of touching the real data file --
// store.js has no test-root override like moduleManifests does, and pause
// state needs *some* persistence layer to assert against.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const manifests = require('../src/lib/moduleManifests');
const moduleRunner = require('../src/lib/moduleRunner');
const scheduler = require('../src/lib/moduleScheduler');
const store = require('../src/lib/store');

function watchdogManifestFields(id, intervalMs) {
  return {
    id,
    nombre: `Fixture ${id}`,
    descripcion: 'A test watchdog module, not a real module of the project.',
    esTerceroNoLibre: false,
    queToca: ['nothing, it is a test fixture'],
    compatibleCon: { androidVersion: [15], gpuMode: ['host'] },
    version: 1,
    etapa: [7],
    entry: './entry.js',
    schedule: { intervalMs },
  };
}

// Same shape as moduleRunner.test.js's withFixtureModules, narrowed to
// stage-7 fixtures and with the in-memory store mocked for the duration.
function withWatchdogFixture({ id = 'fx-wd', intervalMs = 60_000, entryBody }, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-modulescheduler-'));
  fs.mkdirSync(path.join(root, 'manifests'));
  const dir = path.join(root, id);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(watchdogManifestFields(id, intervalMs), null, 2));
  fs.writeFileSync(path.join(dir, 'entry.js'), entryBody);
  manifests._setModulesRootForTests(root);
  moduleRunner._resetForTests();

  const fakeStore = new Map();
  const getMock = (instanceId) => fakeStore.get(instanceId);
  const upsertMock = (instance) => { fakeStore.set(instance.id, instance); return instance; };
  const getRestore = store.get;
  const upsertRestore = store.upsert;
  store.get = getMock;
  store.upsert = upsertMock;

  return Promise.resolve(fn({ root, id, fakeStore })).finally(() => {
    store.get = getRestore;
    store.upsert = upsertRestore;
    scheduler._resetForTests();
    manifests._setModulesRootForTests(null);
    moduleRunner._resetForTests();
  });
}

function requireFixtureEntry(root, id) {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(path.join(root, id, 'entry.js'));
}

test('moduleScheduler.start: ticks the module once per intervalMs, with (instanceId, containerId)', (t) => withWatchdogFixture({
  intervalMs: 1000,
  entryBody: `
    module.exports.calls = [];
    module.exports.runTick = async (instanceId, containerId) => {
      module.exports.calls.push({ instanceId, containerId });
    };
  `,
}, async ({ root, id, fakeStore }) => {
  fakeStore.set('inst-1', { id: 'inst-1' });
  t.mock.timers.enable({ apis: ['setInterval'] });

  scheduler.start('inst-1', 'container-1', [id]);
  assert.deepEqual(requireFixtureEntry(root, id).calls, []); // nothing yet, intervalMs hasn't elapsed

  t.mock.timers.tick(1000);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(requireFixtureEntry(root, id).calls, [{ instanceId: 'inst-1', containerId: 'container-1' }]);

  t.mock.timers.tick(1000);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(requireFixtureEntry(root, id).calls.length, 2);
}));

test('moduleScheduler.start: calling it again for the same instance+module does not double-schedule', (t) => withWatchdogFixture({
  intervalMs: 1000,
  entryBody: `
    module.exports.calls = [];
    module.exports.runTick = async () => { module.exports.calls.push(1); };
  `,
}, async ({ root, id, fakeStore }) => {
  fakeStore.set('inst-1', { id: 'inst-1' });
  t.mock.timers.enable({ apis: ['setInterval'] });

  scheduler.start('inst-1', 'container-1', [id]);
  scheduler.start('inst-1', 'container-1', [id]); // e.g. create() then an immediate start() racing it

  t.mock.timers.tick(1000);
  await new Promise((r) => setTimeout(r, 0));
  // One timer, not two -- otherwise this would be 2.
  assert.equal(requireFixtureEntry(root, id).calls.length, 1);
}));

test('moduleScheduler.pause: the timer keeps firing but the module is not actually invoked while paused', (t) => withWatchdogFixture({
  intervalMs: 1000,
  entryBody: `
    module.exports.calls = [];
    module.exports.runTick = async () => { module.exports.calls.push(1); };
  `,
}, async ({ root, id, fakeStore }) => {
  fakeStore.set('inst-1', { id: 'inst-1' });
  t.mock.timers.enable({ apis: ['setInterval'] });

  scheduler.start('inst-1', 'container-1', [id]);
  scheduler.pause('inst-1', id);

  t.mock.timers.tick(1000);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(requireFixtureEntry(root, id).calls, []); // skipped, not run

  scheduler.resume('inst-1', id);
  t.mock.timers.tick(1000);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(requireFixtureEntry(root, id).calls.length, 1);
}));

test('moduleScheduler.stop: clears the timer, no more ticks after it', (t) => withWatchdogFixture({
  intervalMs: 1000,
  entryBody: `
    module.exports.calls = [];
    module.exports.runTick = async () => { module.exports.calls.push(1); };
  `,
}, async ({ root, id, fakeStore }) => {
  fakeStore.set('inst-1', { id: 'inst-1' });
  t.mock.timers.enable({ apis: ['setInterval'] });

  scheduler.start('inst-1', 'container-1', [id]);
  t.mock.timers.tick(1000);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(requireFixtureEntry(root, id).calls.length, 1);

  scheduler.stop('inst-1');
  t.mock.timers.tick(5000);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(requireFixtureEntry(root, id).calls.length, 1); // unchanged
}));

test('moduleScheduler.status: reports running/paused/lastRunAt/lastOk, including for a module that is not currently scheduled', (t) => withWatchdogFixture({
  intervalMs: 1000,
  entryBody: `module.exports.runTick = async () => {};`,
}, async ({ id, fakeStore }) => {
  fakeStore.set('inst-1', { id: 'inst-1' });

  const beforeStart = scheduler.status('inst-1', [id]);
  assert.deepEqual(beforeStart, [{
    moduleId: id, intervalMs: 1000, running: false, paused: false, lastRunAt: null, lastOk: null, lastError: null,
  }]);

  t.mock.timers.enable({ apis: ['setInterval'] });
  scheduler.start('inst-1', 'container-1', [id]);
  t.mock.timers.tick(1000);
  await new Promise((r) => setTimeout(r, 0));

  const afterTick = scheduler.status('inst-1', [id])[0];
  assert.equal(afterTick.running, true);
  assert.equal(afterTick.paused, false);
  assert.equal(afterTick.lastOk, true);
  assert.ok(afterTick.lastRunAt);
}));

test('moduleScheduler.status: a module that throws is reported with lastOk=false and lastError, ticking continues', (t) => withWatchdogFixture({
  intervalMs: 1000,
  entryBody: "module.exports.runTick = async () => { throw new Error('boom'); };",
}, async ({ id, fakeStore }) => {
  fakeStore.set('inst-1', { id: 'inst-1' });
  t.mock.timers.enable({ apis: ['setInterval'] });

  scheduler.start('inst-1', 'container-1', [id]);
  t.mock.timers.tick(1000);
  await new Promise((r) => setTimeout(r, 0));
  let s = scheduler.status('inst-1', [id])[0];
  assert.equal(s.lastOk, false);
  assert.match(s.lastError, /boom/);

  t.mock.timers.tick(1000); // a failed tick must not cancel future ones
  await new Promise((r) => setTimeout(r, 0));
  s = scheduler.status('inst-1', [id])[0];
  assert.equal(s.lastOk, false); // still failing, but it DID run again
}));

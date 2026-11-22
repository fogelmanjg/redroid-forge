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

function watchdogManifestFields(id, intervalMs, startPaused) {
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
    schedule: startPaused === undefined ? { intervalMs } : { intervalMs, startPaused },
  };
}

// Same shape as moduleRunner.test.js's withFixtureModules, narrowed to
// stage-7 fixtures and with the in-memory store mocked for the duration.
function withWatchdogFixture({ id = 'fx-wd', intervalMs = 60_000, startPaused, entryBody }, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-modulescheduler-'));
  fs.mkdirSync(path.join(root, 'manifests'));
  const dir = path.join(root, id);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(watchdogManifestFields(id, intervalMs, startPaused), null, 2));
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

// 21/11/2026: a recreate (POST /:id/display) used to leave the timer on the deleted container.
test('moduleScheduler.start: a new containerId for an already-scheduled module replaces the stale timer', (t) => withWatchdogFixture({
  intervalMs: 1000,
  entryBody: `
    module.exports.calls = [];
    module.exports.runTick = async (instanceId, containerId) => { module.exports.calls.push(containerId); };
  `,
}, async ({ root, id, fakeStore }) => {
  fakeStore.set('inst-1', { id: 'inst-1' });
  t.mock.timers.enable({ apis: ['setInterval'] });

  scheduler.start('inst-1', 'old-container', [id]);
  scheduler.start('inst-1', 'new-container', [id]); // the instance was recreated, no stop() in between

  t.mock.timers.tick(1000);
  await new Promise((r) => setTimeout(r, 0));
  // Only the new container is ticked, and only once (the old timer is gone, not running alongside).
  assert.deepEqual(requireFixtureEntry(root, id).calls, ['new-container']);
}));

// 21/11/2026: every (re)scheduling restarts the watchdog from zero, even for the same container.
test('moduleScheduler.start: scheduling again restarts the timer from zero', (t) => withWatchdogFixture({
  intervalMs: 1000,
  entryBody: `
    module.exports.calls = [];
    module.exports.runTick = async () => { module.exports.calls.push(1); };
  `,
}, async ({ root, id, fakeStore }) => {
  fakeStore.set('inst-1', { id: 'inst-1' });
  t.mock.timers.enable({ apis: ['setInterval'] });

  scheduler.start('inst-1', 'container-1', [id]);
  t.mock.timers.tick(900);              // almost a full interval into the first cycle...
  scheduler.start('inst-1', 'container-1', [id]); // ...the instance is started again
  t.mock.timers.tick(200);              // 1100 ms since the first start, 200 since the second
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(requireFixtureEntry(root, id).calls.length, 0, 'the old cycle must not fire');
  t.mock.timers.tick(800);              // a full interval since the second start
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(requireFixtureEntry(root, id).calls.length, 1);
}));

// 21/11/2026: turning a watchdog on from the UI.
test('moduleScheduler.resumeNow: resumes, runs one pass right away and restarts the timer from zero', (t) => withWatchdogFixture({
  intervalMs: 1000,
  entryBody: `
    module.exports.calls = [];
    module.exports.runTick = async () => { module.exports.calls.push(1); };
  `,
}, async ({ root, id, fakeStore }) => {
  fakeStore.set('inst-1', { id: 'inst-1', watchdogPaused: { [id]: true } });
  t.mock.timers.enable({ apis: ['setInterval'] });
  scheduler.start('inst-1', 'container-1', [id]);
  t.mock.timers.tick(900);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(requireFixtureEntry(root, id).calls.length, 0, 'paused: nothing ran');

  assert.equal(scheduler.resumeNow('inst-1', id), true);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(requireFixtureEntry(root, id).calls.length, 1, 'one immediate pass');
  assert.equal(fakeStore.get('inst-1').watchdogPaused[id], false, 'stored as an explicit false, not a deleted key');

  t.mock.timers.tick(200); // 1100 ms since start(), only 200 since resumeNow()
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(requireFixtureEntry(root, id).calls.length, 1, 'the old cycle is gone');
  t.mock.timers.tick(800);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(requireFixtureEntry(root, id).calls.length, 2, 'next pass one full interval after turning on');
}));

test('moduleScheduler.resumeNow: an instance that is not running just gets the resume persisted', (t) => withWatchdogFixture({
  intervalMs: 1000,
  entryBody: 'module.exports.runTick = async () => {};',
}, async ({ id, fakeStore }) => {
  fakeStore.set('inst-2', { id: 'inst-2', watchdogPaused: { [id]: true } });
  assert.equal(scheduler.resumeNow('inst-2', id), false);
  assert.equal(fakeStore.get('inst-2').watchdogPaused[id], false);
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

test('defaultPauseForNewModules: a watchdog module the instance never had before starts paused', (t) => withWatchdogFixture({
  entryBody: 'module.exports.runTick = async () => {};',
}, ({ id }) => {
  assert.deepEqual(scheduler.defaultPauseForNewModules(null, [id]), { [id]: true });
  assert.deepEqual(scheduler.defaultPauseForNewModules({}, [id]), { [id]: true });
}));

test('defaultPauseForNewModules: a module with schedule.startPaused=false opts out of the safe default and starts active', (t) => withWatchdogFixture({
  startPaused: false,
  entryBody: 'module.exports.runTick = async () => {};',
}, ({ id }) => {
  assert.deepEqual(scheduler.defaultPauseForNewModules(null, [id]), { [id]: false });
  assert.deepEqual(scheduler.defaultPauseForNewModules({}, [id]), { [id]: false });
}));

test('defaultPauseForNewModules: schedule.startPaused=false still yields to an existing explicit state (does not force it back active)', (t) => withWatchdogFixture({
  startPaused: false,
  entryBody: 'module.exports.runTick = async () => {};',
}, ({ id }) => {
  assert.deepEqual(scheduler.defaultPauseForNewModules({ [id]: true }, [id]), { [id]: true });
}));

test('defaultPauseForNewModules: a module already in existingPaused keeps its own state, paused or not', (t) => withWatchdogFixture({
  entryBody: 'module.exports.runTick = async () => {};',
}, ({ id }) => {
  assert.deepEqual(scheduler.defaultPauseForNewModules({ [id]: false }, [id]), { [id]: false });
  assert.deepEqual(scheduler.defaultPauseForNewModules({ [id]: true }, [id]), { [id]: true });
}));

test('defaultPauseForNewModules: merges with unrelated existing keys instead of replacing them', (t) => withWatchdogFixture({
  entryBody: 'module.exports.runTick = async () => {};',
}, ({ id }) => {
  assert.deepEqual(
    scheduler.defaultPauseForNewModules({ 'some-other-module': true }, [id]),
    { 'some-other-module': true, [id]: true },
  );
}));

test('defaultPauseForNewModules: a non-watchdog module id is simply ignored, nothing is seeded for it', () => {
  assert.deepEqual(scheduler.defaultPauseForNewModules(null, ['not-a-watchdog-module']), {});
});

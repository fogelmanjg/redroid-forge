// Coverage of the generic module runner (Phase 5, see docs/ROADMAP.md and
// docs/ARCHITECTURE.md). It does not start Docker or a real redroid -- the test
// modules are pure fixtures (no child_process/dockerode) that only note that they
// were called and with which arguments, to verify the point of the lifecycle at
// which the runner invokes them. The only contact with a real module is a smoke
// test of hwenc's stage 3 (see below), chosen because it is the only function of
// that module that does not touch child_process/docker.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const manifests = require('../src/lib/moduleManifests');
const moduleRunner = require('../src/lib/moduleRunner');

function baseManifestFields(id, etapa) {
  return {
    id,
    nombre: `Fixture ${id}`,
    descripcion: 'A test module, not a real module of the project.',
    esTerceroNoLibre: false,
    queToca: ['nothing, it is a test fixture'],
    compatibleCon: { androidVersion: [15], gpuMode: ['host'] },
    version: 1,
    etapa,
    entry: './entry.js',
  };
}

// Builds `<root>/manifests/` (empty, but it has to exist -- loadAll() reads it
// without checking whether it is empty) plus `<root>/<id>/{manifest.json,entry.js}`
// for every requested fixture, and leaves moduleManifests pointing at that root
// while `fn` runs. `fixtures` is an array of { id, etapa, entryBody }.
// NOTE: `fn` is async -- a plain `try { return fn(root); } finally { ... }`
// fires the `finally` as soon as `fn(root)` returns the promise (synchronously),
// not when that promise resolves, and the cleanup would overwrite the fixtures'
// root while the test body is still running between awaits. That is why it is
// wrapped with Promise.resolve(...).finally(...) instead of try/finally.
function withFixtureModules(fixtures, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-modulerunner-'));
  fs.mkdirSync(path.join(root, 'manifests'));
  for (const { id, etapa, entryBody } of fixtures) {
    const dir = path.join(root, id);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(baseManifestFields(id, etapa), null, 2));
    fs.writeFileSync(path.join(dir, 'entry.js'), entryBody);
  }
  manifests._setModulesRootForTests(root);
  moduleRunner._resetForTests();
  return Promise.resolve(fn(root)).finally(() => {
    manifests._setModulesRootForTests(null);
    moduleRunner._resetForTests();
  });
}

// Returns the same module object that moduleRunner already loaded (via
// require()) -- Node caches by resolved path, so asking for it again with the
// same absolute path gives the same instance, with the annotations (`calls`) the
// run left.
function requireFixtureEntry(root, id) {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(path.join(root, id, 'entry.js'));
}

test('moduleRunner.prepareCreate: calls prepareCreate() of every stage-3 module and gathers binds/cmd', () => withFixtureModules([
  {
    id: 'fx-binds',
    etapa: [3],
    entryBody: `
      module.exports.calls = [];
      module.exports.prepareCreate = () => {
        module.exports.calls.push('prepareCreate');
        return { binds: ['/host/a:/guest/a'], cmd: ['androidboot.fx=1'] };
      };
    `,
  },
  {
    id: 'fx-no-stage3',
    etapa: [4], // it does not take part in stage 3 -- prepareCreate should not call it
    entryBody: `
      module.exports.calls = [];
      module.exports.integrate = () => { module.exports.calls.push('integrate'); };
    `,
  },
], async (root) => {
  const result = await moduleRunner.prepareCreate(['fx-binds', 'fx-no-stage3']);
  assert.deepEqual(result, { binds: ['/host/a:/guest/a'], cmd: ['androidboot.fx=1'] });
  assert.deepEqual(requireFixtureEntry(root, 'fx-binds').calls, ['prepareCreate']);
  assert.deepEqual(requireFixtureEntry(root, 'fx-no-stage3').calls, []);
}));

test('moduleRunner.prepareCreate: a module that requires nothing at create breaks nothing', () => withFixtureModules([], async () => {
  const result = await moduleRunner.prepareCreate([]);
  assert.deepEqual(result, { binds: [], cmd: [] });
}));

test('moduleRunner.integrate: calls integrate(containerId) of stage 4 with the containerId, in order', () => withFixtureModules([
  {
    id: 'fx-a',
    etapa: [4],
    entryBody: `
      module.exports.calls = [];
      module.exports.integrate = async (containerId) => { module.exports.calls.push(['a', containerId]); };
    `,
  },
  {
    id: 'fx-b',
    etapa: [4],
    entryBody: `
      module.exports.calls = [];
      module.exports.integrate = async (containerId) => { module.exports.calls.push(['b', containerId]); };
    `,
  },
], async (root) => {
  await moduleRunner.integrate(['fx-a', 'fx-b'], 'container123');
  assert.deepEqual(requireFixtureEntry(root, 'fx-a').calls, [['a', 'container123']]);
  assert.deepEqual(requireFixtureEntry(root, 'fx-b').calls, [['b', 'container123']]);
}));

test('moduleRunner.integrate: if a module declares stage 4 but its entry does not export "integrate", it fails clearly', () => withFixtureModules([
  {
    id: 'fx-broken',
    etapa: [4],
    entryBody: 'module.exports = {};',
  },
], async () => {
  await assert.rejects(
    () => moduleRunner.integrate(['fx-broken'], 'container123'),
    /fx-broken.*stage 4.*does not export "integrate"/s,
  );
}));

test('moduleRunner.ensureHostInfraReady: calls the stage-5 hook with no arguments', () => withFixtureModules([
  {
    id: 'fx-infra',
    etapa: [5],
    entryBody: `
      module.exports.calls = [];
      module.exports.ensureHostInfraReady = async () => { module.exports.calls.push('ready'); };
    `,
  },
], async (root) => {
  await moduleRunner.ensureHostInfraReady(['fx-infra']);
  assert.deepEqual(requireFixtureEntry(root, 'fx-infra').calls, ['ready']);
}));

test('moduleRunner.scheduleRuntimeFixups: calls the stage-6 hook with the containerId, fire-and-forget', () => withFixtureModules([
  {
    id: 'fx-fixup',
    etapa: [6],
    entryBody: `
      module.exports.calls = [];
      module.exports.ensureRuntimeReady = async (containerId) => { module.exports.calls.push(containerId); };
    `,
  },
], async (root) => {
  moduleRunner.scheduleRuntimeFixups(['fx-fixup'], 'containerXYZ');
  // Fire-and-forget: the runner does not return a promise to wait on, so the
  // test yields control (a microtask) before verifying.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requireFixtureEntry(root, 'fx-fixup').calls, ['containerXYZ']);
}));

test('moduleRunner.scheduleRuntimeFixups: it does not bring the process down if the stage-6 hook rejects', () => withFixtureModules([
  {
    id: 'fx-fixup-fails',
    etapa: [6],
    entryBody: `
      module.exports.ensureRuntimeReady = async () => { throw new Error('boom'); };
    `,
  },
], async () => {
  assert.doesNotThrow(() => moduleRunner.scheduleRuntimeFixups(['fx-fixup-fails'], 'containerXYZ'));
  // Lets the rejection be processed (and "caught" by the internal .catch) before
  // the test ends -- if it were not caught, node --test would flag it as an
  // unhandledRejection.
  await new Promise((resolve) => setImmediate(resolve));
}));

test('moduleRunner.scheduleRuntimeFixups: if the module does not export the stage-6 hook, it warns but does not break', () => withFixtureModules([
  {
    id: 'fx-no-hook',
    etapa: [6],
    entryBody: 'module.exports = {};',
  },
], async () => {
  assert.doesNotThrow(() => moduleRunner.scheduleRuntimeFixups(['fx-no-hook'], 'containerXYZ'));
}));

// Unlike the tests above, these two use the REAL catalog of manifests
// (backend/src/modules/manifests/*.json + backend/src/modules/hwenc/) instead of
// a fixtures root -- the reset to the default root is forced at the beginning so
// as not to depend on the order in which node:test ran the previous tests of this
// file.
function withRealManifests(fn) {
  manifests._setModulesRootForTests(null);
  moduleRunner._resetForTests();
  return fn();
}

test('moduleRunner: a required module without an "entry" (the pure contract modules of Phase 4) takes part in no stage', () => withRealManifests(async () => {
  // magisk/wifi-falso (the existing flat manifests) declare no etapa/entry --
  // asking the runner to run their stages must not fail, it must simply do
  // nothing. (gapps stopped being one of them: it has its own folder and stages 4 and 6.)
  const createReq = await moduleRunner.prepareCreate(['magisk']);
  assert.deepEqual(createReq, { binds: [], cmd: [] });
  await assert.doesNotReject(() => moduleRunner.integrate(['magisk'], 'containerX'));
  await assert.doesNotReject(() => moduleRunner.ensureHostInfraReady(['magisk']));
  assert.doesNotThrow(() => moduleRunner.scheduleRuntimeFixups(['magisk'], 'containerX'));
}));

// Smoke test against the REAL hwenc module (not a fixture) -- the only function
// of that module that does not touch child_process/docker, so it is safe to call
// as is in a unit test (see docs/ROADMAP.md). It covers that the convention of
// resolving "entry" relative to the module's folder (moduleManifests.moduleDir())
// effectively finds and loads backend/src/modules/hwenc/integrate.js.
test('moduleRunner.prepareCreate: real hwenc module, stage 3 (the only hook without child_process/docker)', () => withRealManifests(async () => {
  const hwAccel = require('../src/lib/hwAccel');
  const { REQUIRED_BOOT_FLAGS } = require('../src/modules/hwenc/integrate');
  const result = await moduleRunner.prepareCreate(['hwenc']);
  assert.deepEqual(result, { binds: [hwAccel.daemonBind()], cmd: REQUIRED_BOOT_FLAGS });
}));

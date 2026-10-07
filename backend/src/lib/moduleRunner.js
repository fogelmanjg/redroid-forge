const path = require('path');
const manifests = require('./moduleManifests');

// Generic orchestrator of modules with real execution logic (etapa/entry in
// their manifest, see docs/ARCHITECTURE.md) -- Phase 5, generalized from the
// only real case that existed (hwenc, wired by hand in instances.js). Unlike
// moduleGate.js (which only decides whether a module *can* be enabled:
// compatibility + consent), this file is the one that actually executes the
// module's code at the moment of the lifecycle that corresponds to it.
//
// Convention (also documented in docs/ARCHITECTURE.md): a module that declares
// "etapa": [...] (stage) in its manifest exposes, from the file it declares in
// "entry" (resolved relative to THE MODULE'S FOLDER, never to this file), a
// function with a fixed name for every stage that applies to it. The stages it
// does not declare need not be exported.
function log(msg) { console.log(`[moduleRunner] ${msg}`); }
function warn(msg) { console.warn(`[moduleRunner] ${msg}`); }

const STAGE_EXPORT_NAME = {
  // Stage 3: before runtime.create(). Sync or async, no arguments -- "what THIS
  // MODULE needs to be able to be created", not something specific to a
  // particular instance (width/height/dpi/etc. are still built by instances.js).
  // It returns `{ binds?: string[], cmd?: string[] }`, purely additive.
  3: 'prepareCreate',
  // Stage 4: between runtime.create() and runtime.start() -- the only window in
  // which /vendor is writable (see ARCHITECTURE.md). It receives the
  // containerId already created (still stopped), and a context
  // `{ display: { width, height } }`.
  4: 'integrate',
  // Stage 5: companion infrastructure on the host, independent of any particular
  // instance (e.g. the VA-API daemon of hwAccel.js). No arguments, idempotent by
  // the module's own contract.
  5: 'ensureHostInfraReady',
  // Stage 6: against an instance that has already started. It receives the live containerId.
  6: 'ensureRuntimeReady',
};

// `require()` cache per module id -- the same criterion as moduleManifests (the
// manifests/entries are static files of the repo, not user data).
// `_resetForTests()` clears it so a test can point to a new fixture under the
// same id without dragging along the require() of a previous run.
const entryCache = new Map();

function loadEntry(manifest) {
  if (entryCache.has(manifest.id)) return entryCache.get(manifest.id);
  const dir = manifests.moduleDir(manifest.id);
  if (!dir) {
    throw new Error(`Could not resolve the folder of module "${manifest.id}" to load its entry ("${manifest.entry}")`);
  }
  // eslint-disable-next-line global-require, import/no-dynamic-require -- the
  // path is dynamic by design: every module declares its own in its manifest.
  const entryModule = require(path.join(dir, manifest.entry));
  entryCache.set(manifest.id, entryModule);
  return entryModule;
}

// Modules, from the list of ids required by the image (see
// moduleGate.requiredModuleIdsForImage), that also declare "etapa"/"entry" --
// the "pure contract" modules (gapps/magisk/wifi-falso today, with no execution
// logic of their own yet) have no "entry", and it breaks nothing that they do
// not: they simply do not take part in any stage of this runner.
function modulesForStage(requiredModuleIds, stage) {
  return requiredModuleIds
    .map((id) => manifests.get(id))
    .filter((m) => m && Array.isArray(m.etapa) && m.etapa.includes(stage) && m.entry);
}

function requireStageFn(manifest, stage) {
  const entryModule = loadEntry(manifest);
  const exportName = STAGE_EXPORT_NAME[stage];
  const fn = entryModule[exportName];
  if (typeof fn !== 'function') {
    throw new Error(
      `Module "${manifest.id}" declares stage ${stage} in its manifest but its entry `
      + `("${manifest.entry}") does not export "${exportName}"`,
    );
  }
  return fn;
}

// Stage 3 -- called BEFORE runtime.create(). Serially (not Promise.all): the
// order in which several modules add binds/cmd can matter (e.g. boot flags that
// override each other), and there are too few modules for the cost of
// parallelizing to be worth it.
async function prepareCreate(requiredModuleIds) {
  const binds = [];
  const cmd = [];
  for (const manifest of modulesForStage(requiredModuleIds, 3)) {
    const fn = requireStageFn(manifest, 3);
    // eslint-disable-next-line no-await-in-loop
    const result = (await fn()) || {};
    if (Array.isArray(result.binds)) binds.push(...result.binds);
    if (Array.isArray(result.cmd)) cmd.push(...result.cmd);
  }
  return { binds, cmd };
}

// Stage 4 -- called AFTER runtime.create() and BEFORE runtime.start(). It is
// awaited serially and end to end: if a module fails, the next one is not run
// nor is start() reached -- better a half-injected create() that is visible in
// the error than a boot with half of the declared modules silently not applied.
async function integrate(requiredModuleIds, containerId, ctx = {}) {
  for (const manifest of modulesForStage(requiredModuleIds, 4)) {
    const fn = requireStageFn(manifest, 4);
    log(`stage 4: integrating module "${manifest.id}" into ${containerId}...`);
    // eslint-disable-next-line no-await-in-loop
    await fn(containerId, ctx);
  }
}

// Stage 5 -- host infrastructure, called before start/restart (the same moment
// at which instances.js already called hwAccel.ensureDaemonRunning by hand).
// Each module is responsible for making its own hook idempotent.
async function ensureHostInfraReady(requiredModuleIds) {
  for (const manifest of modulesForStage(requiredModuleIds, 5)) {
    const fn = requireStageFn(manifest, 5);
    // eslint-disable-next-line no-await-in-loop
    await fn();
  }
}

// Stage 6 -- post-boot fixups against an instance that has already started.
// Fire-and-forget on purpose, the same pattern as scheduleWifiFixes/hwsimWifi.js:
// it does not block the HTTP response of start/restart, and a module that fails
// here must not bring down the instance's startup (it is alive anyway, this is
// an adjustment on something that already works, not a precondition).
function scheduleRuntimeFixups(requiredModuleIds, containerId) {
  for (const manifest of modulesForStage(requiredModuleIds, 6)) {
    let fn;
    try {
      fn = requireStageFn(manifest, 6);
    } catch (e) {
      warn(e.message);
      // eslint-disable-next-line no-continue
      continue;
    }
    Promise.resolve(fn(containerId)).catch((e) => {
      warn(`stage 6 of module "${manifest.id}" failed for ${containerId}: ${e.message}`);
    });
  }
}

// Only for tests.
function _resetForTests() { entryCache.clear(); }

module.exports = {
  prepareCreate, integrate, ensureHostInfraReady, scheduleRuntimeFixups, _resetForTests,
};

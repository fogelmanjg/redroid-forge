const store = require('./store');
const moduleRunner = require('./moduleRunner');

// Pause state is PERSISTED on the instance record (store.js), not on an in-memory
// flag or a touch-file on disk like the cron script this replaces
// (cifi-watchdogctl.sh) -- it has to survive a backend restart the same way every
// other per-instance setting already does (deviceProfile, requiredModuleIds...).
// Everything else here (the timer itself, last-run bookkeeping) is runtime state:
// it does not need to survive a restart, the timer gets rebuilt from scratch the
// next time the instance starts anyway.
function log(msg) { console.log(`[moduleScheduler] ${msg}`); }

// instanceId -> Map<moduleId, { timer, containerId, intervalMs, lastRunAt, lastOk, lastError }>
const scheduled = new Map();

function isPaused(instanceId, moduleId) {
  const instance = store.get(instanceId);
  return !!(instance && instance.watchdogPaused && instance.watchdogPaused[moduleId]);
}

function setPaused(instanceId, moduleId, paused) {
  const instance = store.get(instanceId);
  if (!instance) throw Object.assign(new Error('Instance not found'), { httpStatus: 404 });
  const watchdogPaused = { ...(instance.watchdogPaused || {}) };
  if (paused) watchdogPaused[moduleId] = true;
  else delete watchdogPaused[moduleId];
  return store.upsert({ ...instance, watchdogPaused });
}

async function tick(instanceId, containerId, manifest, entry) {
  if (isPaused(instanceId, manifest.id)) return; // skip silently -- not an error, a deliberate pause
  const result = await moduleRunner.runTick(manifest, instanceId, containerId);
  entry.lastRunAt = new Date().toISOString();
  entry.lastOk = result.ok;
  entry.lastError = result.ok ? null : result.error;
}

// Schedules every stage-7 module this instance has (from its already-persisted
// requiredModuleIds, same source scheduleRuntimeFixups uses) -- idempotent: a
// module already scheduled for this instance is left alone (e.g. called again
// from both start() and a resume() that happens to race with it), only new ones
// get a timer. Called right after a container starts (same point as
// scheduleRuntimeFixups, stage 6) -- never awaited by the caller, scheduling
// itself is synchronous and the first tick only fires after intervalMs.
function start(instanceId, containerId, requiredModuleIds) {
  const modules = moduleRunner.watchdogModules(requiredModuleIds);
  if (modules.length === 0) return;
  let perInstance = scheduled.get(instanceId);
  if (!perInstance) {
    perInstance = new Map();
    scheduled.set(instanceId, perInstance);
  }
  for (const manifest of modules) {
    if (perInstance.has(manifest.id)) continue; // already scheduled, leave its timer running
    const entry = {
      containerId, intervalMs: manifest.schedule.intervalMs, lastRunAt: null, lastOk: null, lastError: null,
    };
    entry.timer = setInterval(() => {
      tick(instanceId, containerId, manifest, entry).catch((e) => {
        // tick() itself does not throw (moduleRunner.runTick already catches), this is
        // only a last-resort net for a bug in tick()'s own bookkeeping -- a module
        // misbehaving is already reflected in entry.lastError without reaching here.
        log(`unexpected error ticking "${manifest.id}" for ${instanceId}: ${e.message}`);
      });
    }, manifest.schedule.intervalMs);
    perInstance.set(manifest.id, entry);
    log(`scheduled "${manifest.id}" for ${instanceId} every ${manifest.schedule.intervalMs}ms`);
  }
}

// Clears every timer this instance has, regardless of module -- called on
// stop()/delete() (before the container actually stops, same as
// releaseHwsimPhys's reasoning: once the container is gone there is nothing
// left to tick against, and nothing guarantees exec() would fail fast against a
// stopped container rather than hang until a module's own timeout).
function stop(instanceId) {
  const perInstance = scheduled.get(instanceId);
  if (!perInstance) return;
  for (const entry of perInstance.values()) clearInterval(entry.timer);
  scheduled.delete(instanceId);
}

// Status of every stage-7 module this instance HAS (from requiredModuleIds), not
// only the ones currently scheduled -- a stopped instance still has its
// watchdogs declared, just not running, and the frontend needs to be able to
// show "paused"/"not running" either way rather than an empty list.
function status(instanceId, requiredModuleIds) {
  const perInstance = scheduled.get(instanceId);
  return moduleRunner.watchdogModules(requiredModuleIds).map((manifest) => {
    const entry = perInstance && perInstance.get(manifest.id);
    return {
      moduleId: manifest.id,
      intervalMs: manifest.schedule.intervalMs,
      running: !!entry,
      paused: isPaused(instanceId, manifest.id),
      lastRunAt: entry ? entry.lastRunAt : null,
      lastOk: entry ? entry.lastOk : null,
      lastError: entry ? entry.lastError : null,
    };
  });
}

function pause(instanceId, moduleId) { return setPaused(instanceId, moduleId, true); }
function resume(instanceId, moduleId) { return setPaused(instanceId, moduleId, false); }

// Only for tests.
function _resetForTests() { for (const id of Array.from(scheduled.keys())) stop(id); }

module.exports = { start, stop, status, pause, resume, isPaused, _resetForTests };

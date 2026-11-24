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
  // false, not a deleted key (21/11/2026): defaultPauseForNewModules treats a module with NO key
  // as "never seen", and would re-pause a watchdog the user had explicitly turned on the next
  // time the instance's modules were recomputed (e.g. any recreate through /display).
  watchdogPaused[moduleId] = !!paused;
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
// itself is synchronous; the first pass runs once Android has booted (see newEntry).
// First pass right after Android boots (1.0.0-rc.3), not one whole interval later: a watchdog that
// reopens a game (cifi, every 5 min) left it closed for those 5 minutes after every start or
// restart, for no reason. The scheduler waits for sys.boot_completed (polling, BOOT_POLL_MS, up
// to BOOT_WAIT_MAX_MS), gives the system FIRST_PASS_GRACE_MS to settle (launcher, Play services),
// runs one pass and restarts the interval from there. The plain interval stays armed meanwhile as
// a safety net, so a boot that never reports completed still gets its regular passes. An instance
// that is already running (reattached when this app restarts) is already booted: its first pass
// comes after the grace only.
const BOOT_POLL_MS = 3000;
const BOOT_WAIT_MAX_MS = 180_000;
const FIRST_PASS_GRACE_MS = 15_000;

async function defaultBootCheck(containerId) {
  // eslint-disable-next-line global-require -- lazy: the tests never touch Docker
  const runtime = require('./dockerRuntime');
  try {
    const out = await runtime.exec(containerId, ['getprop', 'sys.boot_completed'], 5000);
    // The raw exec stream carries Docker's frame header bytes too; an empty answer has no frame.
    return String(out || '').replace(/[\x00-\x08]/g, '').trim() === '1';
  } catch {
    return false;
  }
}
let bootCheck = defaultBootCheck;
let timing = { pollMs: BOOT_POLL_MS, maxMs: BOOT_WAIT_MAX_MS, graceMs: FIRST_PASS_GRACE_MS };

// unref'd: a pending wait never keeps the process (or a test run) alive.
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });

async function waitForBoot(containerId, isCancelled) {
  const deadline = Date.now() + timing.maxMs;
  while (!isCancelled() && Date.now() < deadline) {
    if (await bootCheck(containerId)) {
      await sleep(timing.graceMs);
      return !isCancelled();
    }
    await sleep(timing.pollMs);
  }
  return false;
}

function newEntry(instanceId, containerId, manifest, { firstPass = true } = {}) {
  const entry = {
    containerId, intervalMs: manifest.schedule.intervalMs, lastRunAt: null, lastOk: null, lastError: null,
    cancelled: false,
  };
  const arm = () => {
    entry.timer = setInterval(() => {
      tick(instanceId, containerId, manifest, entry).catch((e) => {
        log(`unexpected error ticking "${manifest.id}" for ${instanceId}: ${e.message}`);
      });
    }, manifest.schedule.intervalMs);
  };
  arm();
  if (firstPass) {
    waitForBoot(containerId, () => entry.cancelled).then((booted) => {
      if (!booted || entry.cancelled) return;
      clearInterval(entry.timer);
      arm();
      log(`"${manifest.id}" for ${instanceId}: Android booted, first pass now`);
      return tick(instanceId, containerId, manifest, entry);
    }).catch((e) => {
      log(`first pass of "${manifest.id}" for ${instanceId} failed unexpectedly: ${e.message}`);
    });
  }
  return entry;
}

function cancel(entry) {
  entry.cancelled = true;
  clearInterval(entry.timer);
}

function start(instanceId, containerId, requiredModuleIds) {
  const modules = moduleRunner.watchdogModules(requiredModuleIds);
  if (modules.length === 0) return;
  let perInstance = scheduled.get(instanceId);
  if (!perInstance) {
    perInstance = new Map();
    scheduled.set(instanceId, perInstance);
  }
  for (const manifest of modules) {
    // Every (re)scheduling starts the watchdog from zero (21/11/2026, asked by the user): a
    // fresh timer and fresh lastRunAt/lastOk/lastError on every start, restart, recreate and
    // backend boot -- never "keep the old timer" (that used to be the rule, and it is how a
    // recreated instance kept ticking against its deleted container). One timer per module
    // either way: the previous one is cleared first. The pause state is NOT reset -- it is the
    // instance's own persisted choice (instance.watchdogPaused), not part of the timer.
    const existing = perInstance.get(manifest.id);
    if (existing) {
      cancel(existing);
      if (existing.containerId !== containerId) {
        log(`"${manifest.id}" for ${instanceId} was scheduled against container ${String(existing.containerId).slice(0, 12)}; rescheduling against ${String(containerId).slice(0, 12)}`);
      }
    }
    perInstance.set(manifest.id, newEntry(instanceId, containerId, manifest));
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
  for (const entry of perInstance.values()) cancel(entry);
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

// Turning a watchdog ON from the UI (21/11/2026, asked by the user): resume, restart its timer
// from zero, and run one pass right away instead of waiting a whole interval to find out whether
// it works. The immediate pass is not awaited (a cifi pass can take several seconds: am start +
// taps); its result shows up in status() as soon as it finishes. If the instance is not running
// there is no timer to restart -- the resume alone is persisted and applies on the next start.
function resumeNow(instanceId, moduleId) {
  resume(instanceId, moduleId);
  const perInstance = scheduled.get(instanceId);
  const old = perInstance && perInstance.get(moduleId);
  if (!old) return false;
  const manifest = moduleRunner.watchdogModules([moduleId]).find((m) => m.id === moduleId);
  if (!manifest) return false;
  cancel(old);
  const entry = newEntry(instanceId, old.containerId, manifest, { firstPass: false }); // it runs its own pass right below
  perInstance.set(moduleId, entry);
  tick(instanceId, old.containerId, manifest, entry).catch((e) => {
    log(`immediate pass of "${moduleId}" for ${instanceId} failed unexpectedly: ${e.message}`);
  });
  log(`"${moduleId}" for ${instanceId} turned on: timer restarted, immediate pass running`);
  return true;
}

// A watchdog's own tap sequence (e.g. cifi's startGame/automation/continueBtn) assumes a
// KNOWN state after reopening the app -- it has no way to recognize a screen it has never seen
// before. A brand new install can hit a one-time first-run gate (e.g. a ToS/Privacy Policy
// screen) that the watchdog was never taught -- if that instance's process happens to die and
// restart during that window, the watchdog would reopen it and tap blindly into a screen it does
// not understand, which can do more harm than leaving it alone. Found for real, 01/11/2026,
// jgustavo47: a fresh `cifi` install got stuck on exactly this kind of screen (not a crash --
// `isRunning()` never triggered here -- but the same blind-tap risk applies once the module
// starts ticking against it).
//
// Default fix: any watchdog module a requiredModuleIds change is adding for the FIRST time
// (creation, or added later through /display's `modules` param) starts PAUSED -- the human has
// to get the app through its own first run once, then explicitly resume the watchdog (the
// pause/resume API already existed for this). A module the instance already had keeps whatever
// pause state it already had (its own key already exists in `existingPaused`) -- this only seeds
// a default for one it never had before, it never re-pauses one already running.
//
// A module's own manifest can opt out with `schedule.startPaused: false` (found needed for real,
// 17/11/2026, cifi: the human running the module's own first-run-by-hand step every time before
// activating it was friction the module's manifest can just document instead -- see its own
// `queToca` warning). This is a per-module, explicit choice by that module's author, not a
// blanket change to the convention above: any OTHER watchdog module written without thinking
// through the first-run risk still gets the safe default.
function defaultPauseForNewModules(existingPaused, requiredModuleIds) {
  const watchdogPaused = { ...(existingPaused || {}) };
  for (const manifest of moduleRunner.watchdogModules(requiredModuleIds)) {
    if (!(manifest.id in watchdogPaused)) {
      watchdogPaused[manifest.id] = manifest.schedule?.startPaused !== false;
    }
  }
  return watchdogPaused;
}

// Only for tests.
function _resetForTests() { for (const id of Array.from(scheduled.keys())) stop(id); }
function _setBootCheckForTests(fn, t) {
  bootCheck = fn || defaultBootCheck;
  timing = { pollMs: BOOT_POLL_MS, maxMs: BOOT_WAIT_MAX_MS, graceMs: FIRST_PASS_GRACE_MS, ...(t || {}) };
}

module.exports = {
  start, stop, status, pause, resume, resumeNow, isPaused, defaultPauseForNewModules, _resetForTests,
  _setBootCheckForTests,
};

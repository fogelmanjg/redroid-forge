'use strict';

// Restarts an instance whose Android restarted on its own inside a container that kept running.
//
// When system_server dies (seen 25/11/2026: surfaceflinger aborting on a YV12 video buffer, during an
// ad), Android restarts its whole userspace: every app is killed and the framework comes back up, but
// the container -- and so everything this app set up around it at start -- does not. The hwsim WiFi
// is the visible casualty (wificond finds the renamed eth0 where its radio should be and WiFi stays
// off), but anything else prepared at start may be half broken too. Repairing pieces one by one is a
// losing game; a full restart of the instance puts everything back the way a normal start does.
//
// Detection: system_server's pid. It is read only once Android reports boot completed, and the first
// pid seen for a given container start is the baseline. A different pid later, with the same
// container start, means Android restarted inside it. A new container start (any restart, by this
// app or not) just sets a new baseline.
//
// Guard rails: an instance that keeps crashing is not restarted forever -- after MAX_RESTARTS within
// WINDOW_MS this gives up on it (logged, flagged) until its next start. A failing probe (container
// gone, exec error) never counts as a restart.
//
// Before restarting (and also when giving up), beforeRestart saves the logcat and tombstones
// (crashLogs.js): the container restart would otherwise wipe the only record of the cause.

const { execFile } = require('child_process');

const POLL_MS = 30 * 1000;
const MAX_RESTARTS = 3;
const WINDOW_MS = 60 * 60 * 1000;

const PROBE = 'getprop sys.boot_completed; pidof system_server';

function defaultProbe(containerId) {
  return new Promise((resolve, reject) => {
    execFile('docker', ['exec', containerId, 'sh', '-c', PROBE], { timeout: 15000 }, (err, stdout) => {
      if (err) return reject(err);
      return resolve(stdout);
    });
  });
}

// "1\n1234\n" -> { booted: true, pid: '1234' }. pidof can print several pids; one system_server is
// expected, so the list as a whole is the identity.
function parseProbe(stdout) {
  const lines = String(stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
  return { booted: lines[0] === '1', pid: lines[1] || null };
}

function createWatch({
  listRunning, // async () => [{ instance, startedAt }]: instances whose container is running right now
  restart, // async (instance) => void: the same full restart the UI does
  onRestarted = () => {}, // (instance, at) => void: record it on the instance
  beforeRestart = async () => {}, // async (instance, info) => void: save the logs while they still exist
  onBaseline = async () => {}, // async (instance) => void: Android finished booting in a new container start
  probe = defaultProbe,
  now = () => Date.now(),
  log = (m) => console.log(`[androidRestartWatch] ${m}`),
} = {}) {
  // containerId -> { startedAt, pid, restarts: [ms], gaveUp }
  const seen = new Map();
  // instance id -> restart history that survives the container start our own restart causes
  const history = new Map();
  const busy = new Set();

  async function checkOne({ instance, startedAt }) {
    if (busy.has(instance.id)) return;
    let state;
    try {
      state = parseProbe(await probe(instance.containerId));
    } catch (e) {
      return; // not answering (booting, stopping, gone): never a restart
    }
    if (!state.booted || !state.pid) return;

    const prev = seen.get(instance.containerId);
    if (!prev || prev.startedAt !== startedAt) {
      seen.set(instance.containerId, { startedAt, pid: state.pid });
      try { await onBaseline(instance); } catch { /* best effort */ }
      return;
    }
    if (prev.pid === state.pid) return;

    const t = now();
    const recent = (history.get(instance.id) || []).filter((x) => t - x < WINDOW_MS);
    const info = { 'system_server pid': `${prev.pid} -> ${state.pid}`, 'automatic restarts in the last hour': recent.length };
    // The logs are saved for every crash seen, also when the instance is then left alone.
    busy.add(instance.id);
    try { await beforeRestart(instance, info); } catch { /* never blocks the restart */ } finally { busy.delete(instance.id); }
    if (recent.length >= MAX_RESTARTS) {
      if (!prev.gaveUp) log(`"${instance.name}": Android restarted inside the container again, but it was already restarted ${recent.length} times in the last hour -- leaving it alone until its next start`);
      seen.set(instance.containerId, { ...prev, pid: state.pid, gaveUp: true });
      return;
    }
    log(`"${instance.name}": Android restarted inside the running container (system_server ${prev.pid} -> ${state.pid}); restarting the instance`);
    busy.add(instance.id);
    try {
      await restart(instance);
      recent.push(t);
      history.set(instance.id, recent);
      onRestarted(instance, new Date(t).toISOString());
    } catch (e) {
      log(`"${instance.name}": automatic restart failed: ${e.message}`);
      seen.set(instance.containerId, { ...prev, pid: state.pid }); // do not retry the same event
    } finally {
      busy.delete(instance.id);
    }
  }

  async function tick() {
    let running;
    try { running = await listRunning(); } catch (e) { return; }
    const live = new Set(running.map((r) => r.instance.containerId));
    for (const id of seen.keys()) if (!live.has(id)) seen.delete(id);
    await Promise.all(running.map((r) => checkOne(r)));
  }

  let timer = null;
  return {
    tick,
    start(pollMs = POLL_MS) { if (!timer) timer = setInterval(() => { tick().catch(() => {}); }, pollMs); },
    stop() { clearInterval(timer); timer = null; },
    _seen: seen,
  };
}

module.exports = { createWatch, parseProbe, MAX_RESTARTS, WINDOW_MS, POLL_MS };

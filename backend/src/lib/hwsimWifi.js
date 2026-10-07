const cp = require('child_process');
const runtime = require('./dockerRuntime');
const store = require('./store');

// This is deliberately NOT `promisify(execFile)` (as before, neither resolved
// once at import time nor per call): `child_process.execFile` carries its own
// `util.promisify.custom` symbol, which survives `t.mock.method` -- so
// `promisify(cp.execFile)` in a mocked test still ends up calling Node's real
// implementation inside, ignoring the mock (confirmed by hand). Wrapping
// `cp.execFile`'s callback by hand avoids that shortcut and lets the tests really
// mock `child_process.execFile`.
function execFileAsync(file, args) {
  return new Promise((resolve, reject) => {
    cp.execFile(file, args, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve({ stdout, stderr });
    });
  });
}

const HWSIM_RADIO_COUNT = process.env.HWSIM_RADIO_COUNT || '6'; // 2 radios/instance

function log(msg) { console.log(`[hwsimWifi] ${msg}`); }
function warn(msg) { console.warn(`[hwsimWifi] ${msg}`); }

// Ports fake-wifi-networking.service.ts from plenum-redroid. It runs as root
// inside the privileged --pid=host --network=host container, so the commands act
// directly on the host without needing sudo.

function parsePhyIfacePairs(iwDevOutput) {
  const pairs = [];
  let currentPhy = null;
  for (const line of iwDevOutput.split('\n')) {
    const phyMatch = line.match(/^phy#(\d+)/);
    if (phyMatch) { currentPhy = `phy${phyMatch[1]}`; continue; }
    const ifaceMatch = line.match(/^\s*Interface (\S+)/);
    if (ifaceMatch && currentPhy) {
      pairs.push({ phy: currentPhy, iface: ifaceMatch[1] });
      currentPhy = null;
    }
  }
  return pairs;
}

// Serialization queue for claiming hwsim phy/iface pairs (a known bug, see
// docs/ROADMAP.md Phase 3 step 4): without this, two instances that start/restart
// at almost the same time may call ensureHwsimWifi in parallel, both read 'iw dev'
// before either has claimed anything, see the same "free" pairs, and both try to
// move them -- one of the two ends up without wifi radios that boot. By chaining
// every attempt to this single module-level promise (the same pattern as a queue
// with a mutex: attempt N+1 does not even start reading 'iw dev' until attempt N
// has fully resolved, success or failure) it is guaranteed that there are never two
// 'iw dev' reads in flight at the same time.
let hwsimClaimTail = Promise.resolve();

// Ceiling for every attempt in the queue: without this, a single hung host command
// inside the critical section (e.g. an `iw phy ... set netns` that never returns
// because of a stuck netlink call) leaves `hwsimClaimTail` never advancing, and ANY
// future instance that needs fake wifi on this host waits forever -- a single hung
// command went from "that instance is out of luck this boot" to "the whole host
// can no longer start fake wifi until the backend is restarted" (a real
// code-review finding, PR #3). The abandoned attempt may keep running in the
// background (there is no generic way to kill what `fn` launched inside, which
// includes both execFileAsync and runtime.exec via dockerode) -- an accepted
// residual risk: a late claim running in parallel with the next one, far more
// bounded than the total deadlock it replaces.
const HWSIM_CLAIM_TIMEOUT_MS = Number(process.env.HWSIM_CLAIM_TIMEOUT_MS) || 30000;

function runHwsimClaim(fn) {
  const attempt = hwsimClaimTail.then(() => new Promise((resolve, reject) => {
    let settled = false;
    // If fn() wins the race (the normal case, almost always) the timer has to be
    // cancelled -- without this a 30 s setTimeout stays alive for every successful
    // claim, holding the event loop and, if nobody else references it, ending up in
    // a reject() without a handler later (an unhandled rejection).
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`runHwsimClaim: attempt hung for more than ${HWSIM_CLAIM_TIMEOUT_MS}ms, abandoned so as not to jam the queue`));
    }, HWSIM_CLAIM_TIMEOUT_MS);
    fn().then(
      (value) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); },
      (err) => { if (settled) return; settled = true; clearTimeout(timer); reject(err); },
    );
  }));
  // The tail keeps advancing even if this attempt failed or was abandoned by a
  // timeout -- a rejected claim must never jam those behind it in the queue.
  // `attempt` (what is returned to the caller) does keep the real result/error.
  hwsimClaimTail = attempt.then(() => {}, () => {});
  return attempt;
}

// Only for tests: the queue is a module-level singleton, so without this a test
// could start with the tail still "dirty" from a previous test (for example one
// that left a mock half-resolved).
function _resetHwsimClaimTailForTests() {
  hwsimClaimTail = Promise.resolve();
}

// Instances that effectively have hwsim phys assigned at this moment -- "the
// container is running" is not enough (see below). It is added when
// claimAndAssignHwsimPair() moves at least one phy into that instance's netns; an
// old entry for a container that already died is discarded on its own the next
// time it is queried (containerId is never reused between instances, so there is
// no risk of a false positive in the meantime).
const instancesHoldingHwsim = new Set();

// To decide whether it is safe to reload mac80211_hwsim when 'iw dev' shows no
// free phy: if they are really all in use by another instance that keeps running,
// reloading the module would steal them (see the nuance ported from
// jg-dashboard/redroid.service.ts). It is only reloaded if NO other instance with
// fake wifi is using hwsim right now.
//
// NOTE: "using hwsim" is instancesHoldingHwsim, not "the container is running"
// (info.State.Running) -- two instances A and B may start almost together, both
// with their container already "Running" in Docker before either has claimed
// anything (the claim is serialized by runHwsimClaim). If A checks this while B's
// claim is STILL queued behind A's, counting B as "running" was enough for A to
// wrongly conclude "someone else is using hwsim" and skip a reload that could
// have freed radios for both (a real code-review finding, PR #3).
async function anyOtherInstanceUsingHwsim(excludeContainerId) {
  const others = store.readAll().filter((i) => i.needsHwsimWifi && i.containerId && i.containerId !== excludeContainerId);
  for (const other of others) {
    if (!instancesHoldingHwsim.has(other.containerId)) continue;
    try {
      const info = await runtime.inspect(other.containerId);
      if (info.State.Running) return true;
      instancesHoldingHwsim.delete(other.containerId); // it died, it has nothing assigned anymore
    } catch {
      instancesHoldingHwsim.delete(other.containerId); // the container no longer exists
    }
  }
  return false;
}

// Critical section of ensureHwsimWifi, always run through runHwsimClaim: it picks a
// free phy/iface pair and moves it into the instance's netns, including renaming
// the interfaces once inside that netns. It never runs overlapped with another claim.
async function claimAndAssignHwsimPair(instanceId, containerId, pid) {
  // A phy from a previous swap may still carry the name "wlan0_fake".
  await execFileAsync('ip', ['link', 'set', 'wlan0_fake', 'down']).catch(() => {});
  await execFileAsync('ip', ['link', 'set', 'wlan0_fake', 'name', 'wlan0']).catch(() => {});

  let freePairs = [];
  try {
    const { stdout } = await execFileAsync('iw', ['dev']);
    freePairs = parsePhyIfacePairs(stdout);
  } catch (e) {
    warn(`'iw dev' failed for ${instanceId}: ${e}`);
    return;
  }

  // Seen in practice: sometimes a phy does not return to the host's default netns
  // when the container that held it dies -- it simply disappears (root cause never
  // confirmed). If NONE is free, reloading the module only makes sense if no other
  // instance with fake wifi is running right now -- if one is, reloading would steal
  // the radios it already has assigned.
  if (freePairs.length === 0) {
    if (await anyOtherInstanceUsingHwsim(containerId)) {
      warn(`0 free phys for ${instanceId} but another instance is using hwsim -- the module is not reloaded`);
    } else {
      warn(`0 free phys for ${instanceId} and no other instance using hwsim -- reloading mac80211_hwsim`);
      try {
        await execFileAsync('rmmod', ['mac80211_hwsim']);
        await execFileAsync('modprobe', ['mac80211_hwsim', `radios=${HWSIM_RADIO_COUNT}`]);
        const { stdout } = await execFileAsync('iw', ['dev']);
        freePairs = parsePhyIfacePairs(stdout);
      } catch (e) {
        warn(`reloading mac80211_hwsim failed for ${instanceId}: ${e}`);
      }
    }
  }

  if (freePairs.length < 2) {
    warn(`only ${freePairs.length} free phy(s) for ${instanceId} (it needs 2) — wifi will not work this boot`);
    return;
  }

  const [a, b] = freePairs;
  const targetNames = ['wlan0', 'wlan1'];
  const renamedOk = [];
  for (const [i, pair] of [a, b].entries()) {
    try {
      await execFileAsync('iw', ['phy', pair.phy, 'set', 'netns', pid]);
      // From here on the phy is already physically in this instance's netns
      // (regardless of whether the interface rename below goes well) -- it is
      // marked right away, not only if renamedOk ends up true, because
      // instancesHoldingHwsim exists for "do not steal this phy from this
      // instance", not for "the rename went perfectly for it".
      instancesHoldingHwsim.add(containerId);
      if (pair.iface !== targetNames[i]) {
        let ok = false;
        for (let attempt = 0; attempt < 5 && !ok; attempt++) {
          await runtime.exec(containerId, ['ip', 'link', 'set', pair.iface, 'down']).catch(() => {});
          await runtime.exec(containerId, ['ip', 'link', 'set', pair.iface, 'name', targetNames[i]]).catch(() => {});
          try {
            await runtime.exec(containerId, ['ip', 'link', 'show', targetNames[i]]);
            ok = true;
          } catch {
            await new Promise((r) => setTimeout(r, 500));
          }
        }
        renamedOk.push(ok);
        if (!ok) warn(`could not rename ${pair.iface}->${targetNames[i]} for ${instanceId}`);
      } else {
        renamedOk.push(true);
      }
    } catch (e) {
      warn(`could not move ${pair.phy} into ${instanceId}'s netns: ${e}`);
      renamedOk.push(false);
    }
  }

  if (renamedOk.every(Boolean)) {
    log(`${a.phy} (${a.iface}->wlan0), ${b.phy} (${b.iface}->wlan1) moved into ${instanceId}'s netns (pid ${pid})`);
  } else {
    warn(`incomplete setup for ${instanceId} (pid ${pid})`);
  }
}

// Runs on every start (Docker recreates the netns each time). An instance's phys
// return on their own to the host's netns when its container dies.
async function ensureHwsimWifi(instanceId, containerId) {
  try {
    await execFileAsync('modprobe', ['mac80211_hwsim', `radios=${HWSIM_RADIO_COUNT}`]);
  } catch (e) {
    warn(`modprobe failed for ${instanceId}: ${e}`);
  }

  let pid;
  try {
    pid = await runtime.getPid(containerId);
  } catch (e) {
    warn(`could not get the PID of ${instanceId}: ${e}`);
    return;
  }

  await runHwsimClaim(() => claimAndAssignHwsimPair(instanceId, containerId, pid));
}

function scheduleHwsimWifiFix(instanceId, containerId) {
  ensureHwsimWifi(instanceId, containerId).catch((e) => warn(`scheduleHwsimWifiFix failed for ${instanceId}: ${e}`));
}

// The fake wifi HAL only fires when something asks Android to connect.
async function ensureWifiConnected(instanceId, containerId) {
  const MAX_ATTEMPTS = 6;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    let status = '';
    try {
      status = await runtime.exec(containerId, ['su', '-c', 'cmd wifi status']);
    } catch (e) {
      warn(`status check failed for ${instanceId}: ${e}`);
    }
    if (status.includes('Wifi is connected')) return;

    try {
      await runtime.exec(containerId, ['su', '-c', 'svc wifi enable']);
      await new Promise((r) => setTimeout(r, 3000));
      await runtime.exec(containerId, ['su', '-c', 'cmd wifi connect-network jg-wifi open']);
    } catch (e) {
      warn(`attempt ${i + 1} failed for ${instanceId}: ${e}`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  warn(`attempts exhausted for ${instanceId} — it may need a manual reconnection`);
}

function scheduleWifiConnectedFix(instanceId, containerId) {
  setTimeout(() => {
    ensureWifiConnected(instanceId, containerId).catch((e) => warn(`scheduleWifiConnectedFix failed for ${instanceId}: ${e}`));
  }, 20000);
}

// The fake-wifi images hide eth0 from ConnectivityService, so netd never adds an
// ip rule "lookup main" for that interface — without it, eth0 stays behind the
// catch-all "unreachable" rule until the wifi swap happens, and ADB becomes
// unreliable.
async function ensureEth0Routing(instanceId, containerId) {
  const script = "ip rule show | grep -q 'lookup main' || ip rule add priority 25000 lookup main";
  const MAX_ATTEMPTS = 8;
  const RETRY_DELAY_MS = 2000;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await runtime.exec(containerId, ['su', '-c', script]);
    } catch (e) {
      warn(`ip rule add failed for ${instanceId} (attempt ${attempt}): ${e}`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      continue;
    }

    const ip = await runtime.getBridgeIp(containerId).catch(() => undefined);
    if (!ip) { await new Promise((r) => setTimeout(r, RETRY_DELAY_MS)); continue; }

    try {
      await execFileAsync('ip', ['neigh', 'flush', ip]);
      await execFileAsync('ping', ['-c', '1', '-W', '1', ip]).catch(() => {});
    } catch (e) {
      warn(`neigh flush failed for ${instanceId}: ${e}`);
    }

    try {
      const { stdout } = await execFileAsync('ip', ['neigh', 'show', ip]);
      if (/\b(REACHABLE|STALE|DELAY|PROBE)\b/.test(stdout)) {
        log(`neighbor resolved for ${instanceId} on attempt ${attempt}`);
        return;
      }
    } catch (e) {
      warn(`neigh show failed for ${instanceId}: ${e}`);
    }

    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  }
  warn(`neighbor still unresolved for ${instanceId} after ${MAX_ATTEMPTS} attempts`);
}

function scheduleEth0RoutingFix(instanceId, containerId) {
  setTimeout(() => {
    ensureEth0Routing(instanceId, containerId).catch((e) => warn(`scheduleEth0RoutingFix failed for ${instanceId}: ${e}`));
  }, 20000);
}

module.exports = {
  ensureHwsimWifi, scheduleHwsimWifiFix,
  ensureWifiConnected, scheduleWifiConnectedFix,
  ensureEth0Routing, scheduleEth0RoutingFix,
  _resetHwsimClaimTailForTests,
};

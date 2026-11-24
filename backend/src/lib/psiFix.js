'use strict';

// Third member of the meminfoFix.js / cpuFix.js family (1.0.0-rc.4): memory PRESSURE. lmkd, the
// Android low-memory killer, does not wait for memory to run out -- it reacts to PSI events from
// /proc/pressure/memory ("tasks stalled waiting for memory"). /proc/pressure/* is not namespaced:
// inside a container it is the WHOLE HOST's pressure. So whenever the host itself stalls for a
// moment (kswapd reclaiming page cache, swap-in, another heavy container), every instance's lmkd
// sees "critical" pressure at the same instant and kills -- a critical kill goes down to oom_adj 0,
// the foreground app included. Seen on prod 24/11/2026: CIFI (3 GB instance, 1.4 GB used, cgroup
// oom 0) killed as LOW_MEMORY while on screen at 18:12:57, together with cifi-nuevo; and at
// 20:18:07 three other instances at once -- always right when the host's sar showed a kswapd
// spike, with 34 GB still available on the host. Inside cifi, its own cgroup memory.pressure had
// ~1 s of stall over 3 days; /proc/pressure/memory (the host's) had ~982 s.
//
// Fix: the container's own cgroup v2 memory.pressure (same format, and it accepts the same PSI
// triggers lmkd writes) is bound over /proc/pressure/memory at post-fs-data, before lmkd starts
// (class core, started at `on boot`). Static file, no host-side refresh needed: the kernel keeps
// it live. Android mounts cgroup2 at /sys/fs/cgroup, and with the container's private cgroup
// namespace that root IS the instance's cgroup.

const fs = require('fs');
const path = require('path');
const cpuFix = require('./cpuFix');

const RC_SOURCE = path.join(__dirname, 'redroid-forge-psi.rc');
const RC_TARGET = '/vendor/etc/init/redroid-forge-psi.rc';

function warn(msg) { console.warn(`[psi-fix] ${msg}`); }

// Before every start/restart. Never fails the start: without it the instance runs as before, only
// with the host's pressure.
async function ensure(instance, { copyIn } = {}) {
  if (!instance || !instance.containerId) return;
  const put = copyIn || ((content, dest) => cpuFix.defaultCopyIn(content, dest, instance.containerId));
  try {
    await put(fs.readFileSync(RC_SOURCE, 'utf8'), RC_TARGET);
  } catch (e) {
    warn(`could not install the pressure .rc in "${instance.name}": ${e.message}`);
  }
}

module.exports = { ensure, RC_SOURCE, RC_TARGET };

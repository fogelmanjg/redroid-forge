'use strict';

// Workaround for the same Linux/Docker limitation as meminfoFix.js, for CPUs instead of RAM
// (1.0.0-rc.3). A container always sees the HOST's /sys/devices/system/cpu/{online,possible,present}
// (0-15 on a 16-thread host) even when it is pinned to a few CPUs with `cpusetCpus`. Android's
// bionic (sysconf(_SC_NPROCESSORS_CONF/ONLN), Java's Runtime.availableProcessors()) and engines
// like Unity read those files, so an app sizes its thread pools for 16 cores while it can only run
// on 4. Found live on cifi-nuevo (24/11/2026): Unity logged "Cores = 16" on a 4-CPU instance;
// with the three files showing "6-7,14-15" it logged "Cores = 4" and the game ran 131 threads
// instead of 173. The scheduler affinity (pid 1: c0c0) was always right -- only the count lied.
//
// Mechanism: like meminfoFix's rc trigger, but the content is fixed for the whole boot, so no host
// bind or refresh timer is needed: before every start/restart a small file with the CPU list and
// an `.rc` are copied into /vendor (docker cp works on a stopped or a running container), and
// Android's own init binds the file over the three sysfs files at post-fs-data. It works for
// instances created before this existed, too. A live cpuset change (POST /:id/resources) is seen
// by Android from the next start or restart.
// No cpuset -> the host's own online list is written: the instance really can use every CPU, and
// a previously pinned instance stops showing its old list.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const RC_SOURCE = path.join(__dirname, 'redroid-forge-cpus.rc');
const RC_TARGET = '/vendor/etc/init/redroid-forge-cpus.rc';
const LIST_TARGET = '/vendor/etc/redroid-forge-cpus';
// This process sees the host's sysfs (sysfs is not namespaced), same file the containers see.
const HOST_ONLINE = process.env.REDROID_FORGE_HOST_CPU_ONLINE || '/sys/devices/system/cpu/online';

function warn(msg) { console.warn(`[cpu-fix] ${msg}`); }

// "6,7,14,15" (Docker's format) -> "6-7,14-15" (the kernel's cpulist format, what these sysfs
// files normally hold; bionic parses both, this just keeps the file looking like the real one).
function toCpuList(cpuset) {
  const ids = new Set();
  for (const part of String(cpuset).split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new Error(`bad cpuset "${cpuset}"`);
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) ids.add(i);
  }
  const sorted = [...ids].sort((x, y) => x - y);
  if (sorted.length === 0) throw new Error(`empty cpuset "${cpuset}"`);
  const ranges = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (const n of sorted.slice(1).concat([Infinity])) {
    if (n === prev + 1) { prev = n; continue; }
    ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = n;
    prev = n;
  }
  return ranges.join(',');
}

function cpuListFor(instance, { readHostOnline } = {}) {
  if (instance.cpusetCpus) return toCpuList(instance.cpusetCpus);
  const read = readHostOnline || (() => fs.readFileSync(HOST_ONLINE, 'utf8'));
  return read().trim();
}

// docker cp keeps the source's permissions, and Android's init skips a group/other-writable .rc
// ("Skipping insecure file", see meminfoFix.js): always 0644, never trusting the mode on disk.
async function defaultCopyIn(srcContent, dest, containerId) {
  const tmp = path.join(os.tmpdir(), `cpufix-${containerId.slice(0, 12)}-${path.basename(dest)}`);
  fs.writeFileSync(tmp, srcContent);
  try {
    await execFileAsync('chown', ['root:root', tmp]);
    await execFileAsync('chmod', ['0644', tmp]);
    await execFileAsync('docker', ['cp', tmp, `${containerId}:${dest}`]);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// Before every start/restart. Never fails the start: an instance without the fix still runs, as
// before, only with the host's CPU count.
async function ensure(instance, { copyIn, readHostOnline } = {}) {
  if (!instance || !instance.containerId) return;
  const put = copyIn || ((content, dest) => defaultCopyIn(content, dest, instance.containerId));
  try {
    const list = cpuListFor(instance, { readHostOnline });
    await put(`${list}\n`, LIST_TARGET);
    await put(fs.readFileSync(RC_SOURCE, 'utf8'), RC_TARGET);
  } catch (e) {
    warn(`could not install the CPU list in "${instance.name}": ${e.message}`);
  }
}

// defaultCopyIn is shared with psiFix.js (same "0644, never trust the mode on disk" rule).
module.exports = { ensure, toCpuList, cpuListFor, defaultCopyIn, RC_SOURCE, RC_TARGET, LIST_TARGET };

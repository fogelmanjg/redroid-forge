'use strict';

// Workaround for a Linux/Docker limitation, not a toggleable feature -- same category as the
// Memory/MemorySwap pairing in dockerRuntime.create() (no manifest/contract: there is no
// non-free component or UX tradeoff to disclose here, only a bug to route around).
//
// Confirmed for real on pvz2-tv/5561 (jg-dashboard v1, see memory): Android inside a redroid
// container reads /proc/meminfo to learn "Total RAM" and decide when to trim caches / kill
// background processes -- but a Linux container never gets its own view of that file, so it
// always reports the HOST's full RAM, never the cgroup's actual memory limit (Docker's
// `Memory`/`memoryMb`). An instance capped at e.g. 4096 MB still thinks it has the host's 64 GB
// free and never trims proactively; the cgroup OOM killer ends up doing the work abruptly
// instead once the real limit is hit, which is the mid-game stutter this fixes. Confirmed with
// real numbers: 3030/4096 MB used cgroup-side while `dumpsys meminfo` inside the container still
// reported the host's 63 GB and "status moderate".
//
// Fix: a real, regular file with just the fields Android's low-memory path actually reads
// (frameworks/base's MemInfoReader, lmkd). MemTotal is fixed to the cgroup limit at create time;
// MemFree/MemAvailable/Cached are kept fresh by a periodic tick (scheduleRefresh) that reads the
// container's own cgroup v2 memory.current/memory.stat on the host -- the same two candidate
// cgroup paths (systemd vs cgroupfs driver) backend/scripts/scenarios/lib/sampler.py already uses
// for its own CPU/memory sampling of containers.
//
// Getting the file in front of Android is a two-step dance, found by testing live against a real
// instance on 24/10/2026 -- a direct HostConfig bind of this file onto /proc/meminfo at container
// CREATE time DOES take effect (confirmed: `docker inspect` showed the mount, and reading it
// right after create gave the right numbers), but Android's own init.rc remounts a fresh procfs
// over the whole of /proc early in boot (the `hidepid=invisible` mount visible in a booted
// instance's own mount table) -- that remount shadows our earlier submount, and `dumpsys meminfo`
// goes right back to reporting the host's full RAM. The actual fix has to happen AFTER that boot
// remount: (1) prepareBinds() binds the host file at create time onto a STABLE path that is NOT
// under /proc (IN_CONTAINER_SRC, below) -- Android's boot never touches this path, so the bind
// (and therefore every later write to the host file, since a bind mount shares the underlying
// inode, it is not a copy) survives boot intact; (2) installRcTrigger() drops a `.rc` into
// Android's own `/vendor/etc/init/` at stage 4 (same mechanism redroid-gralloc-fix already uses),
// triggered `on post-fs-data` -- after Android's own procfs remount, confirmed by init's own
// ordering, not a guess -- so Android's OWN init lays that same file over /proc/meminfo itself,
// no host-side polling needed (see installRcTrigger's own comment for the full history: an
// earlier docker-exec-retry version of this existed and was replaced on 31/10/2026). Live-verified
// end to end on 24/10/2026 against aurora-host-test (a real 4096 MB-capped instance on this host):
// before, `dumpsys meminfo` reported "Total RAM: 63,646,788K"; after, "Total RAM: 4,194,304K" --
// exactly the cgroup limit, matching the pvz2-tv finding this fixes.
//
// Deliberately NOT a "etapa"/"entry" module (see moduleRunner.js): it has nothing to do with an
// image or a user choice, it applies whenever an instance has a memory cap at all, the same way
// the Memory/MemorySwap pairing in dockerRuntime.create() is unconditional rather than opt-in.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const store = require('./store');

const execFileAsync = promisify(execFile);

// Unlike the other REDROID_FORGE_*_DIR vars that are genuinely optional (REDROID_HWENC_ARTIFACTS_DIR,
// REDROID_FORGE_VIRTWIFI_KO_PATH), this one is NOT optional once redroid-forge itself runs in a
// container -- same situation as REDROID_FORGE_BACKUPS_DIR (see settings.js and docker-compose.yml's
// own comment on it): the file this module writes gets bind-mounted into OTHER containers via the
// Docker socket, which resolves bind sources against the HOST's filesystem, not against this
// process's own. The `__dirname`-based fallback below is only correct when this process runs
// directly on the host (e.g. under `node --test`, no container in between) -- docker-compose.yml
// sets the env var to the real host path precisely so the two agree when containerized.
const DATA_DIR = process.env.REDROID_FORGE_MEMINFO_FIX_DIR
  || path.join(__dirname, '..', '..', 'data', 'meminfo-fix');

// Overridable so tests can point it at a fake tree instead of the host's real /sys/fs/cgroup.
// This process's OWN /sys/fs/cgroup is useless here even unoverridden: Docker gives this
// container a private cgroup namespace by default, where that path shows only this container's
// own slice ("0::/"), none of the sibling redroid instances this module needs to read. The real
// host tree (with every instance's own docker-<id>.scope) has to be bind-mounted in at this same
// path explicitly -- see docker-compose.yml's own comment on its /sys/fs/cgroup volume entry.
const CGROUP_ROOT = process.env.REDROID_FORGE_CGROUP_ROOT || '/sys/fs/cgroup';

const REFRESH_MS = 5000;

// NOT under /proc (Android's own boot-time remount only touches /proc itself, see the file
// comment) -- and, found live (24/10/2026), NOT under /mnt either: that one looked safe (it is
// not /proc) but turned out to be its OWN case of the same problem, Android's init assembles it
// as a fresh tmpfs full of storage-emulation directories (androidwritable, obb, sdcard, ...) at
// boot, which just as thoroughly wipes a bind placed there beforehand. /vendor does not have
// that problem -- confirmed by the already-working redroid-gralloc-fix module, whose injected
// files (docker cp'd in at stage 4, before first boot) keep their ORIGINAL timestamps after a
// full boot instead of the container's boot time, proving Android never remounts/rebuilds it.
const IN_CONTAINER_SRC = '/vendor/.redroid-forge-meminfo';

const timers = new Map(); // instanceId -> NodeJS.Timeout

function log(msg) { console.log(`[meminfo-fix] ${msg}`); }
function warn(msg) { console.warn(`[meminfo-fix] ${msg}`); }

// Keyed by volumeName, not instance.name -- found for real (30/10/2026) renaming an instance
// (routes/instances.js's PUT /:id/name) and later restarting it: the bind mount in the
// container's HostConfig is a path string frozen at CREATE time, it only "follows the inode"
// while that exact mount stays continuously active. The moment the container stops and Docker
// has to remount it fresh, it re-resolves the OLD path from HostConfig.Binds, finds nothing
// there any more, and Docker auto-creates a DIRECTORY at that missing path -- which then fails
// to bind-mount onto a file target ("not a directory") and the container can never start again.
// volumeName is immutable once set at creation (never re-derived from the renamable `name`,
// same property instances.js already relies on for the Docker volume itself), so using it here
// instead avoids the whole class of bug without needing to keep any file in sync on rename.
function hostFilePath(volumeName) {
  return path.join(DATA_DIR, volumeName, 'meminfo');
}

// Pure. Clamped so the fields stay internally consistent (free+cached <= total) even if a read
// lands mid-update or a cgroup number is momentarily inconsistent -- cosmetic only, Android reads
// a slightly-off snapshot for at most one tick (REFRESH_MS), never a nonsensical one.
function render({ totalKb, freeKb, cachedKb }) {
  const t = Math.max(0, Math.round(totalKb));
  const f = Math.max(0, Math.min(t, Math.round(freeKb)));
  const c = Math.max(0, Math.min(t - f, Math.round(cachedKb)));
  const avail = f + c;
  const line = (label, kb) => `${label}:`.padEnd(16) + `${kb} kB\n`;
  // Only the fields Android's boot-time/low-memory path actually consults -- a real
  // /proc/meminfo has ~50 fields, the rest are not read anywhere in that path and would only be
  // extra bytes to keep in sync on every tick.
  return (
    line('MemTotal', t)
    + line('MemFree', f)
    + line('MemAvailable', avail)
    + line('Buffers', 0)
    + line('Cached', c)
    + line('SwapCached', 0)
    + line('SwapTotal', 0)
    + line('SwapFree', 0)
    + line('Dirty', 0)
    + line('Shmem', 0)
    + line('Slab', 0)
    + line('VmallocTotal', t)
  );
}

function writeFile(volumeName, fields) {
  const file = hostFilePath(volumeName);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, render(fields));
  return file;
}

// Called from the create/recreate handlers, before runtime.create() -- the bind has to be part
// of HostConfig.Binds at creation time, Docker has no live-attach for a new mount. Returns []
// (no bind added) when the instance has no memory cap: Android seeing the real host RAM is not
// wrong when nothing is capping it below that, there is nothing to correct. `volumeName`, not
// `name` -- see hostFilePath's own comment on why this has to be the immutable one.
function prepareBinds(volumeName, memoryMb) {
  if (!memoryMb) return [];
  const totalKb = memoryMb * 1024;
  // A freshly created container has ~0 used yet -- refresh() corrects this within REFRESH_MS of
  // the first tick once it is actually running.
  const file = writeFile(volumeName, { totalKb, freeKb: totalKb, cachedKb: 0 });
  // Onto IN_CONTAINER_SRC, not /proc/meminfo directly -- see the file comment on why the actual
  // /proc/meminfo bind has to happen later, post-boot (installRcTrigger).
  return [`${file}:${IN_CONTAINER_SRC}`];
}

// The actual /proc/meminfo bind, done natively by Android's OWN init instead of a host-side
// docker-exec retry loop. Earlier version of this (bindOnce/scheduleBindMount, removed
// 31/10/2026, see git history if it is ever needed again) ran `mount --bind` via `docker exec`,
// fire-and-forget, retried every 2s for up to 20s on the theory that the container's shell was
// not reachable yet right after start() -- found for real against a live instance with a heavier
// first boot (gapps+aurora+arm-translation+wifi-interno, a lot to install/start) that 20s was not
// always enough, and nothing ever retried again after that: Android was stuck reporting the
// host's full RAM until the next full recreate. Same race every OTHER stage-6 fixup in this
// project already has (see androidExec.js's execAndroidWithRetry, 60s) -- but there is a cleaner
// answer specific to this one action: Android's own init can do the mount itself. Stage-4 modules
// (redroid-gralloc-fix is the existing example) already drop a `.rc` file into
// `/vendor/etc/init/` while the container is stopped and Android picks it up automatically on its
// next boot -- this reuses exactly that mechanism instead of inventing a second one.
// RC_SOURCE's trigger (`on post-fs-data`) runs after Android's own stock init.rc remounts a fresh
// procfs over /proc (the thing that forced this to be a two-step bind in the first place, see the
// top-of-file comment) -- init's own trigger ordering guarantees that, no polling needed.
// Live-verified end to end on 31/10/2026 against a disposable test instance: booted with the .rc
// installed and NO docker-exec bind call from this project at all, and `/proc/meminfo` inside
// already showed the right MemTotal. The one real unknown going in -- would SELinux block init's
// own domain (`u:r:init:s0`) from doing a mount that a root shell exec can -- was NOT the
// problem; the actual blocker was simpler: `docker cp` preserves the source file's host
// permissions, and Android's init refuses to even parse a `.rc` that is group/other-writable
// ("Skipping insecure file") -- RC_SOURCE is kept at 644 on disk for exactly this reason, do not
// loosen it.
const RC_SOURCE = path.join(__dirname, 'redroid-forge-meminfo.rc');
const RC_TARGET = '/vendor/etc/init/redroid-forge-meminfo.rc';

// Stage 4 (between runtime.create() and runtime.start(), the only window /vendor is writable --
// same timing as redroid-gralloc-fix's own RC injection). No-op for an instance with no memory
// cap, same guard as prepareBinds -- there would be nothing at IN_CONTAINER_SRC for the .rc to
// bind from.
async function installRcTrigger(containerId, memoryMb, { copyIn } = {}) {
  if (!memoryMb) return;
  const put = copyIn || ((src, dest) => execFileAsync('docker', ['cp', src, `${containerId}:${dest}`]));
  await put(RC_SOURCE, RC_TARGET);
  log(`installed ${RC_TARGET} in ${containerId} (Android's own init will bind /proc/meminfo after post-fs-data)`);
}

// The two cgroup v2 layouts a container's scope can show up under, depending on Docker's cgroup
// driver (systemd vs cgroupfs) -- same two candidates as sampler.py's Container class.
function cgroupPath(containerId) {
  for (const cand of [
    `${CGROUP_ROOT}/system.slice/docker-${containerId}.scope`,
    `${CGROUP_ROOT}/docker/${containerId}`,
  ]) {
    if (fs.existsSync(cand)) return cand;
  }
  return null;
}

function readMatch(file, re) {
  try {
    const m = fs.readFileSync(file, 'utf8').match(re);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

// One tick: re-derive MemFree/MemAvailable/Cached from the container's real cgroup v2 usage.
// Looked up fresh by instanceId on every tick (never closed over) so a live memory change via
// POST /:id/resources, or a recreate (new containerId, same instanceId -- see
// routes/instances.js's own comment on why `id` stays stable across one), is picked up on the
// very next tick with no extra wiring at either of those call sites.
function refresh(instanceId) {
  const instance = store.get(instanceId);
  if (!instance || !instance.memoryMb || !instance.containerId) return;
  const cg = cgroupPath(instance.containerId);
  if (!cg) return; // not up yet, or neither known cgroup driver layout -- try again next tick
  const currentBytes = readMatch(path.join(cg, 'memory.current'), /^(\d+)/);
  if (currentBytes === null) return;
  const fileBytes = readMatch(path.join(cg, 'memory.stat'), /^file\s+(\d+)/m) || 0;
  const totalKb = instance.memoryMb * 1024;
  const cachedKb = fileBytes / 1024;
  const freeKb = totalKb - currentBytes / 1024;
  writeFile(instance.volumeName, { totalKb, freeKb, cachedKb });
}

// Idempotent and safe to call on every create/start/restart/recreate, same style as
// scheduleWifiFixes: clears any previous timer for this instance first, then only re-arms one if
// the instance actually has a memory cap.
function scheduleRefresh(instance) {
  release(instance.id);
  if (!instance.memoryMb) return;
  timers.set(instance.id, setInterval(() => {
    try { refresh(instance.id); } catch (e) { warn(`tick failed for ${instance.id}: ${e.message}`); }
  }, REFRESH_MS));
}

function release(instanceId) {
  const t = timers.get(instanceId);
  if (t) {
    clearInterval(t);
    timers.delete(instanceId);
  }
}

// Mirrors the instance's own volume removal on delete -- the generated file is derived state,
// not something worth keeping around once the instance it was for is gone.
function cleanup(volumeName) {
  fs.rmSync(path.join(DATA_DIR, volumeName), { recursive: true, force: true });
}

module.exports = {
  prepareBinds, installRcTrigger, scheduleRefresh, release, refresh, cleanup,
  render, hostFilePath, cgroupPath, DATA_DIR, REFRESH_MS, IN_CONTAINER_SRC, RC_SOURCE, RC_TARGET,
};

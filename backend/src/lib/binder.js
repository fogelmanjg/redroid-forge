const fs = require('fs');
const { execFileSync } = require('child_process');
const store = require('./store');

const BINDERFS_ROOT = '/dev/binderfs';

// Ports ensureBinderDevice() from host-resource-allocator.service.ts. It runs
// as root inside the privileged --pid=host container, so sudo is not needed
// (unlike the original in plenum-redroid).
function ensureBinderDevice(name) {
  const devPath = `${BINDERFS_ROOT}/${name}`;
  if (fs.existsSync(devPath)) return;

  const script = [
    'import ctypes, fcntl, os',
    'BINDER_CTL_ADD = (3 << 30) | (0x62 << 8) | (1 << 0) | (264 << 16)',
    'class binderfs_device(ctypes.Structure):',
    '    _fields_ = [("name", ctypes.c_char * 256), ("major", ctypes.c_uint32), ("minor", ctypes.c_uint32)]',
    'dev = binderfs_device()',
    `dev.name = b"${name}"`,
    `fd = os.open("${BINDERFS_ROOT}/binder-control", os.O_RDONLY)`,
    'fcntl.ioctl(fd, BINDER_CTL_ADD, dev)',
    'os.close(fd)',
  ].join('\n');

  execFileSync('python3', ['-c', script]);
  fs.chmodSync(devPath, 0o666);
}

// REDROID_FORGE_BINDER_RESERVED="1,2,3,50": slots already used by ANOTHER orchestrator on the same host (e.g. the
// previous dashboard, during the migration). redroid-forge's store only knows its own instances: without this,
// with an empty registry it would pick slot 1 and reuse the binder1 node of a foreign instance, leaving two
// Androids on the same binder.
function reservedSlots(env = process.env) {
  return String(env.REDROID_FORGE_BINDER_RESERVED || '')
    .split(',').map((x) => x.trim()).filter((x) => /^\d+$/.test(x)).map(Number);
}

// Slots: without the coexistence offset with plenum-redroid's jg-dashboard v1 —
// here our own store is the only source of truth, so it is enough to take the
// next free integer. In binderfs mode the nodes are created on demand, so any
// slot >= 1 will do. In legacy mode (see below) only the slots whose three nodes
// already exist on the host will do: the numbered ones (1, 2, ...) are preferred
// and it falls back to slot 0 (/dev/binder, no suffix) if there is no other --
// the case of a host with the module's default `devices=binder,hwbinder,
// vndbinder` (confirmed on n02).
function nextFreeSlot({
  legacy = useLegacyBinder(), exists = fs.existsSync, reserved = reservedSlots(), accessible = worldAccessible,
} = {}) {
  const used = new Set(store.readAll().map((i) => i.binderSlot).filter((s) => s != null));
  for (const r of reserved) used.add(r);
  if (!legacy) {
    let slot = 1;
    while (used.has(slot)) slot++;
    return slot;
  }
  const candidates = [];
  for (let n = 1; n <= 32; n++) candidates.push(n);
  candidates.push(0);
  const free = candidates.find((n) => !used.has(n)
    && legacyNodeNames(n).every((name) => exists(`/dev/${name}`)) && restrictedNodes(n, accessible, exists).length === 0);
  if (free === undefined) {
    const restricted = candidates.filter((n) => !used.has(n)).flatMap((n) => restrictedNodes(n, accessible, exists));
    if (restricted.length > 0) {
      throw new Error(
        `binder legacy: the free slots are not usable because their nodes are not world-accessible (${restricted.slice(0, 3).join(', ')}...). `
        + 'Android\'s servicemanager runs as a non-root user inside the container: chmod 0666 the binder nodes (e.g. `chmod 0666 /dev/binder /dev/hwbinder /dev/vndbinder /dev/binder[0-9]* /dev/hwbinder[0-9]* /dev/vndbinder[0-9]*` as root).',
      );
    }
    throw new Error(
      'binder legacy: there is no free slot with its three nodes in /dev. ' +
      'Extend "options binder_linux devices=..." (see Doctor, `node backend/scripts/binder-devices.js`) and reboot: the module cannot be reloaded.'
    );
  }
  return free;
}

// Kernels without CONFIG_ANDROID_BINDERFS (e.g. jgustavo46, see Doctor): there is
// no binderfs or binder-control, the nodes are created by the binder_linux module
// when it loads, according to its `devices=` parameter (/dev/binderN,
// /dev/hwbinderN, ...). They cannot be created on the fly -- if the requested slot
// is not in `devices=`, that parameter has to be extended and the module reloaded.
// Slot 0 = nodes without a suffix (/dev/binder); slot N>=1 = /dev/binderN.
function legacyNodeNames(slot) {
  const suffix = slot === 0 ? '' : String(slot);
  return [`binder${suffix}`, `hwbinder${suffix}`, `vndbinder${suffix}`];
}

// The value of `options binder_linux devices=...` that creates `slots` slots (0 .. slots-1): slot 0 is
// the nodes without a suffix, the rest are numbered. It is a superset of what Waydroid's package asks for
// (binder,hwbinder,vndbinder + the same with 1 and 2), in the same order. Pure.
function legacyDevicesParam(slots) {
  if (!Number.isInteger(slots) || slots < 1 || slots > 64) throw new Error('slots must be an integer between 1 and 64');
  const names = [];
  for (let n = 0; n < slots; n++) names.push(...legacyNodeNames(n));
  return names.join(',');
}

// A node is only usable if EVERY user can open it for reading and writing (mode 0666): the servicemanager
// of Android runs as a non-root user inside the container, and with a root-only node (the module creates
// them 0600) the instance dies a few seconds after starting (exit 129) -- found out on 10/10/2026 with
// slot 0 of the Polaris. A node that does not exist counts as accessible here: that is reported on its own.
function worldAccessible(p) {
  try { return (fs.statSync(p).mode & 0o006) === 0o006; } catch { return true; }
}

function restrictedNodes(slot, accessible = worldAccessible, exists = fs.existsSync) {
  return legacyNodeNames(slot).map((n) => `/dev/${n}`).filter((p) => exists(p) && !accessible(p));
}

function useLegacyBinder(exists = fs.existsSync) {
  return !exists(`${BINDERFS_ROOT}/binder-control`);
}

// Returns the Docker binds "/dev/binderfs/binderN:/dev/binder" (and hwbinder/vndbinder)
// for a given slot, creating the devices if needed. In legacy mode the source is
// "/dev/binderN" and it must already exist.
function binderBinds(slot, { legacy = useLegacyBinder(), exists = fs.existsSync, accessible = worldAccessible } = {}) {
  const targets = ['/dev/binder', '/dev/hwbinder', '/dev/vndbinder'];
  if (legacy) {
    const names = legacyNodeNames(slot);
    const missing = names.filter((n) => !exists(`/dev/${n}`));
    if (missing.length) {
      throw new Error(
        `binder legacy: /dev/${missing.join(', /dev/')} missing -- the binder_linux module did not create them. ` +
        'Extend "options binder_linux devices=..." (see Doctor, `node backend/scripts/binder-devices.js`) and reboot: the module cannot be reloaded.'
      );
    }
    const restricted = restrictedNodes(slot, accessible, exists);
    if (restricted.length) {
      throw new Error(
        `binder legacy: ${restricted.join(', ')} are not world-accessible (mode 0666 needed): Android's servicemanager runs as a non-root user `
        + 'inside the container and the instance would die a few seconds after starting.',
      );
    }
    return names.map((n, i) => `/dev/${n}:${targets[i]}`);
  }
  const names = [`binder${slot}`, `hwbinder${slot}`, `vndbinder${slot}`];
  names.forEach(ensureBinderDevice);
  return names.map((n, i) => `${BINDERFS_ROOT}/${n}:${targets[i]}`);
}

module.exports = {
  nextFreeSlot, binderBinds, useLegacyBinder, reservedSlots, legacyDevicesParam, legacyNodeNames, restrictedNodes, worldAccessible, BINDERFS_ROOT,
};

const fs = require('fs');
const { execFileSync } = require('child_process');
const store = require('./store');

const BINDERFS_ROOT = '/dev/binderfs';

// Porta ensureBinderDevice() de host-resource-allocator.service.ts. Corre
// como root dentro del contenedor privilegiado --pid=host, así que no hace
// falta sudo (a diferencia del original en plenum-redroid).
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

// Slots: sin el offset de convivencia con jg-dashboard v1 de plenum-redroid —
// acá el store propio es la única fuente de verdad, así que alcanza con
// tomar el próximo entero libre.
function nextFreeSlot() {
  const used = new Set(store.readAll().map((i) => i.binderSlot).filter(Boolean));
  let slot = 1;
  while (used.has(slot)) slot++;
  return slot;
}

// Devuelve los binds Docker "/dev/binderfs/binderN:/dev/binder" (y hwbinder/vndbinder)
// para un slot dado, creando los dispositivos si hace falta.
function binderBinds(slot) {
  const names = [`binder${slot}`, `hwbinder${slot}`, `vndbinder${slot}`];
  const targets = ['/dev/binder', '/dev/hwbinder', '/dev/vndbinder'];
  names.forEach(ensureBinderDevice);
  return names.map((n, i) => `${BINDERFS_ROOT}/${n}:${targets[i]}`);
}

module.exports = { nextFreeSlot, binderBinds, BINDERFS_ROOT };

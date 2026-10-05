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

// Kernels sin CONFIG_ANDROID_BINDERFS (ej. jgustavo46, ver Doctor): no hay
// binderfs ni binder-control, los nodos los crea el modulo binder_linux al
// cargarse, segun su parametro `devices=` (/dev/binderN, /dev/hwbinderN, ...).
// No se pueden crear en caliente -- si el slot pedido no esta en `devices=`,
// hay que ampliar ese parametro y recargar el modulo.
function useLegacyBinder(exists = fs.existsSync) {
  return !exists(`${BINDERFS_ROOT}/binder-control`);
}

// Devuelve los binds Docker "/dev/binderfs/binderN:/dev/binder" (y hwbinder/vndbinder)
// para un slot dado, creando los dispositivos si hace falta. En modo legacy el
// origen es "/dev/binderN" y se exige que ya exista.
function binderBinds(slot, { legacy = useLegacyBinder(), exists = fs.existsSync } = {}) {
  const names = [`binder${slot}`, `hwbinder${slot}`, `vndbinder${slot}`];
  const targets = ['/dev/binder', '/dev/hwbinder', '/dev/vndbinder'];
  if (legacy) {
    const missing = names.filter((n) => !exists(`/dev/${n}`));
    if (missing.length) {
      throw new Error(
        `binder legacy: faltan /dev/${missing.join(', /dev/')} -- el modulo binder_linux no los creo. ` +
        'Ampliar "options binder_linux devices=..." (ver Doctor) y recargar el modulo.'
      );
    }
    return names.map((n, i) => `/dev/${n}:${targets[i]}`);
  }
  names.forEach(ensureBinderDevice);
  return names.map((n, i) => `${BINDERFS_ROOT}/${n}:${targets[i]}`);
}

module.exports = { nextFreeSlot, binderBinds, useLegacyBinder, BINDERFS_ROOT };

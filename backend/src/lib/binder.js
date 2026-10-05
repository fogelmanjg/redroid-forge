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
// tomar el próximo entero libre. En modo binderfs los nodos se crean a pedido,
// así que cualquier slot >= 1 sirve. En modo legacy (ver abajo) solo sirven
// los slots cuyos tres nodos ya existen en el host: se prefieren los
// numerados (1, 2, ...) y se cae al slot 0 (/dev/binder, sin sufijo) si no
// hay otro -- caso de un host con el default `devices=binder,hwbinder,
// vndbinder` del modulo (confirmado en n02).
function nextFreeSlot({ legacy = useLegacyBinder(), exists = fs.existsSync } = {}) {
  const used = new Set(store.readAll().map((i) => i.binderSlot).filter((s) => s != null));
  if (!legacy) {
    let slot = 1;
    while (used.has(slot)) slot++;
    return slot;
  }
  const candidates = [];
  for (let n = 1; n <= 32; n++) candidates.push(n);
  candidates.push(0);
  const free = candidates.find((n) => !used.has(n) && legacyNodeNames(n).every((name) => exists(`/dev/${name}`)));
  if (free === undefined) {
    throw new Error(
      'binder legacy: no hay ningun slot libre con sus tres nodos en /dev. ' +
      'Ampliar "options binder_linux devices=..." (ver Doctor) y recargar el modulo.'
    );
  }
  return free;
}

// Kernels sin CONFIG_ANDROID_BINDERFS (ej. jgustavo46, ver Doctor): no hay
// binderfs ni binder-control, los nodos los crea el modulo binder_linux al
// cargarse, segun su parametro `devices=` (/dev/binderN, /dev/hwbinderN, ...).
// No se pueden crear en caliente -- si el slot pedido no esta en `devices=`,
// hay que ampliar ese parametro y recargar el modulo.
// Slot 0 = nodos sin sufijo (/dev/binder); slot N>=1 = /dev/binderN.
function legacyNodeNames(slot) {
  const suffix = slot === 0 ? '' : String(slot);
  return [`binder${suffix}`, `hwbinder${suffix}`, `vndbinder${suffix}`];
}

function useLegacyBinder(exists = fs.existsSync) {
  return !exists(`${BINDERFS_ROOT}/binder-control`);
}

// Devuelve los binds Docker "/dev/binderfs/binderN:/dev/binder" (y hwbinder/vndbinder)
// para un slot dado, creando los dispositivos si hace falta. En modo legacy el
// origen es "/dev/binderN" y se exige que ya exista.
function binderBinds(slot, { legacy = useLegacyBinder(), exists = fs.existsSync } = {}) {
  const targets = ['/dev/binder', '/dev/hwbinder', '/dev/vndbinder'];
  if (legacy) {
    const names = legacyNodeNames(slot);
    const missing = names.filter((n) => !exists(`/dev/${n}`));
    if (missing.length) {
      throw new Error(
        `binder legacy: faltan /dev/${missing.join(', /dev/')} -- el modulo binder_linux no los creo. ` +
        'Ampliar "options binder_linux devices=..." (ver Doctor) y recargar el modulo.'
      );
    }
    return names.map((n, i) => `/dev/${n}:${targets[i]}`);
  }
  const names = [`binder${slot}`, `hwbinder${slot}`, `vndbinder${slot}`];
  names.forEach(ensureBinderDevice);
  return names.map((n, i) => `${BINDERFS_ROOT}/${n}:${targets[i]}`);
}

module.exports = { nextFreeSlot, binderBinds, useLegacyBinder, BINDERFS_ROOT };

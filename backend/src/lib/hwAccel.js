const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

// Mismo patron que BINDERFS_ROOT en binder.js: directorio real del host,
// bind-mounteado en docker-compose.yml hacia el contenedor del backend, y
// hacia cada instancia que lo necesite via el bind que devuelve daemonBind().
const VAAPI_ROOT = '/dev/vaapi-helper';
const SOCKET_PATH = `${VAAPI_ROOT}/socket`;
const DAEMON_BIN = path.join(__dirname, '..', '..', 'native', 'vaapi-daemon', 'daemon');
const DAEMON_START_TIMEOUT_MS = 5000;

function log(msg) { console.log(`[hwAccel] ${msg}`); }
function warn(msg) { console.warn(`[hwAccel] ${msg}`); }

let daemonProcess = null;

// AMD/Intel exponen VA-API encode real (radeonsi/iHD). NVIDIA solo expone
// decode via nvidia-vaapi-driver (VAEntrypointVLD, no EncSlice) -- el
// encode en hosts NVIDIA es un componente aparte (redroid-nvidia, Venus-proxy
// + NVENC, Fase 2 paso 2), no este daemon. Ver README de redroid-hwenc,
// seccion "Why NVIDIA isn't in the encode table".
async function detectGpuVendor() {
  try {
    const { stdout } = await execFileAsync('lspci', ['-nnk']);
    const blocks = stdout.split(/\n(?=\S)/).filter((b) => /VGA compatible controller|3D controller|Display controller/.test(b));
    if (blocks.some((b) => /NVIDIA/i.test(b))) return 'nvidia';
    if (blocks.some((b) => /(Advanced Micro Devices|AMD\/ATI|\bATI\b)/i.test(b))) return 'amd';
    if (blocks.some((b) => /Intel/i.test(b))) return 'intel';
    return 'unknown';
  } catch (e) {
    warn(`lspci fallo, no se pudo detectar el vendor de GPU: ${e.message}`);
    return 'unknown';
  }
}

function encodeSupported(vendor) {
  return vendor === 'amd' || vendor === 'intel';
}

function isDaemonAlive() {
  return daemonProcess !== null && !daemonProcess.killed && fs.existsSync(SOCKET_PATH);
}

// Un solo daemon por host, compartido por todas las instancias -- no es un
// proceso por instancia. Idempotente: no hace nada si ya esta corriendo.
async function ensureDaemonRunning() {
  if (isDaemonAlive()) return;

  if (!fs.existsSync(DAEMON_BIN)) {
    throw new Error(`Binario del daemon VA-API no encontrado en ${DAEMON_BIN} (deberia compilarse al construir la imagen, ver backend/native/vaapi-daemon/Makefile)`);
  }

  fs.mkdirSync(VAAPI_ROOT, { recursive: true });
  fs.chmodSync(VAAPI_ROOT, 0o777);
  // Un socket viejo de un daemon anterior que murio sin limpiar bloquea el bind().
  fs.rmSync(SOCKET_PATH, { force: true });

  daemonProcess = spawn(DAEMON_BIN, [], { stdio: ['ignore', 'pipe', 'pipe'] });
  daemonProcess.stdout.on('data', (d) => log(d.toString().trim()));
  daemonProcess.stderr.on('data', (d) => warn(d.toString().trim()));
  daemonProcess.on('exit', (code, signal) => {
    warn(`el daemon VA-API termino (code=${code}, signal=${signal}) -- se reintenta en el proximo ensureDaemonRunning()`);
    daemonProcess = null;
  });

  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
  while (!fs.existsSync(SOCKET_PATH)) {
    if (!daemonProcess) throw new Error('El daemon VA-API murio antes de abrir su socket -- revisar logs de stderr arriba');
    if (Date.now() > deadline) throw new Error(`El daemon VA-API no abrio ${SOCKET_PATH} a tiempo`);
    await new Promise((r) => setTimeout(r, 100));
  }
  log(`daemon VA-API arriba, escuchando en ${SOCKET_PATH}`);
}

// Bind Docker "/dev/vaapi-helper:/dev/vaapi-helper" -- mismo host path a
// ambos lados, igual que binderBinds() en binder.js, para que el socket
// AF_UNIX sea el mismo archivo real visto por el backend y por la instancia.
function daemonBind() {
  return `${VAAPI_ROOT}:${VAAPI_ROOT}`;
}

module.exports = { detectGpuVendor, encodeSupported, ensureDaemonRunning, daemonBind, VAAPI_ROOT, SOCKET_PATH };

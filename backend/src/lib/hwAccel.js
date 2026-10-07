const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const net = require('net');

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

// Supervision del daemon: si muere (por ejemplo, un reset del GPU de amdgpu lo aborta con SIGABRT -- "The CS has
// cancelled because the context is lost"), el encode y el decode por hardware de TODAS las instancias quedan
// caidos hasta que alguien lo relance. Se relanza solo, con espera creciente para no entrar en un bucle apretado
// si muere apenas arranca (driver roto, GPU que no vuelve).
const RESTART_MIN_MS = 1000;
const RESTART_MAX_MS = 30000;
const STABLE_UPTIME_MS = 60000; // si vivio al menos esto, el proximo reinicio vuelve a empezar desde el minimo
let daemonWanted = false;
let restartTimer = null;
let restartDelayMs = RESTART_MIN_MS;
let daemonStartedAt = 0;

// Pura (para probarla): cuanto esperar antes de relanzar, dado cuanto vivio la ultima vez y la espera anterior.
// Devuelve { wait, next }: esperar `wait` ahora y usar `next` como espera anterior la proxima vez.
function nextRestartDelay(prevDelayMs, uptimeMs) {
  const wait = uptimeMs >= STABLE_UPTIME_MS ? RESTART_MIN_MS : Math.max(RESTART_MIN_MS, prevDelayMs);
  return { wait, next: Math.min(wait * 2, RESTART_MAX_MS) };
}

function scheduleDaemonRestart(uptimeMs) {
  if (!daemonWanted || restartTimer) return;
  const { wait, next } = nextRestartDelay(restartDelayMs, uptimeMs);
  restartDelayMs = next;
  warn(`el daemon VA-API se relanza en ${Math.round(wait / 1000)} s`);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    ensureDaemonRunning().catch((e) => {
      warn(`no se pudo relanzar el daemon VA-API: ${e.message}`);
      scheduleDaemonRestart(0);
    });
  }, wait);
  if (restartTimer.unref) restartTimer.unref();
}

// Apagado ordenado: deja de relanzar y mata al daemon.
function stopDaemon() {
  daemonWanted = false;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (daemonProcess) daemonProcess.kill();
}

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
  daemonWanted = true;
  if (isDaemonAlive()) return;

  if (!fs.existsSync(DAEMON_BIN)) {
    throw new Error(`Binario del daemon VA-API no encontrado en ${DAEMON_BIN} (deberia compilarse al construir la imagen, ver backend/native/vaapi-daemon/Makefile)`);
  }

  fs.mkdirSync(VAAPI_ROOT, { recursive: true });
  fs.chmodSync(VAAPI_ROOT, 0o777);
  // Un socket viejo de un daemon anterior que murio sin limpiar bloquea el bind().
  fs.rmSync(SOCKET_PATH, { force: true });

  daemonProcess = spawn(DAEMON_BIN, [], { stdio: ['ignore', 'pipe', 'pipe'] });
  daemonStartedAt = Date.now();
  daemonProcess.stdout.on('data', (d) => log(d.toString().trim()));
  daemonProcess.stderr.on('data', (d) => warn(d.toString().trim()));
  daemonProcess.on('exit', (code, signal) => {
    warn(`el daemon VA-API termino (code=${code}, signal=${signal})`);
    daemonProcess = null;
    scheduleDaemonRestart(Date.now() - daemonStartedAt);
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

// ---- Decode por hardware (protocolo hwdec v2, backend/native/vaapi-daemon/protocol.h) ----
//
// Cada host decodifica por hardware solo lo que su GPU ofrece (ej. Polaris: H.264 y HEVC; Iris Xe
// ademas VP9). El daemon lo averigua con VA-API y lo informa por VAAPI_CMD_HWDEC_CAPS; el modulo
// hwenc registra en Android SOLO esos decoders (ver integrate.js), para que el reproductor nunca
// reciba uno que el hardware no puede sostener.
const VAAPI_CMD_HWDEC_CAPS = 4;
const HWDEC_CAPS_RESPONSE_SIZE = 176; // int32 status, u32 reservado, u32 mask, u32 mask10, char[160] driver
// Indice de codec en el protocolo -> componente Codec2 que existe para ese codec. Los codecs que el
// hardware puede decodificar pero para los que todavia no hay componente en Android (vp8, mpeg2, vc1,
// av1) no aparecen: no hay nada que registrar.
const HWDEC_COMPONENTS = {
  0: { id: 'h264', name: 'c2.hardware.decoder.h264', type: 'video/avc' },
  1: { id: 'hevc', name: 'c2.hardware.decoder.hevc', type: 'video/hevc' },
  2: { id: 'vp9', name: 'c2.hardware.decoder.vp9', type: 'video/x-vnd.on2.vp9' },
};

function parseHwdecCaps(buf) {
  if (buf.length < HWDEC_CAPS_RESPONSE_SIZE) return null;
  const status = buf.readInt32LE(0);
  const mask = buf.readUInt32LE(8);
  const mask10 = buf.readUInt32LE(12);
  const end = buf.indexOf(0, 16);
  const driver = buf.toString('utf-8', 16, end < 0 || end > 176 ? 176 : end);
  if (status !== 0) return { driver, codecs: [] };
  const codecs = Object.entries(HWDEC_COMPONENTS)
    .filter(([i]) => (mask >>> Number(i)) & 1)
    .map(([i, c]) => ({ ...c, tenBit: Boolean((mask10 >>> Number(i)) & 1) }));
  return { driver, codecs };
}

// Resuelve siempre: si el daemon no esta, esta compilado sin HWDEC (cierra la conexion sin responder)
// o no contesta a tiempo, el resultado es "ningun decoder", nunca un error.
function queryHwdecCaps({ socketPath = SOCKET_PATH, timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    const none = { driver: null, codecs: [] };
    const chunks = [];
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(value);
    };
    const sock = net.createConnection(socketPath);
    sock.setTimeout(timeoutMs, () => finish(none));
    sock.on('connect', () => {
      const tag = Buffer.alloc(4);
      tag.writeUInt32LE(VAAPI_CMD_HWDEC_CAPS, 0);
      sock.write(tag);
    });
    sock.on('data', (d) => {
      chunks.push(d);
      if (Buffer.concat(chunks).length >= HWDEC_CAPS_RESPONSE_SIZE) {
        finish(parseHwdecCaps(Buffer.concat(chunks)) || none);
      }
    });
    sock.on('error', () => finish(none));
    sock.on('close', () => finish(parseHwdecCaps(Buffer.concat(chunks)) || none));
  });
}

module.exports = {
  detectGpuVendor, encodeSupported, ensureDaemonRunning, stopDaemon, nextRestartDelay, daemonBind, queryHwdecCaps, parseHwdecCaps,
  HWDEC_COMPONENTS, VAAPI_ROOT, SOCKET_PATH,
};

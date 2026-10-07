const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const net = require('net');

const execFileAsync = promisify(execFile);

// The same pattern as BINDERFS_ROOT in binder.js: a real directory of the host,
// bind-mounted in docker-compose.yml into the backend's container, and into every
// instance that needs it via the bind that daemonBind() returns.
const VAAPI_ROOT = '/dev/vaapi-helper';
const SOCKET_PATH = `${VAAPI_ROOT}/socket`;
const DAEMON_BIN = path.join(__dirname, '..', '..', 'native', 'vaapi-daemon', 'daemon');
const DAEMON_START_TIMEOUT_MS = 5000;

function log(msg) { console.log(`[hwAccel] ${msg}`); }
function warn(msg) { console.warn(`[hwAccel] ${msg}`); }

let daemonProcess = null;

// Daemon supervision: if it dies (for example, an amdgpu GPU reset aborts it with SIGABRT -- "The CS has
// cancelled because the context is lost"), the hardware encode and decode of ALL the instances stay down until
// somebody relaunches it. It relaunches itself, with an increasing wait so as not to enter a tight loop if it
// dies as soon as it starts (a broken driver, a GPU that does not come back).
const RESTART_MIN_MS = 1000;
const RESTART_MAX_MS = 30000;
const STABLE_UPTIME_MS = 60000; // if it lived at least this long, the next restart starts again from the minimum
let daemonWanted = false;
let restartTimer = null;
let restartDelayMs = RESTART_MIN_MS;
let daemonStartedAt = 0;

// Pure (so it can be tested): how long to wait before relaunching, given how long it lived last time and the
// previous wait. It returns { wait, next }: wait `wait` now and use `next` as the previous wait next time.
function nextRestartDelay(prevDelayMs, uptimeMs) {
  const wait = uptimeMs >= STABLE_UPTIME_MS ? RESTART_MIN_MS : Math.max(RESTART_MIN_MS, prevDelayMs);
  return { wait, next: Math.min(wait * 2, RESTART_MAX_MS) };
}

function scheduleDaemonRestart(uptimeMs) {
  if (!daemonWanted || restartTimer) return;
  const { wait, next } = nextRestartDelay(restartDelayMs, uptimeMs);
  restartDelayMs = next;
  warn(`the VA-API daemon is relaunched in ${Math.round(wait / 1000)} s`);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    ensureDaemonRunning().catch((e) => {
      warn(`could not relaunch the VA-API daemon: ${e.message}`);
      scheduleDaemonRestart(0);
    });
  }, wait);
  if (restartTimer.unref) restartTimer.unref();
}

// Orderly shutdown: it stops relaunching and kills the daemon.
function stopDaemon() {
  daemonWanted = false;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (daemonProcess) daemonProcess.kill();
}

// AMD/Intel expose real VA-API encode (radeonsi/iHD). NVIDIA only exposes
// decode via nvidia-vaapi-driver (VAEntrypointVLD, not EncSlice) -- encode on
// NVIDIA hosts is a separate component (redroid-nvidia, Venus-proxy
// + NVENC, Phase 2 step 2), not this daemon. See redroid-hwenc's README,
// section "Why NVIDIA isn't in the encode table".
async function detectGpuVendor() {
  try {
    const { stdout } = await execFileAsync('lspci', ['-nnk']);
    const blocks = stdout.split(/\n(?=\S)/).filter((b) => /VGA compatible controller|3D controller|Display controller/.test(b));
    if (blocks.some((b) => /NVIDIA/i.test(b))) return 'nvidia';
    if (blocks.some((b) => /(Advanced Micro Devices|AMD\/ATI|\bATI\b)/i.test(b))) return 'amd';
    if (blocks.some((b) => /Intel/i.test(b))) return 'intel';
    return 'unknown';
  } catch (e) {
    warn(`lspci failed, the GPU vendor could not be detected: ${e.message}`);
    return 'unknown';
  }
}

function encodeSupported(vendor) {
  return vendor === 'amd' || vendor === 'intel';
}

function isDaemonAlive() {
  return daemonProcess !== null && !daemonProcess.killed && fs.existsSync(SOCKET_PATH);
}

// A single daemon per host, shared by all the instances -- it is not a process
// per instance. Idempotent: it does nothing if it is already running.
async function ensureDaemonRunning() {
  daemonWanted = true;
  if (isDaemonAlive()) return;

  if (!fs.existsSync(DAEMON_BIN)) {
    throw new Error(`VA-API daemon binary not found at ${DAEMON_BIN} (it should be built when the image is built, see backend/native/vaapi-daemon/Makefile)`);
  }

  fs.mkdirSync(VAAPI_ROOT, { recursive: true });
  fs.chmodSync(VAAPI_ROOT, 0o777);
  // An old socket from a previous daemon that died without cleaning up blocks bind().
  fs.rmSync(SOCKET_PATH, { force: true });

  daemonProcess = spawn(DAEMON_BIN, [], { stdio: ['ignore', 'pipe', 'pipe'] });
  daemonStartedAt = Date.now();
  daemonProcess.stdout.on('data', (d) => log(d.toString().trim()));
  daemonProcess.stderr.on('data', (d) => warn(d.toString().trim()));
  daemonProcess.on('exit', (code, signal) => {
    warn(`the VA-API daemon ended (code=${code}, signal=${signal})`);
    daemonProcess = null;
    scheduleDaemonRestart(Date.now() - daemonStartedAt);
  });

  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
  while (!fs.existsSync(SOCKET_PATH)) {
    if (!daemonProcess) throw new Error('The VA-API daemon died before opening its socket -- check the stderr logs above');
    if (Date.now() > deadline) throw new Error(`The VA-API daemon did not open ${SOCKET_PATH} in time`);
    await new Promise((r) => setTimeout(r, 100));
  }
  log(`VA-API daemon up, listening on ${SOCKET_PATH}`);
}

// Docker bind "/dev/vaapi-helper:/dev/vaapi-helper" -- the same host path on
// both sides, like binderBinds() in binder.js, so that the AF_UNIX socket is the
// same real file seen by the backend and by the instance.
function daemonBind() {
  return `${VAAPI_ROOT}:${VAAPI_ROOT}`;
}

// ---- Hardware decode (hwdec protocol v2, backend/native/vaapi-daemon/protocol.h) ----
//
// Every host decodes in hardware only what its GPU offers (e.g. Polaris: H.264 and HEVC; Iris Xe
// also VP9). The daemon finds out with VA-API and reports it through VAAPI_CMD_HWDEC_CAPS; the hwenc
// module registers in Android ONLY those decoders (see integrate.js), so that the player never
// receives one the hardware cannot sustain.
const VAAPI_CMD_HWDEC_CAPS = 4;
const HWDEC_CAPS_RESPONSE_SIZE = 176; // int32 status, u32 reserved, u32 mask, u32 mask10, char[160] driver
// Codec index in the protocol -> the Codec2 component that exists for that codec. The codecs the
// hardware can decode but for which there is no component in Android yet (vp8, mpeg2, vc1, av1) do
// not appear: there is nothing to register.
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

// It always resolves: if the daemon is not there, is built without HWDEC (it closes the connection without
// answering) or does not answer in time, the result is "no decoder", never an error.
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

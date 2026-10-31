const fs = require('fs');
const net = require('net');

// Host-side counterpart of the "nvenc" module (NVIDIA hardware encode, backend/native/
// nvenc-daemon) -- see that directory's README for why this is NOT spawned by this backend
// the way hwAccel.js spawns vaapi-daemon. The backend image is Alpine/musl; the daemon dlopen()s
// three proprietary glibc blobs (libcuda.so.1, libnvidia-encode.so.1, libvulkan.so.1) that a
// musl process cannot be relied on to load. The daemon instead runs as its own systemd unit on
// the host (see nvenc-daemon.service.example) -- this file only ever CONNECTS to its socket,
// the same "adopt, never replace" path hwAccel.js already has for a second forge's daemon on
// the same host (see its own socketAnswers()/ensureDaemonRunning() comment).
const NVENC_ROOT = process.env.REDROID_FORGE_NVENC_DIR || '/dev/nvenc-helper';
const SOCKET_PATH = `${NVENC_ROOT}/socket`;
// The guest component dials a fixed path, /dev/venus/nvenc-scm.sock (see android/nvenc_codec2/
// component/vtest_encode_client.cpp) -- this project's own instances never run a real Venus
// socket alongside it (gpuMode stays "guest"), so /dev/venus only ever has this one file in it.
const INSTANCE_NVENC_DIR = '/dev/venus';

function socketAnswers(socketPath = SOCKET_PATH, timeoutMs = 1000) {
  return new Promise((resolve) => {
    if (!fs.existsSync(socketPath)) { resolve(false); return; }
    const c = net.connect(socketPath);
    const done = (ok) => { c.destroy(); resolve(ok); };
    c.setTimeout(timeoutMs, () => done(false));
    c.on('connect', () => done(true));
    c.on('error', () => done(false));
  });
}

// Stage 5 (moduleRunner.js): unlike hwAccel's ensureDaemonRunning, this never starts a process
// of its own -- see this file's own top comment for why. A clear, actionable error instead of a
// silent no-op: the alternative (letting instance creation proceed with no real encoder behind
// it) would surface as a much more confusing failure later, inside the Android guest.
async function ensureDaemonRunning() {
  if (await socketAnswers()) return;
  throw new Error(
    `No NVENC daemon answers at ${SOCKET_PATH}. Install it as a systemd service `
    + '(see backend/native/nvenc-daemon/README.md and nvenc-daemon.service.example) and start it '
    + 'on the HOST, not inside this container -- it is not something this backend can spawn itself.',
  );
}

// Docker bind "<NVENC_ROOT>:/dev/venus" -- the directory holding the daemon's socket, bound at
// the fixed path the guest component dials. Same trick as hwAccel.js's daemonBind()/binder.js.
function daemonBind() {
  return `${NVENC_ROOT}:${INSTANCE_NVENC_DIR}`;
}

module.exports = {
  NVENC_ROOT, SOCKET_PATH, INSTANCE_NVENC_DIR, socketAnswers, ensureDaemonRunning, daemonBind,
};

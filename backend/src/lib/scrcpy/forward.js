'use strict';

// Bridges scrcpy-server's abstract Unix-domain sockets (inside the instance's Android network
// namespace) to a real host-reachable TCP port, via `adb forward` -- the same mechanism the real
// desktop scrcpy client uses, and the only practical way to reach an abstract socket from outside
// its netns without a much more invasive nsenter-style approach. Goes through each instance's
// already-existing, already-externally-reachable `adbPort` (see routes/instances.js, and
// scripts/connect.sh's own `adb connect $HOST:$PORT` for the exact same target).
//
// Deliberately NOT `portAllocator.js` for the local TCP ports this allocates: that module is for
// the user-facing `adbPort` range (a fixed pool, persisted, checked for conflicts across
// instances) -- these are purely internal, ephemeral, one per active viewer session, freed the
// moment the session ends, never persisted or exposed to a user.

const net = require('net');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

// 127.0.0.1:0 -- let the OS pick a free ephemeral port, then release it immediately. Same
// well-known technique used anywhere a "give me a free port" helper is needed; there's a narrow
// window where another process could grab it before `adb forward` binds it for real, same
// unavoidable race any such helper has.
function allocateLocalPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function adb(args) {
  const { stdout } = await execFileAsync('adb', args);
  return stdout;
}

// Idempotent-ish: a target already connected still returns success (adb's own behavior), so no
// need to check first -- mirrors scripts/connect.sh's own `adb connect ... >/dev/null` call.
async function ensureConnected(host, adbPort) {
  await adb(['connect', `${host}:${adbPort}`]);
}

// `scrcpySocketName`: the abstract socket name scrcpy-server listens on for this session (e.g.
// `scrcpy_<scid>` -- exact format confirmed against the real protocol in launchServer.js).
async function addForward(host, adbPort, localPort, scrcpySocketName) {
  await adb(['-s', `${host}:${adbPort}`, 'forward', `tcp:${localPort}`, `localabstract:${scrcpySocketName}`]);
}

async function removeForward(host, adbPort, localPort) {
  try {
    await adb(['-s', `${host}:${adbPort}`, 'forward', '--remove', `tcp:${localPort}`]);
  } catch (e) { /* already gone (session/device disconnected) -- not an error for a teardown path */ }
}

module.exports = { allocateLocalPort, ensureConnected, addForward, removeForward };

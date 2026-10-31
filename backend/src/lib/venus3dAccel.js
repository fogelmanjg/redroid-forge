'use strict';

const fs = require('fs');
const net = require('net');

// Host-side counterpart of the "venus3d" module (real 3D acceleration on NVIDIA hosts via a
// Venus-proxy pipeline, ported from redroid-nvidia's Tier 4/5) -- see backend/native/
// venus3d-daemon/README.md for why this is NOT spawned by this backend, same reasoning as
// nvencAccel.js: the daemon (virgl_test_server + its virgl_render_server helper) links against
// the real NVIDIA userspace driver (libcuda/libvulkan/EGL), which this backend's Alpine/musl
// image cannot be relied on to dlopen(). It runs as its own systemd unit on the host; this file
// only ever CONNECTS to its socket.
//
// Reuses nvenc's own host directory (REDROID_FORGE_NVENC_DIR, default /dev/nvenc-helper)
// rather than introducing a second one -- nvenc-daemon's own README already documents that its
// SCM socket has to live in "the same directory bind-mounted into the redroid container as
// /dev/venus", precisely so a real Venus socket can sit alongside it. Both daemons' sockets end
// up as two plain files in that one host directory; each one is bind-mounted into the guest at
// its own, independent, fixed path (see daemonBind() below for this module's one file --
// nvencAccel.js's own daemonBind() mounts the whole directory at /dev/venus instead, for its
// different, already-fixed guest-side path).
const VENUS_ROOT = process.env.REDROID_FORGE_NVENC_DIR || '/dev/nvenc-helper';
const SOCKET_FILENAME = 'venus.sock';
const HOST_SOCKET_PATH = `${VENUS_ROOT}/${SOCKET_FILENAME}`;
// Mesa's guest Venus driver (vn_renderer_vtest.c) dials VTEST_SOCKET_NAME if set, else the
// upstream default "/tmp/.virgl_test" (vtest_protocol.h's VTEST_DEFAULT_SOCKET_NAME -- this
// project's own Mesa patch did not change that default, confirmed by diff).
//
// Real gap found on real hardware (31/10/2026): a single-file bind mount under /dev or /tmp
// does NOT survive to be visible inside the guest -- Android's own init remounts BOTH of those
// as fresh tmpfs during boot (confirmed via `mount` inside a running instance: "tmpfs on /dev
// type tmpfs", "tmpfs on /tmp type tmpfs"), which shadows whatever Docker bind-mounted there at
// container-create time. /vendor is not remounted this way (it is the actual vendor partition
// Docker itself backs, and this module's own installFiles() already proves files placed there
// at stage 4 survive into the booted guest) -- so the socket is bound there instead. A global
// init-level `export` (tried first, via a new /vendor/etc/init/*.rc) never actually reached
// surfaceflinger's own environment (confirmed via /proc/1/environ post-boot -- no other .rc
// file in the stock image uses `export` at all, so there was no working precedent for its
// trigger timing); venus3dService.js's patchSurfaceflingerRc() instead adds a
// `setenv VTEST_SOCKET_NAME ...` line directly to surfaceflinger's own service block in
// system/etc/init/surfaceflinger.rc, the well-documented, narrowly-scoped mechanism that is
// confirmed to work.
const GUEST_SOCKET_PATH = '/vendor/venus.sock';

function socketAnswers(socketPath = HOST_SOCKET_PATH, timeoutMs = 1000) {
  return new Promise((resolve) => {
    if (!fs.existsSync(socketPath)) { resolve(false); return; }
    const c = net.connect(socketPath);
    const done = (ok) => { c.destroy(); resolve(ok); };
    c.setTimeout(timeoutMs, () => done(false));
    c.on('connect', () => done(true));
    c.on('error', () => done(false));
  });
}

// Stage 5 (moduleRunner.js): never starts a process of its own, same reasoning as nvencAccel's
// own ensureDaemonRunning -- a clear, actionable error instead of letting instance creation
// proceed with no real Venus renderer behind it (a vague boot-time crash later, in the guest).
async function ensureHostInfraReady() {
  if (await socketAnswers()) return;
  throw new Error(
    `No Venus/virgl_test_server daemon answers at ${HOST_SOCKET_PATH}. Install it as a systemd `
    + 'service (see backend/native/venus3d-daemon/README.md and venus3d-daemon.service.example) '
    + 'and start it on the HOST, not inside this container.',
  );
}

// Docker bind "<venus.sock on the host>:/tmp/.virgl_test" -- a single-file bind (not a
// directory, unlike nvencAccel's own daemonBind()), since the guest-side path this needs to
// land on is fixed by Mesa's own upstream default rather than by this project's choice.
function daemonBind() {
  return `${HOST_SOCKET_PATH}:${GUEST_SOCKET_PATH}`;
}

module.exports = {
  VENUS_ROOT, HOST_SOCKET_PATH, GUEST_SOCKET_PATH, socketAnswers, ensureHostInfraReady, daemonBind,
};

'use strict';

// GET /api/instances/:id/viewer (WebSocket upgrade) -- Hito 2 of the web viewer work (see
// /home/jgustavo/.claude/plans/recursive-dreaming-honey.md): streams one instance's screen to a
// browser "ventanita" (frontend/viewer.js). An 'upgrade' event never goes through Express
// middleware at all, so this replicates auth.attachUser/requireAuth by hand (auth.resolveUser,
// factored out of attachUser for exactly this) instead of being able to reuse the
// routes/instances.js pattern of a plain Express handler.
//
// Capability: `view` -- any role, per the plan's own decided access model (viewing the screen is
// not the same gate as start-stop/configure). Input (Hito 3) will check `start-stop` instead,
// on the control messages themselves, not here.
//
// Periodic PNG captures (screenshotCapture.js), NOT the scrcpy video pipeline -- changed
// 15/11/2026, after the hwenc validation above found the shared VA-API daemon's encode path
// fails intermittently under host-wide concurrent load (the exact same max_size that worked 3
// times in a row failed 3 times in a row minutes later, with other instances' own encode
// activity interleaved in the daemon's log throughout) -- a crash that kills the whole
// scrcpy-server process, not just that one connection. `adb exec-out screencap` never touches
// MediaCodec/VA-API, so it cannot hit that bug by construction, and the ventanita never needed
// smoothness or real video to begin with (decided explicitly, 15/11/2026: "no necesito
// fluidez"). The real scrcpy pipeline (viewerSession.js, launchServer.js's bitRate/maxFps knobs)
// is untouched -- Hito 4 (expandida/pantalla completa, which DOES need real video+audio) is a
// different call into that same code, not a mode flag added here.

const store = require('../lib/store');
const permissions = require('../lib/permissions');
const auth = require('../lib/auth');
const httpListeners = require('../lib/httpListeners');
const wsServer = require('../lib/wsServer');
const screenshotCapture = require('../lib/screenshotCapture');

const HOST = '127.0.0.1'; // docker-compose.yml: network_mode: host -- reaches the instance's
// published adbPort directly, same as viewerSession.js's own HOST constant.
const CAPTURE_INTERVAL_MS = 1500; // "no necesito fluidez" -- a couple of seconds between frames
// is the explicit target, not a compromise.

const PATH_RE = /^\/api\/instances\/([^/]+)\/viewer(?:\?.*)?$/;

function rejectUpgrade(socket, status, message) {
  const statusText = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found' }[status] || 'Error';
  try {
    socket.write(`HTTP/1.1 ${status} ${statusText}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${message || statusText}`);
  } catch (e) { /* socket may already be unusable -- destroy() below is what actually matters */ }
  socket.destroy();
}

async function handleUpgrade(req, socket, head) {
  // Every upgrade handler this project registers (httpListeners.onUpgrade -- each one its own
  // independent 'upgrade' listener on the same http.Server, ALL of which fire for every upgrade
  // request, not just the first match) gets a look at every path. The `startsWith` check alone is
  // not a real "is this mine" test -- found live (routes/viewerExpanded.js's own Paso A
  // validation, 15/11/2026): it let this handler 404-and-destroy a sibling route's socket
  // (/viewer/full) just for sharing the /api/instances/ prefix, before that other handler ever
  // got a turn. A non-match now just falls through silently (Node's default hang/eventual
  // timeout), same posture already taken for a path outside /api/instances/ entirely -- fixing
  // "almost looks like mine" to behave the same as "not mine at all", not a new behavior.
  const match = PATH_RE.exec(req.url);
  if (!match) return;
  const instanceId = match[1];

  const user = auth.resolveUser(req);
  if (!user) { rejectUpgrade(socket, 401, 'Not logged in'); return; }

  const instance = store.get(instanceId);
  try {
    permissions.assertCan(user, 'view', instance);
  } catch (e) {
    rejectUpgrade(socket, e.httpStatus || 500, e.message);
    return;
  }

  const ws = wsServer.acceptUpgrade(req, socket, head);
  if (!ws) return; // acceptUpgrade already answered (not a real WS handshake) and destroyed it

  // Initial capture size: an optional ?size= query param (frontend/viewer.js's wsUrl()), falling
  // back to the unconfigured default for the "completo" tab's own 👁 toggle, which never sets
  // one. `new URL` over a manual query-string split because req.url for an upgrade request is
  // still just "path?query", same shape a normal request would have.
  const initialSize = new URL(req.url, 'http://internal').searchParams.get('size');

  let consecutiveErrors = 0;
  const session = screenshotCapture.startLoop(HOST, instance.adbPort, CAPTURE_INTERVAL_MS, initialSize,
    (png) => { consecutiveErrors = 0; ws.send(png); },
    (err) => {
      consecutiveErrors += 1;
      console.error(`ventanita capture error for instance ${instanceId}:`, err.message);
      // 3, not 1 -- a single failed capture is routine (adb momentarily busy, instance mid-boot)
      // and the loop already keeps going on its own; only give up on the WS once it's clearly
      // not transient, same "don't overreact to one blip" reasoning as viewerSession.js's own
      // readLoop never treating isolated errors as fatal.
      if (consecutiveErrors >= 3) ws.close(1011, 'Upstream capture failing');
    });

  // Live resize (15/11/2026, "la proxima actualizacion viene el tamaño nuevo") -- a lone TEXT
  // control message, `{"size": <number>}`, from frontend/viewer.js's Viewer.setSize(). Anything
  // malformed (not JSON, not that shape, or a BINARY frame -- this connection never receives one
  // from the client, but a stray frame should not crash the session) is just ignored: this is a
  // best-effort knob, not something worth tearing the connection down over.
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    try {
      const msg = JSON.parse(data.toString('utf-8'));
      if (msg && typeof msg.size === 'number') session.setSize(msg.size);
    } catch (e) { /* ignore -- see comment above */ }
  });

  ws.on('close', () => session.stop());
  // WsConnection is an EventEmitter -- 'error' with no listener at all is one of the handful of
  // events Node itself special-cases to THROW instead of silently dropping, which an abrupt
  // client disconnect (no clean WS close handshake, just the TCP connection dying -- confirmed
  // live, Hito 2 validation: EPIPE writing a video packet to a client that vanished) hits via the
  // underlying socket's own 'error' event. 'close' always follows a dead socket regardless, which
  // is what actually tears the session down -- there is nothing more to do here than not crash.
  ws.on('error', () => {});
}

function registerUpgrade() {
  httpListeners.onUpgrade(handleUpgrade);
}

module.exports = { registerUpgrade };

'use strict';

// GET /api/instances/:id/viewer/full (WebSocket upgrade) -- the "expandida" mode of the plan at
// /home/jgustavo/.claude/plans/recursive-dreaming-honey.md (Hitos 3+4, merged into one
// deliverable: input only makes sense once a live video session already exists to point it at).
// Separate path and separate file from routes/viewer.js on purpose -- the payload shape is
// completely different (real scrcpy video/audio chunks, not a JPEG per message), same reasoning
// that already split routes/instances.js from this file's sibling.
//
// Capability: `view` to open the connection at all (any role, same as the ventanita); `start-stop`
// is re-checked (not just at connect time) before applying any input message, computed once as
// `canControl` -- a viewer-only user can still watch, their input messages are just ignored.
//
// Drives viewerSession.js (the real scrcpy-server pipeline, built and validated in Hito 1, unused
// by any route until now) directly, with real quality knobs -- not screenshotCapture.js, which is
// routes/viewer.js's own thing and stays untouched.

const store = require('../lib/store');
const permissions = require('../lib/permissions');
const auth = require('../lib/auth');
const httpListeners = require('../lib/httpListeners');
const wsServer = require('../lib/wsServer');
const viewerSession = require('../lib/scrcpy/viewerSession');
const protocol = require('../lib/scrcpy/protocol');
const { OpusTranscoder } = require('../lib/scrcpy/opusTranscoder');

const PATH_RE = /^\/api\/instances\/([^/]+)\/viewer\/full(?:\?.*)?$/;

// scrcpy's own desktop-client defaults (app/src/cli.c) -- "calidad tipo streaming", not the
// ventanita's deliberately tiny/slow numbers. maxSize 0 means "no cap" in scrcpy-server's own
// argv handling (launchServer.buildArgs only adds max_size= when truthy) -- capped here instead
// at a sane ceiling so a 4K-configured instance doesn't push an enormous frame into a browser tab.
const MAX_SIZE = 1920;
const MAX_FPS = 60;
const BIT_RATE = 8_000_000;

// Wire tags for the binary frames this route sends -- see the plan's "Framing sobre el WS"
// section. Kept to the one byte of tag + flags + PTS that WebCodecs actually needs on the
// frontend (EncodedVideoChunk/EncodedAudioChunk's type + timestamp); the video "session"
// (width/height) packet is deliberately never forwarded -- the frontend gets real dimensions
// from the first decoded VideoFrame itself, one less thing to keep in sync.
const TAG_VIDEO = 0x01;
const TAG_AUDIO = 0x02;

function rejectUpgrade(socket, status, message) {
  const statusText = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found' }[status] || 'Error';
  try {
    socket.write(`HTTP/1.1 ${status} ${statusText}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${message || statusText}`);
  } catch (e) { /* socket may already be unusable -- destroy() below is what actually matters */ }
  socket.destroy();
}

// Media packet (isConfig/isKeyFrame/pts/size/payload, see protocol.js's parseFrameHeader) -> one
// binary WS frame: [tag:1][flags:1][pts:8 BE][payload]. flags bit0 = keyframe, bit1 = config
// (SPS/PPS-only packet, no frame data) -- the frontend needs isConfig explicitly, not just for
// the very first packet: scrcpy-server can send a fresh one later too (e.g. a resolution change),
// and frontend/viewerExpanded.js has to buffer every one of those the same way, not just the
// first. `pts` is a BigInt (61-bit field) -- written with writeBigUInt64BE rather than converted
// to Number on this side, so the frontend decides how (and whether) to narrow it; it always fits
// a double in practice (scrcpy's own PTS is microseconds since session start, nowhere near 2^53
// for any session length that matters here).
function encodeMediaFrame(tag, pkt) {
  const buf = Buffer.alloc(10 + pkt.payload.length);
  buf[0] = tag;
  buf[1] = (pkt.isKeyFrame ? 0x01 : 0x00) | (pkt.isConfig ? 0x02 : 0x00);
  buf.writeBigUInt64BE(pkt.pts, 2);
  pkt.payload.copy(buf, 10);
  return buf;
}

async function handleUpgrade(req, socket, head) {
  if (!req.url.startsWith('/api/instances/')) return; // not ours -- same "leave it alone"
  // reasoning as routes/viewer.js: some other handler, or none, owns this path.
  const match = PATH_RE.exec(req.url);
  if (!match) return; // not /viewer/full specifically -- might be routes/viewer.js's own
  // /viewer (no trailing /full), which runs as a separate onUpgrade handler and claims it.
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
  const canControl = permissions.can(user, 'start-stop', instance);

  const ws = wsServer.acceptUpgrade(req, socket, head);
  if (!ws) return; // acceptUpgrade already answered (not a real WS handshake) and destroyed it

  // Found live 15/11/2026: no image/host tried so far has a working Opus ENCODER on-device
  // (confirmed down to the vendor's own media_codecs XML -- no entry, Codec2 or OMX), and a
  // prior attempt at decoding AAC in the browser instead already failed. `audio_codec: 'raw'`
  // sidesteps the device encoder entirely (plain PCM, no MediaCodec involved) -- opusTranscoder
  // does the PCM -> Opus step ourselves, in process, before this packet ever reaches the WS.
  const opus = new OpusTranscoder();
  let session;
  // 'close' is registered BEFORE awaiting the start (21/11/2026). It used to be registered only
  // after viewerSession.start() resolved -- a client gone during those seconds (tab closed while
  // "connecting", page reloaded) fired its one 'close' with nobody listening, so session.stop()
  // never ran and the scrcpy-server it had just launched kept encoding through the shared VA-API
  // daemon indefinitely. Now a close at any point is remembered, and a session that finishes
  // starting for a connection already gone is stopped right away (just below the try/catch).
  let clientGone = false;
  ws.on('close', () => {
    clientGone = true;
    if (session) session.stop();
    opus.close();
  });
  // See routes/viewer.js's own comment on this exact pattern: an abrupt client disconnect surfaces
  // as the underlying socket's 'error' before 'close', and WsConnection is an EventEmitter that
  // throws on an unhandled 'error' -- 'close' is what actually tears the session down.
  ws.on('error', () => {});
  try {
    session = await viewerSession.start(instance, {
      maxSize: MAX_SIZE,
      maxFps: MAX_FPS,
      bitRate: BIT_RATE,
      audio: true,
      audioCodec: 'raw',
      onVideoPacket: (pkt) => { if (pkt.type !== 'session') ws.send(encodeMediaFrame(TAG_VIDEO, pkt)); },
      onAudioPacket: (pkt) => {
        if (pkt.type !== 'media') return; // raw audio has no 'session' packet, but stay defensive
        for (const opusPkt of opus.push(pkt.payload)) ws.send(encodeMediaFrame(TAG_AUDIO, opusPkt));
      },
      onError: (err) => {
        console.error(`expandida viewer session error for instance ${instanceId}:`, err.message);
        ws.close(1011, 'Upstream session failing');
      },
    });
  } catch (e) {
    console.error(`expandida viewer failed to start for instance ${instanceId}:`, e.message);
    // A WS close, not rejectUpgrade(): the 101 already went out in acceptUpgrade, so an HTTP 500
    // written now would just be garbage bytes inside the WS stream. The 'close' handler above
    // does the opus cleanup.
    ws.close(1011, 'Failed to start viewer session');
    return;
  }
  if (clientGone) {
    session.stop();
    return;
  }

  // Input channel (browser -> server), Hito 3 merged into this same route per the plan --
  // JSON text messages only, ignored outright (not an error) if this connection never passed the
  // start-stop check, same "best-effort knob, not worth tearing the connection down over" stance
  // routes/viewer.js already takes with its own malformed-resize-message handling.
  ws.on('message', (data, isBinary) => {
    if (isBinary || !canControl) return;
    let msg;
    try { msg = JSON.parse(data.toString('utf-8')); } catch (e) { return; }
    try {
      if (msg.type === 'touch') {
        session.control.sendTouch({
          action: protocol.MOTION_ACTION[msg.action?.toUpperCase()],
          x: msg.x, y: msg.y, screenWidth: msg.screenWidth, screenHeight: msg.screenHeight,
        });
      } else if (msg.type === 'key') {
        session.control.sendKey({ action: protocol.KEY_ACTION[msg.action?.toUpperCase()], keycode: msg.keycode });
      } else if (msg.type === 'text') {
        session.control.sendText(String(msg.text));
      } else if (msg.type === 'rotate') {
        // 1.0.0-beta.2: portrait <-> landscape. Same start-stop gate as every other input above.
        session.control.sendRotate();
      }
    } catch (e) { /* malformed/out-of-range field in an otherwise-valid message -- ignore, same
      reasoning as the JSON.parse catch above: this is a best-effort input channel. */ }
  });

}

function registerUpgrade() {
  httpListeners.onUpgrade(handleUpgrade);
}

module.exports = { registerUpgrade };

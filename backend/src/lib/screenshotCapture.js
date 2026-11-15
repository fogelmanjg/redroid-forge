'use strict';

// Ventanita capture loop (15/11/2026) -- replaces the scrcpy video pipeline for the ventanita
// specifically, after finding the shared hwenc daemon's VA-API encode path fails intermittently
// under host-wide concurrent load (confirmed live: the exact same max_size that worked 3 times
// in a row failed 3 times in a row minutes later, with other instances' own encode activity
// interleaved in the daemon's log throughout) -- a crash that kills the WHOLE scrcpy-server
// process, not just degrades that one connection. `adb exec-out screencap` never touches
// MediaCodec/VA-API at all, so it cannot hit that bug by construction. Also simply cheaper end to
// end, which matters since the ventanita was explicitly scoped to not need smoothness: no
// scrcpy-server process running on the device, no adb forward, no WebCodecs decoder in the
// browser -- just one PNG every couple of seconds. The real scrcpy pipeline (viewerSession.js)
// is untouched and still what Hito 4 (expandida/pantalla completa) will use -- this file is only
// ever reached from the ventanita's own default path.

const { spawn } = require('child_process');
const sharp = require('sharp');

// `exec-out`, not `adb shell` -- `adb shell` multiplexes stdout through a text-oriented protocol
// that mangles arbitrary binary bytes (CRLF translation, among other things); `exec-out` is ADB's
// own binary-safe raw-passthrough mode, built for exactly this (PNG/image data).
function captureScreenshot(host, adbPort) {
  return new Promise((resolve, reject) => {
    const child = spawn('adb', ['-s', `${host}:${adbPort}`, 'exec-out', 'screencap', '-p']);
    const chunks = [];
    let stderr = '';
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => { stderr += c.toString('utf-8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) { reject(new Error(`screencap exited ${code}: ${stderr.trim()}`)); return; }
      const png = Buffer.concat(chunks);
      if (png.length === 0) { reject(new Error('screencap produced no data')); return; }
      resolve(png);
    });
  });
}

// `screencap` itself has no scale-down option -- it always returns the device's full native
// resolution (confirmed live, 15/11/2026: ~238KB per frame on a 720x1280 instance, more bandwidth
// than the scrcpy video pipeline this replaced). So decided explicitly (15/11/2026, "achicar...
// alta perdida, para que ocupe el menor ancho de banda posible"): shrink it ourselves after
// capture, down to the shorter side at a target size, and re-encode as heavily-lossy JPEG rather
// than keep the lossless PNG. `fit: 'outside'` with a square target box is sharp's way of pinning
// the SHORTER output side to that number regardless of portrait vs landscape (it scales to the
// smallest size that still covers an NxN box, preserving aspect -- for a 720x1280 input and N=80
// that is width=80, height~142, never the other way around).
//
// The target size is a PER-CONNECTION parameter now, not a fixed constant -- the "visores" grid
// view (frontend) wants a configurable, live-adjustable preview size (15/11/2026: "podemos eso
// pasarlo como parametro y dejarlos agrandar un poco... y la proxima actualizacion viene el
// tamaño nuevo"), and stretching a still-80px image with CSS just looks blurry past its native
// size -- the fix is to actually capture bigger, not to fake it client-side. Clamped here
// (not just on the frontend slider) because this value arrives over the WS from the browser
// (routes/viewer.js's resize control message) and must never be trusted as-is: an oversized
// value would mean sharp doing real, repeated work resizing a full-resolution screencap to a huge
// target every ~1.5s, for every open viewer.
const VENTANITA_DEFAULT_SIZE = 160; // unchanged from before this became configurable -- the
// "completo" tab's per-row 👁 toggle never sends a size, so it keeps today's look exactly.
const VENTANITA_MIN_SIZE = 60;
const VENTANITA_MAX_SIZE = 480; // headroom above the "visores" slider's own max (400) on purpose.
const VENTANITA_JPEG_QUALITY = 20; // 1-100; low on purpose -- size over fidelity was the explicit ask

function clampSize(size) {
  const n = Number(size);
  if (!Number.isFinite(n)) return VENTANITA_DEFAULT_SIZE;
  return Math.min(VENTANITA_MAX_SIZE, Math.max(VENTANITA_MIN_SIZE, Math.round(n)));
}

function shrinkForVentanita(pngBuffer, shortSide) {
  const size = clampSize(shortSide);
  return sharp(pngBuffer)
    .resize(size, size, { fit: 'outside' })
    .jpeg({ quality: VENTANITA_JPEG_QUALITY })
    .toBuffer();
}

// Captures immediately, then every intervalMs, until stop() is called. A single failed capture
// (one ADB hiccup, or a shrink failure on a truncated/corrupt capture) does not end the loop --
// the caller's onError just hears about it and decides whether repeated failures warrant closing
// the WS; the next tick is scheduled regardless.
//
// Returns { stop, setSize } rather than a bare stop function now -- setSize lets the caller
// change the capture size of an ALREADY-RUNNING loop (routes/viewer.js wires it to an incoming
// WS resize message). It only affects whichever tick has not started capturing yet -- a resize
// that arrives mid-capture takes effect on the one after, never retroactively.
function startLoop(host, adbPort, intervalMs, initialSize, onFrame, onError) {
  let stopped = false;
  let timer = null;
  let size = clampSize(initialSize);

  async function tick() {
    if (stopped) return;
    try {
      const png = await captureScreenshot(host, adbPort);
      const jpeg = await shrinkForVentanita(png, size);
      if (!stopped) onFrame(jpeg);
    } catch (e) {
      if (!stopped && onError) onError(e);
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  }

  tick();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    setSize(next) {
      size = clampSize(next);
    },
  };
}

module.exports = { captureScreenshot, shrinkForVentanita, startLoop, clampSize, VENTANITA_DEFAULT_SIZE };

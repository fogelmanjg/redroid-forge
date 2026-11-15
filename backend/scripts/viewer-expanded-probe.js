#!/usr/bin/env node
'use strict';

// Paso A validation (see /home/jgustavo/.claude/plans/recursive-dreaming-honey.md): a raw WS
// client -- no `ws` npm dependency, same reasoning as backend/src/lib/wsServer.js -- against the
// real, running desa server's new /api/instances/:id/viewer/full route. Confirms the whole
// backend path end to end (route -> viewerSession.js -> real scrcpy-server) BEFORE any frontend
// code exists, same "retire the protocol risk with a throwaway script first" discipline as
// scrcpy-probe.js in Hito 1.
//
// Connects as a loopback request -- auth.isTrustedLocalTool bypasses the cookie/session check
// entirely for a genuine 127.0.0.1 request with no X-Forwarded-For, so this script needs no login
// flow of its own, same free ride any other local dev tool on this host gets.
//
//   node backend/scripts/viewer-expanded-probe.js <instance-id> [port]
//
// Logs the first N video/audio tagged frames (tag/flags/pts/size) and sends one touch-down+up in
// the middle of the device's screen, then closes cleanly. Does not decode anything -- that is
// exactly the part Paso B hands to WebCodecs in the browser, not this script's job.

const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.argv[3]) || 8099;
const instanceId = process.argv[2];
if (!instanceId) {
  console.error('Usage: node backend/scripts/viewer-expanded-probe.js <instance-id> [port]');
  process.exit(2);
}

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'; // same fixed RFC6455 GUID wsServer.js uses

function connect(path) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: '127.0.0.1', port: PORT, path, method: 'GET',
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13',
      },
    });
    req.on('upgrade', (res, socket) => {
      const expected = crypto.createHash('sha1').update(key + GUID).digest('base64');
      if (res.headers['sec-websocket-accept'] !== expected) { reject(new Error('bad Sec-WebSocket-Accept')); return; }
      resolve(socket);
    });
    req.on('error', reject);
    req.on('response', (res) => reject(new Error(`server answered ${res.statusCode}, not an upgrade`)));
    req.end();
  });
}

// Minimal CLIENT-side frame codec -- the mirror of wsServer.js's server-side one. A client frame
// MUST be masked (RFC6455 5.1); the server never checks the mask value itself (nothing in this
// project's threat model relies on it -- see wsServer.js), but an unmasked client frame is
// invalid wire format some implementations reject outright, so this still sets a real one rather
// than skip it as a shortcut.
function encodeFrame(payload, opcode) {
  const masked = Buffer.alloc(4);
  crypto.randomFillSync(masked);
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, 0x80 | len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  const body = Buffer.alloc(len);
  for (let i = 0; i < len; i++) body[i] = payload[i] ^ masked[i % 4];
  return Buffer.concat([header, masked, body]);
}

function sendText(socket, obj) { socket.write(encodeFrame(Buffer.from(JSON.stringify(obj), 'utf-8'), 0x1)); }

// Reads exactly as many SERVER frames (unmasked) as the caller wants, calling `onFrame(opcode,
// payload)` for each -- no reassembly beyond a single frame, since this project's own server
// never fragments (confirmed: wsServer.js's send() always writes one frame per call).
function readFrames(socket, onFrame) {
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      const len0 = buf[1] & 0x7f;
      let offset = 2;
      let len = len0;
      if (len0 === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); offset = 4; }
      else if (len0 === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); offset = 10; }
      if (buf.length < offset + len) return;
      const payload = buf.subarray(offset, offset + len);
      buf = buf.subarray(offset + len);
      onFrame(opcode, payload);
    }
  });
}

async function main() {
  const socket = await connect(`/api/instances/${instanceId}/viewer/full`);
  console.log('WS upgrade accepted.');

  let videoFrames = 0;
  let audioFrames = 0;
  let firstVideoConfigSeen = false;
  const MAX_FRAMES_TO_LOG = 12;

  readFrames(socket, (opcode, payload) => {
    if (opcode === 0x8) { console.log('Server sent CLOSE.'); socket.end(); return; }
    if (opcode !== 0x2) { console.log(`Unexpected non-binary frame, opcode=${opcode}`); return; }
    const tag = payload[0];
    const flags = payload[1];
    const pts = payload.readBigUInt64BE(2);
    const size = payload.length - 10;
    if (tag === 0x01) {
      videoFrames += 1;
      if (videoFrames <= MAX_FRAMES_TO_LOG) console.log(`video  #${videoFrames}: keyframe=${!!(flags & 1)} pts=${pts} size=${size}`);
      if (!firstVideoConfigSeen && size > 0) {
        // Not re-deriving the SPS profile/level here (that's frontend/viewerExpanded.js's job in
        // Paso B) -- just confirm the payload LOOKS like Annex B (starts with a 00 00 00 01 or
        // 00 00 01 start code), which is the one assumption the whole WebCodecs plan rests on.
        const p = payload.subarray(10, 10 + Math.min(8, size));
        const looksAnnexB = (p[0] === 0 && p[1] === 0 && p[2] === 0 && p[3] === 1) || (p[0] === 0 && p[1] === 0 && p[2] === 1);
        console.log(`  first bytes: ${p.toString('hex')} -- looks like Annex B start code: ${looksAnnexB}`);
        firstVideoConfigSeen = true;
      }
    } else if (tag === 0x02) {
      audioFrames += 1;
      if (audioFrames <= MAX_FRAMES_TO_LOG) console.log(`audio  #${audioFrames}: pts=${pts} size=${size}`);
    } else {
      console.log(`Unknown tag byte ${tag}`);
    }
  });

  // Give video/audio a few seconds to flow, then send one test tap in roughly the middle of the
  // instance's own display (store.get isn't available to this throwaway client script without
  // pulling in the whole backend require graph -- 720x1280 is this host's visor-test-host, good
  // enough for a manual "did it register on the real device" check).
  await new Promise((r) => setTimeout(r, 4000));
  console.log(`So far: ${videoFrames} video frames, ${audioFrames} audio frames.`);

  console.log('Sending a test tap (360,640 on a 720x1280 screen)...');
  sendText(socket, { type: 'touch', action: 'down', x: 360, y: 640, screenWidth: 720, screenHeight: 1280 });
  await new Promise((r) => setTimeout(r, 80));
  sendText(socket, { type: 'touch', action: 'up', x: 360, y: 640, screenWidth: 720, screenHeight: 1280 });

  await new Promise((r) => setTimeout(r, 2000));
  console.log(`Final: ${videoFrames} video frames, ${audioFrames} audio frames. Closing.`);
  socket.write(encodeFrame(Buffer.alloc(0), 0x8));
  socket.end();
  process.exit(0);
}

main().catch((e) => { console.error('Probe failed:', e); process.exit(1); });

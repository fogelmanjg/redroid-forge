'use strict';

// Pure encode/decode helpers for scrcpy-server's real wire protocol (Genymobile/scrcpy, tag
// v5.0.1 -- protocol details have changed across versions historically, this is pinned to the
// exact version this project pushes, see pushServer.js). No I/O here on purpose, so this is
// testable without a real device. Every layout below was confirmed against the real v5.0.1
// source (not docs/blog posts, which are frequently stale for this project) -- file:line
// citations kept in comments the same way the rest of this codebase documents a finding.

// -- scid: 8 lowercase hex chars, random 31-bit value (top bit always 0 to avoid Java `int`
// sign issues on the server side) -- app/src/scrcpy.c:293-300.
function generateScid() {
  return (Math.floor(Math.random() * 0x80000000) >>> 0).toString(16).padStart(8, '0');
}

// The one abstract socket name shared by all 3 channels (video/audio/control), built identically
// client- and server-side -- server.c:1074-1080 / DesktopConnection.getSocketName (Java)
// lines 47-54. `scid` must be the exact 8-hex-char string generateScid() produced.
function socketName(scid) {
  return `scrcpy_${scid}`;
}

// -- Frame header (device/Streamer.java:17-19, 107-124; client-side bit diagram verbatim from
// app/src/demuxer.c:66-119) --
// Every video/audio packet is prefixed by 12 bytes, big-endian:
//   if byte0 & 0x80 (session packet, VIDEO ONLY): bytes 0-3 = flags (bit31=session, bit0 of
//     byte3 = "client resized"), bytes 4-7 = width (u32), bytes 8-11 = height (u32). No payload
//     follows -- the 12 bytes ARE the whole packet.
//   else (media packet): bytes 0-7 = a 64-bit field where bit63=0 (not session), bit62=config,
//     bit61=keyframe, bits 0-60=PTS (so PTS is a 61-bit value, hence BigInt here, not Number);
//     bytes 8-11 = payload size (u32); `size` bytes of raw codec payload follow.
const SESSION_FLAG = 0x80;
const CONFIG_FLAG = 1n << 62n;
const KEY_FRAME_FLAG = 1n << 61n;
const PTS_MASK = KEY_FRAME_FLAG - 1n; // bits 0-60

function parseFrameHeader(buf) {
  if (buf.length !== 12) throw new Error(`frame header must be 12 bytes, got ${buf.length}`);
  if (buf[0] & SESSION_FLAG) {
    return {
      type: 'session',
      width: buf.readUInt32BE(4),
      height: buf.readUInt32BE(8),
      clientResized: (buf[3] & 0x01) !== 0,
    };
  }
  const ptsAndFlags = buf.readBigUInt64BE(0);
  return {
    type: 'media',
    isConfig: (ptsAndFlags & CONFIG_FLAG) !== 0n,
    isKeyFrame: (ptsAndFlags & KEY_FRAME_FLAG) !== 0n,
    pts: ptsAndFlags & PTS_MASK,
    size: buf.readUInt32BE(8),
  };
}

// -- Codec-id header: first 4 bytes of EVERY video/audio socket, 4-char ASCII packed big-endian
// as a uint32 (Streamer.java:39-55 writeVideoHeader/writeAudioHeader; ids cross-checked against
// app/src/demuxer.c:21-29). 0 = stream disabled by device, 1 = device-side config error.
const CODEC_IDS = {
  0x68323634: 'h264', 0x68323635: 'h265', 0x00617631: 'av1', 0x00767038: 'vp8', 0x00767039: 'vp9',
  0x6f707573: 'opus', 0x00616163: 'aac', 0x666c6163: 'flac', 0x00726177: 'raw',
};

function parseCodecId(buf) {
  const id = buf.readUInt32BE(0);
  if (id === 0) return { disabled: true, raw: id };
  if (id === 1) return { error: true, raw: id };
  return { codec: CODEC_IDS[id] || null, raw: id };
}

// -- Device-name handshake (DesktopConnection.sendDeviceMeta, device/DesktopConnection.java:
// 118-126, 155-165; client read in app/src/server.c:595-610): exactly 64 raw bytes, UTF-8,
// NUL-padded, sent ONCE on the first connected socket (video, since this project always enables
// it) before anything else -- only if send_device_meta stays at its default (true), which this
// project never overrides.
const DEVICE_NAME_FIELD_LENGTH = 64;

function parseDeviceName(buf) {
  if (buf.length !== DEVICE_NAME_FIELD_LENGTH) throw new Error(`device name field must be ${DEVICE_NAME_FIELD_LENGTH} bytes, got ${buf.length}`);
  const nul = buf.indexOf(0);
  return buf.toString('utf-8', 0, nul === -1 ? buf.length : nul);
}

// -- Control messages, client -> server (ControlMessage.java:10-32 / app/src/control_msg.h:
// 29-53). No outer framing on this socket at all -- each message is self-delimiting from its
// own type-specific layout.
const CONTROL_MSG_TYPE = {
  INJECT_KEYCODE: 0, INJECT_TEXT: 1, INJECT_TOUCH_EVENT: 2, INJECT_SCROLL_EVENT: 3,
  BACK_OR_SCREEN_ON: 4, SET_CLIPBOARD: 9, ROTATE_DEVICE: 11,
};

// AMOTION_EVENT_ACTION_* (app/src/android/input.h:211-278) -- only the ones this project's
// single-pointer, no-multitouch, no-IME viewer actually needs (see the user's own product
// decisions: no multitouch in the browser, no IME/text composition).
const MOTION_ACTION = { DOWN: 0, UP: 1, MOVE: 2 };

// AKEY_EVENT_ACTION_* (app/src/android/input.h:97-108).
const KEY_ACTION = { DOWN: 0, UP: 1 };

// A single, fixed, non-multitouch pointer id -- "generic finger" (not "mouse": this project's
// input comes from a touchscreen-equivalent pointer/touch event on the browser side, and using
// the finger id rather than the mouse one avoids Android treating it as a desktop mouse pointer
// with hover semantics). app/src/control_msg.h:23-27.
const POINTER_ID_GENERIC_FINGER = 0xFFFFFFFFFFFFFFFEn;

// control_msg.c:118-127 / ControlMessageReader.java:111-119. 32 bytes.
function encodeTouchEvent({
  action, x, y, screenWidth, screenHeight, pressure = 1, actionButton = 0, buttons = 0,
  pointerId = POINTER_ID_GENERIC_FINGER,
}) {
  const buf = Buffer.alloc(32);
  buf[0] = CONTROL_MSG_TYPE.INJECT_TOUCH_EVENT;
  buf[1] = action;
  buf.writeBigUInt64BE(pointerId, 2);
  buf.writeInt32BE(x, 10);
  buf.writeInt32BE(y, 14);
  buf.writeUInt16BE(screenWidth, 18);
  buf.writeUInt16BE(screenHeight, 20);
  buf.writeUInt16BE(Math.max(0, Math.min(65535, Math.round(pressure * 65535))), 22);
  buf.writeInt32BE(actionButton, 24);
  buf.writeInt32BE(buttons, 28);
  return buf;
}

// control_msg.c:107-112 / ControlMessageReader.java:72-78. 14 bytes.
function encodeKeyEvent({ action, keycode, repeat = 0, metastate = 0 }) {
  const buf = Buffer.alloc(14);
  buf[0] = CONTROL_MSG_TYPE.INJECT_KEYCODE;
  buf[1] = action;
  buf.writeInt32BE(keycode, 2);
  buf.writeUInt32BE(repeat, 6);
  buf.writeInt32BE(metastate, 10);
  return buf;
}

// control_msg.c:86-92, 113-117. type byte + 4-byte-BE length + UTF-8 text (plain committed
// string only -- no IME/composition support, per the user's own decision).
function encodeTextEvent(text) {
  const textBuf = Buffer.from(text, 'utf-8');
  const buf = Buffer.alloc(5 + textBuf.length);
  buf[0] = CONTROL_MSG_TYPE.INJECT_TEXT;
  buf.writeUInt32BE(textBuf.length, 1);
  textBuf.copy(buf, 5);
  return buf;
}

// ROTATE_DEVICE (app/src/control_msg.h's enum position 11 at scrcpy v5.0.1, checked against that
// tag's source): no payload, the type byte alone. The server toggles the device between portrait
// and landscape; the video then restarts at the new size with a fresh config packet.
function encodeRotateDevice() {
  return Buffer.from([CONTROL_MSG_TYPE.ROTATE_DEVICE]);
}

module.exports = {
  generateScid, socketName,
  parseFrameHeader, parseCodecId, parseDeviceName, DEVICE_NAME_FIELD_LENGTH,
  CONTROL_MSG_TYPE, MOTION_ACTION, KEY_ACTION, POINTER_ID_GENERIC_FINGER,
  encodeTouchEvent, encodeKeyEvent, encodeTextEvent, encodeRotateDevice,
};

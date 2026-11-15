'use strict';

// The VIDEO connection -- always the FIRST of the 3 (video/audio/control) the device accepts, in
// this project's fixed configuration (all 3 channels always requested, per the "one session, all
// 3 channels" decision). Being first is what makes it carry the tunnel's dummy liveness byte and
// the one-time device-name handshake (see protocol.js's header comment for the exact sourcing);
// a hypothetical video-disabled configuration would need a different "who's first" assignment,
// but this project never disables video, so that case is deliberately not handled here.

const { connectAndReadDummyByte } = require('./connectRetry');
const { FrameReader } = require('./frameReader');
const protocol = require('./protocol');

// Split from reading the handshake (readVideoHandshake, below): found the hard way (Hito 1
// validation, 14/11/2026) that the device only writes the dummy byte immediately on accept --
// the device-name field, and everything after it on every channel, waits until ALL 3 sockets
// (video, audio, control) have been accepted, not just video. A caller that tries to read the
// device name right after connecting video, before connecting audio/control, deadlocks forever:
// the device is waiting for connections our own client hasn't made yet because it's stuck
// waiting on video's handshake first. So the right sequence is: connect all 3 raw sockets, THEN
// read handshakes/packets off of them.
async function connectVideoSocket(localPort) {
  // connectAndReadDummyByte, not a plain connect+read: `adb forward`'s local listener accepts
  // the TCP connect() instantly regardless of whether the device side is ready, so the retry has
  // to cover "connected but the socket closed with no data" too, not just "connect() itself
  // failed" -- see connectRetry.js's own comment for the full story.
  const { socket, firstChunk } = await connectAndReadDummyByte(localPort);
  // firstChunk is the dummy byte plus whatever else arrived in the same TCP segment (in practice
  // just the 1 dummy byte, confirmed live -- the rest only arrives once all 3 sockets are up) --
  // hand it all to the reader rather than just the first byte, so nothing is silently dropped.
  const reader = new FrameReader(socket, firstChunk.subarray(1));
  return { socket, reader };
}

async function readVideoHandshake(reader) {
  const deviceName = protocol.parseDeviceName(await reader.readExact(protocol.DEVICE_NAME_FIELD_LENGTH));
  const codec = protocol.parseCodecId(await reader.readExact(4));

  async function readPacket() {
    const info = protocol.parseFrameHeader(await reader.readExact(12));
    if (info.type === 'session') return info; // no payload -- the 12 bytes ARE the whole packet
    return { ...info, payload: await reader.readExact(info.size) };
  }

  return { deviceName, codec, readPacket };
}

module.exports = { connectVideoSocket, readVideoHandshake };

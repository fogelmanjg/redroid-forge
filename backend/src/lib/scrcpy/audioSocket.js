'use strict';

// The AUDIO connection -- always the SECOND of the 3, so unlike videoSocket.js it gets neither
// the dummy byte nor the device-name handshake (both only ever happen on the first-accepted
// socket, which is video in this project's fixed configuration). Still gets its own 4-byte
// codec-id header (every video/audio socket does), and its frames never carry a "session"
// variant -- that 12-byte-header special case is video-only (Streamer.java's writeSessionMeta is
// only ever called from the video encoder path, never the audio one).

const { connectRetry } = require('./connectRetry');
const { FrameReader } = require('./frameReader');
const protocol = require('./protocol');

// Split from reading the handshake, same reason as videoSocket.js's connectVideoSocket/
// readVideoHandshake split: nothing beyond a bare accept() happens on any channel until all 3
// (video, audio, control) are connected, so connecting has to happen before any read, across all
// 3 sockets, not socket-by-socket.
async function connectAudioSocket(localPort) {
  const socket = await connectRetry(localPort);
  return { socket, reader: new FrameReader(socket) };
}

async function readAudioHandshake(reader) {
  const codec = protocol.parseCodecId(await reader.readExact(4));

  async function readPacket() {
    const info = protocol.parseFrameHeader(await reader.readExact(12));
    return { ...info, payload: await reader.readExact(info.size) };
  }

  return { codec, readPacket };
}

module.exports = { connectAudioSocket, readAudioHandshake };

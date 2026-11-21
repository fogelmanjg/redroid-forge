'use strict';

// The CONTROL connection -- always the THIRD of the 3. No handshake bytes at all on this socket
// (no dummy byte, no device name, no codec-id header -- those are video/audio-only concepts);
// it is pure client-to-server control messages, self-delimited by their own type-specific layout
// (see protocol.js). This project only ever WRITES to this socket (single-pointer touch/key/text
// injection) -- device-to-client messages (e.g. clipboard push) are out of scope, per the
// project's own decided scope (no IME/clipboard sync needed for this viewer).

const { connectRetry } = require('./connectRetry');
const protocol = require('./protocol');

async function connectControl(localPort) {
  const socket = await connectRetry(localPort);
  return {
    socket,
    sendTouch(opts) { socket.write(protocol.encodeTouchEvent(opts)); },
    sendKey(opts) { socket.write(protocol.encodeKeyEvent(opts)); },
    sendText(text) { socket.write(protocol.encodeTextEvent(text)); },
    sendRotate() { socket.write(protocol.encodeRotateDevice()); },
  };
}

module.exports = { connectControl };

'use strict';

// Connects to our own `adb forward`-ed local port, retrying like the real desktop client does
// (server.c:489-539/665-669: up to 100 attempts, 100ms apart) -- the Android-side scrcpy-server
// may not be listening on the forwarded socket the instant `app_process` starts, same race
// androidExec.js's execAndroidWithRetry documents for `docker exec` right after a container
// starts, different mechanism here (TCP connect, not docker exec).

const net = require('net');

function connectOnce(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.removeAllListeners('error'); resolve(socket); });
    socket.once('error', reject);
  });
}

async function connectRetry(port, { retries = 100, intervalMs = 100 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await connectOnce(port);
    } catch (e) {
      lastErr = e;
      // eslint-disable-next-line no-await-in-loop
      if (attempt < retries) await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  throw lastErr;
}

// Found the hard way (Hito 1 validation, 14/11/2026): `adb forward`'s LOCAL listening socket
// accepts a TCP connect() INSTANTLY regardless of whether the device side is ready yet -- it
// only tries the actual relay to the device's abstract socket afterwards, and closes our local
// socket if THAT fails. So a plain "retry connect() until it succeeds" (connectRetry above)
// retries nothing in practice: the very first connect() always "succeeds", then the socket closes
// moments later with no data ever sent. The real desktop client hits this exact same thing and
// solves it the same way (app/src/server.c's connect_and_read_byte, confirmed in its own comment:
// "the connection may succeed even if the server behind the adb tunnel is not listening, so read
// one byte to detect a working connection") -- retry the WHOLE connect-then-read-one-byte
// sequence as a unit, not just the connect. Only meaningful for the first (video) socket, the
// only one that gets the dummy byte in forward-tunnel mode (see protocol.js's header comment).
function readOneByte(socket) {
  return new Promise((resolve, reject) => {
    const onData = (chunk) => { cleanup(); resolve(chunk); };
    const onClose = () => { cleanup(); reject(new Error('socket closed before the dummy byte arrived')); };
    const onError = (err) => { cleanup(); reject(err); };
    function cleanup() {
      socket.removeListener('data', onData);
      socket.removeListener('close', onClose);
      socket.removeListener('error', onError);
    }
    socket.once('data', onData);
    socket.once('close', onClose);
    socket.once('error', onError);
  });
}

async function connectAndReadDummyByte(port, { retries = 100, intervalMs = 100 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    const socket = await connectOnce(port);
    try {
      // eslint-disable-next-line no-await-in-loop
      const firstChunk = await readOneByte(socket);
      return { socket, firstChunk }; // firstChunk may hold more than just the dummy byte -- caller's FrameReader handles that
    } catch (e) {
      lastErr = e;
      socket.destroy();
      // eslint-disable-next-line no-await-in-loop
      if (attempt < retries) await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  throw lastErr;
}

module.exports = { connectRetry, connectAndReadDummyByte };

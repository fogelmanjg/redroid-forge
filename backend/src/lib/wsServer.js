'use strict';

// A hand-rolled WebSocket server (RFC 6455) -- no `ws` npm dependency, same posture as this
// project's existing auth/session code (session.js's own comment: "no new dependency, same
// reasoning as userStore.js preferring scrypt over adding bcrypt"). The handshake is a single
// SHA1+base64 of the client's key against a fixed GUID (crypto, already a dependency of
// everything else in this project); frame parsing is the ~100 lines below. Only what this
// project's one WS use case (the scrcpy viewer, routes/viewer.js) actually needs: text/binary
// messages, close, and ping/pong answered automatically -- no compression (`permessage-deflate`),
// no subprotocol negotiation.

const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'; // fixed by the RFC, not a secret

const OPCODE = { CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

// See WsConnection._startHeartbeat. Overridable by env only so tests can run it in milliseconds.
const HEARTBEAT_INTERVAL_MS = Number(process.env.REDROID_FORGE_WS_HEARTBEAT_MS) || 10000;
const HEARTBEAT_TIMEOUT_MS = HEARTBEAT_INTERVAL_MS * 3;

function computeAcceptKey(clientKey) {
  return crypto.createHash('sha1').update(clientKey + GUID).digest('base64');
}

// Writes the 101 response directly to the raw socket (this runs inside an http 'upgrade'
// handler -- the request has not been answered yet, so there is no `res` to use) and hands back
// a WsConnection wrapping the now-upgraded socket. Returns null (writes a plain 400 instead) if
// the request is not really a WS handshake at all -- found worth guarding explicitly rather than
// trusting every 'upgrade' event is one: anything that reaches `upgrade` without this header is
// not a browser WebSocket client, so answering it as if it were would just hang the connection.
function acceptUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return null;
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${computeAcceptKey(key)}\r\n\r\n`,
  );
  return new WsConnection(socket);
}

// Emits 'message' (Buffer, isBinary) and 'close' -- the two events every caller in this project
// needs (routes/viewer.js). Ping/pong is answered automatically right here, never surfaced as an
// event: it is pure protocol housekeeping, not something a caller has a reason to see.
class WsConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this._buf = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentOpcode = null;
    this._closing = false; // true once OUR OWN close() has run -- guards against sending a
    // second close frame, separate from _emitCloseOnce's guard against emitting 'close' twice
    // (the socket can reach "closed" via either path, close() or the other side hanging up, and
    // each needs its own idempotency).
    this._emittedClose = false;
    socket.on('data', (chunk) => this._onData(chunk));
    // Found the hard way (Hito 2 validation, 15/11/2026): a client that vanishes without a clean
    // WS close handshake (killed, network drop, or just process.exit() on the other end -- not
    // a hypothetical, this is literally what happens when a browser tab closes) sends a TCP FIN,
    // which Node surfaces as 'end' (the READABLE side ending), not 'close' (BOTH directions
    // fully done) -- 'close' only fires once this side also calls .end()/destroy(), which never
    // happened here since nothing was listening for 'end' to trigger it. Without this, a session
    // whose viewer just disappears never tears down: no caller 'close' event, so
    // routes/viewer.js's own session.stop() never runs, leaking the scrcpy-server process on the
    // device and the adb forward forever (confirmed live: ps still showed app_process running
    // minutes later). `end()` here closes our side too, which is what makes the socket's own
    // real 'close' event follow right behind it for the normal case.
    socket.on('end', () => socket.end());
    socket.on('close', () => this._emitCloseOnce());
    socket.on('error', (err) => this.emit('error', err));
    this._startHeartbeat();
  }

  // Heartbeat (21/11/2026). The 'end' handler above covers a client that hangs up cleanly (TCP
  // FIN); it does NOT cover one that just vanishes -- a tablet going to sleep, Wi-Fi dropping, a
  // client PC freezing outright (seen live on jgustavo46 the day before). No FIN ever arrives,
  // and without traffic in our direction the kernel only notices via TCP keepalive, ~2 h by
  // default: all that time the expanded viewer's scrcpy-server kept encoding at 60 fps through the
  // shared VA-API daemon for nobody. Now this side pings every HEARTBEAT_INTERVAL_MS; every
  // browser answers a ping with a pong on its own (RFC 6455 5.5.2, no page code involved), and
  // ANY inbound byte counts as "still there". Nothing for HEARTBEAT_TIMEOUT_MS -> destroy(), whose
  // 'close' runs the caller's normal teardown, exactly as if the client had hung up.
  _startHeartbeat() {
    this._lastSeen = Date.now();
    this._heartbeat = setInterval(() => {
      if (Date.now() - this._lastSeen > HEARTBEAT_TIMEOUT_MS) {
        this.socket.destroy();
        return;
      }
      this._sendFrame(OPCODE.PING, Buffer.alloc(0));
    }, HEARTBEAT_INTERVAL_MS);
    if (this._heartbeat.unref) this._heartbeat.unref();
  }

  _emitCloseOnce() {
    if (this._emittedClose) return;
    this._emittedClose = true;
    clearInterval(this._heartbeat);
    this.emit('close');
  }

  _onData(chunk) {
    this._lastSeen = Date.now();
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    // A single TCP read can carry several WS frames back to back (e.g. a run of small control
    // messages) -- keep parsing until a full frame is no longer buffered, not just once per
    // 'data' event.
    while (this._tryParseOneFrame());
  }

  // -> true if a full frame was consumed (there may be another already buffered, see the while
  // loop above), false if the buffer does not hold a complete frame yet (wait for more 'data').
  _tryParseOneFrame() {
    const buf = this._buf;
    if (buf.length < 2) return false;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < offset + 2) return false;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return false;
      // A control message (touch/key/text) or a video/audio frame from THIS project's own
      // backend never gets anywhere near 2^53 bytes -- Number() losing precision past that is
      // not a real concern here, unlike protocol.js's genuinely 61-bit scrcpy PTS field.
      len = Number(buf.readBigUInt64BE(offset));
      offset += 8;
    }
    let maskKey;
    if (masked) {
      if (buf.length < offset + 4) return false;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + len) return false;
    let payload = buf.subarray(offset, offset + len);
    if (masked) {
      // subarray is a view into `buf` -- unmask into a fresh copy, or this would corrupt
      // whatever of `buf` is kept (the leftover after this frame, sliced off below).
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
    }
    this._buf = buf.subarray(offset + len);

    if (opcode === OPCODE.CLOSE) { this.close(); return false; }
    if (opcode === OPCODE.PING) { this._sendFrame(OPCODE.PONG, payload); return true; }
    if (opcode === OPCODE.PONG) return true;

    if (opcode === OPCODE.CONTINUATION) {
      this._fragments.push(payload);
    } else {
      this._fragments = [payload];
      this._fragmentOpcode = opcode;
    }
    if (fin) {
      const full = this._fragments.length === 1 ? this._fragments[0] : Buffer.concat(this._fragments);
      const isBinary = this._fragmentOpcode === OPCODE.BINARY;
      this._fragments = [];
      this.emit('message', full, isBinary);
    }
    return true;
  }

  // Server-to-client frames are never masked (RFC 6455 5.1: only client-to-server frames are) --
  // no mask key to generate or apply here, unlike parsing above.
  _sendFrame(opcode, payload) {
    // writableEnded too (21/11/2026): after our own close() -> socket.end() the socket is not
    // destroyed yet, and a write there raises "write after end" as an 'error' event.
    if (this.socket.destroyed || this.socket.writableEnded) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch (e) { /* socket already gone -- the caller's own 'close' handler is what matters */ }
  }

  send(data, { binary = true } = {}) {
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
    this._sendFrame(binary ? OPCODE.BINARY : OPCODE.TEXT, payload);
  }

  close(code = 1000, reason = '') {
    if (this._closing) return;
    this._closing = true;
    clearInterval(this._heartbeat);
    try {
      const reasonBuf = Buffer.from(reason, 'utf-8');
      // Sent BEFORE end()-ing the socket below, not after -- _sendFrame only checks
      // socket.destroyed (set by end()/the OS, never by this flag), so the ordering here is
      // what actually determines whether the close frame goes out at all.
      this._sendFrame(OPCODE.CLOSE, Buffer.concat([Buffer.from([code >> 8, code & 0xff]), reasonBuf]));
    } catch (e) { /* best-effort close frame -- end() below is what actually matters */ }
    this.socket.end();
  }
}

module.exports = { acceptUpgrade };

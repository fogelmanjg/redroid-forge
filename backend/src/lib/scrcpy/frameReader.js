'use strict';

// A sequential, exact-byte-count reader over a net.Socket -- `socket.read(n)` on its own returns
// null until at least n bytes are buffered, which needs its own 'readable' loop to use correctly;
// this wraps that into a plain `await readExact(n)`, since every caller in this directory only
// ever has one read in flight at a time (never calls readExact again before the previous one
// resolves), so a single pending-request slot is enough -- no reason for a queue.

class FrameReader {
  // `initialChunk`: bytes already consumed from the socket before this reader existed -- needed
  // because connectRetry.connectAndReadDummyByte() has to read the first byte itself (as part of
  // the connect-and-verify retry unit, see its own comment for why), and whatever arrived in that
  // same TCP segment past the dummy byte would otherwise be lost rather than handed to the reader.
  constructor(socket, initialChunk) {
    this.chunks = initialChunk && initialChunk.length ? [initialChunk] : [];
    this.available = initialChunk ? initialChunk.length : 0;
    this.waiting = null; // { n, resolve, reject }
    this.pendingError = null;
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (err) => this._onEnd(err));
    socket.on('close', () => this._onEnd(new Error('socket closed before enough bytes arrived')));
  }

  _onData(chunk) {
    this.chunks.push(chunk);
    this.available += chunk.length;
    this._tryResolve();
  }

  _onEnd(err) {
    this.pendingError = this.pendingError || err;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w.reject(this.pendingError);
    }
  }

  _tryResolve() {
    if (!this.waiting || this.available < this.waiting.n) return;
    const buf = Buffer.concat(this.chunks, this.available);
    const result = buf.subarray(0, this.waiting.n);
    const rest = buf.subarray(this.waiting.n);
    this.chunks = rest.length ? [rest] : [];
    this.available = rest.length;
    const w = this.waiting;
    this.waiting = null;
    w.resolve(result);
  }

  readExact(n) {
    if (this.waiting) return Promise.reject(new Error('readExact already in flight'));
    if (this.pendingError) return Promise.reject(this.pendingError);
    return new Promise((resolve, reject) => {
      this.waiting = { n, resolve, reject };
      this._tryResolve();
    });
  }
}

module.exports = { FrameReader };

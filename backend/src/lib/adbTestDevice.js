'use strict';

// A minimal ADB *device* (1.0.0-beta.5): not an Android instance, just enough of the ADB transport
// protocol for a real `adb connect host:port` to see a device and for `adb -s host:port shell echo ...`
// to get an answer. Used only by lib/scrcpyLauncherTest.js, so the "Test local scrcpy" button proves
// the whole path a real scrcpy launch will take -- the browser's scheme handler, the local launcher,
// the local adb, the network and the host firewall -- without needing any instance running.
//
// Wire format (AOSP packages/modules/adb/protocol.txt): a 24-byte little-endian header
// { command, arg0, arg1, data_length, data_crc32, magic = command ^ 0xffffffff } followed by
// data_length bytes. "crc32" is really a byte sum, and hosts that negotiate version >= 0x01000001
// (every adb of the last years) ignore it; it is still filled in for older ones.
//
// What it does: answers CNXN with a device banner (no AUTH: a device that replies CNXN directly is
// treated as authorized), and for each OPEN of a `shell:<cmd>` stream calls onShell(cmd), writes the
// returned text and closes the stream. It advertises no features, so adb falls back to the legacy
// `shell:` service (no shell_v2 framing). Anything else it is asked to open is refused with CLSE.

const net = require('net');

const A_CNXN = 0x4e584e43;
const A_OPEN = 0x4e45504f;
const A_OKAY = 0x59414b4f;
const A_CLSE = 0x45534c43;
const A_WRTE = 0x45545257;
const A_VERSION = 0x01000001;
const MAX_PAYLOAD = 256 * 1024;
const HEADER = 24;
// A real host never sends more than a few KB before the shell answer; anything bigger is not adb.
const MAX_BUFFERED = 1024 * 1024;

const BANNER = 'device::ro.product.name=redroid-forge-test;ro.product.model=redroid-forge-launcher-test;'
  + 'ro.product.device=redroid-forge-test;features=';

function encode(command, arg0, arg1, data = Buffer.alloc(0)) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf-8');
  const header = Buffer.alloc(HEADER);
  let sum = 0;
  for (const b of payload) sum = (sum + b) >>> 0;
  header.writeUInt32LE(command, 0);
  header.writeUInt32LE(arg0 >>> 0, 4);
  header.writeUInt32LE(arg1 >>> 0, 8);
  header.writeUInt32LE(payload.length, 12);
  header.writeUInt32LE(sum, 16);
  header.writeUInt32LE((command ^ 0xffffffff) >>> 0, 20);
  return Buffer.concat([header, payload]);
}

// Splits a byte stream into messages. Returns { messages, rest }; throws on a header whose magic does
// not match (not adb at all -- the caller drops the connection).
function decode(buf) {
  const messages = [];
  let off = 0;
  while (buf.length - off >= HEADER) {
    const command = buf.readUInt32LE(off);
    const magic = buf.readUInt32LE(off + 20);
    if (((command ^ 0xffffffff) >>> 0) !== magic) throw new Error('not an adb message (bad magic)');
    const len = buf.readUInt32LE(off + 12);
    if (len > MAX_PAYLOAD) throw new Error(`adb message too big (${len} bytes)`);
    if (buf.length - off - HEADER < len) break;
    messages.push({
      command,
      arg0: buf.readUInt32LE(off + 4),
      arg1: buf.readUInt32LE(off + 8),
      data: buf.subarray(off + HEADER, off + HEADER + len),
    });
    off += HEADER + len;
  }
  return { messages, rest: buf.subarray(off) };
}

// Handles one TCP connection from an adb host. onShell(cmd) -> string (sync).
function handleConnection(socket, { onShell, idleMs = 15000 } = {}) {
  let buf = Buffer.alloc(0);
  let nextLocalId = 1;
  const pendingClose = new Map(); // our local id -> host's id, waiting for the host's OKAY to our WRTE
  socket.setTimeout(idleMs, () => socket.destroy());
  socket.on('error', () => {});
  socket.on('data', (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    if (buf.length > MAX_BUFFERED) { socket.destroy(); return; }
    let decoded;
    try { decoded = decode(buf); } catch (e) { socket.destroy(); return; }
    buf = decoded.rest;
    for (const msg of decoded.messages) {
      if (msg.command === A_CNXN) {
        socket.write(encode(A_CNXN, A_VERSION, MAX_PAYLOAD, BANNER));
      } else if (msg.command === A_OPEN) {
        const hostId = msg.arg0;
        const service = msg.data.toString('utf-8').replace(/\0+$/, '');
        if (!service.startsWith('shell:')) { socket.write(encode(A_CLSE, 0, hostId)); continue; }
        const localId = nextLocalId++;
        let out;
        try { out = String(onShell ? onShell(service.slice('shell:'.length)) : ''); } catch (e) { out = 'error\n'; }
        socket.write(encode(A_OKAY, localId, hostId));
        socket.write(encode(A_WRTE, localId, hostId, out));
        pendingClose.set(localId, hostId);
      } else if (msg.command === A_OKAY) {
        // The host acknowledged our WRTE: the answer is out, close the stream.
        const hostId = pendingClose.get(msg.arg1);
        if (hostId !== undefined) {
          pendingClose.delete(msg.arg1);
          socket.write(encode(A_CLSE, msg.arg1, hostId));
        }
      } else if (msg.command === A_CLSE) {
        // Host closed a stream (or answered ours): nothing to do. A_WRTE from the host (stdin) is
        // ignored on purpose -- a legacy shell with a command never needs it.
      }
    }
  });
}

// -> net.Server, not listening yet.
function createServer(opts) {
  return net.createServer((socket) => handleConnection(socket, opts));
}

module.exports = {
  createServer, handleConnection, encode, decode, BANNER, A_CNXN, A_OPEN, A_OKAY, A_CLSE, A_WRTE, A_VERSION,
};

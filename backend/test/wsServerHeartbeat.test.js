// WsConnection heartbeat (21/11/2026): a client that vanishes without a FIN (sleeping tablet,
// dropped Wi-Fi, a frozen PC) must still end the connection -- 'close' is what tears the
// expandida's scrcpy-server down. Runs with a 40 ms heartbeat (timeout = 3x) instead of 10 s.
process.env.REDROID_FORGE_WS_HEARTBEAT_MS = '40';

const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const wsServer = require('../src/lib/wsServer');

const HANDSHAKE_REQ = { headers: { 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', upgrade: 'websocket' } };

// A real TCP pair: `server` is what acceptUpgrade wraps, `client` plays the browser.
function socketPair() {
  return new Promise((resolve) => {
    const srv = net.createServer((server) => resolve({ server, client, srv }));
    let client;
    srv.listen(0, '127.0.0.1', () => { client = net.connect(srv.address().port, '127.0.0.1'); });
  });
}

// A masked client->server PONG frame with an empty payload (what a browser answers a ping with).
const CLIENT_PONG = Buffer.from([0x8a, 0x80, 1, 2, 3, 4]);

test('heartbeat: a client that never answers is dropped and close is emitted', async () => {
  const { server, client, srv } = await socketPair();
  const ws = wsServer.acceptUpgrade(HANDSHAKE_REQ, server);
  ws.on('error', () => {}); // the routes always listen too -- an abrupt reset surfaces here
  const t0 = Date.now();
  await new Promise((resolve) => ws.on('close', resolve));
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 100, `closed too early (${elapsed} ms)`);
  assert.ok(elapsed < 1000, `took too long to notice (${elapsed} ms)`);
  client.destroy();
  srv.close();
});

test('heartbeat: a client that answers the pings stays connected', async () => {
  const { server, client, srv } = await socketPair();
  const ws = wsServer.acceptUpgrade(HANDSHAKE_REQ, server);
  ws.on('error', () => {}); // the routes always listen too -- an abrupt reset surfaces here
  let closed = false;
  ws.on('close', () => { closed = true; });
  let pings = 0;
  client.on('data', (buf) => {
    // Server frames are unmasked; 0x89 = FIN + PING. Answer every one, like a browser does.
    for (let i = 0; i < buf.length - 1; i++) {
      if (buf[i] === 0x89 && buf[i + 1] === 0x00) { pings += 1; client.write(CLIENT_PONG); }
    }
  });
  await new Promise((r) => setTimeout(r, 400)); // ~3x the timeout
  assert.strictEqual(closed, false);
  assert.ok(pings >= 3, `expected several pings, saw ${pings}`);
  ws.close();
  client.destroy();
  srv.close();
});

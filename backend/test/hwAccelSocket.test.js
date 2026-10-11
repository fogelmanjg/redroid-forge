'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const hwAccel = require('../src/lib/hwAccel');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'vaapi-sock-')); }

test('socketAnswers: true for a live listener, false for a missing file or a leftover nobody listens on', async () => {
  const dir = tmp();
  const live = path.join(dir, 'live');
  const server = net.createServer().listen(live);
  await new Promise((r) => server.on('listening', r));
  assert.strictEqual(await hwAccel.socketAnswers(live), true);
  server.close();
  assert.strictEqual(await hwAccel.socketAnswers(path.join(dir, 'missing')), false);
  const stale = path.join(dir, 'stale');
  fs.writeFileSync(stale, '');
  assert.strictEqual(await hwAccel.socketAnswers(stale), false, 'a file that is not a listening socket is a leftover');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('by default the directory is the shared one, bound at the same path', () => {
  assert.strictEqual(hwAccel.daemonBind(), `${hwAccel.VAAPI_ROOT}:${hwAccel.INSTANCE_VAAPI_DIR}`);
  if (!process.env.REDROID_FORGE_VAAPI_DIR) assert.strictEqual(hwAccel.daemonBind(), '/dev/vaapi-helper:/dev/vaapi-helper');
});

test('REDROID_FORGE_VAAPI_DIR gives a forge its own directory and socket, bound where the Android side looks for it', () => {
  const out = execFileSync(process.execPath, ['-e', `
    const h = require(${JSON.stringify(require.resolve('../src/lib/hwAccel'))});
    console.log(JSON.stringify({ sock: h.SOCKET_PATH, bind: h.daemonBind() }));
  `], { env: { ...process.env, REDROID_FORGE_VAAPI_DIR: '/tmp/rf-test/vaapi' }, encoding: 'utf8' });
  const r = JSON.parse(out);
  assert.strictEqual(r.sock, '/tmp/rf-test/vaapi/socket');
  assert.strictEqual(r.bind, '/tmp/rf-test/vaapi:/dev/vaapi-helper');
});

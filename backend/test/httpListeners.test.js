const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const express = require('express');
const settings = require('../src/lib/settings');
const httpListeners = require('../src/lib/httpListeners');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'httplisteners-'));
  return path.join(dir, 'settings.json');
}

// Isolates settings.js from this host's real backend/data/settings.json for the duration of one
// test (same reasoning as settings.js's own `settingsFile()` comment) -- httpListeners.js calls
// settings.get() with no explicit `file`, so the only way to point it at a tmp file is this env
// var, read fresh on every call.
function withSettingsFile(file, fn) {
  const prev = process.env.REDROID_FORGE_SETTINGS_FILE;
  process.env.REDROID_FORGE_SETTINGS_FILE = file;
  return Promise.resolve().then(fn).finally(() => {
    if (prev === undefined) delete process.env.REDROID_FORGE_SETTINGS_FILE;
    else process.env.REDROID_FORGE_SETTINGS_FILE = prev;
  });
}

// A free ephemeral port, picked once and reused across every host in the test below -- every
// host in a given computeBindHosts() result shares the same PORT (that's the whole point: one
// app, reachable on several addresses), so binding each to a different random port would not
// exercise the real shape at all.
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on('error', reject);
  });
}

function get(host, port, pathName = '/') {
  // agent: false -- otherwise Node's global agent can hand back a pooled socket from a PRIOR
  // request to this same host:port, now pointing at a server that restart() already closed;
  // that reused socket, not this module, is what produces the "socket hang up" (confirmed with
  // an isolated repro while writing this test).
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path: pathName, timeout: 1000, agent: false }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
  });
}

test('computeBindHosts(): empty settings and no env -- only loopback', () => withSettingsFile(tmpFile(), () => {
  delete process.env.REDROID_FORGE_BIND_HOST;
  assert.deepStrictEqual(httpListeners.computeBindHosts(), ['127.0.0.1']);
}));

test('computeBindHosts(): REDROID_FORGE_BIND_HOST is only an escape hatch before appBindHosts is ever set', () => {
  const file = tmpFile();
  return withSettingsFile(file, () => {
    process.env.REDROID_FORGE_BIND_HOST = '127.0.0.9';
    assert.deepStrictEqual(httpListeners.computeBindHosts(), ['127.0.0.1', '127.0.0.9']);
    // Explicitly 127.0.0.1 in the env var changes nothing -- already implicit.
    process.env.REDROID_FORGE_BIND_HOST = '127.0.0.1';
    assert.deepStrictEqual(httpListeners.computeBindHosts(), ['127.0.0.1']);
    delete process.env.REDROID_FORGE_BIND_HOST;
  });
});

test('computeBindHosts(): appBindHosts wins once set, even over a real env var', () => {
  const file = tmpFile();
  return withSettingsFile(file, () => {
    process.env.REDROID_FORGE_BIND_HOST = '127.0.0.9';
    settings.update({ appBindHosts: ['127.0.0.2'] }, file);
    assert.deepStrictEqual(httpListeners.computeBindHosts(), ['127.0.0.1', '127.0.0.2']);
    delete process.env.REDROID_FORGE_BIND_HOST;
  });
});

test('computeBindHosts(): 0.0.0.0 collapses everything else, loopback included', () => {
  const file = tmpFile();
  return withSettingsFile(file, () => {
    settings.update({ appBindHosts: ['127.0.0.2', '0.0.0.0'] }, file);
    assert.deepStrictEqual(httpListeners.computeBindHosts(), ['0.0.0.0']);
  });
});

test('listen() then restart(): the app follows appBindHosts to a new address without dropping loopback', async () => {
  const file = tmpFile();
  await withSettingsFile(file, async () => {
    const port = await freePort();
    const app = express();
    app.get('/', (req, res) => res.send('ok'));
    httpListeners.listen(app, port);
    try {
      assert.strictEqual(await get('127.0.0.1', port), 200);

      settings.update({ appBindHosts: ['127.0.0.2'] }, file);
      await httpListeners.restart();
      assert.strictEqual(await get('127.0.0.1', port), 200, 'loopback must still answer after a restart');
      assert.strictEqual(await get('127.0.0.2', port), 200, 'the newly-added address must answer too');

      settings.update({ appBindHosts: [] }, file);
      await httpListeners.restart();
      assert.strictEqual(await get('127.0.0.1', port), 200);
      await assert.rejects(get('127.0.0.2', port), 'the removed address must no longer answer');
    } finally {
      await httpListeners.closeAll();
    }
  });
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const fetchApk = require('../src/modules/aurora-store/fetch');
const aurora = require('../src/modules/aurora-store/integrate');
const moduleGate = require('../src/lib/moduleGate');
const manifests = require('../src/lib/moduleManifests');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-store-test-'));

// Local HTTP server that serves one fixed body at /apk -- same pattern as
// test/knownDbUpdate.test.js, avoids depending on f-droid.org or mocking `fetch`'s shape by hand.
async function serve(body, status, fn) {
  const server = http.createServer((req, res) => {
    res.statusCode = status || 200;
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${server.address().port}/apk`); } finally { server.close(); }
}

test('manifest: declares stage 6 only, no stage 4 -- it installs after boot, not into /system', () => {
  const m = manifests.get('aurora-store');
  assert.ok(m, 'manifest must exist and load');
  assert.deepStrictEqual(m.etapa, [6]);
  assert.strictEqual(m.esTerceroNoLibre, false);
});

test('moduleGate.requiredModuleIds: aurora-store can be requested per instance', () => {
  const img = { id: 'x', androidVersion: 15, gpuMode: 'host' };
  assert.deepStrictEqual(moduleGate.requiredModuleIds(img, ['aurora-store']), ['aurora-store']);
  assert.deepStrictEqual(moduleGate.requiredModuleIds(img, ['gapps', 'aurora-store']), ['gapps', 'aurora-store']);
});

test('ensureCached: downloads, verifies against the given sha256, and caches it', async () => {
  const dir = tmpDir();
  try {
    const body = Buffer.from('not the real apk, just test bytes');
    const sha256 = crypto.createHash('sha256').update(body).digest('hex');
    await serve(body, 200, async (url) => {
      const file = await fetchApk.ensureCached(dir, fetch, url, sha256);
      assert.strictEqual(file, fetchApk.cachedApkPath(dir));
      assert.ok(fs.existsSync(file));
      assert.deepStrictEqual(fs.readFileSync(file), body);
    });
    // Second call: already cached and matching -- must not need the server at all.
    const file2 = await fetchApk.ensureCached(dir, async () => { throw new Error('must not fetch again'); }, 'http://unused', sha256);
    assert.strictEqual(file2, fetchApk.cachedApkPath(dir));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ensureCached: a hash mismatch is rejected and nothing is cached', async () => {
  const dir = tmpDir();
  try {
    const expected = 'f'.repeat(64);
    await serve(Buffer.from('tampered or wrong file'), 200, async (url) => {
      await assert.rejects(() => fetchApk.ensureCached(dir, fetch, url, expected), /does not match the pinned sha256/);
    });
    assert.ok(!fs.existsSync(fetchApk.cachedApkPath(dir)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ensureCached: an HTTP error is reported, not silently swallowed', async () => {
  const dir = tmpDir();
  try {
    await serve(Buffer.from('nope'), 404, async (url) => {
      await assert.rejects(() => fetchApk.ensureCached(dir, fetch, url, 'f'.repeat(64)), /HTTP 404/);
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('isInstalled: parses "pm list packages" output', async () => {
  const present = async () => ({ stdout: 'package:com.aurora.store\n', stderr: '' });
  const absent = async () => ({ stdout: '', stderr: '' });
  assert.strictEqual(await aurora.isInstalled('cid', { exec: present }), true);
  assert.strictEqual(await aurora.isInstalled('cid', { exec: absent }), false);
});

test('ensureRuntimeReady: already installed -- skips the download/copy/install, still applies the WebView fix', async () => {
  const seen = [];
  const exec = async (cmd, args) => {
    seen.push(args.slice(2));
    if (args.includes('pm') && args.includes('list')) return { stdout: 'package:com.aurora.store\n' };
    return { stdout: '' };
  };
  const copy = async () => { throw new Error('must not copy when already installed'); };
  await aurora.ensureRuntimeReady('cid', { exec, copy });
  assert.ok(seen.some((a) => a.join(' ').includes('webview-command-line')));
  assert.ok(!seen.some((a) => a.includes('install')));
});

test('ensureRuntimeReady: not installed -- caches the apk, copies it in, installs it, then applies the WebView fix', async () => {
  const dir = tmpDir();
  try {
    const body = Buffer.from('fake apk bytes for this test');
    const sha256 = crypto.createHash('sha256').update(body).digest('hex');
    await serve(body, 200, async (url) => {
      const order = [];
      const exec = async (cmd, args) => {
        order.push(args.slice(2));
        if (args.includes('pm') && args.includes('list')) return { stdout: '' }; // not installed yet
        return { stdout: '' };
      };
      const copy = async (src, dest) => { order.push(['cp', src, dest]); };
      await aurora.ensureRuntimeReady('cid', { exec, dir, fetchImpl: fetch, url, sha256, copy });

      const kinds = order.map((a) => a[0]);
      assert.deepStrictEqual(kinds, ['pm', 'cp', 'pm', 'sh']);
      assert.deepStrictEqual(order[1], ['cp', fetchApk.cachedApkPath(dir), aurora.REMOTE_APK_PATH]);
      assert.deepStrictEqual(order[2], ['pm', 'install', '-r', aurora.REMOTE_APK_PATH]);
      assert.match(order[3].join(' '), /webview-command-line/);
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

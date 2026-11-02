const test = require('node:test');
const assert = require('node:assert');
const vc = require('../src/lib/versionCheck');

const fakeRes = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

test('getInstalledVersion: reads package.json\'s version', () => {
  const pkg = require('../package.json');
  assert.strictEqual(vc.getInstalledVersion(), pkg.version);
});

test('isNewer: numeric, left to right, a missing part counts as 0', () => {
  assert.strictEqual(vc.isNewer('0.5.0', '0.4.1'), true);
  assert.strictEqual(vc.isNewer('0.4.1', '0.4.1'), false);
  assert.strictEqual(vc.isNewer('0.4.0', '0.4.1'), false);
  assert.strictEqual(vc.isNewer('0.5', '0.4.9'), true);
  assert.strictEqual(vc.isNewer('1.0.0', '0.9.9'), true);
});

test('fetchLatestRelease: reads tag_name (strips a leading "v") and html_url', async () => {
  const fetchImpl = async (url, opts) => {
    assert.match(url, /^https:\/\/api\.github\.com\/repos\/fogelmanjg\/redroid-forge\/releases\/latest$/);
    assert.strictEqual(opts.headers['User-Agent'], 'redroid-forge');
    return fakeRes(200, { tag_name: 'v0.5.0', html_url: 'https://github.com/x/releases/tag/v0.5.0', published_at: '2026-10-30T00:00:00Z' });
  };
  const r = await vc.fetchLatestRelease({ fetchImpl });
  assert.deepStrictEqual(r, { latest: '0.5.0', url: 'https://github.com/x/releases/tag/v0.5.0', publishedAt: '2026-10-30T00:00:00Z' });
});

test('fetchLatestRelease: a repo with no releases (404) gets a clear, specific error', async () => {
  const fetchImpl = async () => fakeRes(404, {});
  await assert.rejects(vc.fetchLatestRelease({ fetchImpl }), (e) => e.code === 'sin-releases');
});

test('fetchLatestRelease: any other non-ok status is reported as "http"', async () => {
  const fetchImpl = async () => fakeRes(403, {});
  await assert.rejects(vc.fetchLatestRelease({ fetchImpl }), (e) => e.code === 'http');
});

test('fetchLatestRelease: a network failure is reported as "red"', async () => {
  const fetchImpl = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
  await assert.rejects(vc.fetchLatestRelease({ fetchImpl }), (e) => e.code === 'red' && /ENOTFOUND/.test(e.message));
});

test('fetchLatestRelease: a release without tag_name is reported as "formato"', async () => {
  const fetchImpl = async () => fakeRes(200, { html_url: 'x' });
  await assert.rejects(vc.fetchLatestRelease({ fetchImpl }), (e) => e.code === 'formato');
});

test('checkForUpdate: newer=true when GitHub has a higher version than installed', async () => {
  const fetchImpl = async () => fakeRes(200, { tag_name: 'v0.5.0', html_url: 'u' });
  const r = await vc.checkForUpdate({ installed: '0.4.1', fetchImpl });
  assert.deepStrictEqual(r, { installed: '0.4.1', latest: '0.5.0', url: 'u', publishedAt: null, newer: true });
});

test('checkForUpdate: newer=false when already on the latest', async () => {
  const fetchImpl = async () => fakeRes(200, { tag_name: 'v0.4.1', html_url: 'u' });
  const r = await vc.checkForUpdate({ installed: '0.4.1', fetchImpl });
  assert.strictEqual(r.newer, false);
});

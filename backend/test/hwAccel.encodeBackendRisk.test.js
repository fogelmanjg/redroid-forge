const test = require('node:test');
const assert = require('node:assert');
const hwAccel = require('../src/lib/hwAccel');

// Only the vendor+backend combinations that do NOT need vendor === 'amd' && backend === 'ffmpeg'
// together are covered here -- those short-circuit before ever calling isAmdPolarisFamily()
// (which shells out to lspci), so they are pure and safe to test without touching the real host.
// The actual Polaris detection (isAmdPolarisFamily, a real lspci call) is not unit-tested here,
// same as detectGpuVendor right above it in hwAccel.js -- neither is mocked anywhere in this
// test suite.

test('encodeBackendRisk: legacy on Intel is flagged (the original P-frame corruption bug)', async () => {
  const risk = await hwAccel.encodeBackendRisk('intel', 'legacy');
  assert.ok(risk && typeof risk.reason === 'string' && risk.reason.length > 0);
  assert.match(risk.reason, /P-frames/);
});

test('encodeBackendRisk: ffmpeg on Intel is not flagged -- it is the validated option there', async () => {
  assert.strictEqual(await hwAccel.encodeBackendRisk('intel', 'ffmpeg'), null);
});

test('encodeBackendRisk: legacy on AMD is not flagged -- short-circuits before checking Polaris', async () => {
  assert.strictEqual(await hwAccel.encodeBackendRisk('amd', 'legacy'), null);
});

test('encodeBackendRisk: nvidia is never flagged (encode is not even on this daemon there)', async () => {
  assert.strictEqual(await hwAccel.encodeBackendRisk('nvidia', 'legacy'), null);
  assert.strictEqual(await hwAccel.encodeBackendRisk('nvidia', 'ffmpeg'), null);
});

test('encodeBackendRisk: unknown vendor is never flagged', async () => {
  assert.strictEqual(await hwAccel.encodeBackendRisk('unknown', 'ffmpeg'), null);
});

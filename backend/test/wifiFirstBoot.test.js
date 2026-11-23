// lib/hwsimWifi.js ensureWifiConnected (1.0.0-beta.7): the "fake wifi never connects on the first
// boot" fix. Root cause: the HAL reads /data/local/tmp/.jg-netinfo for its static IP on connect, and
// on a first boot nothing had written it yet -> DHCP fallback -> drop after ~18 s. Docker is faked:
// what matters is the ORDER (netinfo written before connect) and that a "connected" that drops does
// not count as done.
const test = require('node:test');
const assert = require('node:assert');
const runtime = require('../src/lib/dockerRuntime');
const hwsimWifi = require('../src/lib/hwsimWifi');

const FAST = { bootWaitMs: 1000, pollMs: 1, enableWaitMs: 1, afterConnectMs: 1, confirmMs: 1 };

function fakeAndroid(t, { bootAfter = 0, statuses }) {
  const calls = [];
  let polls = 0;
  let s = 0;
  t.mock.method(runtime, 'exec', async (id, cmd) => {
    const line = cmd.join(' ');
    calls.push(line);
    if (line.endsWith('getprop sys.boot_completed')) { polls++; return polls > bootAfter ? '\u0001\u0000\u0000\u0000\u0000\u0000\u0000\u00021\n' : '\n'; } // with Docker's frame header, as live
    if (line.endsWith('cmd wifi status')) return statuses[Math.min(s++, statuses.length - 1)];
    return '';
  });
  return calls;
}

test('waits for boot, writes .jg-netinfo BEFORE connecting, and confirms the connection holds', async (t) => {
  const calls = fakeAndroid(t, { bootAfter: 2, statuses: ['Wifi is enabled\nWifi is not connected', 'Wifi is connected to "jg-wifi"', 'Wifi is connected to "jg-wifi"'] });
  await hwsimWifi.ensureWifiConnected('i1', 'c1', FAST);
  assert.strictEqual(calls.filter((c) => c.endsWith('getprop sys.boot_completed')).length, 3, 'polled until boot_completed=1');
  const netinfo = calls.findIndex((c) => c.includes('.jg-netinfo'));
  const connect = calls.findIndex((c) => c.includes('connect-network jg-wifi open'));
  assert.ok(netinfo >= 0 && connect > netinfo, 'netinfo written before the connect request');
  assert.strictEqual(calls.filter((c) => c.includes('connect-network')).length, 1, 'one connect was enough');
});

test('a "connected" that has dropped by the confirmation check is retried, not counted as done', async (t) => {
  // connected -> (confirm) dropped -> connect again -> connected -> (confirm) still connected
  const calls = fakeAndroid(t, { statuses: ['Wifi is connected to "jg-wifi"', 'Wifi is not connected', 'Wifi is connected to "jg-wifi"', 'Wifi is connected to "jg-wifi"'] });
  await hwsimWifi.ensureWifiConnected('i1', 'c1', FAST);
  assert.strictEqual(calls.filter((c) => c.includes('connect-network')).length, 1, 'reconnected once after the drop');
});

test('the netinfo script only uses eth0 (no-op after the swap) and leaves a world-readable file', () => {
  assert.match(hwsimWifi.NETINFO_SCRIPT, /dev eth0/);
  assert.match(hwsimWifi.NETINFO_SCRIPT, /chmod 644/);
  assert.match(hwsimWifi.NETINFO_SCRIPT, /; true$/, 'never fails the attempt when eth0 is gone');
});

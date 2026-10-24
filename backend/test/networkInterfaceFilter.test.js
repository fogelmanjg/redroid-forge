'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { isNoisyByDefault, isVisible } = require('../src/lib/networkInterfaceFilter');

test('isNoisyByDefault: flags known container/CNI noise', () => {
  for (const name of ['docker0', 'docker1', 'br-abcdef012345', 'docker_gwbridge', 'veth1234abc', 'cni0', 'flannel.1', 'cali1a2b3c4d', 'tunl0', 'kube-bridge']) {
    assert.ok(isNoisyByDefault(name), name);
  }
});

test('isNoisyByDefault: does not flag physical NICs, WiFi, VPNs or VM bridges', () => {
  for (const name of ['eth0', 'enp3s0', 'wlan0', 'wlp2s0', 'tailscale0', 'wg0', 'tun0', 'ppp0', 'virbr0', 'vmbr0', 'br0', 'bond0', 'zt7abc123']) {
    assert.ok(!isNoisyByDefault(name), name);
  }
});

test('isVisible: no override -> follows the heuristic', () => {
  assert.equal(isVisible('docker0'), false);
  assert.equal(isVisible('eth0'), true);
});

test('isVisible: an explicit override always wins, either direction', () => {
  assert.equal(isVisible('docker0', { docker0: true }), true); // force-show something noisy
  assert.equal(isVisible('eth0', { eth0: false }), false); // force-hide something normally visible
  assert.equal(isVisible('eth1', { eth0: false }), true); // override is per-interface, not global
});

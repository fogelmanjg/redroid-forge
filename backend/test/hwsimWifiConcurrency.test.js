// Regression of Phase 3 (docs/ROADMAP.md, step 4): two instances that start/restart
// at almost the same time must not be able to claim the same phy/iface pair of
// mac80211_hwsim. It does not start real Docker/hardware -- it mocks
// child_process.execFile (used by hwsimWifi.js for 'iw dev'/'iw phy ... set netns')
// and dockerRuntime (getPid/exec/inspect) via t.mock, in the same no-new-dependencies
// style as moduleContract.test.js.
//
// IMPORTANT (see the PR description): this validates the mocked concurrency model,
// not a real dual-instance startup race against Docker -- that still has to be
// tested on real hardware before merging.
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');

const runtime = require('../src/lib/dockerRuntime');
const store = require('../src/lib/store');
const hwsimWifi = require('../src/lib/hwsimWifi');

// Simulates the host's real state: a phy that "iw phy X set netns" really moves
// stops appearing in the next read of 'iw dev'. Unlike giving each call its own
// independent fixture (that would prove nothing: each instance would see its own
// free pairs and they could never step on each other), this list is shared by BOTH
// concurrent calls, just as they share the host's same default netns in reality.
// `claimedBy` records which instance got each phy, and `collisions` flags whether
// two claims ever tried to move the same phy -- that is what makes the test fail
// if the serialization queue is not there.
function makeSharedHostState(pairs) {
  return { free: pairs.map((p) => ({ ...p })), claimedBy: {}, collisions: [] };
}

function iwDevOutput(pairs) {
  return pairs.map((p) => `${p.phy.replace('phy', 'phy#')}\n\tInterface ${p.iface}`).join('\n');
}

// Reproduces the real async mechanics of dockerode/execFile (it never resolves in
// the same tick) -- without this, two calls to ensureHwsimWifi could run in a
// serialized order by pure chance of the microtask scheduler, without the
// runHwsimClaim queue having anything to do with it.
function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function mockExecFile(t, hostState, instanceIdByPid) {
  t.mock.method(cp, 'execFile', (file, args, cb) => {
    (async () => {
      await tick();
      if (file === 'modprobe' || file === 'rmmod') {
        return cb(null, '', '');
      }
      if (file === 'ip' && args[0] === 'link') {
        // "ip link set wlan0_fake ..." -- it does not exist in this fixture.
        return cb(new Error('no such device'));
      }
      if (file === 'iw' && args[0] === 'dev') {
        return cb(null, iwDevOutput(hostState.free), '');
      }
      if (file === 'iw' && args[0] === 'phy') {
        const phy = args[1];
        const pid = args[4];
        const idx = hostState.free.findIndex((p) => p.phy === phy);
        if (idx === -1) {
          // Another instance already has it -- it is exactly the collision this
          // test exists to detect.
          hostState.collisions.push({ phy, wantedBy: instanceIdByPid[pid], heldBy: hostState.claimedBy[phy] });
          return cb(new Error(`${phy} is no longer free on the host (double claim)`));
        }
        hostState.free.splice(idx, 1); // it moves into the container's netns -> it stops being free
        hostState.claimedBy[phy] = instanceIdByPid[pid];
        return cb(null, '', '');
      }
      return cb(null, '', '');
    })();
  });
}

function mockRuntime(t, pidByContainer) {
  t.mock.method(runtime, 'getPid', async (containerId) => {
    await tick();
    return pidByContainer[containerId];
  });
  t.mock.method(runtime, 'exec', async () => {
    await tick();
    return ''; // enough for "ip link show wlanX" not to throw and renamedOk to be true
  });
}

test('ensureHwsimWifi: two concurrent calls never claim the same phy pair', async (t) => {
  hwsimWifi._resetHwsimClaimTailForTests();
  t.mock.method(store, 'readAll', () => []); // no other registered instances for the reload nuance

  const hostState = makeSharedHostState([
    { phy: 'phy0', iface: 'wlan0' },
    { phy: 'phy1', iface: 'wlan1' },
    { phy: 'phy2', iface: 'wlan2' },
    { phy: 'phy3', iface: 'wlan3' },
  ]);
  const pidByContainer = { 'container-a': '1001', 'container-b': '2002' };
  const instanceIdByPid = { 1001: 'instance-a', 2002: 'instance-b' };
  mockExecFile(t, hostState, instanceIdByPid);
  mockRuntime(t, pidByContainer);

  await Promise.all([
    hwsimWifi.ensureHwsimWifi('instance-a', 'container-a'),
    hwsimWifi.ensureHwsimWifi('instance-b', 'container-b'),
  ]);

  assert.deepEqual(hostState.collisions, []);
  // The fixture's 4 phys are exactly enough for the 2 instances (2 each) -- if any
  // is left over, one fell short unnecessarily.
  assert.equal(hostState.free.length, 0);

  const claimedPairs = Object.entries(hostState.claimedBy).reduce((acc, [phy, owner]) => {
    (acc[owner] ||= []).push(phy);
    return acc;
  }, {});
  assert.equal(claimedPairs['instance-a']?.length, 2);
  assert.equal(claimedPairs['instance-b']?.length, 2);
  // The claims are disjoint: no phy appears in both lists.
  const overlap = claimedPairs['instance-a'].filter((phy) => claimedPairs['instance-b'].includes(phy));
  assert.deepEqual(overlap, []);
});

test('ensureHwsimWifi: with 3 free phys for 2 instances, neither steps on the other even if one ends up without wifi', async (t) => {
  hwsimWifi._resetHwsimClaimTailForTests();
  t.mock.method(store, 'readAll', () => []);

  const hostState = makeSharedHostState([
    { phy: 'phy0', iface: 'wlan0' },
    { phy: 'phy1', iface: 'wlan1' },
    { phy: 'phy2', iface: 'wlan2' },
  ]);
  const pidByContainer = { 'container-a': '1001', 'container-b': '2002' };
  const instanceIdByPid = { 1001: 'instance-a', 2002: 'instance-b' };
  mockExecFile(t, hostState, instanceIdByPid);
  mockRuntime(t, pidByContainer);

  // It must reject neither of the two -- for the one that gets fewer than 2 free
  // phys, ensureHwsimWifi logs a warning and returns without throwing.
  await assert.doesNotReject(Promise.all([
    hwsimWifi.ensureHwsimWifi('instance-a', 'container-a'),
    hwsimWifi.ensureHwsimWifi('instance-b', 'container-b'),
  ]));

  assert.deepEqual(hostState.collisions, []);
  // The only leftover phy (not enough to build a second pair) stays unassigned --
  // what matters is that the same phy was never attempted to be moved twice (that
  // would have been recorded in collisions above).
  assert.equal(hostState.free.length, 1);
});

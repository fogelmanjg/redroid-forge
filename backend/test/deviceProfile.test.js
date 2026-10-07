// Coverage of Phase 3 (docs/ROADMAP.md step 1): device profile spoofing ported
// from jg-dashboard/redroid.service.ts (DEVICE_PROFILES,
// buildDeviceProfileScript). It does not start real Docker -- it mocks
// dockerRuntime.exec, the same style as moduleContract.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');

const runtime = require('../src/lib/dockerRuntime');
const deviceProfile = require('../src/lib/deviceProfile');

test('DEVICE_PROFILES: includes "samsung" with the 5 fields the fingerprint build needs', () => {
  const samsung = deviceProfile.DEVICE_PROFILES.samsung;
  assert.ok(samsung);
  for (const field of ['brand', 'manufacturer', 'device', 'name', 'model']) {
    assert.equal(typeof samsung[field], 'string');
    assert.ok(samsung[field].length > 0);
  }
});

test('buildDeviceProfileScript: a named profile generates "mount -o remount,rw" and a sed per build.prop file', () => {
  const script = deviceProfile.buildDeviceProfileScript(deviceProfile.DEVICE_PROFILES.samsung, 15);
  assert.match(script, /^ok=1\nmount -o remount,rw \/ \|\| ok=0/);
  for (const file of deviceProfile.BUILD_PROP_FILES) {
    assert.match(script, new RegExp(`\\[ -f '${file.replace(/\//g, '\\/')}' \\]`));
  }
  // brand/manufacturer/device/name/model all go in, and the fingerprint uses the
  // # delimiter (not /) because the fingerprint carries unescaped slashes.
  assert.match(script, /ro\\\.\[a-zA-Z0-9_\.\]\*\\\.brand\)=\.\*\/\\1=samsung/);
  assert.match(script, /s#\^\(ro\\\.\[a-zA-Z0-9_\.\]\*\\\.fingerprint\)=\.\*#\\1=samsung\/a55x\/a55x:15\//);
  // it never touches ro.hardware/ro.boot.hardware -- it would break the GPU HAL.
  assert.doesNotMatch(script, /\.hardware\)/);
});

test('buildDeviceProfileScript: a null profile (revert) only restores from the backup, it does not mutate build.prop', () => {
  const script = deviceProfile.buildDeviceProfileScript(null, 15);
  assert.match(script, /^ok=1\nmount -o remount,rw \/ \|\| ok=0/);
  assert.doesNotMatch(script, /sed -i/);
  for (const file of deviceProfile.BUILD_PROP_FILES) {
    assert.match(script, new RegExp(`cp '${file.replace(/\//g, '\\/')}\\.rf-pre-spoof\\.bak' '${file.replace(/\//g, '\\/')}'`));
  }
});

// Regression of the real code-review finding (PR #3): before, every line of the
// script ended in "; true" unconditionally, so a sed that really failed (e.g.
// because the remount above had already failed) was indistinguishable from a
// simply absent file -- the script ALWAYS exited with 0 and applyDeviceProfile()
// never learned of a real failure. Now the final exit code depends on the shell
// variable `ok`, which only a real failure (remount, backup or sed/cp) can lower
// to 0 -- an absent file never touches it.
test('buildDeviceProfileScript: the final exit code depends on "ok", never on an unconditional ";true"', () => {
  const script = deviceProfile.buildDeviceProfileScript(deviceProfile.DEVICE_PROFILES.samsung, 15);
  assert.doesNotMatch(script, /; true$/m);
  assert.ok(script.trim().endsWith('[ "$ok" = "1" ]'));
  assert.match(script, /mount -o remount,rw \/ \|\| ok=0/);
  for (const file of deviceProfile.BUILD_PROP_FILES) {
    const esc = file.replace(/[/.]/g, '\\$&');
    assert.match(script, new RegExp(`\\[ -f '${esc}' \\] && \\{.*\\|\\| ok=0; \\}`));
  }
});

test('applyDeviceProfile: an unknown profile rejects without touching the container', async (t) => {
  const execMock = t.mock.method(runtime, 'exec', async () => { throw new Error('should not be called'); });
  await assert.rejects(
    deviceProfile.applyDeviceProfile('container-x', 15, 'made-up-motorola'),
    /Unknown device profile/,
  );
  assert.equal(execMock.mock.callCount(), 0);
});

test('applyDeviceProfile: runs the script as root via "su -c", the same pattern as ensureWifiConnected', async (t) => {
  let seenArgs = null;
  t.mock.method(runtime, 'exec', async (containerId, cmd) => {
    seenArgs = { containerId, cmd };
    return '';
  });

  const applied = await deviceProfile.applyDeviceProfile('container-x', 15, 'samsung');
  assert.equal(applied, 'samsung');
  assert.equal(seenArgs.containerId, 'container-x');
  assert.equal(seenArgs.cmd[0], 'su');
  assert.equal(seenArgs.cmd[1], '-c');
  assert.match(seenArgs.cmd[2], /samsung/);
});

test('applyDeviceProfile: without profileKey (or "redroid") it applies the revert script', async (t) => {
  let script = null;
  t.mock.method(runtime, 'exec', async (containerId, cmd) => {
    script = cmd[2];
    return '';
  });

  const applied = await deviceProfile.applyDeviceProfile('container-x', 15, undefined);
  assert.equal(applied, deviceProfile.DEFAULT_PROFILE);
  assert.doesNotMatch(script, /sed -i/);
});

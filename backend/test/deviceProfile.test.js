// Cobertura de la Fase 3 (docs/ROADMAP.md paso 1): device profile spoofing
// portado de jg-dashboard/redroid.service.ts (DEVICE_PROFILES,
// buildDeviceProfileScript). No levanta Docker real -- mockea
// dockerRuntime.exec, mismo estilo que moduleContract.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');

const runtime = require('../src/lib/dockerRuntime');
const deviceProfile = require('../src/lib/deviceProfile');

test('DEVICE_PROFILES: incluye "samsung" con los 5 campos que building el fingerprint necesita', () => {
  const samsung = deviceProfile.DEVICE_PROFILES.samsung;
  assert.ok(samsung);
  for (const field of ['brand', 'manufacturer', 'device', 'name', 'model']) {
    assert.equal(typeof samsung[field], 'string');
    assert.ok(samsung[field].length > 0);
  }
});

test('buildDeviceProfileScript: perfil nombrado genera "mount -o remount,rw" y un sed por archivo de build.prop', () => {
  const script = deviceProfile.buildDeviceProfileScript(deviceProfile.DEVICE_PROFILES.samsung, 15);
  assert.match(script, /^mount -o remount,rw \//);
  for (const file of deviceProfile.BUILD_PROP_FILES) {
    assert.match(script, new RegExp(`\\[ -f '${file.replace(/\//g, '\\/')}' \\]`));
  }
  // brand/manufacturer/device/name/model van todos, y el fingerprint usa el
  // delimitador # (no /) porque el fingerprint trae barras sin escapar.
  assert.match(script, /ro\\\.\[a-zA-Z0-9_\.\]\*\\\.brand\)=\.\*\/\\1=samsung/);
  assert.match(script, /s#\^\(ro\\\.\[a-zA-Z0-9_\.\]\*\\\.fingerprint\)=\.\*#\\1=samsung\/a55x\/a55x:15\//);
  // nunca toca ro.hardware/ro.boot.hardware -- romperia el HAL de GPU.
  assert.doesNotMatch(script, /\.hardware\)/);
});

test('buildDeviceProfileScript: perfil null (revert) solo restaura desde el backup, no muta build.prop', () => {
  const script = deviceProfile.buildDeviceProfileScript(null, 15);
  assert.match(script, /^mount -o remount,rw \//);
  assert.doesNotMatch(script, /sed -i/);
  for (const file of deviceProfile.BUILD_PROP_FILES) {
    assert.match(script, new RegExp(`cp '${file.replace(/\//g, '\\/')}\\.rf-pre-spoof\\.bak' '${file.replace(/\//g, '\\/')}'`));
  }
});

test('buildDeviceProfileScript: termina en "true" para no romper si a la imagen le falta alguna particion', () => {
  const script = deviceProfile.buildDeviceProfileScript(deviceProfile.DEVICE_PROFILES.samsung, 15);
  assert.ok(script.trim().endsWith('true'));
});

test('applyDeviceProfile: perfil desconocido rechaza sin llegar a tocar el contenedor', async (t) => {
  const execMock = t.mock.method(runtime, 'exec', async () => { throw new Error('no deberia llamarse'); });
  await assert.rejects(
    deviceProfile.applyDeviceProfile('container-x', 15, 'motorola-inventado'),
    /Perfil de dispositivo desconocido/,
  );
  assert.equal(execMock.mock.callCount(), 0);
});

test('applyDeviceProfile: corre el script como root via "su -c", mismo patron que ensureWifiConnected', async (t) => {
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

test('applyDeviceProfile: sin profileKey (o "redroid") aplica el script de revert', async (t) => {
  let script = null;
  t.mock.method(runtime, 'exec', async (containerId, cmd) => {
    script = cmd[2];
    return '';
  });

  const applied = await deviceProfile.applyDeviceProfile('container-x', 15, undefined);
  assert.equal(applied, deviceProfile.DEFAULT_PROFILE);
  assert.doesNotMatch(script, /sed -i/);
});

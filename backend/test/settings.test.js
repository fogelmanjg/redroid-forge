const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const settings = require('../src/lib/settings');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-'));
  return path.join(dir, 'settings.json');
}

test('get(): no file yet -- falls back to defaults', () => {
  const file = tmpFile();
  assert.deepStrictEqual(settings.get(file), settings.DEFAULTS);
});

test('update(): persists and merges on top of defaults', () => {
  const file = tmpFile();
  const after = settings.update({ backupDir: '/mnt/backups' }, file);
  assert.strictEqual(after.backupDir, '/mnt/backups');
  assert.deepStrictEqual(settings.get(file), after);
});

test('update(): a later partial update does not clobber unrelated settings', () => {
  const file = tmpFile();
  settings.update({ backupDir: '/mnt/backups' }, file);
  const after = settings.update({}, file);
  assert.strictEqual(after.backupDir, '/mnt/backups');
});

test('get(): corrupt file is ignored, falls back to defaults', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{not json');
  assert.deepStrictEqual(settings.get(file), settings.DEFAULTS);
});

test('appBindHosts: empty array by default, persists once set, clears back to empty', () => {
  const file = tmpFile();
  assert.deepStrictEqual(settings.get(file).appBindHosts, []);
  const after = settings.update({ appBindHosts: ['192.168.1.50'] }, file);
  assert.deepStrictEqual(after.appBindHosts, ['192.168.1.50']);
  assert.deepStrictEqual(settings.get(file).appBindHosts, ['192.168.1.50']);
  const cleared = settings.update({ appBindHosts: [] }, file);
  assert.deepStrictEqual(cleared.appBindHosts, []);
});

test('get(): migrates the old single appBindHost field to appBindHosts transparently', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ backupDir: '/mnt/backups', appBindHost: '100.73.0.50' }));
  assert.deepStrictEqual(settings.get(file).appBindHosts, ['100.73.0.50']);
  assert.strictEqual(settings.get(file).appBindHost, undefined);
});

test('get(): migrating a legacy appBindHost of exactly "127.0.0.1" needs no extra entry (already implicit)', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ appBindHost: '127.0.0.1' }));
  assert.deepStrictEqual(settings.get(file).appBindHosts, []);
});

test('operatorPoolMaxVcpus/operatorPoolMaxMemoryMb: null by default, persist once set (src/lib/quotas.js\'s shared pool)', () => {
  const file = tmpFile();
  assert.strictEqual(settings.get(file).operatorPoolMaxVcpus, null);
  assert.strictEqual(settings.get(file).operatorPoolMaxMemoryMb, null);
  const after = settings.update({ operatorPoolMaxVcpus: 10, operatorPoolMaxMemoryMb: 32768 }, file);
  assert.strictEqual(after.operatorPoolMaxVcpus, 10);
  assert.strictEqual(after.operatorPoolMaxMemoryMb, 32768);
  assert.strictEqual(settings.get(file).operatorPoolMaxVcpus, 10);
});

test('authMode/oidcProviders: null by default (auth.js/oidc.js fall back to their env vars), persist once set', () => {
  const file = tmpFile();
  assert.strictEqual(settings.get(file).authMode, null);
  assert.strictEqual(settings.get(file).oidcProviders, null);
  const after = settings.update({ authMode: 'local', oidcProviders: [{ id: 'kc', label: 'KC', issuerUrl: 'https://idp.example', clientId: 'x' }] }, file);
  assert.strictEqual(after.authMode, 'local');
  assert.deepStrictEqual(after.oidcProviders, [{ id: 'kc', label: 'KC', issuerUrl: 'https://idp.example', clientId: 'x' }]);
  assert.strictEqual(settings.get(file).authMode, 'local');
});

test('oidcProviders: can be set to an explicit empty array -- distinct from null (never touched)', () => {
  const file = tmpFile();
  const after = settings.update({ oidcProviders: [] }, file);
  assert.deepStrictEqual(after.oidcProviders, []);
  assert.deepStrictEqual(settings.get(file).oidcProviders, []);
});

test('settingsFile(): REDROID_FORGE_SETTINGS_FILE overrides the default path when no explicit file arg is given', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-env-'));
  const file = path.join(dir, 'settings.json');
  const prev = process.env.REDROID_FORGE_SETTINGS_FILE;
  process.env.REDROID_FORGE_SETTINGS_FILE = file;
  try {
    settings.update({ authMode: 'both' });
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf-8')).authMode, 'both');
  } finally {
    if (prev === undefined) delete process.env.REDROID_FORGE_SETTINGS_FILE; else process.env.REDROID_FORGE_SETTINGS_FILE = prev;
  }
});

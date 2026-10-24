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

test('appBindHost: null by default, persists once set, clears back to null', () => {
  const file = tmpFile();
  assert.strictEqual(settings.get(file).appBindHost, null);
  const after = settings.update({ appBindHost: '192.168.1.50' }, file);
  assert.strictEqual(after.appBindHost, '192.168.1.50');
  assert.strictEqual(settings.get(file).appBindHost, '192.168.1.50');
  const cleared = settings.update({ appBindHost: null }, file);
  assert.strictEqual(cleared.appBindHost, null);
});

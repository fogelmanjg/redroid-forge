const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const runtime = require('../src/lib/dockerRuntime');
const instanceSupport = require('../src/lib/instanceSupport');
const backup = require('../src/lib/backup');

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rf-backup-'));
}

test('backupFileName: instance name + timestamp, no characters Docker/the filesystem would reject', () => {
  const name = backup.backupFileName('aurora-host-test', new Date('2026-01-02T03:04:05.006Z'));
  assert.strictEqual(name, 'aurora-host-test-2026-01-02T03-04-05-006Z.tar.gz');
});

test('createBackup: runs tar through alpine mounted read-only, writes a sidecar with the real digest/modules', async (t) => {
  t.mock.method(runtime, 'getImageDigest', async () => DIGEST_A);
  let ephemeralArgs;
  t.mock.method(runtime, 'runEphemeral', async (...args) => { ephemeralArgs = args; return ''; });
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const instance = {
    name: 'aurora-host-test', volumeName: 'redroid-forge-aurora-host-test',
    dockerImage: 'redroid/redroid:15.0.0-latest', hasGapps: false, requiredModuleIds: ['wifi-interno'],
  };
  const result = await backup.createBackup(instance, dir);

  const [image, cmd, binds] = ephemeralArgs;
  assert.strictEqual(image, 'alpine');
  assert.deepStrictEqual(cmd, ['tar', 'czf', `/backup/${result.file}`, '-C', '/data', '.']);
  assert.deepStrictEqual(binds, ['redroid-forge-aurora-host-test:/data:ro', `${dir}:/backup`]);

  assert.strictEqual(result.meta.dockerImage, 'redroid/redroid:15.0.0-latest');
  assert.strictEqual(result.meta.baseDigest, DIGEST_A);
  assert.ok(result.file.startsWith('aurora-host-test-') && result.file.endsWith('.tar.gz'));
  const sidecar = JSON.parse(fs.readFileSync(`${result.path}.json`, 'utf-8'));
  assert.deepStrictEqual(sidecar, result.meta);
});

test('createBackup: an instance with no volume refuses instead of calling Docker', async (t) => {
  t.mock.method(runtime, 'runEphemeral', async () => { throw new Error('should not be called'); });
  await assert.rejects(
    backup.createBackup({ name: 'x', volumeName: null }, tmpDir()),
    /no volume/,
  );
});

test('listBackups: reads sidecars where present, newest first, missing folder -> empty', () => {
  assert.deepStrictEqual(backup.listBackups(path.join(tmpDir(), 'does-not-exist')), []);

  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'a-2026-01-01T00-00-00-000Z.tar.gz'), 'x');
  fs.writeFileSync(path.join(dir, 'a-2026-01-01T00-00-00-000Z.tar.gz.json'), JSON.stringify({ createdAt: '2026-01-01T00:00:00.000Z' }));
  fs.writeFileSync(path.join(dir, 'b-2026-02-01T00-00-00-000Z.tar.gz'), 'yy'); // no sidecar at all

  const list = backup.listBackups(dir);
  assert.strictEqual(list.length, 2);
  // no sidecar -> sorts as if createdAt === '' (last)
  assert.strictEqual(list[0].file, 'a-2026-01-01T00-00-00-000Z.tar.gz');
  assert.strictEqual(list[0].meta.createdAt, '2026-01-01T00:00:00.000Z');
  assert.strictEqual(list[1].meta, null);
});

test('compatibilityWarnings: no sidecar -> a single "cannot be checked" warning', () => {
  const warnings = backup.compatibilityWarnings(null, { dockerImage: 'x', hasGapps: false });
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /cannot be checked/);
});

test('compatibilityWarnings: different image -> warns, same image -> no warning', () => {
  const instance = { dockerImage: 'redroid/redroid:15.0.0-latest', hasGapps: false };
  assert.strictEqual(backup.compatibilityWarnings({ dockerImage: 'redroid/redroid:11.0.0-latest' }, instance).length, 1);
  assert.strictEqual(backup.compatibilityWarnings({ dockerImage: 'redroid/redroid:15.0.0-latest' }, instance).length, 0);
});

test('compatibilityWarnings: gapps id mismatch only matters if the instance actually has gapps', (t) => {
  t.mock.method(instanceSupport, 'localGappsId', () => 'gapps-current');
  const meta = { dockerImage: 'img', gappsId: 'gapps-old' };
  assert.strictEqual(backup.compatibilityWarnings(meta, { dockerImage: 'img', hasGapps: true }).length, 1);
  assert.strictEqual(backup.compatibilityWarnings(meta, { dockerImage: 'img', hasGapps: false }).length, 0);
});

test('restoreBackup: refuses while the instance is running, without touching the volume', async (t) => {
  t.mock.method(runtime, 'inspect', async () => ({ State: { Status: 'running' } }));
  t.mock.method(runtime, 'runEphemeral', async () => { throw new Error('should not be called'); });
  const instance = { volumeName: 'v', containerId: 'c', dockerImage: 'img', hasGapps: false };
  await assert.rejects(
    backup.restoreBackup(instance, tmpDir(), 'whatever.tar.gz'),
    /Stop the instance/,
  );
});

test('restoreBackup: rejects a file name that is not a bare name inside backupDir', async (t) => {
  t.mock.method(runtime, 'inspect', async () => ({ State: { Status: 'exited' } }));
  const instance = { volumeName: 'v', containerId: 'c', dockerImage: 'img', hasGapps: false };
  await assert.rejects(backup.restoreBackup(instance, tmpDir(), '../../etc/passwd'), /Invalid backup file/);
  await assert.rejects(backup.restoreBackup(instance, tmpDir(), 'not-a-tarball.txt'), /Invalid backup file/);
});

test('restoreBackup: missing file -> 404', async (t) => {
  t.mock.method(runtime, 'inspect', async () => ({ State: { Status: 'exited' } }));
  const instance = { volumeName: 'v', containerId: 'c', dockerImage: 'img', hasGapps: false };
  const err = await backup.restoreBackup(instance, tmpDir(), 'missing.tar.gz').catch((e) => e);
  assert.strictEqual(err.httpStatus, 404);
});

test('restoreBackup: wipes then extracts; warns about the identity clash unless resetIdentity is set', async (t) => {
  t.mock.method(runtime, 'inspect', async () => ({ State: { Status: 'exited' } }));
  const calls = [];
  t.mock.method(runtime, 'runEphemeral', async (...args) => { calls.push(args); return ''; });
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'b.tar.gz'), 'x');
  const instance = {
    volumeName: 'redroid-forge-x', containerId: 'c', dockerImage: 'img', hasGapps: true,
  };

  const kept = await backup.restoreBackup(instance, dir, 'b.tar.gz');
  assert.strictEqual(calls.length, 1); // extract only, no identity wipe
  assert.deepStrictEqual(calls[0][2], ['redroid-forge-x:/data', `${path.join(dir, 'b.tar.gz')}:/backup.tar.gz:ro`]);
  assert.ok(kept.warnings.some((w) => /same device twice/.test(w)));

  calls.length = 0;
  const reset = await backup.restoreBackup(instance, dir, 'b.tar.gz', { resetIdentity: true });
  assert.strictEqual(calls.length, 2); // extract + identity wipe
  assert.match(calls[1][1].join(' '), /com\.google\.android\.gsf/);
  assert.ok(!reset.warnings.some((w) => /same device twice/.test(w)));
});

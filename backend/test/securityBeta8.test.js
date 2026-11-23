// 1.0.0-beta.8 security fixes: setup/status no longer leaks account names before login, sessions
// follow the account's current state (deleted / role changed / password changed / log out
// everywhere), backups belong to the owners of their instance.
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const userStore = require('../src/lib/userStore');
const roleAssignments = require('../src/lib/roleAssignments');
const permissions = require('../src/lib/permissions');

function freshAuth(mode) {
  const keep = ['REDROID_FORGE_AUTH', 'REDROID_FORGE_LOCAL_ADMIN_USER', 'REDROID_FORGE_LOCAL_ADMIN_PASSWORD', 'REDROID_FORGE_SETTINGS_FILE'];
  const prev = Object.fromEntries(keep.map((k) => [k, process.env[k]]));
  process.env.REDROID_FORGE_AUTH = mode;
  process.env.REDROID_FORGE_LOCAL_ADMIN_USER = 'test-admin';
  process.env.REDROID_FORGE_LOCAL_ADMIN_PASSWORD = 'test-password';
  process.env.REDROID_FORGE_SETTINGS_FILE = path.join(os.tmpdir(), `rf-b8-settings-${process.pid}.json`);
  delete require.cache[require.resolve('../src/lib/auth')];
  const auth = require('../src/lib/auth');
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return auth;
}
function cookieFor(auth, user) {
  let set;
  auth.setSessionCookie({ headers: {} }, { cookie: (n, v) => { set = `${n}=${v}`; } }, user);
  return { headers: { cookie: set }, socket: { remoteAddress: '100.64.0.9' } };
}

test('session: the role comes from the store now, not from the cookie', (t) => {
  const auth = freshAuth('both');
  let row = { id: 'u1', role: 'admin', username: 'ana' };
  t.mock.method(userStore, 'findById', (id) => (id === 'u1' ? row : undefined));
  const req = cookieFor(auth, row);
  assert.strictEqual(auth.resolveUser(req).role, 'admin');
  row = { ...row, role: 'viewer' };
  assert.strictEqual(auth.resolveUser(req).role, 'viewer', 'demoted -> takes effect on the next request');
  row = undefined;
  assert.strictEqual(auth.resolveUser(req), undefined, 'deleted account -> its cookie is dead');
});

test('session: sessionsValidAfter (password change / log out everywhere) kills older cookies only', (t) => {
  const auth = freshAuth('both');
  const row = { id: 'u1', role: 'operator', username: 'ana' };
  t.mock.method(userStore, 'findById', () => row);
  const old = cookieFor(auth, row);
  row.sessionsValidAfter = Date.now() + 1;
  assert.strictEqual(auth.resolveUser(old), undefined);
  const realNow = Date.now;
  t.mock.method(Date, 'now', () => realNow() + 10);
  assert.strictEqual(auth.resolveUser(cookieFor(auth, row)).id, 'u1', 'a login after that works');
});

test('session: an OIDC identity needs a current role; removing it ends the session', (t) => {
  const auth = freshAuth('both');
  t.mock.method(userStore, 'findById', () => undefined);
  let a = { externalId: 'kc:7', username: 'vic', role: 'operator' };
  t.mock.method(roleAssignments, 'findByExternalId', (id) => (id === 'kc:7' ? a : undefined));
  const req = cookieFor(auth, { id: 'kc:7', role: 'operator', username: 'vic' });
  assert.deepStrictEqual(auth.resolveUser(req), { id: 'kc:7', role: 'operator', username: 'vic' });
  a = { ...a, role: null };
  assert.strictEqual(auth.resolveUser(req), undefined);
});

test('setup/status: no account names or repo path for an anonymous visitor once auth is on', async () => {
  const http = require('http');
  const express = require('express');
  const prev = { a: process.env.REDROID_FORGE_AUTH, s: process.env.REDROID_FORGE_SETTINGS_FILE, u: process.env.REDROID_FORGE_LOCAL_ADMIN_USER, p: process.env.REDROID_FORGE_LOCAL_ADMIN_PASSWORD, r: process.env.REDROID_FORGE_REPO_DIR };
  Object.assign(process.env, { REDROID_FORGE_AUTH: 'local', REDROID_FORGE_SETTINGS_FILE: path.join(os.tmpdir(), `rf-b8-s2-${process.pid}.json`), REDROID_FORGE_LOCAL_ADMIN_USER: 'x', REDROID_FORGE_LOCAL_ADMIN_PASSWORD: 'yyyyyyyy', REDROID_FORGE_REPO_DIR: '/srv/forge' });
  delete require.cache[require.resolve('../src/lib/auth')];
  delete require.cache[require.resolve('../src/routes/auth')];
  const routes = require('../src/routes/auth');
  const get = (user) => new Promise((resolve, reject) => {
    const app = express();
    app.use((rq, rs, next) => { rq.user = user; next(); });
    app.use('/api/auth', routes);
    const s = app.listen(0, () => {
      http.get({ port: s.address().port, path: '/api/auth/setup/status' }, (res) => {
        let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { s.close(); resolve(JSON.parse(b)); });
      }).on('error', reject);
    });
  });
  try {
    const anon = await get(undefined);
    assert.deepStrictEqual(anon.localUsernames, []);
    assert.strictEqual(anon.repoDir, null);
    const admin = await get({ id: 'a', role: 'admin', username: 'ana' });
    assert.strictEqual(admin.repoDir, '/srv/forge');
  } finally {
    for (const [k, v] of Object.entries({ REDROID_FORGE_AUTH: prev.a, REDROID_FORGE_SETTINGS_FILE: prev.s, REDROID_FORGE_LOCAL_ADMIN_USER: prev.u, REDROID_FORGE_LOCAL_ADMIN_PASSWORD: prev.p, REDROID_FORGE_REPO_DIR: prev.r })) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    delete require.cache[require.resolve('../src/lib/auth')];
    delete require.cache[require.resolve('../src/routes/auth')];
  }
});

test('backups: an operator only reaches backups of instances they own or owned', () => {
  const op = { id: 'op1', role: 'operator' };
  const instances = [{ id: 'i-mine', ownerId: ['op1'] }, { id: 'i-other', ownerId: ['op2'] }];
  assert.ok(permissions.canAccessBackup(op, { instanceId: 'i-gone', ownerIds: ['op1'] }, instances), 'owned it when the backup was made');
  assert.ok(permissions.canAccessBackup(op, { instanceId: 'i-mine', ownerIds: ['op9'] }, instances), 'owns the instance now');
  assert.ok(!permissions.canAccessBackup(op, { instanceId: 'i-other', ownerIds: ['op2'] }, instances), "someone else's");
  assert.ok(!permissions.canAccessBackup(op, { instanceName: 'old' }, instances), 'pre-beta.8 backup: admin only');
  assert.ok(!permissions.canAccessBackup(op, null, instances), 'no sidecar: admin only');
  assert.ok(permissions.canAccessBackup({ id: 'a', role: 'admin' }, null, instances));
  assert.ok(!permissions.canAccessBackup(undefined, { ownerIds: ['op1'] }, instances));
});

test('backups: the sidecar records the instance and its owners', async (t) => {
  const backup = require('../src/lib/backup');
  const runtime = require('../src/lib/dockerRuntime');
  t.mock.method(runtime, 'getImageDigest', async () => 'sha256:x');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-b8-bk-'));
  t.mock.method(runtime, 'runEphemeral', async (img, cmd) => { fs.writeFileSync(path.join(dir, cmd[2].match(/'\/backup\/(\.[^']+\.partial)'/)[1]), ''); return ''; });
  const r = await backup.createBackup({ id: 'i1', name: 'n', volumeName: 'v', ownerId: ['op1', 'op2'], dockerImage: 'img' }, dir, { createdBy: 'op1' });
  assert.deepStrictEqual([r.meta.instanceId, r.meta.ownerIds, r.meta.createdBy], ['i1', ['op1', 'op2'], 'op1']);
  assert.deepStrictEqual(backup.readMeta(dir, r.file).ownerIds, ['op1', 'op2']);
});

// --- beta.8 functional fixes: backup jobs, partial files, retention, retries that stop ---
test('backup: a failed tar leaves no .partial behind and nothing in the list', async (t) => {
  const backup = require('../src/lib/backup');
  const runtime = require('../src/lib/dockerRuntime');
  t.mock.method(runtime, 'getImageDigest', async () => null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-b8-fail-'));
  t.mock.method(runtime, 'runEphemeral', async (img, cmd) => {
    fs.writeFileSync(path.join(dir, cmd[2].match(/'\/backup\/(\.[^']+\.partial)'/)[1]), 'half');
    throw new Error('runEphemeral timeout');
  });
  await assert.rejects(backup.createBackup({ id: 'i1', name: 'n', volumeName: 'v', dockerImage: 'img' }, dir), /timeout/);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('backup retention: keeps the newest N of THAT instance, never others or pre-beta.8 ones', () => {
  const backup = require('../src/lib/backup');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-b8-keep-'));
  const mk = (file, meta) => { fs.writeFileSync(path.join(dir, file), ''); fs.writeFileSync(path.join(dir, `${file}.json`), JSON.stringify(meta)); };
  mk('a1.tar.gz', { instanceId: 'A', createdAt: '2026-01-01' });
  mk('a2.tar.gz', { instanceId: 'A', createdAt: '2026-01-02' });
  mk('a3.tar.gz', { instanceId: 'A', createdAt: '2026-01-03' });
  mk('b1.tar.gz', { instanceId: 'B', createdAt: '2026-01-01' });
  mk('old.tar.gz', { instanceName: 'a', createdAt: '2025-01-01' });
  assert.deepStrictEqual(backup.pruneBackups(dir, 'A', 0), [], '0 = keep all');
  assert.deepStrictEqual(backup.pruneBackups(dir, 'A', 2), ['a1.tar.gz']);
  assert.deepStrictEqual(backup.listBackups(dir).map((b) => b.file).sort(), ['a2.tar.gz', 'a3.tar.gz', 'b1.tar.gz', 'old.tar.gz']);
});

test('backup jobs: one per instance, progress and result readable, errors captured', async () => {
  const jobs = require('../src/lib/backupJobs');
  let release;
  const gate = new Promise((r) => { release = r; });
  const j = jobs.start('inst-x', 'backup', async (job) => { job.phase = 'archiving'; job.bytesDone = 5; await gate; return { file: 'f' }; });
  assert.strictEqual(j.state, 'running');
  assert.throws(() => jobs.start('inst-x', 'restore', async () => {}), /already in progress/);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(jobs.current('inst-x').bytesDone, 5);
  release();
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual([jobs.current('inst-x').state, jobs.current('inst-x').result], ['done', { file: 'f' }]);
  jobs.start('inst-x', 'restore', async () => { throw new Error('boom'); }, { log: { warn() {} } });
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual([jobs.current('inst-x').state, jobs.current('inst-x').error], ['error', 'boom']);
});

test('exec retries stop as soon as the container is no longer running', async () => {
  const { execAndroidWithRetry, isContainerGone } = require('../src/lib/androidExec');
  let calls = 0;
  const exec = async () => { calls++; throw Object.assign(new Error('Command failed'), { code: 1, stderr: 'Error response from daemon: container abc is not running' }); };
  await assert.rejects(execAndroidWithRetry('abc', ['true'], { exec, delayMs: 1 }));
  assert.strictEqual(calls, 1, 'no retries against a stopped container');
  assert.ok(isContainerGone(new Error('(HTTP code 409) container stopped/paused - container abc is not running')));
  assert.ok(isContainerGone(new Error('No such container: abc')));
  assert.ok(!isContainerGone(new Error('exec /system/bin/sh: no such file or directory')), 'booting, keep retrying');
});

test('persistent log: lines are timestamped and the file rotates by size', () => {
  const logFile = require('../src/lib/logFile');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-b8-log-'));
  const file = path.join(dir, 'forge.log');
  const write = logFile.createWriter(file, { maxBytes: 200, keep: 2, now: () => new Date('2026-11-23T10:00:00Z') });
  for (let i = 0; i < 10; i++) write('info', [`line %d ${'x'.repeat(40)}`, i]);
  assert.match(fs.readFileSync(file, 'utf-8'), /^2026-11-23T10:00:00.000Z INFO  line \d/);
  assert.ok(fs.existsSync(`${file}.1`) && fs.existsSync(`${file}.2`) && !fs.existsSync(`${file}.3`));
});

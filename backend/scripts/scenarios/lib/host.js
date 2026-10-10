'use strict';

// The machine under test (e.g. jgustavo46), reached through ssh. Everything the runner does on it goes
// through here, so the rest of the code does not know about ssh, quoting or privileges.
//
// Privileges: reading debugfs and /dev/kmsg, and cleaning up root-owned files, need root on the host.
// How to get it differs per machine, so it is configurable (`rootCmd`, default "sudo -n"); on a host
// where the account is already root, set it to "" and nothing is prefixed.

const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

// POSIX single-quote quoting of one argument.
function q(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

class Host {
  constructor({ ssh, rootCmd = 'sudo -n', log = () => {} }) {
    if (!ssh) throw new Error('the ssh target of the host under test is required');
    this.ssh = ssh;
    this.rootCmd = rootCmd;
    this.log = log;
  }

  // Runs a shell command on the host. Resolves with { stdout, stderr, code }; it does NOT throw on a
  // non-zero exit code unless `check` is true (the callers decide what a failure means).
  async run(cmd, { check = false, timeoutMs = 120000 } = {}) {
    try {
      const { stdout, stderr } = await execFileAsync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', this.ssh, cmd],
        { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
      return { stdout, stderr, code: 0 };
    } catch (e) {
      const r = { stdout: e.stdout || '', stderr: e.stderr || e.message, code: typeof e.code === 'number' ? e.code : 1 };
      if (check) throw Object.assign(new Error(`on ${this.ssh}: ${cmd.slice(0, 160)} -> ${r.stderr.trim().slice(0, 300)}`), r);
      return r;
    }
  }

  // As root (see the note above).
  root(cmd, opts) {
    return this.run(this.rootCmd ? `${this.rootCmd} sh -c ${q(cmd)}` : cmd, opts);
  }

  // A long-lived command whose process the caller controls (e.g. a workload that runs for a minute).
  spawn(cmd) {
    return spawn('ssh', ['-o', 'BatchMode=yes', this.ssh, cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
  }

  async putFile(localPath, remotePath) {
    await execFileAsync('scp', ['-q', '-o', 'BatchMode=yes', localPath, `${this.ssh}:${remotePath}`], { timeout: 600000 });
  }

  async getFile(remotePath, localPath) {
    await execFileAsync('scp', ['-q', '-o', 'BatchMode=yes', `${this.ssh}:${remotePath}`, localPath], { timeout: 600000 });
  }

  async rsyncTo(localDir, remoteDir, excludes = []) {
    const args = ['-a', '--delete', ...excludes.flatMap((x) => ['--exclude', x]), `${localDir}/`, `${this.ssh}:${remoteDir}/`];
    await execFileAsync('rsync', args, { timeout: 600000 });
  }

  // JSON call to a forge API that listens on the host's localhost (so no firewall is involved).
  async api(port, method, path, body) {
    const data = body === undefined ? '' : `-H 'content-type: application/json' -d ${q(JSON.stringify(body))}`;
    const r = await this.run(`curl -s -m 120 -X ${method} ${data} -w '\\n%{http_code}' http://127.0.0.1:${port}/api${path}`);
    const idx = r.stdout.lastIndexOf('\n');
    const status = Number(r.stdout.slice(idx + 1));
    const raw = r.stdout.slice(0, idx);
    let json = null;
    try { json = raw ? JSON.parse(raw) : null; } catch { json = { raw }; }
    return { status, json };
  }
}

module.exports = { Host, q };

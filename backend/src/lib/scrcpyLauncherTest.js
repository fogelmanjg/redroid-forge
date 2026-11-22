'use strict';

// "Test local scrcpy" (1.0.0-beta.5). The browser cannot tell whether a custom URL scheme has a
// handler installed (on purpose, so pages cannot fingerprint what you have), so instead of guessing
// by user agent this PROVES it end to end:
//
//   1. start() hands out a one-time code and makes sure the test port is open: a minimal ADB device
//      (lib/adbTestDevice.js) listening on REDROID_FORGE_LAUNCHER_TEST_PORT, plus a temporary
//      firewall ACCEPT for it (a host whose INPUT policy is DROP would otherwise only let it through
//      on some interfaces -- instance ports are Docker-published and bypass INPUT, this one does not).
//   2. The page opens scrcpy-redroid://test/<host>:<port>/<code>; the local launcher
//      (launcher/linux) runs `adb connect` + `adb shell echo redroid-forge-launcher-test <code> ...`.
//   3. The fake device sees the code, marks it confirmed with the versions the launcher reported,
//      and the page (polling result()) turns the feature on in that browser.
//
// The port is NOT open by default: the listener and the firewall rule exist only while at least one
// code is pending (TTL_MS), and are both removed as soon as none is (confirmed or expired).

const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const adbTestDevice = require('./adbTestDevice');

const execFileAsync = promisify(execFile);

const TTL_MS = 60_000;
const MAX_PENDING = 10;
const SHELL_TAG = 'redroid-forge-launcher-test';
const FW_COMMENT = 'redroid-forge-launcher-test';
const DEFAULT_PORT = 15599;

function testPort(env = process.env) {
  const n = Number(env.REDROID_FORGE_LAUNCHER_TEST_PORT || DEFAULT_PORT);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`REDROID_FORGE_LAUNCHER_TEST_PORT must be a TCP port, got "${env.REDROID_FORGE_LAUNCHER_TEST_PORT}"`);
  return n;
}

// Version strings the launcher reports end up in the UI: keep them short and printable.
function cleanVersion(s) {
  return String(s || '').replace(/[^\w.+-]/g, '').slice(0, 40) || null;
}

function fwRuleArgs(port) {
  return ['INPUT', '-p', 'tcp', '--dport', String(port), '-m', 'comment', '--comment', FW_COMMENT, '-j', 'ACCEPT'];
}

function createTester({
  port = testPort(), exec = execFileAsync, createServer = adbTestDevice.createServer, now = () => Date.now(),
  ttlMs = TTL_MS, log = console,
} = {}) {
  const codes = new Map(); // code -> { state: 'pending'|'ok', createdAt, launcherVersion, scrcpyVersion, adbVersion }
  let server = null;
  let opening = null;
  let fwOpen = false;
  let firewall = 'unknown'; // 'opened' | 'unavailable' (no iptables / no privileges) | 'unknown'
  let sweepTimer = null;

  function onShell(cmd) {
    const parts = cmd.trim().split(/\s+/);
    // "echo redroid-forge-launcher-test <code> <launcherVersion> <scrcpyVersion> <adbVersion>"
    if (parts[0] === 'echo') parts.shift();
    if (parts[0] !== SHELL_TAG) return 'unknown-command\n';
    const entry = codes.get(parts[1]);
    if (!entry || entry.state !== 'pending' || now() - entry.createdAt > ttlMs) return 'unknown-code\n';
    entry.state = 'ok';
    entry.launcherVersion = cleanVersion(parts[2]);
    entry.scrcpyVersion = cleanVersion(parts[3]);
    entry.adbVersion = cleanVersion(parts[4]);
    entry.confirmedAt = now();
    // Close a little later, not right now: adb still has to read the answer and close its stream.
    setTimeout(() => { sweep().catch(() => {}); }, 2000).unref();
    return 'ok\n';
  }

  async function openFirewall() {
    try {
      await exec('iptables', ['-C', ...fwRuleArgs(port)]).catch(async () => {
        await exec('iptables', ['-A', ...fwRuleArgs(port)]);
      });
      fwOpen = true;
      firewall = 'opened';
    } catch (e) {
      // No iptables in the image, or not privileged: the listener still works wherever the host
      // firewall already lets the port through. The result tells the page, so a failed test can say so.
      firewall = 'unavailable';
    }
  }

  async function closeFirewall() {
    if (!fwOpen) return;
    fwOpen = false;
    await exec('iptables', ['-D', ...fwRuleArgs(port)]).catch(() => {});
  }

  async function ensureOpen() {
    if (server) return;
    if (opening) { await opening; return; }
    opening = (async () => {
      const s = createServer({ onShell });
      await new Promise((resolve, reject) => {
        s.once('error', reject);
        s.listen(port, () => { s.removeListener('error', reject); resolve(); });
      });
      s.on('error', (e) => log.warn(`[scrcpyLauncherTest] test port ${port}: ${e.message}`));
      server = s;
      await openFirewall();
    })();
    try { await opening; } finally { opening = null; }
  }

  async function closeIfIdle() {
    const anyPending = [...codes.values()].some((c) => c.state === 'pending');
    if (anyPending || !server) return;
    const s = server;
    server = null;
    // Firewall first: a connection already established keeps working (RELATED,ESTABLISHED), and
    // close() below only stops NEW connections -- it would wait for adb's open one to time out.
    await closeFirewall();
    s.close();
  }

  // Expires pending codes past their TTL, forgets results nobody asked for in a while, and closes the
  // port when nothing is pending.
  async function sweep() {
    const t = now();
    for (const [code, c] of codes) {
      if (c.state === 'pending' && t - c.createdAt > ttlMs) c.state = 'expired';
      if (c.state !== 'pending' && t - c.createdAt > ttlMs * 5) codes.delete(code);
    }
    await closeIfIdle();
    if (![...codes.values()].some((c) => c.state === 'pending') && sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }

  async function start() {
    const pending = [...codes.values()].filter((c) => c.state === 'pending').length;
    if (pending >= MAX_PENDING) {
      const err = new Error('Too many launcher tests in progress; wait a minute and try again');
      err.httpStatus = 429;
      throw err;
    }
    try {
      await ensureOpen();
    } catch (e) {
      const err = new Error(e.code === 'EADDRINUSE'
        ? `The launcher test port ${port} is in use by something else (another forge testing at the same time?). Set REDROID_FORGE_LAUNCHER_TEST_PORT to a free port.`
        : `Could not open the launcher test port ${port}: ${e.message}`);
      err.httpStatus = 409;
      throw err;
    }
    const code = crypto.randomBytes(16).toString('hex');
    codes.set(code, { state: 'pending', createdAt: now() });
    if (!sweepTimer) {
      sweepTimer = setInterval(() => { sweep().catch(() => {}); }, 1000);
      sweepTimer.unref();
    }
    return { code, port, expiresInMs: ttlMs, firewall };
  }

  function result(code) {
    const c = codes.get(code);
    if (!c) return { state: 'unknown' };
    if (c.state === 'pending' && now() - c.createdAt > ttlMs) c.state = 'expired';
    const { state, launcherVersion = null, scrcpyVersion = null, adbVersion = null } = c;
    return { state, launcherVersion, scrcpyVersion, adbVersion, firewall };
  }

  // At boot: a rule left behind by a previous process that died mid-test.
  async function removeLeftoverRule() {
    for (let i = 0; i < 5; i++) {
      try { await exec('iptables', ['-D', ...fwRuleArgs(port)]); } catch (e) { return; }
    }
  }

  async function stop() {
    for (const c of codes.values()) if (c.state === 'pending') c.state = 'expired';
    await closeIfIdle();
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
  }

  return { start, result, sweep, stop, removeLeftoverRule, isOpen: () => !!server, port };
}

let shared = null;
function getShared() {
  if (!shared) shared = createTester();
  return shared;
}

module.exports = { createTester, getShared, testPort, SHELL_TAG, TTL_MS, MAX_PENDING, DEFAULT_PORT };

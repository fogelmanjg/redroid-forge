'use strict';

// Keeps what Android logged when it restarted on its own, so the cause survives the instance restart.
//
// When system_server dies inside a running container, logd is not part of what restarts: the logcat
// buffers still hold the crash until the container itself restarts. androidRestartWatch calls
// capture() right before that restart, and this copies the logcat (every buffer) and the tombstones
// written in the last minutes into backend/data/crash-logs/<instance id>/<UTC time>/ (logcat gzipped).
//
// Retention (prune): a capture is removed only when it is older than KEEP_MS AND it is not among the
// KEEP_LAST newest of its instance. A chain of crashes keeps every capture of the last day, so the
// first one -- the one that started it -- is not lost; a quiet instance still keeps its last ten.
//
// LOGCAT_SIZE: Android's default buffer covers only a few minutes of a chatty game. setBufferSize()
// raises it after each boot (it is not persistent), so the minutes before a crash are still there.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFile } = require('child_process');

const DIR = process.env.REDROID_FORGE_CRASH_LOGS_DIR || path.join(__dirname, '..', '..', 'data', 'crash-logs');
const KEEP_LAST = 10;
const KEEP_MS = 24 * 60 * 60 * 1000;
const LOGCAT_SIZE = '16M';
const TOMBSTONE_MINUTES = 30;

function dockerExec(containerId, argv, { maxBuffer = 128 * 1024 * 1024, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('docker', ['exec', containerId, ...argv], { maxBuffer, timeout, encoding: 'buffer' }, (err, stdout) => {
      if (err) return reject(err);
      return resolve(stdout);
    });
  });
}

// 2026-11-26T13:43:01.123Z -> 2026-11-26T13-43-01Z (sorts by time, valid on any filesystem)
function stamp(ms) {
  return new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
}

function instanceDir(instanceId, dir = DIR) {
  return path.join(dir, String(instanceId).replace(/[^A-Za-z0-9_-]/g, '_'));
}

// Pure: which capture folders to delete. `entries`: [{ name, mtimeMs }].
function selectToPrune(entries, { now, keepLast = KEEP_LAST, keepMs = KEEP_MS }) {
  const newestFirst = [...entries].sort((a, b) => b.mtimeMs - a.mtimeMs);
  return newestFirst.filter((e, i) => i >= keepLast && now - e.mtimeMs > keepMs).map((e) => e.name);
}

function prune(instanceId, { dir = DIR, now = Date.now() } = {}) {
  const base = instanceDir(instanceId, dir);
  let names;
  try { names = fs.readdirSync(base); } catch { return []; }
  const entries = [];
  for (const name of names) {
    try {
      const st = fs.statSync(path.join(base, name));
      if (st.isDirectory()) entries.push({ name, mtimeMs: st.mtimeMs });
    } catch { /* vanished */ }
  }
  const gone = selectToPrune(entries, { now });
  for (const name of gone) fs.rmSync(path.join(base, name), { recursive: true, force: true });
  return gone;
}

// Never throws: a failed capture must not stop the restart. Returns the folder, or null.
async function capture(instance, info = {}, { dir = DIR, exec = dockerExec, now = Date.now(), log = (m) => console.log(`[crashLogs] ${m}`) } = {}) {
  const target = path.join(instanceDir(instance.id, dir), stamp(now));
  try {
    fs.mkdirSync(target, { recursive: true });
    const lines = [
      `instance: ${instance.name} (${instance.id})`,
      `container: ${instance.containerId}`,
      `detected: ${new Date(now).toISOString()}`,
      ...Object.entries(info).map(([k, v]) => `${k}: ${v}`),
    ];
    fs.writeFileSync(path.join(target, 'info.txt'), `${lines.join('\n')}\n`);

    try {
      const out = await exec(instance.containerId, ['logcat', '-d', '-b', 'all', '-v', 'threadtime']);
      // gzip: with 16 MB buffers a plain capture can reach tens of MB; text compresses ~10x
      fs.writeFileSync(path.join(target, 'logcat.txt.gz'), zlib.gzipSync(out));
    } catch (e) {
      fs.writeFileSync(path.join(target, 'logcat.error.txt'), `${e.message}\n`);
    }

    let tombstones = [];
    try {
      const list = await exec(instance.containerId, ['find', '/data/tombstones', '-type', 'f', '-mmin', `-${TOMBSTONE_MINUTES}`]);
      tombstones = String(list).split('\n').map((s) => s.trim()).filter((s) => s && !s.endsWith('.pb'));
    } catch { /* none, or no find */ }
    for (const t of tombstones) {
      try {
        // eslint-disable-next-line no-await-in-loop
        fs.writeFileSync(path.join(target, path.basename(t)), await exec(instance.containerId, ['cat', t]));
      } catch { /* skip that one */ }
    }

    log(`"${instance.name}": saved logcat${tombstones.length ? ` and ${tombstones.length} tombstone(s)` : ''} in ${target}`);
    prune(instance.id, { dir, now });
    return target;
  } catch (e) {
    log(`"${instance.name}": could not save the crash logs: ${e.message}`);
    return null;
  }
}

async function setBufferSize(instance, { exec = dockerExec } = {}) {
  try { await exec(instance.containerId, ['logcat', '-G', LOGCAT_SIZE], { timeout: 15000 }); } catch { /* best effort */ }
}

function cleanup(instanceId, { dir = DIR } = {}) {
  fs.rmSync(instanceDir(instanceId, dir), { recursive: true, force: true });
}

module.exports = {
  capture, prune, selectToPrune, setBufferSize, cleanup, stamp, instanceDir,
  DIR, KEEP_LAST, KEEP_MS, LOGCAT_SIZE,
};

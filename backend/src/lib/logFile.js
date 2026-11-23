'use strict';

// Persistent log (1.0.0-beta.8). Docker keeps this container's stdout only until the container is
// recreated -- every update (`docker compose up -d --build`) wiped the whole history, exactly the
// history needed to diagnose things like an instance flooding the shared hwenc daemon after the
// fact. install() copies every console.log/info/warn/error line, timestamped, into
// backend/data/logs/forge.log (the data bind mount survives updates), rotated by size:
// forge.log -> forge.log.1 ... forge.log.<KEEP>, oldest dropped.
//
// REDROID_FORGE_LOG_FILE: another path, or "off" to disable. Only server.js calls install(), so
// the test suite never writes here.

const fs = require('fs');
const path = require('path');
const util = require('util');

const DEFAULT_FILE = path.join(__dirname, '..', '..', 'data', 'logs', 'forge.log');
const MAX_BYTES = 10 * 1024 * 1024;
const KEEP = 4;

function rotate(file, keep = KEEP) {
  for (let i = keep - 1; i >= 1; i--) {
    try { fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`); } catch { /* that one does not exist yet */ }
  }
  try { fs.renameSync(file, `${file}.1`); } catch { /* nothing to rotate */ }
}

// -> a writer `(level, args) => void`, also usable on its own (tests).
function createWriter(file, { maxBytes = MAX_BYTES, keep = KEEP, now = () => new Date() } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let size = 0;
  try { size = fs.statSync(file).size; } catch { /* new file */ }
  let fd = fs.openSync(file, 'a');
  return function write(level, args) {
    const text = util.format(...args);
    const line = `${now().toISOString()} ${level.toUpperCase().padEnd(5)} ${text}\n`;
    try {
      if (size + Buffer.byteLength(line) > maxBytes && size > 0) {
        fs.closeSync(fd);
        rotate(file, keep);
        fd = fs.openSync(file, 'a');
        size = 0;
      }
      fs.writeSync(fd, line);
      size += Buffer.byteLength(line);
    } catch { /* a full disk must never take the app down with it */ }
  };
}

let installed = false;
function install(env = process.env) {
  if (installed) return null;
  const setting = env.REDROID_FORGE_LOG_FILE;
  if (setting === 'off') return null;
  const file = setting || DEFAULT_FILE;
  let write;
  try { write = createWriter(file); } catch (e) {
    console.warn(`[logFile] cannot write ${file}: ${e.message} -- persistent log disabled`);
    return null;
  }
  installed = true;
  for (const level of ['log', 'info', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => { original(...args); write(level === 'log' ? 'info' : level, args); };
  }
  return file;
}

module.exports = { install, createWriter, rotate, DEFAULT_FILE, MAX_BYTES, KEEP };

'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const settings = require('./settings');
const store = require('./store');

const execFileAsync = promisify(execFile);

// null in settings.json (never touched through the UI, settings.js's own "never touched"
// convention -- see its encodeBackend/authMode comments) falls back to the env var, which
// stays the bootstrap/pre-UI default. Read fresh on every call, not cached at module load, so a
// range saved through Settings (routes/settings.js) applies to the very next instance
// created/edited with no restart -- same reasoning as settings.js's own encodeBackend.
function range() {
  const s = settings.get();
  const start = Number(s.adbPortStart ?? process.env.ADB_PORT_START ?? 5555);
  const end = Number(s.adbPortEnd ?? process.env.ADB_PORT_END ?? 5595);
  return { start, end };
}

function nextPort() {
  const { start, end } = range();
  const used = new Set(store.readAll().map((i) => i.adbPort));
  for (let p = start; p <= end; p += 1) {
    if (!used.has(p)) return p;
  }
  throw new Error('No free ADB ports in the configured range');
}

// Every TCP port this HOST (not just this container) is currently listening on --
// `network_mode: host` (docker-compose.yml) is what makes this a real host-wide check and not
// a container-local one. Pulled out here (10/11/2026) so doctor.js's "ADB port range
// availability" check and the live checks below (routes/instances.js, routes/settings.js) share
// one implementation instead of three copies drifting apart.
async function listeningPorts() {
  const { stdout } = await execFileAsync('ss', ['-ltnH']);
  return new Set(
    stdout.split('\n')
      .map((line) => line.trim().split(/\s+/)[3])
      .filter(Boolean)
      .map((addr) => Number(addr.slice(addr.lastIndexOf(':') + 1)))
      .filter((p) => Number.isInteger(p) && p > 0),
  );
}

// -> { free, usedBy } for ONE port. `usedBy` is `instance:<name>` when another of this
// project's own instances already has it (found in the store, so at least it is explained
// instead of just "taken") or `host` when it is something else entirely, found only via `ss`.
// `excludeInstanceId` lets an instance being EDITED check the very port it already holds
// without flagging its own current binding as a conflict with itself.
async function portStatus(port, { excludeInstanceId } = {}) {
  const other = store.readAll().find((i) => i.adbPort === port && i.id !== excludeInstanceId);
  if (other) return { free: false, usedBy: `instance:${other.name}` };
  const listening = await listeningPorts();
  return listening.has(port) ? { free: false, usedBy: 'host' } : { free: true, usedBy: null };
}

// -> { total, taken: number[] } for a whole RANGE -- same exclusion/host-check as portStatus
// above, shared by doctor.js's check and the live range-check while editing Settings.
async function rangeStatus({ start, end }, { excludeInstanceId } = {}) {
  const ownPorts = new Set(
    store.readAll().filter((i) => i.id !== excludeInstanceId).map((i) => i.adbPort).filter(Boolean),
  );
  const listening = await listeningPorts();
  const taken = [];
  for (let p = start; p <= end; p += 1) {
    if (listening.has(p) && !ownPorts.has(p)) taken.push(p);
  }
  return { total: end - start + 1, taken };
}

module.exports = { range, nextPort, listeningPorts, portStatus, rangeStatus };

'use strict';

// fwknop (Single Packet Authorization) integration for per-instance, per-interface
// ADB/scrcpy port-knocking (docs/ROADMAP.md Phase 9, design agreed 26/10/2026). `fwknopd` runs
// as one more supervised child process inside this same container -- `network_mode: host` +
// `privileged: true` (docker-compose.yml) already put it in the real host's netns with real
// `iptables` access, same reasoning as hwAccel.js's vaapi-daemon, no separate companion needed.
//
// The backend is the ONLY fwknop client that ever knocks (see routes/instances.js's
// POST /:id/adb-access), always from 127.0.0.1, on behalf of an already-authenticated,
// already role-checked UI session -- this project's own Phase 7 access control is the "prior
// authenticated channel" classic SPA exists to substitute for when there is none. The SPA
// crypto still does real work: `fwknopd`'s own PCAP_INTF: lo means it only ever SEES packets
// that originate on this host's own loopback (not a listening socket reachable from outside),
// and its own timeout-based firewall rule cleanup is more robust than a hand-rolled Node timer
// that would leak an open rule if this process restarted mid-window.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const { readJsonObject, writeJsonObject } = require('./jsonFileStore');

const execFileAsync = promisify(execFile);

const DATA_DIR = path.join(__dirname, '..', '..', 'data', 'fwknop');
const KEY_FILE = path.join(DATA_DIR, 'keys.json');
const FWKNOPD_CONF = path.join(DATA_DIR, 'fwknopd.conf');
const ACCESS_CONF = path.join(DATA_DIR, 'access.conf');

const ADB_PORT_START = parseInt(process.env.ADB_PORT_START || '5555', 10);
const ADB_PORT_END = parseInt(process.env.ADB_PORT_END || '5595', 10);

// "1 minute to successfully connect" is the agreed default (ROADMAP Phase 9). Any client-
// requested window beyond that is a warning, never a block (routes/instances.js) -- so
// MAX_FW_TIMEOUT (fwknopd's OWN cap, 300s if left unset) is raised here to effectively "no
// cap", matching that explicit decision instead of silently re-imposing one underneath it.
const DEFAULT_KNOCK_SECONDS = 60;
// fwknopd's own hard ceiling for this field (RCHK_MAX_FW_TIMEOUT in its source, `(2 << 22)`
// seconds, ~97 days) -- not a choice of this app's, it is the most fwknopd will ever accept;
// confirmed live (26/10/2026) that anything above it is rejected outright at config-parse time
// ("MAX_FW_TIMEOUT value not in range"), so this is the real value, not a round number picked
// to "look like" no cap.
const MAX_FW_TIMEOUT_SECONDS = 2 << 22;

// Generated once per file and persisted (not re-derived from an env var), same pattern as
// session.js's getSecret -- an fwknop key that changed on every restart would make every
// in-flight access.conf/fwknopd pairing instantly invalid for no reason.
function getOrGenerateKeys(file = KEY_FILE) {
  const stored = readJsonObject(file);
  if (stored.rijndael && stored.hmac) return stored;
  const keys = { rijndael: crypto.randomBytes(32).toString('base64'), hmac: crypto.randomBytes(32).toString('base64') };
  writeJsonObject(file, keys);
  return keys;
}

// fwknop has no port-RANGE syntax in OPEN_PORTS (confirmed against its own access.c parser,
// 26/10/2026 session -- expand_acc_port_list() splits on commas and parse_proto_and_port()
// strtol's the part after '/', a '-' just fails to parse) -- enumerated explicitly instead.
function buildOpenPortsList(start = ADB_PORT_START, end = ADB_PORT_END) {
  const ports = [];
  for (let p = start; p <= end; p++) ports.push(`tcp/${p}`);
  return ports.join(',');
}

// access.conf: one stanza, SOURCE pinned to 127.0.0.1 -- legitimacy was already decided by
// Phase 7's auth before the knock is even sent (see routes/instances.js), the knock itself is
// just the mechanism, so there is no per-user/per-instance stanza here.
function renderAccessConf(keys, { start = ADB_PORT_START, end = ADB_PORT_END } = {}) {
  return [
    'SOURCE              127.0.0.1',
    `OPEN_PORTS          ${buildOpenPortsList(start, end)}`,
    `KEY_BASE64          ${keys.rijndael}`,
    `HMAC_KEY_BASE64     ${keys.hmac}`,
    `FW_ACCESS_TIMEOUT   ${DEFAULT_KNOCK_SECONDS}`,
    `MAX_FW_TIMEOUT      ${MAX_FW_TIMEOUT_SECONDS}`,
    '',
  ].join('\n');
}

// The chain/jump name this feature's own fwknopd manages, deliberately NOT the library's own
// default ("FWKNOP_INPUT"). Found live (26/10/2026): this host already runs its OWN,
// completely unrelated `fwknop-server.service` (systemd, protecting SSH, pre-existing, not
// part of this project) that ALSO defaults to that exact chain name -- `network_mode: host` +
// `pid: host` mean there is no namespace of any kind separating the two, so sharing the
// default name would make this feature's fwknopd manage the SAME chain as the host's own SSH
// SPA setup. Confirmed live that fwknopd detects an existing jump rule and does not duplicate
// it, so no crash resulted -- but FLUSH_IPT_AT_EXIT: Y (the library default) on THIS fwknopd
// would still flush that SHARED chain when this container stops, deleting the host's own live
// SSH access rule. A chain name unique to this project removes the collision entirely instead
// of merely disabling the symptom.
const CHAIN_NAME = 'REDROID_FORGE_FWKNOP_INPUT';

function renderFwknopdConf() {
  return [
    // Only ever sniffs loopback -- a knock from any real network interface is invisible to
    // this process, not merely rejected by the SOURCE check below it.
    'PCAP_INTF           lo;',
    'ENABLE_SPA_OVER_HTTP N;',
    `IPT_INPUT_ACCESS    ACCEPT, filter, INPUT, 1, ${CHAIN_NAME}, 1;`,
    // Belt-and-suspenders beyond the unique chain name above: never flush ANY chain this
    // fwknopd did not create fresh itself, under any circumstance, on this shared-netns host.
    'FLUSH_IPT_AT_INIT   N;',
    'FLUSH_IPT_AT_EXIT   N;',
    '',
  ].join('\n');
}

// fwknopd refuses to start if either config file is group/world-readable (it holds the SPA
// key) -- confirmed live (26/10/2026): "file ... permissions should only be user read/write
// (0600, -rw-------)". fs.writeFileSync's default mode (0666 minus umask) is not strict
// enough, so both are chmod'd explicitly right after writing.
function ensureConfigFiles({
  dir = DATA_DIR, keyFile = KEY_FILE, fwknopdConf = FWKNOPD_CONF, accessConf = ACCESS_CONF,
} = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const keys = getOrGenerateKeys(keyFile);
  fs.writeFileSync(fwknopdConf, renderFwknopdConf());
  fs.chmodSync(fwknopdConf, 0o600);
  fs.writeFileSync(accessConf, renderAccessConf(keys));
  fs.chmodSync(accessConf, 0o600);
  return { keys, fwknopdConf, accessConf };
}

// Module-level handle, same single-instance-per-process pattern as hwAccel.js's
// daemonProcess -- fwknopd is a singleton (one set of iptables chains), never one per instance.
let daemonProcess = null;

// This container runs with `pid: host` (docker-compose.yml) -- a PREVIOUS container that
// exited uncleanly (killed rather than given a chance to run server.js's own SIGTERM handler,
// see server.js) can leave an fwknopd with the exact same `-c <our conf>` command line still
// alive on the host, outliving the container it belonged to. Starting a SECOND one against
// the same config/chain is the same kind of collision this module exists to avoid (see
// CHAIN_NAME's own comment) -- `pkill -f` matching our own config file's path is specific
// enough to never touch the host's unrelated `fwknop-server.service` (different config path
// entirely, /etc/fwknop/...).
function killStale(fwknopdConf, { execSync = require('child_process').execFileSync } = {}) {
  try {
    execSync('pkill', ['-9', '-f', `fwknopd -f -c ${fwknopdConf}`]);
  } catch {
    // exit code 1 = no matching process, the common case -- not an error
  }
}

function start({ spawnFn = spawn, conf } = {}) {
  if (daemonProcess) return daemonProcess;
  const { fwknopdConf, accessConf } = conf || ensureConfigFiles();
  killStale(fwknopdConf);
  daemonProcess = spawnFn('fwknopd', ['-f', '-c', fwknopdConf, '-a', accessConf], { stdio: ['ignore', 'pipe', 'pipe'] });
  daemonProcess.on('exit', (code) => {
    console.error(`fwknopd exited unexpectedly (code ${code})`);
    daemonProcess = null;
  });
  daemonProcess.stderr?.on('data', (d) => console.error(`fwknopd: ${d}`.trim()));
  return daemonProcess;
}

// SIGKILL, not SIGTERM: fwknopd's own graceful shutdown would run its exit-time rule cleanup
// (harmless here with FLUSH_IPT_AT_EXIT: N and our own unique chain, but SIGKILL is also just
// faster and simpler for a process this module fully owns and is about to stop tracking).
function stop() {
  if (daemonProcess) { daemonProcess.kill('SIGKILL'); daemonProcess = null; }
}

function isRunning() {
  return !!daemonProcess;
}

// Any `fwknopd` process on the host that is NOT this project's own (matched by command line,
// same `pkill -f` target as killStale() above) -- for doctor.js's own check. `pid: host` is
// what makes this even meaningful to ask: on a normal container this would only ever see
// itself. Found live (26/10/2026, see CHAIN_NAME's comment): this host already runs an
// unrelated `fwknop-server.service` for SSH, and there is no reason another host running
// redroid-forge could not have its own unrelated fwknop setup too -- this is a real scenario
// to detect and explain, not a one-off fluke of this particular host.
async function detectForeignFwknopd({ exec = execFileAsync, fwknopdConf = FWKNOPD_CONF } = {}) {
  try {
    const { stdout } = await exec('pgrep', ['-af', 'fwknopd']);
    return stdout.split('\n').map((l) => l.trim()).filter(Boolean).filter((line) => !line.includes(fwknopdConf));
  } catch (e) {
    if (e.code === 1) return []; // pgrep's own "no process matched at all" -- not an error
    throw e;
  }
}

const ESTABLISHED_ARGS = (hostIp, port) => [
  '-d', hostIp, '-p', 'tcp', '--dport', String(port), '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '-j', 'ACCEPT',
];
const DROP_ARGS = (hostIp, port) => ['-d', hostIp, '-p', 'tcp', '--dport', String(port), '-j', 'DROP'];

async function ruleExists(args, exec) {
  try {
    await exec('iptables', ['-C', 'INPUT', ...args]);
    return true;
  } catch {
    return false;
  }
}

// Idempotent: safe to call every time an instance's knockRequiredHosts gains this host, even
// if the rules are somehow already there (process restart, a previous call that half-applied).
// Call order matters -- both use -A (append), so ESTABLISHED must be appended BEFORE DROP to
// land ahead of it in INPUT; fwknopd's own FWKNOP_INPUT jump rule (IPT_INPUT_ACCESS, inserted
// at position 1) stays ahead of both regardless of when this runs.
async function ensureGuardRules(hostIp, port, { exec = execFileAsync } = {}) {
  const established = ESTABLISHED_ARGS(hostIp, port);
  const drop = DROP_ARGS(hostIp, port);
  if (!(await ruleExists(established, exec))) await exec('iptables', ['-A', 'INPUT', ...established]);
  if (!(await ruleExists(drop, exec))) await exec('iptables', ['-A', 'INPUT', ...drop]);
}

// Tolerant of "already gone" (iptables -D exits non-zero with "Bad rule" if the rule is not
// there) -- same reasoning as dockerRuntime's stop()/remove() tolerance of an already-stopped
// container, turning this interface's knock requirement off twice in a row is not an error.
async function removeGuardRules(hostIp, port, { exec = execFileAsync } = {}) {
  await exec('iptables', ['-D', 'INPUT', ...DROP_ARGS(hostIp, port)]).catch(() => {});
  await exec('iptables', ['-D', 'INPUT', ...ESTABLISHED_ARGS(hostIp, port)]).catch(() => {});
}

// In-memory only -- advisory display state for the UI ("open until HH:MM"), never the actual
// enforcement (that is fwknopd's own iptables rule + its own timeout). Losing this on a
// restart is harmless: the real rule either already expired on its own or is still open, and
// the next GET simply shows "closed" until someone knocks again.
const openState = new Map();
const stateKey = (hostIp, port) => `${hostIp}:${port}`;

function getState(hostIp, port) {
  const s = openState.get(stateKey(hostIp, port));
  if (!s || s.openUntil < Date.now()) return { open: false };
  return { open: true, sourceIp: s.sourceIp, openUntil: s.openUntil };
}

// `seconds`: the actual firewall window requested (-f on the fwknop client) -- the caller
// (routes/instances.js) is where "no cap, just a warning past the 1-minute default" lives,
// this function does not re-judge that, it just forwards whatever it is given.
async function requestAccess({
  hostIp, port, sourceIp, seconds = DEFAULT_KNOCK_SECONDS, exec = execFileAsync, keys,
}) {
  await ensureGuardRules(hostIp, port, { exec });
  const k = keys || getOrGenerateKeys();
  const fwTimeout = String(Math.max(1, Math.round(seconds)));
  await exec('fwknop', [
    '-A', `tcp/${port}`,
    '-a', sourceIp,
    '-D', '127.0.0.1',
    '-f', fwTimeout,
    '--key-base64-rijndael', k.rijndael,
    '--key-base64-hmac', k.hmac,
    '--use-hmac',
    '--no-save-args',
    // NOT --no-home-dir: confirmed live (26/10/2026) that it refuses to run unless --rc-file
    // is ALSO given ("must set --rc-file path"), defeating the point of avoiding one entirely.
    // --no-rc-file alone needs neither a home directory nor an rc file at all.
    '--no-rc-file',
  ]);
  openState.set(stateKey(hostIp, port), { sourceIp, openUntil: Date.now() + seconds * 1000 });
  return getState(hostIp, port);
}

module.exports = {
  ADB_PORT_START, ADB_PORT_END, DEFAULT_KNOCK_SECONDS, MAX_FW_TIMEOUT_SECONDS, CHAIN_NAME, FWKNOPD_CONF,
  getOrGenerateKeys, buildOpenPortsList, renderAccessConf, renderFwknopdConf, ensureConfigFiles,
  start, stop, isRunning, detectForeignFwknopd,
  ensureGuardRules, removeGuardRules, requestAccess, getState,
};

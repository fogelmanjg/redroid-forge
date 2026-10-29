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
  // Fire-and-forget: self-heals anything a previous, uncleanly-stopped process left open past
  // its own expiry, and restores the remaining-time timers for anything still legitimately open
  // (see sweepStaleTempRules's own comment -- this module's temporary-access rules cannot reuse
  // fwknopd's own built-in expiry, so they need their own restart-survival story).
  sweepStaleTempRules().catch((e) => console.error(`fwknop: sweepStaleTempRules failed: ${e}`));
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

// Real incident, 28/10/2026, found testing Phase 9 live for the first time against a real
// instance: Docker publishes every instance's ADB port through bridge-network NAT (dockerRuntime
// create()'s PortBindings), which DNATs in PREROUTING -- long before this host's own INPUT chain
// (where this feature's rules used to live) ever runs. Confirmed with kernel packet counters
// (temporary nft probes, removed after): zero hits in INPUT for a real connection, the hits are
// all in FORWARD, via DOCKER-USER (the chain Docker itself reserves for exactly this -- user
// rules that filter traffic to a published container). This was never just a Tailscale problem --
// it never worked for ANY interface, because INPUT is simply the wrong chain for Docker-published
// container traffic. Matching on the container's own bridge IP + its fixed internal port (5555,
// see dockerRuntime.js's ExposedPorts/PortBindings, identical for every instance) plus the
// ORIGINAL pre-NAT destination (`-m conntrack --ctorigdst`/`--ctorigdstport`, already fully
// populated by the time a packet reaches FORWARD, even for its own first SYN -- confirmed live)
// keeps this scoped to exactly the one host interface being gated, the precision `-d hostIp` used
// to give for free back when the rules lived in INPUT.
const CONTAINER_ADB_PORT = 5555;
const DOCKER_USER_CHAIN = 'DOCKER-USER';

const matchArgs = (containerIp, hostIp, port) => [
  '-d', containerIp, '-p', 'tcp', '--dport', String(CONTAINER_ADB_PORT),
  '-m', 'conntrack', '--ctorigdst', hostIp, '--ctorigdstport', String(port),
];
const ESTABLISHED_ARGS = (containerIp, hostIp, port) => [...matchArgs(containerIp, hostIp, port), '--ctstate', 'ESTABLISHED,RELATED', '-j', 'ACCEPT'];
const DROP_ARGS = (containerIp, hostIp, port) => [...matchArgs(containerIp, hostIp, port), '-j', 'DROP'];

async function ruleExists(args, exec) {
  try {
    await exec('iptables', ['-C', DOCKER_USER_CHAIN, ...args]);
    return true;
  } catch {
    return false;
  }
}

// Idempotent: safe to call every time an instance's knockRequiredHosts gains this host, even
// if the rules are somehow already there (process restart, a previous call that half-applied).
// Call order matters -- both use -A (append), so ESTABLISHED must be appended BEFORE DROP to
// land ahead of it in DOCKER-USER.
async function ensureGuardRules(containerIp, hostIp, port, { exec = execFileAsync } = {}) {
  const established = ESTABLISHED_ARGS(containerIp, hostIp, port);
  const drop = DROP_ARGS(containerIp, hostIp, port);
  if (!(await ruleExists(established, exec))) await exec('iptables', ['-A', DOCKER_USER_CHAIN, ...established]);
  if (!(await ruleExists(drop, exec))) await exec('iptables', ['-A', DOCKER_USER_CHAIN, ...drop]);
}

// Tolerant of "already gone" (iptables -D exits non-zero with "Bad rule" if the rule is not
// there) -- same reasoning as dockerRuntime's stop()/remove() tolerance of an already-stopped
// container, turning this interface's knock requirement off twice in a row is not an error.
async function removeGuardRules(containerIp, hostIp, port, { exec = execFileAsync } = {}) {
  await exec('iptables', ['-D', DOCKER_USER_CHAIN, ...DROP_ARGS(containerIp, hostIp, port)]).catch(() => {});
  await exec('iptables', ['-D', DOCKER_USER_CHAIN, ...ESTABLISHED_ARGS(containerIp, hostIp, port)]).catch(() => {});
}

// In-memory only -- advisory display state for the UI ("open until HH:MM"); the real enforcement
// is the tagged temporary ACCEPT rule below. Losing this map on a restart is harmless on its own
// (the next GET just shows "closed" until the sweep below restores it), which is exactly why the
// rule itself carries its own expiry rather than relying on this map.
const openState = new Map();
const stateKey = (hostIp, port) => `${hostIp}:${port}`;

function getState(hostIp, port) {
  const s = openState.get(stateKey(hostIp, port));
  if (!s || s.openUntil < Date.now()) return { open: false };
  return { open: true, sourceIp: s.sourceIp, openUntil: s.openUntil };
}

// The temporary ACCEPT rule a successful knock installs, tagged with its own expiry (no spaces,
// so a naive whitespace split -- same tokenizer detectBypassingRules uses -- never mis-parses
// it). fwknopd's OWN dynamic rule-insertion (IPT_INPUT_ACCESS/CHAIN_NAME) cannot be reused for
// this: it matches by port alone, in a chain jumped from INPUT, which (a) is the wrong chain (see
// above) and (b) could not distinguish between instances anyway, since every container exposes
// the SAME internal port 5555 -- there is no per-container destination in fwknopd's own rule
// shape. The real fwknop client/daemon SPA exchange still happens below regardless (defense in
// depth, same "prior authenticated channel" reasoning as this module's header comment); only the
// rule that actually matters -- this one -- is reimplemented here instead of reused from it.
const TEMP_TAG = 'redroid-forge-knock-open';
const tempArgs = (containerIp, hostIp, port, sourceIp, openUntil) => [
  '-d', containerIp, '-s', sourceIp, '-p', 'tcp', '--dport', String(CONTAINER_ADB_PORT),
  '-m', 'conntrack', '--ctorigdst', hostIp, '--ctorigdstport', String(port),
  '-m', 'comment', '--comment', `${TEMP_TAG}:${hostIp}:${port}:${openUntil}`,
  '-j', 'ACCEPT',
];

// hostIp:port -> Node Timeout, so a fresh knock on an already-open window replaces the old timer
// instead of stacking two that would both try to -D the (by then different-looking) rule.
const openTimers = new Map();

function armExpiry(hostIp, port, ruleArgs, remainingMs, { exec = execFileAsync } = {}) {
  const key = stateKey(hostIp, port);
  const existing = openTimers.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    exec('iptables', ['-D', DOCKER_USER_CHAIN, ...ruleArgs]).catch(() => {});
    openTimers.delete(key);
  }, Math.max(0, remainingMs));
  openTimers.set(key, timer);
}

// Finds this feature's own temporary ACCEPT rules directly in DOCKER-USER by their --comment tag,
// independent of in-memory state -- what lets sweepStaleTempRules self-heal after a restart
// instead of leaking one open forever (the in-memory openTimers/openState above do not survive
// one, unlike fwknopd's own built-in expiry, which this rule shape cannot reuse -- see TEMP_TAG).
async function listTempRules({ exec = execFileAsync } = {}) {
  const { stdout } = await exec('iptables', ['-S', DOCKER_USER_CHAIN]);
  const out = [];
  for (const rawLine of stdout.split('\n')) {
    const tokens = rawLine.trim().split(/\s+/);
    const ci = tokens.indexOf('--comment');
    if (ci === -1) continue;
    const comment = tokens[ci + 1];
    if (!comment || !comment.startsWith(`${TEMP_TAG}:`)) continue;
    const [, hostIp, port, openUntilStr] = comment.split(':');
    // tokens[0] is '-A', tokens[1] is the chain name -- the rest replays exactly against a `-D`.
    out.push({ hostIp, port: Number(port), openUntil: Number(openUntilStr), ruleArgs: tokens.slice(2) });
  }
  return out;
}

// Called once from start() -- removes anything already past its own expiry (leaked by an
// uncleanly-stopped previous process) and re-arms a fresh timer for anything still legitimately
// open, so the remaining window survives a restart instead of being silently lost either way.
async function sweepStaleTempRules({ exec = execFileAsync } = {}) {
  const rules = await listTempRules({ exec }).catch(() => []);
  const now = Date.now();
  for (const rule of rules) {
    if (rule.openUntil <= now) {
      await exec('iptables', ['-D', DOCKER_USER_CHAIN, ...rule.ruleArgs]).catch(() => {});
      continue;
    }
    openState.set(stateKey(rule.hostIp, rule.port), { sourceIp: undefined, openUntil: rule.openUntil });
    armExpiry(rule.hostIp, rule.port, rule.ruleArgs, rule.openUntil - now, { exec });
  }
}

// `seconds`: the actual firewall window requested (-f on the fwknop client, and this temporary
// rule's own lifetime) -- the caller (routes/instances.js) is where "no cap, just a warning past
// the 1-minute default" lives, this function does not re-judge that, it just forwards whatever it
// is given.
async function requestAccess({
  containerIp, hostIp, port, sourceIp, seconds = DEFAULT_KNOCK_SECONDS, exec = execFileAsync, keys,
}) {
  await ensureGuardRules(containerIp, hostIp, port, { exec });
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
  const openUntil = Date.now() + seconds * 1000;
  const args = tempArgs(containerIp, hostIp, port, sourceIp, openUntil);
  // -I ... 1: ahead of every other rule in this chain, including other instances' own guard
  // pairs -- harmless, since none of them can match a different containerIp/ctorigdst anyway.
  await exec('iptables', ['-I', DOCKER_USER_CHAIN, '1', ...args]);
  armExpiry(hostIp, port, args, seconds * 1000, { exec });
  openState.set(stateKey(hostIp, port), { sourceIp, openUntil });
  return getState(hostIp, port);
}

// Deliberately narrow (not a general netfilter rule engine): only the common, realistic shape of
// "an earlier ACCEPT with nothing that would exclude this container/port" (any rule whose match
// criteria do not rule out containerIp:5555 for a fresh connection). Misses anything that requires
// following a jump into another chain, or more exotic match modules (negated matches, -m recent,
// ipsets, ...).
function portInDportsSpec(port, spec) {
  // "-m multiport --dports 22,80,25565:25569" -- comma list of single ports and n:m ranges.
  return spec.split(',').some((part) => {
    if (part.includes(':')) {
      const [lo, hi] = part.split(':').map(Number);
      return port >= lo && port <= hi;
    }
    return Number(part) === port;
  });
}

function ruleTokenValue(tokens, flag) {
  const i = tokens.indexOf(flag);
  return i === -1 ? null : tokens[i + 1];
}

function isOurDropRule(tokens, containerIp) {
  const d = ruleTokenValue(tokens, '-d');
  const dport = ruleTokenValue(tokens, '--dport');
  return tokens[tokens.length - 1] === 'DROP' && (d === containerIp || d === `${containerIp}/32`) && dport === String(CONTAINER_ADB_PORT);
}

function wouldBypassForFreshConnection(tokens, containerIp) {
  if (tokens[tokens.length - 1] !== 'ACCEPT') return false;
  const inIf = ruleTokenValue(tokens, '-i');
  if (inIf === 'lo') return false; // locally-originated (then forwarded) -- same-host trust, not a meaningful bypass of a remote-access gate
  const state = ruleTokenValue(tokens, '--state') || ruleTokenValue(tokens, '--ctstate');
  if (state && !state.split(',').includes('NEW')) return false; // only admits already-established traffic, never a knock-less fresh connection
  const d = ruleTokenValue(tokens, '-d');
  if (d && d !== containerIp && d !== `${containerIp}/32`) return false; // scoped to a different destination
  const proto = ruleTokenValue(tokens, '-p');
  if (proto && proto !== 'tcp') return false;
  const dport = ruleTokenValue(tokens, '--dport');
  if (dport && dport !== String(CONTAINER_ADB_PORT)) return false;
  const dports = ruleTokenValue(tokens, '--dports');
  if (dports && !portInDportsSpec(CONTAINER_ADB_PORT, dports)) return false;
  return true;
}

// Returns the raw `-A DOCKER-USER ...` lines (iptables-save syntax) of any rule that would
// already ACCEPT a fresh connection to this instance's container before this project's own DROP
// rule is ever reached -- i.e. the knock requirement recorded in knockRequiredHosts has no actual
// effect at the firewall. `containerIp`: the instance's own bridge IP (dockerRuntime.getBridgeIp),
// not the host-facing address -- see this module's own header comment on why DOCKER-USER, keyed
// by the container, is the only chain that ever actually sees this traffic.
async function detectBypassingRules(containerIp, { exec = execFileAsync } = {}) {
  const { stdout } = await exec('iptables', ['-S', DOCKER_USER_CHAIN]);
  const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith(`-A ${DOCKER_USER_CHAIN}`));
  const bypassing = [];
  for (const line of lines) {
    const tokens = line.split(/\s+/);
    if (isOurDropRule(tokens, containerIp)) break; // nothing after this point can matter -- it's our own gate
    if (wouldBypassForFreshConnection(tokens, containerIp)) bypassing.push(line);
  }
  return bypassing;
}

module.exports = {
  ADB_PORT_START, ADB_PORT_END, DEFAULT_KNOCK_SECONDS, MAX_FW_TIMEOUT_SECONDS, CHAIN_NAME, FWKNOPD_CONF,
  CONTAINER_ADB_PORT, DOCKER_USER_CHAIN,
  getOrGenerateKeys, buildOpenPortsList, renderAccessConf, renderFwknopdConf, ensureConfigFiles,
  start, stop, isRunning, detectForeignFwknopd, sweepStaleTempRules,
  ensureGuardRules, removeGuardRules, requestAccess, getState, detectBypassingRules,
};

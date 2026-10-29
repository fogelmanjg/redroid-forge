// Coverage of src/lib/fwknop.js: config rendering, key persistence, and the iptables rule
// management (with an injected `exec`, never a real `iptables`/`fwknopd` binary -- see
// hwAccelSocket.test.js's execAndroidWithRetry for the same injectable-exec pattern).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fwknop = require('../src/lib/fwknop');

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fwknop-'));
  return path.join(dir, name);
}

test('getOrGenerateKeys: generated once and persisted (same file -> same keys across calls)', () => {
  const file = tmpFile('keys.json');
  const a = fwknop.getOrGenerateKeys(file);
  const b = fwknop.getOrGenerateKeys(file);
  assert.deepEqual(a, b);
  assert.equal(typeof a.rijndael, 'string');
  assert.equal(typeof a.hmac, 'string');
  assert.ok(Buffer.from(a.rijndael, 'base64').length >= 32);
});

test('getOrGenerateKeys: a different file gets different keys', () => {
  const a = fwknop.getOrGenerateKeys(tmpFile('keys.json'));
  const b = fwknop.getOrGenerateKeys(tmpFile('keys.json'));
  assert.notEqual(a.rijndael, b.rijndael);
});

test('buildOpenPortsList: enumerates every port individually -- fwknop has no range syntax', () => {
  assert.equal(fwknop.buildOpenPortsList(5555, 5557), 'tcp/5555,tcp/5556,tcp/5557');
  assert.equal(fwknop.buildOpenPortsList(5555, 5555), 'tcp/5555');
});

test('renderAccessConf: pins SOURCE to localhost and raises fwknopd\'s own MAX_FW_TIMEOUT cap', () => {
  const conf = fwknop.renderAccessConf({ rijndael: 'R==', hmac: 'H==' }, { start: 5555, end: 5556 });
  assert.match(conf, /SOURCE\s+127\.0\.0\.1/);
  assert.match(conf, /OPEN_PORTS\s+tcp\/5555,tcp\/5556/);
  assert.match(conf, /KEY_BASE64\s+R==/);
  assert.match(conf, /HMAC_KEY_BASE64\s+H==/);
  assert.match(conf, new RegExp(`MAX_FW_TIMEOUT\\s+${fwknop.MAX_FW_TIMEOUT_SECONDS}`));
});

test('renderFwknopdConf: only ever sniffs loopback, uses its own chain name, and never flushes it', () => {
  const conf = fwknop.renderFwknopdConf();
  assert.match(conf, /PCAP_INTF\s+lo;/);
  assert.match(conf, new RegExp(`IPT_INPUT_ACCESS\\s+ACCEPT, filter, INPUT, 1, ${fwknop.CHAIN_NAME}, 1;`));
  assert.match(conf, /FLUSH_IPT_AT_INIT\s+N;/);
  assert.match(conf, /FLUSH_IPT_AT_EXIT\s+N;/);
});

test('CHAIN_NAME is not fwknop\'s own library default -- this host already runs an unrelated fwknopd that uses it', () => {
  assert.notEqual(fwknop.CHAIN_NAME, 'FWKNOP_INPUT');
});

test('ensureConfigFiles: writes both files to the given dir, reusing a key already on disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fwknop-dir-'));
  const keyFile = path.join(dir, 'keys.json');
  const fwknopdConf = path.join(dir, 'fwknopd.conf');
  const accessConf = path.join(dir, 'access.conf');
  const { keys } = fwknop.ensureConfigFiles({ dir, keyFile, fwknopdConf, accessConf });
  assert.ok(fs.existsSync(fwknopdConf));
  assert.ok(fs.existsSync(accessConf));
  const again = fwknop.ensureConfigFiles({ dir, keyFile, fwknopdConf, accessConf });
  assert.deepEqual(again.keys, keys);
});

function fakeExec(existingRules) {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === '-C') {
      const sig = args.join(' ');
      if (!existingRules.has(sig)) { const e = new Error('no such rule'); e.code = 1; throw e; }
      return;
    }
    return { stdout: '' };
  };
  return { exec, calls };
}

// 28/10/2026: the guard rules moved from INPUT (keyed by the host's own interface IP) to
// DOCKER-USER (keyed by the instance's container bridge IP + the ORIGINAL pre-NAT destination,
// via conntrack) -- see fwknop.js's own module comment for the real incident (Docker's bridge-
// network port publishing DNATs in PREROUTING, long before INPUT ever runs, so a rule there
// never once evaluated for real instance traffic, on any interface).
test('ensureGuardRules: appends ESTABLISHED/RELATED before DROP into DOCKER-USER, only for rules not already there', async () => {
  const { exec, calls } = fakeExec(new Set());
  await fwknop.ensureGuardRules('172.17.0.11', '100.73.0.50', 5580, { exec });
  const appends = calls.filter((c) => c[1] === '-A');
  assert.equal(appends.length, 2);
  assert.equal(appends[0][2], fwknop.DOCKER_USER_CHAIN);
  assert.ok(appends[0].includes('ESTABLISHED,RELATED'), 'ESTABLISHED/RELATED exception appended first');
  assert.ok(appends[1].includes('DROP'), 'DROP appended second, so it never precedes the exception');
  for (const a of appends) {
    assert.ok(a.includes('172.17.0.11'), 'matches the container\'s own bridge IP');
    assert.ok(a.includes(String(fwknop.CONTAINER_ADB_PORT)), 'matches the fixed internal ADB port, not the host-facing one');
    assert.ok(a.includes('--ctorigdst') && a.includes('100.73.0.50'), 'scoped to the original (pre-NAT) destination host');
    assert.ok(a.includes('--ctorigdstport') && a.includes('5580'), 'scoped to the original (pre-NAT) destination port');
  }
});

test('ensureGuardRules: idempotent -- does nothing when both rules already exist', async () => {
  const base = ['-d', '172.17.0.11', '-p', 'tcp', '--dport', '5555', '-m', 'conntrack', '--ctorigdst', '100.73.0.50', '--ctorigdstport', '5580'];
  const establishedSig = ['-C', fwknop.DOCKER_USER_CHAIN, ...base, '--ctstate', 'ESTABLISHED,RELATED', '-j', 'ACCEPT'].join(' ');
  const dropSig = ['-C', fwknop.DOCKER_USER_CHAIN, ...base, '-j', 'DROP'].join(' ');
  const { exec, calls } = fakeExec(new Set([establishedSig, dropSig]));
  await fwknop.ensureGuardRules('172.17.0.11', '100.73.0.50', 5580, { exec });
  assert.equal(calls.filter((c) => c[1] === '-A').length, 0);
});

test('removeGuardRules: tolerant of rules that are already gone', async () => {
  const exec = async () => { const e = new Error('Bad rule'); e.code = 1; throw e; };
  await assert.doesNotReject(() => fwknop.removeGuardRules('172.17.0.11', '100.73.0.50', 5580, { exec }));
});

// `seconds: 1` (not e.g. 90) deliberately -- requestAccess arms a REAL setTimeout for its
// temporary ACCEPT rule's own expiry (see armExpiry), and this test never cancels it, so a large
// value would leave the test process waiting that long before it can exit.
test('requestAccess: ensures the guard rules, knocks via the fwknop client, installs its own tagged temporary ACCEPT, and records advisory state', async () => {
  const calls = [];
  const exec = async (cmd, args) => { calls.push([cmd, ...args]); return { stdout: '' }; };
  const keys = { rijndael: 'R==', hmac: 'H==' };
  const before = Date.now();
  const state = await fwknop.requestAccess({
    containerIp: '172.17.0.11', hostIp: '100.73.0.50', port: 5580, sourceIp: '203.0.113.9', seconds: 1, exec, keys,
  });
  assert.equal(state.open, true);
  assert.equal(state.sourceIp, '203.0.113.9');
  assert.ok(state.openUntil >= before + 1000);

  const knock = calls.find((c) => c[0] === 'fwknop');
  assert.ok(knock);
  assert.ok(knock.includes('tcp/5580'));
  assert.ok(knock.includes('203.0.113.9'));
  assert.ok(knock.includes('-f') && knock.includes('1'));
  assert.ok(knock.includes('R==') && knock.includes('H=='));

  // fwknopd's OWN dynamic rule (IPT_INPUT_ACCESS) cannot be reused here -- wrong chain (INPUT),
  // and it cannot tell containers apart anyway (every one exposes the same internal port 5555).
  // The rule that actually matters is this project's own -I into DOCKER-USER.
  const insert = calls.find((c) => c[1] === '-I');
  assert.ok(insert, 'installs its own temporary ACCEPT');
  assert.equal(insert[2], fwknop.DOCKER_USER_CHAIN);
  assert.equal(insert[3], '1');
  assert.ok(insert.includes('172.17.0.11') && insert.includes('203.0.113.9'));
  assert.ok(insert.some((t) => typeof t === 'string' && t.startsWith('redroid-forge-knock-open:100.73.0.50:5580:')));

  assert.ok(fwknop.getState('100.73.0.50', 5580).open);
  assert.equal(fwknop.getState('100.73.0.50', 5581).open, false, 'a different port was never knocked for');
});

// Same "no actual expiry survives a restart for free" problem this module's header comment
// explains for why fwknopd's own built-in one cannot be reused -- this is its replacement:
// a restart (start()) sweeps DOCKER-USER for this project's own tagged rules and either removes
// one already past its own embedded expiry (self-healing a leak from an unclean previous exit),
// or re-arms a fresh timer for the remaining time of one still legitimately open.
test('sweepStaleTempRules: removes an already-expired tagged rule', async () => {
  const pastExpiry = Date.now() - 5000;
  const calls = [];
  // A port not used by any other test in this file -- getState is shared module state, and a
  // collision with e.g. the requestAccess test's own 100.73.0.50:5580 would make this test
  // depend on exactly how much wall-clock time had passed since that other test ran.
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === '-S') {
      return {
        stdout: `-A ${fwknop.DOCKER_USER_CHAIN} -d 172.17.0.11 -s 203.0.113.9 -p tcp --dport 5555 `
          + `-m conntrack --ctorigdst 100.73.0.50 --ctorigdstport 5599 -m comment `
          + `--comment redroid-forge-knock-open:100.73.0.50:5599:${pastExpiry} -j ACCEPT\n`,
      };
    }
    return { stdout: '' };
  };
  await fwknop.sweepStaleTempRules({ exec });
  const del = calls.find((c) => c[1] === '-D');
  assert.ok(del, 'removes the stale rule');
  assert.equal(del[2], fwknop.DOCKER_USER_CHAIN);
  assert.equal(fwknop.getState('100.73.0.50', 5599).open, false);
});

test('sweepStaleTempRules: a still-valid tagged rule is left in place and its state restored', async () => {
  const futureExpiry = Date.now() + 200; // short -- re-arms a REAL setTimeout for the remainder
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === '-S') {
      return {
        stdout: `-A ${fwknop.DOCKER_USER_CHAIN} -d 172.17.0.11 -s 203.0.113.9 -p tcp --dport 5555 `
          + `-m conntrack --ctorigdst 100.73.0.50 --ctorigdstport 5581 -m comment `
          + `--comment redroid-forge-knock-open:100.73.0.50:5581:${futureExpiry} -j ACCEPT\n`,
      };
    }
    return { stdout: '' };
  };
  await fwknop.sweepStaleTempRules({ exec });
  assert.equal(calls.filter((c) => c[1] === '-D').length, 0, 'not removed -- still within its window');
  const state = fwknop.getState('100.73.0.50', 5581);
  assert.equal(state.open, true);
  assert.equal(state.openUntil, futureExpiry);
});

test('detectForeignFwknopd: filters out this project\'s own process by its config path, keeps the rest', async () => {
  const fwknopdConf = '/app/backend/data/fwknop/fwknopd.conf';
  const exec = async () => ({
    stdout: [
      `9027 /usr/sbin/fwknopd`,
      `9883 fwknopd -f -c ${fwknopdConf} -a /app/backend/data/fwknop/access.conf`,
    ].join('\n'),
  });
  const foreign = await fwknop.detectForeignFwknopd({ exec, fwknopdConf });
  assert.deepEqual(foreign, ['9027 /usr/sbin/fwknopd']);
});

test('detectForeignFwknopd: no fwknopd at all (pgrep exit code 1) -> empty, not an error', async () => {
  const exec = async () => { const e = new Error('no process found'); e.code = 1; throw e; };
  assert.deepEqual(await fwknop.detectForeignFwknopd({ exec }), []);
});

test('detectForeignFwknopd: only this project\'s own process running -> empty', async () => {
  const fwknopdConf = '/app/backend/data/fwknop/fwknopd.conf';
  const exec = async () => ({ stdout: `9883 fwknopd -f -c ${fwknopdConf} -a /app/backend/data/fwknop/access.conf\n` });
  assert.deepEqual(await fwknop.detectForeignFwknopd({ exec, fwknopdConf }), []);
});

function fakeIptablesSave(lines) {
  return async () => ({ stdout: lines.join('\n') });
}

// 28/10/2026: moved from scanning INPUT (keyed by hostIp:port) to DOCKER-USER (keyed by the
// container's own bridge IP + the fixed internal ADB port 5555) -- the chain and the matched
// destination both changed along with ensureGuardRules/removeGuardRules, see their own comment
// above and fwknop.js's module header for why.
test('detectBypassingRules: real incident shape -- an earlier blanket accept-everything rule shadows our own DROP', async () => {
  const exec = fakeIptablesSave([
    '-A DOCKER-USER -i lo -j ACCEPT',
    '-A DOCKER-USER -m state --state RELATED,ESTABLISHED -j ACCEPT',
    '-A DOCKER-USER -i tailscale0 -j ACCEPT',
    '-A DOCKER-USER -d 172.17.0.11/32 -p tcp -m tcp --dport 5555 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT',
    '-A DOCKER-USER -d 172.17.0.11/32 -p tcp -m tcp --dport 5555 -j DROP',
  ]);
  const bypassing = await fwknop.detectBypassingRules('172.17.0.11', { exec });
  assert.equal(bypassing.length, 1);
  assert.match(bypassing[0], /tailscale0/);
});

test('detectBypassingRules: no earlier rule matches -> empty', async () => {
  const exec = fakeIptablesSave([
    '-A DOCKER-USER -i lo -j ACCEPT',
    '-A DOCKER-USER -p tcp -m tcp --dport 80 -j ACCEPT',
    '-A DOCKER-USER -s 192.168.1.0/24 -p tcp -m tcp --dport 445 -j ACCEPT',
    '-A DOCKER-USER -d 172.17.0.11/32 -p tcp -m tcp --dport 5555 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT',
    '-A DOCKER-USER -d 172.17.0.11/32 -p tcp -m tcp --dport 5555 -j DROP',
  ]);
  assert.deepEqual(await fwknop.detectBypassingRules('172.17.0.11', { exec }), []);
});

test('detectBypassingRules: an ESTABLISHED/RELATED-only accept never bypasses a fresh knock-less connection', async () => {
  const exec = fakeIptablesSave([
    '-A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT',
    '-A DOCKER-USER -d 172.17.0.11/32 -p tcp -m tcp --dport 5555 -j DROP',
  ]);
  assert.deepEqual(await fwknop.detectBypassingRules('172.17.0.11', { exec }), []);
});

test('detectBypassingRules: a multiport accept covering the internal ADB port counts as a bypass', async () => {
  const exec = fakeIptablesSave([
    '-A DOCKER-USER -p tcp -m multiport --dports 22,25565:25569,5550:5560 -j ACCEPT',
    '-A DOCKER-USER -d 172.17.0.11/32 -p tcp -m tcp --dport 5555 -j DROP',
  ]);
  const bypassing = await fwknop.detectBypassingRules('172.17.0.11', { exec });
  assert.equal(bypassing.length, 1);
});

test('detectBypassingRules: stops scanning once it reaches our own DROP rule (later rules cannot matter)', async () => {
  const exec = fakeIptablesSave([
    '-A DOCKER-USER -d 172.17.0.11/32 -p tcp -m tcp --dport 5555 -j DROP',
    '-A DOCKER-USER -i tailscale0 -j ACCEPT', // after our own gate -- irrelevant, never flagged
  ]);
  assert.deepEqual(await fwknop.detectBypassingRules('172.17.0.11', { exec }), []);
});

test('detectBypassingRules: a rule scoped to a DIFFERENT container\'s bridge IP never counts as a bypass', async () => {
  const exec = fakeIptablesSave([
    '-A DOCKER-USER -d 172.17.0.12/32 -p tcp -m tcp --dport 5555 -j ACCEPT', // a different instance entirely
    '-A DOCKER-USER -d 172.17.0.11/32 -p tcp -m tcp --dport 5555 -j DROP',
  ]);
  assert.deepEqual(await fwknop.detectBypassingRules('172.17.0.11', { exec }), []);
});

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
  };
  return { exec, calls };
}

test('ensureGuardRules: appends ESTABLISHED/RELATED before DROP, only for rules not already there', async () => {
  const { exec, calls } = fakeExec(new Set());
  await fwknop.ensureGuardRules('100.73.0.50', 5580, { exec });
  const appends = calls.filter((c) => c[1] === '-A');
  assert.equal(appends.length, 2);
  assert.ok(appends[0].includes('ESTABLISHED,RELATED'), 'ESTABLISHED/RELATED exception appended first');
  assert.ok(appends[1].includes('DROP'), 'DROP appended second, so it never precedes the exception');
  assert.ok(appends[0].includes('100.73.0.50') && appends[1].includes('100.73.0.50'));
});

test('ensureGuardRules: idempotent -- does nothing when both rules already exist', async () => {
  const establishedSig = ['-C', 'INPUT', '-d', '100.73.0.50', '-p', 'tcp', '--dport', '5580', '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '-j', 'ACCEPT'].join(' ');
  const dropSig = ['-C', 'INPUT', '-d', '100.73.0.50', '-p', 'tcp', '--dport', '5580', '-j', 'DROP'].join(' ');
  const { exec, calls } = fakeExec(new Set([establishedSig, dropSig]));
  await fwknop.ensureGuardRules('100.73.0.50', 5580, { exec });
  assert.equal(calls.filter((c) => c[1] === '-A').length, 0);
});

test('removeGuardRules: tolerant of rules that are already gone', async () => {
  const exec = async () => { const e = new Error('Bad rule'); e.code = 1; throw e; };
  await assert.doesNotReject(() => fwknop.removeGuardRules('100.73.0.50', 5580, { exec }));
});

test('requestAccess: ensures the guard rules, knocks via the fwknop client, and records advisory state', async () => {
  const calls = [];
  const exec = async (cmd, args) => { calls.push([cmd, ...args]); };
  const keys = { rijndael: 'R==', hmac: 'H==' };
  const before = Date.now();
  const state = await fwknop.requestAccess({
    hostIp: '100.73.0.50', port: 5580, sourceIp: '203.0.113.9', seconds: 90, exec, keys,
  });
  assert.equal(state.open, true);
  assert.equal(state.sourceIp, '203.0.113.9');
  assert.ok(state.openUntil >= before + 90 * 1000);

  const knock = calls.find((c) => c[0] === 'fwknop');
  assert.ok(knock);
  assert.ok(knock.includes('tcp/5580'));
  assert.ok(knock.includes('203.0.113.9'));
  assert.ok(knock.includes('-f') && knock.includes('90'));
  assert.ok(knock.includes('R==') && knock.includes('H=='));

  assert.ok(fwknop.getState('100.73.0.50', 5580).open);
  assert.equal(fwknop.getState('100.73.0.50', 5581).open, false, 'a different port was never knocked for');
});

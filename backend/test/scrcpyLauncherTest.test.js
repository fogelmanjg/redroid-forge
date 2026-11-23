// lib/adbTestDevice.js + lib/scrcpyLauncherTest.js (1.0.0-beta.5): the fake ADB device behind the
// "Test local scrcpy" button, and the one-time-code / ephemeral-port lifecycle around it. The real
// adb + launcher path was checked by hand against a real `adb` (see CHANGELOG); this drives the
// same protocol with a raw client so it runs anywhere.
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const dev = require('../src/lib/adbTestDevice');
const { createTester, SHELL_TAG } = require('../src/lib/scrcpyLauncherTest');

// Minimal adb HOST: CNXN, then OPEN shell:<cmd>, collect WRTE data, ack it, until CLSE.
function adbShell(port, cmd) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = Buffer.alloc(0);
    let banner = null;
    let out = '';
    sock.on('error', reject);
    sock.on('connect', () => sock.write(dev.encode(dev.A_CNXN, dev.A_VERSION, 4096, 'host::features=')));
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const { messages, rest } = dev.decode(buf);
      buf = rest;
      for (const m of messages) {
        if (m.command === dev.A_CNXN) {
          banner = m.data.toString();
          sock.write(dev.encode(dev.A_OPEN, 7, 0, `shell:${cmd}\0`));
        } else if (m.command === dev.A_WRTE) {
          out += m.data.toString();
          sock.write(dev.encode(dev.A_OKAY, 7, m.arg0));
        } else if (m.command === dev.A_CLSE) {
          sock.end();
          resolve({ banner, out });
        }
      }
    });
    setTimeout(() => { sock.destroy(); reject(new Error('timeout')); }, 3000).unref();
  });
}

const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => r(port)); }); });

test('the fake device answers CNXN with a device banner and runs shell commands through onShell', async () => {
  const port = await freePort();
  const seen = [];
  const server = dev.createServer({ onShell: (c) => { seen.push(c); return 'hello\n'; } });
  await new Promise((r) => server.listen(port, r));
  try {
    const { banner, out } = await adbShell(port, 'echo hi');
    assert.match(banner, /^device::/);
    assert.strictEqual(out, 'hello\n');
    assert.deepStrictEqual(seen, ['echo hi']);
  } finally { server.close(); }
});

test('decode rejects what is not adb (bad magic) and waits for a partial message', () => {
  const msg = dev.encode(dev.A_OKAY, 1, 2, 'abc');
  assert.deepStrictEqual(dev.decode(msg.subarray(0, 25)).messages, []);
  assert.strictEqual(dev.decode(msg).messages[0].data.toString(), 'abc');
  const bad = Buffer.from(msg); bad.writeUInt32LE(0, 20);
  assert.throws(() => dev.decode(bad), /bad magic/);
});

test('a valid code is confirmed with the reported versions; the port and the firewall rule close after', async () => {
  const port = await freePort();
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push(args.slice(0, 1)[0]);
    if (args[0] === '-C') throw new Error('no such rule');
    return { stdout: '' };
  };
  const t = createTester({ port, exec, sources: ['10.0.0.0/8'] });
  const { code, firewall } = await t.start();
  assert.strictEqual(firewall, 'opened');
  assert.ok(t.isOpen());
  const { out } = await adbShell(port, `echo ${SHELL_TAG} ${code} 1 5.0.1 1.0.41`);
  assert.strictEqual(out, 'ok\n');
  assert.deepStrictEqual(t.result(code), { state: 'ok', launcherVersion: '1', scrcpyVersion: '5.0.1', adbVersion: '1.0.41', firewall: 'opened' });
  await t.sweep();
  assert.strictEqual(t.isOpen(), false, 'nothing pending -> port closed');
  assert.deepStrictEqual(calls, ['-C', '-A', '-D'], 'rule checked, added, then removed');
});

test('a wrong or reused code is refused, and a code expires after the TTL', async () => {
  const port = await freePort();
  let clock = 1000;
  const t = createTester({ port, exec: async () => { throw new Error('no iptables'); }, now: () => clock, ttlMs: 60000 });
  const { code, firewall } = await t.start();
  assert.strictEqual(firewall, 'unavailable', 'no iptables is reported, not fatal');
  assert.strictEqual((await adbShell(port, `echo ${SHELL_TAG} ${'0'.repeat(32)} 1 x y`)).out, 'unknown-code\n');
  assert.strictEqual((await adbShell(port, 'reboot')).out, 'unknown-command\n');
  assert.strictEqual((await adbShell(port, `echo ${SHELL_TAG} ${code} 1 x y`)).out, 'ok\n');
  assert.strictEqual((await adbShell(port, `echo ${SHELL_TAG} ${code} 1 x y`)).out, 'unknown-code\n', 'one use only');
  const { code: late } = await t.start();
  clock += 61000;
  assert.strictEqual(t.result(late).state, 'expired');
  await t.sweep();
  assert.strictEqual(t.isOpen(), false);
});

test('the port is in use -> a 409 that names the setting to change', async () => {
  const blocker = net.createServer();
  const port = await freePort();
  await new Promise((r) => blocker.listen(port, r));
  try {
    const t = createTester({ port, exec: async () => ({ stdout: '' }) });
    await assert.rejects(t.start(), (e) => e.httpStatus === 409 && /REDROID_FORGE_LAUNCHER_TEST_PORT/.test(e.message));
  } finally { blocker.close(); }
});

test('the temporary firewall rule only admits private/CGNAT sources by default, configurable', () => {
  const { testSources } = require('../src/lib/scrcpyLauncherTest');
  assert.deepStrictEqual(testSources({}), ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10']);
  assert.deepStrictEqual(testSources({ REDROID_FORGE_LAUNCHER_TEST_SOURCES: '192.168.1.0/24, junk;rm, 100.64.0.0/10' }), ['192.168.1.0/24', '100.64.0.0/10']);
});

test('leftover rules with our comment are found and deleted, whatever their source', async () => {
  const deleted = [];
  const exec = async (cmd, args) => {
    if (args[0] === '-S') {
      return { stdout: '-P INPUT DROP\n-A INPUT -s 10.0.0.0/8 -p tcp -m tcp --dport 15599 -m comment --comment redroid-forge-launcher-test -j ACCEPT\n-A INPUT -p tcp -m tcp --dport 15599 -m comment --comment redroid-forge-launcher-test -j ACCEPT\n-A INPUT -p tcp --dport 22 -j ACCEPT\n' };
    }
    if (args[0] === '-D') deleted.push(args.join(' '));
    return { stdout: '' };
  };
  await createTester({ port: 1, exec }).removeLeftoverRule();
  assert.strictEqual(deleted.length, 2);
  assert.ok(deleted.every((d) => d.includes('redroid-forge-launcher-test')));
});

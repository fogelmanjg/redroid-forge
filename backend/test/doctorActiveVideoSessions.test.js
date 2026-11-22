'use strict';

// Doctor "Active video sessions (scrcpy)" (rewritten 21/11/2026, 1.0.0-beta.4): counts the
// scrcpy-server processes inside each running instance and tells this forge's own expanded viewer
// sessions apart from external clients and from sessions it does not track (left behind).
// (The old version counted TCP connections to the ADB port, which the host's shared adb server
// always held -- it warned for every instance anyone had ever viewed.)

const test = require('node:test');
const assert = require('node:assert');

const doctor = require('../src/lib/doctor');

// What `ps -A -o ARGS | grep scrcpy.Server` prints inside an instance: a `sh -c` wrapper line and
// the real app_process line per session.
const OWN = 'app_process / com.genymobile.scrcpy.Server 5.0.1 scid=1111aaaa log_level=info tunnel_forward=true cleanup=false max_size=1920';
const OWN_SH = 'sh -c CLASSPATH=/data/local/tmp/scrcpy-server.jar app_process / com.genymobile.scrcpy.Server 5.0.1 scid=1111aaaa cleanup=false';
const LEFT = 'app_process / com.genymobile.scrcpy.Server 5.0.1 scid=2222bbbb log_level=info tunnel_forward=true cleanup=false max_size=1920';
const EXTERNAL = 'app_process / com.genymobile.scrcpy.Server 5.0 scid=3333cccc log_level=info video_bit_rate=2900000 audio_codec=aac tunnel_forward=true';

function run({ instances, ps = {}, running = () => true, own = ['1111aaaa'] }) {
  return doctor.checkActiveVideoSessions({
    list: () => instances,
    isRunning: async (inst) => running(inst),
    psScrcpy: async (inst) => (ps[inst.name] || []).join('\n'),
    ownScids: () => new Set(own),
  });
}

test('classifyScrcpyServers: own / left behind / external, wrapper lines ignored', () => {
  const c = doctor.classifyScrcpyServers([OWN_SH, OWN, LEFT, EXTERNAL].join('\n'), new Set(['1111aaaa']));
  assert.deepStrictEqual(c, { expanded: 1, leftBehind: 1, external: 1 });
});

test('no instances -> ok', async () => {
  const r = await run({ instances: [] });
  assert.strictEqual(r.status, 'ok');
});

test('running instances without any scrcpy-server -> ok, even if adb is connected', async () => {
  const r = await run({ instances: [{ name: 'a', containerId: 'c1' }], ps: { a: [] } });
  assert.strictEqual(r.status, 'ok');
  assert.match(r.detail, /No instance has a video session/);
});

test('a stopped instance is not looked into', async () => {
  let looked = false;
  const r = await doctor.checkActiveVideoSessions({
    list: () => [{ name: 'a', containerId: 'c1' }],
    isRunning: async () => false,
    psScrcpy: async () => { looked = true; return EXTERNAL; },
    ownScids: () => new Set(),
  });
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(looked, false);
});

test('sessions are counted per instance and by kind', async () => {
  const r = await run({
    instances: [{ name: 'cifi', containerId: 'c1' }, { name: 'herotale', containerId: 'c2' }],
    ps: { cifi: [OWN_SH, OWN, EXTERNAL], herotale: [] },
  });
  assert.strictEqual(r.status, 'warn');
  assert.match(r.detail, /cifi: 2 \(1 expanded viewer, 1 external scrcpy\)/);
  assert.doesNotMatch(r.detail, /herotale/);
  assert.strictEqual(r.fix, undefined);
});

test('a left-behind session is called out with a fix', async () => {
  const r = await run({ instances: [{ name: 'cifi', containerId: 'c1' }], ps: { cifi: [LEFT] } });
  assert.strictEqual(r.status, 'warn');
  assert.match(r.detail, /1 LEFT BEHIND/);
  assert.match(r.detail, /may keep encoding for nobody/);
  assert.ok(r.fix);
});

test('an instance whose check fails is reported, the others still counted', async () => {
  const r = await doctor.checkActiveVideoSessions({
    list: () => [{ name: 'a', containerId: 'c1' }, { name: 'b', containerId: 'c2' }],
    isRunning: async () => true,
    psScrcpy: async (inst) => { if (inst.name === 'a') throw new Error('exec timeout'); return EXTERNAL; },
    ownScids: () => new Set(),
  });
  assert.strictEqual(r.status, 'warn');
  assert.match(r.detail, /a: could not check \(exec timeout\)/);
  assert.match(r.detail, /b: 1 \(1 external scrcpy\)/);
});

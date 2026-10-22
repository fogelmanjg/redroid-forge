// Coverage of the CIFI watchdog module (stage 7 pilot, see
// backend/src/modules/cifi/watchdog.js and docs/REQUIREMENTS.md section 5). Uses
// runTickWith's injectable exec/sleep (same pattern as androidExec.js) instead
// of real dockerode/timers -- a real run of the recovery path takes several
// real minutes (faithfully ported from the original cron script's timing),
// which would make this suite unusable if it actually waited.
const test = require('node:test');
const assert = require('node:assert/strict');

const { runTickWith } = require('../src/modules/cifi/watchdog');

const noSleep = async () => {}; // collapses every real-world wait to instant

function fakeExec(behavior) {
  const calls = [];
  const exec = async (containerId, args) => {
    calls.push(args);
    const result = behavior(args, calls);
    if (result instanceof Error) throw result;
    return result;
  };
  return { exec, calls };
}

test('runTickWith: the game is already running -> no am start, no taps', async () => {
  const { exec, calls } = fakeExec((args) => {
    if (args[0] === 'pidof') return '1234\n';
    throw new Error(`unexpected exec call: ${args.join(' ')}`);
  });

  await runTickWith('inst-1', 'container-1', { exec, sleep: noSleep });

  assert.deepEqual(calls, [['pidof', 'com.OctocubeGamesCompany.CIFI']]);
});

test('runTickWith: not running, recovers on the first am start attempt, taps the right spots', async () => {
  let pidofCalls = 0;
  const { exec, calls } = fakeExec((args) => {
    if (args[0] === 'pidof') {
      pidofCalls += 1;
      // 2 misses (the initial check + the one after the 15s safety sleep), then
      // found right after the one and only `am start` below.
      return pidofCalls <= 2 ? new Error('exit 1') : '1234\n';
    }
    if (args[0] === 'wm') return 'Physical size: 600x1000\n';
    if (args[0] === 'am') return '';
    if (args[0] === 'input') return '';
    throw new Error(`unexpected exec call: ${args.join(' ')}`);
  });

  await runTickWith('inst-1', 'container-1', { exec, sleep: noSleep });

  const amStarts = calls.filter((a) => a[0] === 'am');
  assert.equal(amStarts.length, 1); // opened on the first attempt, no retries needed
  assert.deepEqual(amStarts[0], ['am', 'start', '-n', 'com.OctocubeGamesCompany.CIFI/com.unity3d.player.UnityPlayerActivity']);

  const taps = calls.filter((a) => a[0] === 'input');
  // startGame (0.500,0.941 of 600x1000) + automation (0.277,0.620) + 12x continue (0.500,0.934)
  assert.deepEqual(taps[0], ['input', 'tap', '300', '941']);
  assert.deepEqual(taps[1], ['input', 'tap', '166', '620']);
  assert.equal(taps.length, 2 + 12);
  for (const t2 of taps.slice(2)) assert.deepEqual(t2, ['input', 'tap', '300', '934']);
});

test('runTickWith: it retries am start up to 6 times before giving up', async () => {
  const { exec, calls } = fakeExec((args) => {
    if (args[0] === 'pidof') return new Error('exit 1'); // never comes back, no matter what
    if (args[0] === 'wm') return 'Physical size: 600x1000\n';
    if (args[0] === 'am') return '';
    throw new Error(`unexpected exec call: ${args.join(' ')}`);
  });

  await assert.rejects(
    () => runTickWith('inst-1', 'container-1', { exec, sleep: noSleep }),
    /could not reopen .* after 6 attempts/,
  );

  assert.equal(calls.filter((a) => a[0] === 'am').length, 6);
});

test('runTickWith: a malformed "wm size" output fails loudly instead of tapping blind', async () => {
  const { exec } = fakeExec((args) => {
    if (args[0] === 'pidof') return new Error('exit 1');
    if (args[0] === 'wm') return 'garbage, no WxH here\n';
    throw new Error(`unexpected exec call: ${args.join(' ')}`);
  });

  await assert.rejects(
    () => runTickWith('inst-1', 'container-1', { exec, sleep: noSleep }),
    /could not parse "wm size"/,
  );
});

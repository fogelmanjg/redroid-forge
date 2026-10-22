'use strict';

// CIFI watchdog (stage 7 -- see manifest.json, moduleRunner.js and the
// "Extensibility: user-defined modules" section of docs/REQUIREMENTS.md): the
// pilot port of ~/scripts/cifi-watchdog.sh (a cron job + flock on the host,
// hardcoded to 2 production jg-dashboard instances) into the generic
// periodic-watchdog convention.
//
// Talks to the instance directly via dockerRuntime.exec() (dockerode), not real
// adb -- the original script's entire first comment block exists because of a
// real incident caused by spawning `adb` from a cron job (the adb daemon
// inherited a lock fd and never let go). Going through dockerode's exec API
// sidesteps that whole problem class: there is no adb server to manage.

const runtime = require('../../lib/dockerRuntime');

const PKG = 'com.OctocubeGamesCompany.CIFI';
const ACTIVITY = 'com.unity3d.player.UnityPlayerActivity';

// Percent-of-screen, not fixed pixels -- measured on 600x1000, validated end to
// end on a real instance 2026-08-11 (ported as-is from the original script).
const TAPS = {
  startGame: { px: 0.500, py: 0.941 },
  automation: { px: 0.277, py: 0.620 },
  continueBtn: { px: 0.500, py: 0.934 },
};

function realSleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function isRunning(containerId, exec) {
  try {
    const out = await exec(containerId, ['pidof', PKG]);
    return out.trim().length > 0;
  } catch {
    return false; // pidof exits non-zero when nothing matches -- that is the expected "not running" case, not an error
  }
}

async function screenSize(containerId, exec) {
  const out = await exec(containerId, ['wm', 'size']);
  const m = out.match(/(\d+)x(\d+)/);
  if (!m) throw new Error(`could not parse "wm size" output: ${out.trim()}`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

async function tap(containerId, { width, height }, { px, py }, exec) {
  await exec(containerId, ['input', 'tap', String(Math.round(width * px)), String(Math.round(height * py))]);
}

// One tick: check -> (if needed) reopen -> click through the launch/resume
// screens. Faithful to the original cron script's timing (same sleeps), which
// means a recovery run takes a few minutes, not an instant check -- acceptable
// here because it is a rare path (only when the game actually crashed) and the
// scheduler ticks this on its own timer regardless of how long one run takes.
//
// `exec`/`sleep` are injectable (same pattern as androidExec.js's `exec`
// parameter) so tests can run this instantly against a fake instead of waiting
// on real multi-minute timers -- `runTick` (the stage-7 export moduleRunner
// calls) is a thin wrapper that supplies the real ones.
async function runTickWith(instanceId, containerId, { exec, sleep }) {
  if (await isRunning(containerId, exec)) return; // the common case: nothing to do

  // Same safety margin as the original: avoid reacting to a process that is
  // mid-restart for some other reason and about to reappear on its own.
  await sleep(15_000);
  if (await isRunning(containerId, exec)) return;

  const size = await screenSize(containerId, exec);

  let opened = false;
  for (let attempt = 1; attempt <= 6; attempt++) {
    await exec(containerId, ['am', 'start', '-n', `${PKG}/${ACTIVITY}`]).catch(() => {});
    await sleep(10_000);
    // eslint-disable-next-line no-await-in-loop
    if (await isRunning(containerId, exec)) { opened = true; break; }
  }
  if (!opened) throw new Error(`could not reopen ${PKG} after 6 attempts`);

  await sleep(30_000); // initial load screens
  await tap(containerId, size, TAPS.startGame, exec);
  await sleep(5_000);
  await tap(containerId, size, TAPS.automation, exec);

  // Offline-earnings load time varies with how long it was closed (seconds to
  // ~2 min) -- tapping "continue" before the button exists is harmless, so this
  // just repeats it for up to 2 minutes rather than trying to detect the button.
  for (let i = 0; i < 12; i++) {
    await sleep(10_000);
    // eslint-disable-next-line no-await-in-loop
    await tap(containerId, size, TAPS.continueBtn, exec);
  }
}

function runTick(instanceId, containerId) {
  return runTickWith(instanceId, containerId, { exec: runtime.exec, sleep: realSleep });
}

module.exports = { runTick, runTickWith };

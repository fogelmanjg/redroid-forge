'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

// `docker exec` against an instance that was JUST started: the first attempts fail with
// "exec ...: no such file or directory" or because system_server is not up yet (Android's
// boot takes ~20 s), so it is retried with a fixed delay. The generic runner
// (moduleRunner.js) triggers stage 6 as soon as runtime.start() resolves, without
// waiting for the boot -- knowing how long Android takes is this helper's job, not the
// runner's. Same pattern as execAndroidWithRetry in modules/hwenc/integrate.js.
//
// `noRetryCodes`: exit codes that are a definitive answer of the command and therefore
// there is no point in retrying. `exec` is injectable for tests.
// 1.0.0-beta.8: an error that means the container is not there to wait for -- stopped (by the user,
// by a lock, it crashed) or removed. Retrying cannot help; it only kept `docker exec`-ing a stopped
// container every few seconds for minutes (seen live: antimater, stopped 22 s after starting, kept
// getting ~60 execs over 2.5 min from the gapps post-start steps). The Docker CLI says "container X is
// not running" / "No such container"; the Engine API (runtime.exec) says the same inside its message.
function isContainerGone(e) {
  const text = `${e && e.message ? e.message : ''} ${e && e.stderr ? e.stderr : ''} ${e && e.json && e.json.message ? e.json.message : ''}`;
  return /is not running|no such container/i.test(text);
}

async function execAndroidWithRetry(containerId, argv, {
  attempts = 20, delayMs = 3000, noRetryCodes = [], exec = execFileAsync,
} = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await exec('docker', ['exec', containerId, ...argv]);
    } catch (e) {
      lastErr = e;
      if (noRetryCodes.includes(e.code) || isContainerGone(e)) throw e;
      // eslint-disable-next-line no-await-in-loop
      if (attempt < attempts) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

module.exports = { execAndroidWithRetry, isContainerGone };

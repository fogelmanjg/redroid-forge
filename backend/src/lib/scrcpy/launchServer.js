'use strict';

// Launches the real scrcpy-server.jar (already pushed by pushServer.js) inside an instance's
// container via `app_process`, directly through dockerRuntime -- no `adb shell`, consistent with
// this project's existing docker-exec-not-adb convention (androidExec.js). Exact argv/behavior
// confirmed against the real v5.0.1 source (app/src/server.c:208-487) -- see protocol.js's header
// comment for the same sourcing discipline.
//
// Tunnel mode: this project always uses the FORWARD tunnel (client listens via `adb forward`,
// not `adb reverse`), not scrcpy's own default -- deliberately, to avoid reimplementing the
// reverse-tunnel accept() dance; `tunnel_forward=true` tells the server to connect OUT to our
// already-`adb forward`-ed port instead of listening itself (server.c:331-333, Server.java:95,
// 105 -> DesktopConnection.open()'s connect-not-accept branch).

const { spawn } = require('child_process');
const dockerRuntime = require('../dockerRuntime');
const pushServer = require('./pushServer');
const { generateScid } = require('./protocol');

// Pinned to the exact jar this project pushes (pushServer.js reads whatever `scrcpy --version`
// is installed on THIS host) -- the server does its own version check against this string and
// refuses to start on a mismatch, so it must track the installed scrcpy, not be hand-picked.
// Confirmed on this host: `scrcpy 5.0.1`.
const SCRCPY_VERSION = '5.0.1';

// video/audio/control are always requested (this project's one scrcpy-server session always
// carries all 3 channels, per the "one session, both directions" decision) -- so they are never
// passed as `false` here; only the options that differ from scrcpy's own defaults are added,
// same "only non-default" discipline the real desktop client itself follows (server.c:272-457).
function buildArgs({ scid, maxSize, maxFps, bitRate, logLevel = 'info', audio, audioCodec }) {
  // cleanup=false (default is true): the server deletes its own jar from /data/local/tmp on
  // exit -- fine for a single desktop-client session, but a real correctness risk for this
  // project's actual use case, where more than one session can run against the SAME instance at
  // once (ventanita + expandida, decided explicitly as allowed) -- one session exiting must never
  // delete the jar out from under another still-running one. pushServer.pushToContainer()
  // already re-pushes before every launch regardless, so disabling the server's own self-cleanup
  // costs nothing.
  const args = [`scid=${scid}`, `log_level=${logLevel}`, 'tunnel_forward=true', 'cleanup=false'];
  if (maxSize) args.push(`max_size=${maxSize}`);
  if (maxFps) args.push(`max_fps=${maxFps}`);
  // scrcpy's own default is 8000000 (8 Mbps) -- tuned for a real desktop-sized window, not a
  // ~200px ventanita nobody expects smoothness from (decided explicitly, 15/11/2026: "no necesito
  // fluidez"). bitRate is in bits/second, same unit scrcpy's own CLI takes.
  if (bitRate) args.push(`video_bit_rate=${bitRate}`);
  // audio defaults to on (every real session carries all 3 channels, per the project's own
  // decision) -- `audio=false` here is ONLY a diagnostic escape hatch (see scrcpy-probe.js),
  // not a product option: found live, Hito 1 validation, that this test image's Android build
  // (redroid11_x86_64) has no Opus encoder at all (only AAC/FLAC listed), and the server process
  // dies entirely (not just "no audio") when the opus encoder thread throws.
  if (audio === false) args.push('audio=false');
  // "Opus only, no negotiation" (the plan's original decision) turned out not to hold on ANY
  // image tested so far -- confirmed 15/11/2026 on this exact host (vendor's own
  // media_codecs_google_audio.xml ships zero Opus encoder entries, Codec2 or OMX, just a
  // decoder), matching an already-documented identical finding on redroid11 and on the
  // nvenc+venus3d combination (c2.android.opus.encoder refuses to register either way). AAC is
  // what actually works everywhere tried -- made the explicit default rather than relying on
  // scrcpy-server's own default (Opus), which is exactly the thing that doesn't exist here.
  if (audioCodec) args.push(`audio_codec=${audioCodec}`);
  return args;
}

// Found the hard way (Hito 1 validation, 14/11/2026): `app_process` loads the ART runtime, which
// aborts immediately with "ANDROID_DATA environment variable unset" (SIGABRT, confirmed via
// logcat/tombstone) under a bare `docker exec` -- dockerRuntime.exec/execDetached's fixed `Env`
// array has no ANDROID_DATA/ANDROID_ROOT/BOOTCLASSPATH/etc, and those are version/device-specific
// enough (BOOTCLASSPATH especially, depends on which APEXes are mounted) that hand-rolling them
// would be fragile. `adb shell` already sets up this exact environment correctly -- confirmed
// live, same command that failed under docker exec ran clean under `adb shell` -- which is
// exactly why the real desktop scrcpy client itself launches this way (app/src/server.c:218-253),
// not through any container mechanism. So THIS one step uses real `adb shell` against the
// instance's own `adbPort` (pushServer.pushToContainer still uses `docker cp`/putArchive for
// getting the jar there in the first place -- that part never touched ART, and worked the first
// try).
function shellLaunch(host, adbPort, remoteCmd, { onOutput } = {}) {
  const child = spawn('adb', ['-s', `${host}:${adbPort}`, 'shell', remoteCmd]);
  if (onOutput) {
    child.stdout.on('data', (d) => onOutput(d.toString('utf-8')));
    child.stderr.on('data', (d) => onOutput(d.toString('utf-8')));
  }
  return child;
}

// Starts the server, returns { scid } -- the only handle needed to find and kill it later (see
// killServer below). Does not wait for it to be ready to accept connections; forward.js's own
// connect-with-retry loop is what actually waits (same reasoning as the real desktop client,
// server.c:489-539's up-to-100-retries-at-100ms).
async function launch(containerId, host, adbPort, { maxSize, maxFps, bitRate, logLevel, audio, audioCodec, onOutput } = {}) {
  const scid = generateScid();
  await pushServer.pushToContainer(containerId);
  const args = buildArgs({ scid, maxSize, maxFps, bitRate, logLevel, audio, audioCodec });
  const remoteCmd = `CLASSPATH=${pushServer.DEST_PATH} app_process / com.genymobile.scrcpy.Server ${SCRCPY_VERSION} ${args.join(' ')}`;
  // The host-side `adb shell` child is kept now (21/11/2026) -- before, it was dropped on the
  // floor, so nothing ever ended it: killServer() below kills it first, so a session teardown
  // never leaves an `adb shell` process behind on the host either, whatever happens device-side.
  const child = shellLaunch(host, adbPort, remoteCmd, { onOutput });
  child.on('error', () => {}); // a spawn failure surfaces as forward.js's connect retries failing
  return { scid, child };
}

// Device-side, the process is still found by scid (unique per session, verbatim in argv), which
// survives our own process restarting. 21/11/2026: this used to be one `pkill -f` whose result
// nobody looked at (and whose errors the caller swallowed) -- a scrcpy-server left running keeps
// feeding the host's shared VA-API encode daemon at full frame rate with nobody watching (the
// suspected source of the daemon's memory growth on prod, see CHANGELOG). Now: SIGTERM, check,
// SIGKILL if it is still there, and report whether it is really gone, so the caller can say so.
const KILL_GRACE_MS = 1000;

// `[s]cid=<id>`, not the bare id: as a regex it still matches the server's own "scid=<id>" argv,
// but the literal text "[s]cid=" in the `sh -c` command line running pgrep/pkill does not match
// it -- without this, pgrep always found its own shell and reported the server "alive" forever.
function scidPattern(scid) {
  return `'[s]cid=${scid}'`;
}

async function serverAlive(containerId, scid) {
  const out = await dockerRuntime.exec(containerId, ['sh', '-c', `pgrep -f ${scidPattern(scid)} >/dev/null && echo alive || echo gone`]);
  return String(out || '').includes('alive');
}

async function killServer(containerId, scid, child) {
  if (child && child.exitCode === null && !child.killed) {
    try { child.kill('SIGKILL'); } catch (e) { /* already gone */ }
  }
  await dockerRuntime.exec(containerId, ['sh', '-c', `pkill -f ${scidPattern(scid)} || true`]);
  await new Promise((r) => setTimeout(r, KILL_GRACE_MS));
  if (!(await serverAlive(containerId, scid))) return true;
  await dockerRuntime.exec(containerId, ['sh', '-c', `pkill -9 -f ${scidPattern(scid)} || true`]);
  return !(await serverAlive(containerId, scid));
}

module.exports = { SCRCPY_VERSION, buildArgs, launch, killServer };

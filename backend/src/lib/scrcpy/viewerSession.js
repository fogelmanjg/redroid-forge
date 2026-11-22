'use strict';

// Ties Hito 1's pieces (launchServer/forward/videoSocket/audioSocket/controlSocket) into one
// object per viewer connection: start(instance, opts) / stop(), no state shared between
// sessions -- the project's own decided scope (5 real concurrent scrcpy connections already
// proven safe by the user; no session-limiting or "who controls" arbitration here, see the
// plan's own "Concurrencia ya probada" note).
//
// Hito 2 only drives this in "live preview" shape (video only, small, 5fps, no audio) -- the
// `maxSize`/`maxFps`/`audio` knobs exist already so Hito 4's "expanded viewer" mode is a different
// start() call with different numbers, not a second code path (per the plan: "probablemente
// apagar y relanzar scrcpy-server con otros parámetros en vez de renegociar en vivo").
//
// Control is ALWAYS connected here, even though nothing reads from it yet in Hito 2 (that is
// Hito 3's job, wiring browser pointer events to session.control.sendTouch/sendKey/sendText) --
// found the hard way in Hito 1 validation that the device will not write anything past video's
// very first dummy byte on ANY channel until all 3 requested channels (video, audio if enabled,
// control) have been accepted. Skipping control here would mean video never flows at all, not
// just "no input yet".

const forward = require('./forward');
const launchServer = require('./launchServer');
const { connectVideoSocket, readVideoHandshake } = require('./videoSocket');
const { connectAudioSocket, readAudioHandshake } = require('./audioSocket');
const { connectControl } = require('./controlSocket');
const { socketName } = require('./protocol');

const HOST = '127.0.0.1'; // docker-compose.yml: network_mode: host -- this reaches the
// instance's published adbPort directly, no host.docker.internal needed (confirmed in Hito 1).

// scids of the scrcpy-servers this backend launched and has not stopped yet (21/11/2026) --
// Doctor's video-sessions check uses it to tell this forge's own expanded viewer sessions apart
// from external scrcpy clients and from a session left behind (launched by an earlier run of
// this backend, which lost track of it when it restarted).
const activeScids = new Set();
function activeServerScids() { return new Set(activeScids); }

async function start(instance, { maxSize, maxFps, bitRate, audio = false, audioCodec, onVideoPacket, onAudioPacket, onError } = {}) {
  let localPort;
  let scid;
  let videoConn;
  let audioConn;
  let control;
  let launchedChild;
  let stopped = false;

  async function stop() {
    if (stopped) return; // idempotent: routes/viewer.js's WS 'close' handler and its own catch
    // block can both call this for the same session without double-tearing-down anything.
    stopped = true;
    try { videoConn?.socket.destroy(); } catch (e) { /* tearing down regardless */ }
    try { audioConn?.socket.destroy(); } catch (e) { /* tearing down regardless */ }
    try { control?.socket.destroy(); } catch (e) { /* tearing down regardless */ }
    if (localPort) await forward.removeForward(HOST, instance.adbPort, localPort).catch(() => {});
    // Not swallowed silently any more (21/11/2026): a scrcpy-server that survives its session
    // keeps encoding through the shared VA-API daemon with nobody watching -- worth a log line.
    if (scid) {
      activeScids.delete(scid);
      try {
        const gone = await launchServer.killServer(instance.containerId, scid, launchedChild);
        if (!gone) console.warn(`[viewer] scrcpy-server ${scid} on instance ${instance.id} is still running after SIGKILL`);
      } catch (e) {
        console.warn(`[viewer] could not kill scrcpy-server ${scid} on instance ${instance.id}: ${e.message}`);
      }
    }
  }

  async function readLoop(conn, handshake, onPacket) {
    try {
      // eslint-disable-next-line no-constant-condition
      while (!stopped) {
        // eslint-disable-next-line no-await-in-loop
        const pkt = await handshake.readPacket();
        if (onPacket) onPacket(pkt);
      }
    } catch (e) {
      if (!stopped && onError) onError(e); // a genuine transport failure, not our own teardown
    }
  }

  try {
    await forward.ensureConnected(HOST, instance.adbPort);
    const launched = await launchServer.launch(instance.containerId, HOST, instance.adbPort, { maxSize, maxFps, bitRate, audio, audioCodec });
    scid = launched.scid;
    launchedChild = launched.child;
    activeScids.add(scid);

    localPort = await forward.allocateLocalPort();
    await forward.addForward(HOST, instance.adbPort, localPort, socketName(scid));

    // Order matters twice over -- see launchServer.js/videoSocket.js's own comments: the device
    // tells channels apart by connection order (video, audio, control), and writes nothing past
    // video's dummy byte on any of them until all requested channels are connected. So every raw
    // connect happens first, with no reads in between, then handshakes are read off of them.
    videoConn = await connectVideoSocket(localPort);
    if (audio) audioConn = await connectAudioSocket(localPort);
    control = await connectControl(localPort);

    const videoHandshake = await readVideoHandshake(videoConn.reader);
    const audioHandshake = audioConn ? await readAudioHandshake(audioConn.reader) : null;

    readLoop(videoConn, videoHandshake, onVideoPacket);
    if (audioHandshake) readLoop(audioConn, audioHandshake, onAudioPacket);

    return { stop, control, videoCodec: videoHandshake.codec, audioCodec: audioHandshake?.codec };
  } catch (e) {
    await stop();
    throw e;
  }
}

module.exports = { start, activeServerScids };

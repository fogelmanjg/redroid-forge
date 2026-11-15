'use strict';

// Ties Hito 1's pieces (launchServer/forward/videoSocket/audioSocket/controlSocket) into one
// object per viewer connection: start(instance, opts) / stop(), no state shared between
// sessions -- the project's own decided scope (5 real concurrent scrcpy connections already
// proven safe by the user; no session-limiting or "who controls" arbitration here, see the
// plan's own "Concurrencia ya probada" note).
//
// Hito 2 only drives this in "ventanita" shape (video only, small, 5fps, no audio) -- the
// `maxSize`/`maxFps`/`audio` knobs exist already so Hito 4's "expandida" mode is a different
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

async function start(instance, { maxSize, maxFps, bitRate, audio = false, onVideoPacket, onAudioPacket, onError } = {}) {
  let localPort;
  let scid;
  let videoConn;
  let audioConn;
  let control;
  let stopped = false;

  async function stop() {
    if (stopped) return; // idempotent: routes/viewer.js's WS 'close' handler and its own catch
    // block can both call this for the same session without double-tearing-down anything.
    stopped = true;
    try { videoConn?.socket.destroy(); } catch (e) { /* tearing down regardless */ }
    try { audioConn?.socket.destroy(); } catch (e) { /* tearing down regardless */ }
    try { control?.socket.destroy(); } catch (e) { /* tearing down regardless */ }
    if (localPort) await forward.removeForward(HOST, instance.adbPort, localPort).catch(() => {});
    if (scid) await launchServer.killServer(instance.containerId, scid).catch(() => {});
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
    const launched = await launchServer.launch(instance.containerId, HOST, instance.adbPort, { maxSize, maxFps, bitRate, audio });
    scid = launched.scid;

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

module.exports = { start };

#!/usr/bin/env node
'use strict';

// Hito 1 validation (see /home/jgustavo/.claude/plans/recursive-dreaming-honey.md): drives our
// own scrcpy-server protocol client against ONE real running instance, with no WS/frontend
// involved yet. Confirms (a) the client actually talks to a real scrcpy-server.jar end to end,
// and (b) the negotiated video resolution actually matches what was requested via `max_size`
// against the instance's own display.width/height -- the one real unretired risk this milestone
// exists to retire.
//
//   node backend/scripts/scrcpy-probe.js <instance-id> [maxSize] [--no-audio]
//
// --no-audio: diagnostic escape hatch, not a product option -- found live (Hito 1 validation)
// that this test image's Android build (redroid11_x86_64) has no Opus encoder, and the WHOLE
// server process dies (not just "no audio") when the opus encoder thread throws. Use this to
// keep validating video/resolution/control on an image without a usable Opus encoder while that
// stays open as a question for the user (it contradicts the "Opus only" decision for at least
// this image). When audio is off, control is the 2nd accepted connection, not the 3rd.
//
// Only prints what happened; the session is torn down (forward removed, server killed) before
// exiting either way, same discipline as backend/scripts/binder-devices.js's "changes nothing
// lasting" spirit -- here it changes something TRANSIENTLY (a scrcpy-server process + an adb
// forward, both for the duration of the script only) rather than nothing at all, since there is
// no way to validate this without actually running the real thing.

const store = require('../src/lib/store');
const forward = require('../src/lib/scrcpy/forward');
const launchServer = require('../src/lib/scrcpy/launchServer');
const { connectVideoSocket, readVideoHandshake } = require('../src/lib/scrcpy/videoSocket');
const { connectAudioSocket, readAudioHandshake } = require('../src/lib/scrcpy/audioSocket');
const { connectControl } = require('../src/lib/scrcpy/controlSocket');
const { MOTION_ACTION } = require('../src/lib/scrcpy/protocol');

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--no-audio');
  const audioEnabled = !process.argv.includes('--no-audio');
  const instanceId = args[0];
  const requestedMaxSize = args[1] ? Number(args[1]) : 640;
  if (!instanceId) {
    console.error('Usage: node backend/scripts/scrcpy-probe.js <instance-id> [maxSize]');
    process.exit(2);
  }

  const instance = store.get(instanceId);
  if (!instance) { console.error(`No instance with id ${instanceId}`); process.exit(1); }
  if (!instance.containerId || !instance.adbPort) {
    console.error(`Instance ${instanceId} is missing containerId/adbPort (not running?)`);
    process.exit(1);
  }
  console.log(`Instance ${instanceId}: display=${instance.display?.width}x${instance.display?.height} adbPort=${instance.adbPort}`);

  let localPort;
  let scid;
  let video;
  let audio;
  let control;
  try {
    await forward.ensureConnected('127.0.0.1', instance.adbPort);
    const launched = await launchServer.launch(instance.containerId, '127.0.0.1', instance.adbPort, {
      maxSize: requestedMaxSize,
      audio: audioEnabled,
      onOutput: (text) => console.log(`[scrcpy-server] ${text.trim()}`),
    });
    scid = launched.scid;
    console.log(`Launched scrcpy-server, scid=${scid}, requested max_size=${requestedMaxSize}`);

    localPort = await forward.allocateLocalPort();
    const { socketName } = require('../src/lib/scrcpy/protocol');
    await forward.addForward('127.0.0.1', instance.adbPort, localPort, socketName(scid));
    console.log(`adb forward tcp:${localPort} -> localabstract:${socketName(scid)}`);

    // Order matters twice over, found the hard way (Hito 1 validation, 14/11/2026): the device
    // accepts connections in exactly this order (video, audio, control), telling them apart
    // purely by that order -- AND it writes nothing past video's dummy byte on ANY channel until
    // all 3 are accepted. So all 3 raw connects happen first, with no reads in between, THEN the
    // handshakes are read off of them (video's device name/codec, audio's codec).
    const videoConn = await connectVideoSocket(localPort);
    console.log('Video socket connected (raw).');

    let audioConn;
    if (audioEnabled) {
      audioConn = await connectAudioSocket(localPort);
      console.log('Audio socket connected (raw).');
    } else {
      console.log('Audio disabled (--no-audio) -- skipping, control is next.');
    }

    control = await connectControl(localPort);
    console.log('Control socket connected.');

    const videoHandshake = await readVideoHandshake(videoConn.reader);
    video = { socket: videoConn.socket, ...videoHandshake };
    console.log(`Video handshake read. Device name: "${video.deviceName}". Codec: ${JSON.stringify(video.codec)}`);

    if (audioConn) {
      const audioHandshake = await readAudioHandshake(audioConn.reader);
      audio = { socket: audioConn.socket, ...audioHandshake };
      console.log(`Audio handshake read. Codec: ${JSON.stringify(audio.codec)}`);
    }

    // First packet on the video socket should be the session packet carrying the REAL negotiated
    // resolution -- this is the actual answer to "is the max_size-vs-display.width/height math
    // right", not a theoretical calculation.
    const first = await video.readPacket();
    if (first.type !== 'session') {
      console.warn(`Expected a session packet first, got ${JSON.stringify({ ...first, payload: undefined })}`);
    } else {
      const native = instance.display || {};
      console.log(`Negotiated video size: ${first.width}x${first.height} (native was ${native.width}x${native.height}, requested max_size=${requestedMaxSize})`);
    }

    // A few more frames, just to confirm the stream keeps flowing and log timing.
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop
      const pkt = await video.readPacket();
      if (pkt.type === 'media') {
        console.log(`video frame #${i}: pts=${pkt.pts} size=${pkt.size} config=${pkt.isConfig} key=${pkt.isKeyFrame}`);
      } else {
        console.log(`video packet #${i}: session resize ${pkt.width}x${pkt.height}`);
      }
    }

    // One manual tap, dead center of the negotiated resolution, down+up -- the control-channel
    // smoke test this milestone needs ("send one manual control message").
    const w = first.type === 'session' ? first.width : requestedMaxSize;
    const h = first.type === 'session' ? first.height : requestedMaxSize;
    const cx = Math.floor(w / 2);
    const cy = Math.floor(h / 2);
    control.sendTouch({ action: MOTION_ACTION.DOWN, x: cx, y: cy, screenWidth: w, screenHeight: h });
    await new Promise((r) => setTimeout(r, 80));
    control.sendTouch({ action: MOTION_ACTION.UP, x: cx, y: cy, screenWidth: w, screenHeight: h });
    console.log(`Sent a test tap at (${cx}, ${cy}) of ${w}x${h} -- check the real device/scrcpy for a visible effect.`);

    console.log('Hito 1 probe finished successfully.');
  } finally {
    try { video?.socket.destroy(); } catch (e) { /* tearing down regardless */ }
    try { audio?.socket.destroy(); } catch (e) { /* tearing down regardless */ }
    try { control?.socket.destroy(); } catch (e) { /* tearing down regardless */ }
    if (localPort) await forward.removeForward('127.0.0.1', instance.adbPort, localPort).catch(() => {});
    if (scid) await launchServer.killServer(instance.containerId, scid).catch(() => {});
  }
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });

'use strict';

// PCM (raw, scrcpy's `audio_codec=raw`) -> Opus, in-process, one instance per viewer session --
// the fix for a real device-side gap found live 15/11/2026: this host's Android images (and
// every other combination already tried on other hosts/images in this project, including the
// nvenc+venus3d one) ship zero working Opus ENCODER (Codec2 or OMX; the decoder is there, the
// encoder plain isn't in `media_codecs_google_audio.xml` or registered as a Codec2 component).
// AAC works on-device but WebCodecs' AudioDecoder support for AAC in the browser is the thing
// that already failed in an earlier attempt (user's own prior finding) -- so this takes the one
// thing that DOES work everywhere (raw PCM, no encoder needed at all) and encodes it to Opus
// ourselves, which is what the frontend already decodes.
//
// opusscript (pure WASM/asm.js, no native compile step) chosen over spawning an `ffmpeg` process
// per session: same session-count the project already expects to run concurrently (several
// instances, each with their own viewer), and ffmpeg's own output is only available wrapped in a
// container (Ogg/WebM) that would need its own demuxer here just to get back to discrete Opus
// packets -- this hands back exactly one Opus packet per encode() call already, no parsing.

const OpusScript = require('opusscript');

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2; // s16le, what scrcpy's raw audio source actually sends
const FRAME_SAMPLES = 960; // 20ms @ 48kHz -- one of Opus's fixed valid frame sizes
const FRAME_BYTES = FRAME_SAMPLES * CHANNELS * BYTES_PER_SAMPLE;

// Reframes scrcpy's raw PCM chunks (4096 bytes/~21.3ms each, confirmed live -- NOT a valid Opus
// frame size on their own) into exact 20ms frames before handing them to the encoder; leftover
// bytes carry over to the next push(). pts is synthesized from a running sample count, not
// scrcpy's own PCM packet pts -- the frontend's AudioDecoder only needs a monotonically
// increasing timestamp (playAudioData schedules against the AudioContext's own clock, not pts),
// so re-deriving it from samples actually encoded is simpler and always consistent with the
// Opus stream's real timeline, even across a re-framing boundary.
class OpusTranscoder {
  constructor() {
    this.encoder = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO);
    this.buffer = Buffer.alloc(0);
    this.samplesEncoded = 0;
  }

  // Returns an array (often empty, sometimes more than one) of { isConfig: false, isKeyFrame:
  // false, pts: BigInt, payload: Buffer } packets -- same shape routes/viewerExpanded.js's own
  // encodeMediaFrame already expects from a real scrcpy media packet, so the route does not need
  // to know PCM was ever involved.
  push(pcmChunk) {
    if (this.closed) return []; // an audio packet still in flight after the viewer left
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, pcmChunk]) : pcmChunk;
    const packets = [];
    while (this.buffer.length >= FRAME_BYTES) {
      const frame = this.buffer.subarray(0, FRAME_BYTES);
      this.buffer = this.buffer.subarray(FRAME_BYTES);
      const payload = this.encoder.encode(frame, FRAME_SAMPLES);
      const pts = BigInt(Math.round((this.samplesEncoded / SAMPLE_RATE) * 1e6));
      this.samplesEncoded += FRAME_SAMPLES;
      // opusscript hands back a Buffer view into its own reused internal scratch space -- copy it
      // out, since this packet may still be sitting in an outbound queue after the next push()
      // already overwrote that scratch buffer.
      packets.push({ isConfig: false, isKeyFrame: false, pts, payload: Buffer.from(payload) });
    }
    return packets;
  }

  // Idempotent (21/11/2026): routes/viewerExpanded.js's 'close' handler can now run for a
  // connection whose start failed too, and deleting the same WASM encoder twice is not safe.
  close() {
    if (this.closed) return;
    this.closed = true;
    this.encoder.delete();
  }
}

module.exports = { OpusTranscoder, SAMPLE_RATE, CHANNELS };

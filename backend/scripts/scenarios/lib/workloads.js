'use strict';

// The loads a scenario puts on an instance. Every workload is `async run(ctx)` and resolves with a plain
// object: { type, ok, ...measurements }. It never throws for "the thing under test did not do what it
// should" (that is a result: ok=false with the reason); it throws only if the runner itself is broken.
//
//   ctx = { host, inst, spec, assets, durationS, work (a directory on the host), log }
//
//   idle    nothing: a baseline of what the instance costs by existing
//   encode  screenrecord over a moving screen, at a bitrate: does the encoder deliver it?
//   decode  hwdec_mediacodec_test decoding a clip over and over, with the hardware decoder or the
//           software one: how many frames per second it can sustain
//   (the 3D load comes in the next phase)

const { q } = require('./host');
const { DECODERS } = require('./assets');
const { parseDecodeResult } = require('./toolOutput');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function idle({ spec, durationS }) {
  await sleep(durationS * 1000);
  return { type: 'idle', ok: true, durationS, note: spec.note || null };
}

async function encode({ host, inst, spec, durationS, work, log }) {
  const mbps = spec.bitrateMbps || 8;
  const dur = Math.min(durationS, 180); // the limit of screenrecord
  const d = inst.record.display || {};
  const size = spec.size || (d.width && d.height ? `${d.width}x${d.height}` : '720x1280');
  const remote = '/data/local/tmp/enc.mp4';
  const out = `${work}/enc-${inst.name}.mp4`;
  log(`${inst.name}: encode ${size} at ${mbps} Mbps for ${dur} s`);

  await inst.startMotion();
  const rec = await inst.exec(`screenrecord --bit-rate ${Math.round(mbps * 1e6)} --size ${size} --time-limit ${dur} ${remote}; echo rc=$?`,
    { timeoutMs: (dur + 90) * 1000 });
  await inst.stopMotion();
  const rc = Number((rec.stdout.match(/rc=(\d+)/) || [])[1]);
  if (rc !== 0) {
    return { type: 'encode', ok: false, error: `screenrecord exited with ${rc}: ${(rec.stdout + rec.stderr).trim().slice(-200)}` };
  }

  await inst.copyOut(remote, out);
  await inst.exec(`rm -f ${remote}`);
  const probe = await host.run(`ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=codec_name,width,height,nb_read_frames:format=duration,size -of json ${q(out)}`);
  let info;
  try { info = JSON.parse(probe.stdout); } catch { return { type: 'encode', ok: false, error: 'the recording could not be read (ffprobe)' }; }
  const frames = Number((info.streams[0] || {}).nb_read_frames);
  const seconds = Number(info.format.duration);
  const bytes = Number(info.format.size);
  const decodes = (await host.run(`ffmpeg -v error -i ${q(out)} -f null - 2>&1`)).stdout.trim() === '';
  await host.run(`rm -f ${q(out)}`);
  return {
    type: 'encode',
    ok: decodes && frames > 0,
    targetMbps: mbps,
    achievedMbps: Math.round((bytes * 8) / seconds / 1e4) / 100,
    frames,
    seconds: Math.round(seconds * 10) / 10,
    fps: Math.round((frames / seconds) * 10) / 10,
    size,
    codec: (info.streams[0] || {}).codec_name,
    decodesCleanly: decodes,
  };
}

async function decode({
  host, inst, spec, assets, durationS, log,
}) {
  const kind = spec.decoder === 'sw' ? 'sw' : 'hw';
  const tool = await assets.tool();
  const clip = spec.file
    ? await assets.userClip(spec.file, { seconds: spec.clipSeconds || 20, start: spec.clipStart || 60 })
    : await assets.clip(spec.clip || 'h264_1080', spec.clipSeconds || 10);
  const component = DECODERS[kind][clip.codec];
  const dirIn = '/data/local/tmp/t';
  const clipName = clip.path.split('/').pop();
  await inst.exec(`mkdir -p ${dirIn}`);
  await inst.copyIn(tool, `${dirIn}/hwdec_mediacodec_test`);
  await inst.copyIn(clip.path, `${dirIn}/${clipName}`);
  await inst.exec(`chmod 755 ${dirIn}/hwdec_mediacodec_test`);
  log(`${inst.name}: decode ${clip.name} (${clip.codec}) with ${kind === 'hw' ? 'hardware' : 'software'} (${component}) for ${durationS} s`);

  const runs = [];
  const t0 = Date.now();
  while ((Date.now() - t0) / 1000 < durationS) {
    // The result line goes to stderr; the CRC of every frame goes to /dev/null.
    const r = await inst.exec(`cd ${dirIn} && timeout 180 ./hwdec_mediacodec_test ${clipName} ${component} /dev/null 2>&1 | tail -4`,
      { timeoutMs: 200000 });
    const res = parseDecodeResult(r.stdout);
    if (!res) {
      runs.push({ ok: false, output: r.stdout.trim().slice(-300) });
      break;
    }
    runs.push({ ok: true, frames: res.frames, seconds: res.seconds, fps: res.fps });
  }
  await inst.exec(`rm -rf ${dirIn}`);
  const good = runs.filter((x) => x.ok);
  const frames = good.reduce((a, x) => a + x.frames, 0);
  const seconds = good.reduce((a, x) => a + x.seconds, 0);
  return {
    type: 'decode',
    ok: good.length > 0 && good.length === runs.length,
    decoder: kind,
    component,
    clip: clip.name,
    codec: clip.codec,
    size: clip.size || null,
    runs: runs.length,
    fps: seconds > 0 ? Math.round((frames / seconds) * 10) / 10 : null,
    fpsMin: good.length ? Math.min(...good.map((x) => x.fps)) : null,
    fpsMax: good.length ? Math.max(...good.map((x) => x.fps)) : null,
    error: runs.find((x) => !x.ok) ? runs.find((x) => !x.ok).output : undefined,
  };
}

module.exports = { WORKLOADS: { idle, encode, decode } };

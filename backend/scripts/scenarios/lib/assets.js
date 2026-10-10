'use strict';

// Files the workloads need on the host under test, kept in a cache directory that survives between runs
// (~/.cache/redroid-forge-scenarios): the decode test tool and the video clips.
//
// The clips are GENERATED with ffmpeg (nothing is downloaded): content with a lot of detail and movement, so
// the decoder works as hard as it would on a real film. A real file of the person running the scenario
// (e.g. a movie of their library) can be used too: it is cut to a few seconds with `-c copy` here, on the
// machine where the runner runs, and copied to the host.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { q } = require('./host');
const execFileAsync = promisify(execFile);

const CACHE = '.cache/redroid-forge-scenarios';

// What each generated clip is. H.264 High with B-frames and 4 references and HEVC: the cases the decoder
// of redroid-forge is validated with (see backend/native/vaapi-daemon/README.md).
const GENERATED = {
  h264_1080: { codec: 'h264', ext: 'mp4', size: '1920x1080', args: '-c:v libx264 -profile:v high -bf 2 -refs 4 -pix_fmt yuv420p' },
  h264_720: { codec: 'h264', ext: 'mp4', size: '1280x720', args: '-c:v libx264 -profile:v high -bf 2 -refs 4 -pix_fmt yuv420p' },
  hevc_1080: { codec: 'hevc', ext: 'mp4', size: '1920x1080', args: '-c:v libx265 -pix_fmt yuv420p -tag:v hvc1 -x265-params log-level=none' },
};

// Android-side decoders by name: the hardware one that hwenc registers, and the software one of the platform.
const DECODERS = {
  hw: { h264: 'c2.hardware.decoder.h264', hevc: 'c2.hardware.decoder.hevc' },
  sw: { h264: 'OMX.google.h264.decoder', hevc: 'OMX.google.hevc.decoder' },
};

class Assets {
  constructor(host, { decodeTool, log = () => {} } = {}) {
    this.host = host;
    this.decodeTool = decodeTool;
    this.log = log;
    this.dir = null;
  }

  async init() {
    const home = (await this.host.run('echo $HOME', { check: true })).stdout.trim();
    this.dir = `${home}/${CACHE}`;
    await this.host.run(`mkdir -p ${q(this.dir)}`, { check: true });
  }

  // The test tool (hwdec_mediacodec_test, built from android/vaapi_codec2/test-client in the AOSP tree).
  async tool() {
    if (!this.decodeTool || !fs.existsSync(this.decodeTool)) {
      throw new Error('the decode test tool is not available: build it (see android/README.md) and point to it with decodeTool');
    }
    const remote = `${this.dir}/hwdec_mediacodec_test`;
    const size = fs.statSync(this.decodeTool).size;
    const have = await this.host.run(`stat -c %s ${q(remote)}`);
    if (have.stdout.trim() !== String(size)) {
      this.log('copying the decode test tool to the host');
      await this.host.putFile(this.decodeTool, remote);
      await this.host.run(`chmod 755 ${q(remote)}`, { check: true });
    }
    return remote;
  }

  // A generated clip -> { path (on the host), codec, ... }
  async clip(name, seconds = 10) {
    const spec = GENERATED[name];
    if (!spec) throw new Error(`unknown clip "${name}" (generated ones: ${Object.keys(GENERATED).join(', ')})`);
    const remote = `${this.dir}/${name}-${seconds}s.${spec.ext}`;
    const have = await this.host.run(`test -s ${q(remote)} && echo yes`);
    if (have.stdout.trim() !== 'yes') {
      this.log(`generating the clip ${name} (${seconds} s) on the host`);
      await this.host.run(
        `ffmpeg -v error -y -f lavfi -i mandelbrot=size=${spec.size}:rate=30:maxiter=400 -t ${seconds} ${spec.args} ${q(remote)}`,
        { check: true, timeoutMs: 600000 },
      );
    }
    return { path: remote, codec: spec.codec, name };
  }

  // A real file of the person running the scenario: `seconds` of it, from `start`, video only and without
  // re-encoding. -> { path (on the host), codec, ... }
  async userClip(localFile, { seconds = 20, start = 60 } = {}) {
    if (!fs.existsSync(localFile)) throw new Error(`the clip ${localFile} does not exist`);
    const probe = (await execFileAsync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
      'stream=codec_name,profile,width,height,pix_fmt,avg_frame_rate', '-of', 'json', localFile])).stdout;
    const v = JSON.parse(probe).streams[0];
    const codec = { h264: 'h264', hevc: 'hevc' }[v.codec_name];
    if (!codec) throw new Error(`${path.basename(localFile)} is ${v.codec_name}: only h264 and hevc are supported for now`);
    const id = crypto.createHash('sha1').update(`${localFile}|${start}|${seconds}`).digest('hex').slice(0, 10);
    const remote = `${this.dir}/user-${id}.mp4`;
    const have = await this.host.run(`test -s ${q(remote)} && echo yes`);
    if (have.stdout.trim() !== 'yes') {
      const tmp = path.join(os.tmpdir(), `scn-${id}.mp4`);
      await execFileAsync('ffmpeg', ['-v', 'error', '-y', '-ss', String(start), '-i', localFile, '-t', String(seconds),
        '-map', '0:v:0', '-an', '-sn', '-c:v', 'copy', '-movflags', '+faststart', tmp], { timeout: 300000 });
      await this.host.putFile(tmp, remote);
      fs.rmSync(tmp, { force: true });
    }
    return {
      path: remote, codec, name: path.basename(localFile), profile: v.profile, size: `${v.width}x${v.height}`, pixFmt: v.pix_fmt,
    };
  }
}

module.exports = { Assets, DECODERS, GENERATED };

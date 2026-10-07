#!/usr/bin/env node
'use strict';

// hwenc module (stages 3, 4, 5 and 6 -- see manifest.json, moduleRunner.js and
// docs/ARCHITECTURE.md): it integrates the VA-API Codec2 component (the
// redroid-hwenc project, Apache-2.0, the same author as redroid-forge) into a
// freshly created instance, while it is still stopped, and leaves it usable at
// runtime.
//
// The first module that runs through the generic runner
// (backend/src/lib/moduleRunner.js) instead of being wired by hand in
// instances.js -- it exposes one hook per stage that it declares in its
// manifest.json ("etapa": [3, 4, 5, 6]), with the fixed name that runner
// expects: prepareCreate (3), integrate (4), ensureHostInfraReady (5),
// ensureRuntimeReady (6, it was called ensureHwencReady before this
// convention).
//
// Unlike GApps/Magisk (section 6 of REQUIREMENTS.md), this IS our own 100% free
// code -- the "never host the binary" restriction does not apply. The reason for
// downloading it instead of building it on the spot is purely technical: they
// are Android/bionic binaries that need the complete AOSP toolchain to build,
// not something redroid-forge's normal build can do.
//
// [PENDING] today it reads the artifacts from a local folder
// (REDROID_HWENC_ARTIFACTS_DIR) because redroid-hwenc does not publish a release
// yet -- when one exists, this module would have to download it from there
// instead of assuming they are already on disk.
//
// It uses the `docker` CLI through child_process (the backend's image installs
// `docker-cli` for that, see the Dockerfile) -- porting to dockerode's
// putArchive() (with uid/gid=0 in the tar headers) would remove that dependency.
//
// Tier 5.13 of redroid-hwenc (28-29/09): 3 real bugs found integrating this as a
// module against the official redroid image (not the custom build used before) --
// the instance name (already fixed in the binary this module downloads), the
// missing media_codecs.xml entry (patchMediaCodecsXml already solves it), and the
// encoder's CSD (already fixed in the component). The only one that is still not
// automated is the AIDL/HIDL property -- see ensureRuntimeReady() below.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const hwAccel = require('../../lib/hwAccel');
const execFileAsync = promisify(execFile);

const ARTIFACTS_DIR = process.env.REDROID_HWENC_ARTIFACTS_DIR
  || '/home/jgustavo/aosp-out-redroid15/target/product/redroid_x86_64/vendor';

// Relative path inside ARTIFACTS_DIR -> the same path inside the instance's
// /vendor. Transitive closure of dependencies computed by hand on 28/09
// (readelf -d on the binary + its .so files, resolving against this same tree) --
// see docs/ARCHITECTURE.md for the detail of how this list was built and why it
// does NOT include libva/libgbm/libdrm/libEGL (those are dependencies of the
// host's daemon, not of this binary -- a mistake made the first time, fixed here).
const FILES = [
  'bin/hw/android.hardware.media.c2-vaapi-service',
  'etc/init/android.hardware.media.c2-vaapi-service.rc',
  'etc/seccomp_policy/android.hardware.media.c2-vaapi-seccomp_policy',
  'etc/vintf/manifest/manifest_media_c2_vaapi.xml',
  'lib64/libcodec2.so',
  'lib64/libcodec2_hal_common.so',
  'lib64/libcodec2_aidl.so',
  'lib64/libcodec2_vndk.so',
  'lib64/libcodec2_soft_common.so',
  'lib64/libcodec2_hidl_plugin.so',
  'lib64/android.hardware.media.c2-V1-ndk.so',
  'lib64/libavservices_minijail.so',
  'lib64/libstagefright_bufferpool@2.0.1.so',
  'lib64/android.hardware.graphics.bufferqueue@2.0.so',
  'lib64/libsfplugin_ccodec_utils.so',
  'lib64/android.hardware.media.bufferpool@2.0.so',
  'lib64/android.hardware.media.bufferpool2-V2-ndk.so',
  'lib64/libminijail.so',
  'lib64/libion.so',
  'lib64/libdmabufheap.so',
  'lib64/libcap.so',
  'lib64/libstagefright_aidl_bufferpool2.so',
];

// The backend has to add this to the container's creation Cmd -- it triggers
// redroid.c2.sh (already shipped in the official redroid image), which enables
// debug.stagefright.ccodec. Without it the framework filters ALL Codec2 components
// no matter how well they are registered (Tier 5.6 of redroid-hwenc).
const REQUIRED_BOOT_FLAGS = ['androidboot.use_redroid_c2=1'];

const C2_ENCODER_NAME = 'c2.hardware.encoder.h264';

// Standard resolution steps (long side x short side), from smallest to largest.
const RESOLUTION_LADDER = [
  [426, 240], [640, 360], [854, 480], [1280, 720], [1920, 1080], [2560, 1440], [3840, 2160],
];
const MIN_DECODE_LADDER_INDEX = 3; // floor: 720p, even if the screen is smaller

// Resolution limit that the hardware decoders advertise (decided 06/10/2026): the largest standard step that
// FITS in the instance's screen, rounding down, with a floor at 720p. It is compared in landscape orientation
// regardless of whether the screen is portrait. A player offering UHD on a 720p screen is pointless: the
// compositor rescales it anyway, and the decode and copy of a 4K cost 9 times more.
// Pure (no I/O) so it can be tested.
function decodeSizeLimit(display) {
  const w = Number(display && display.width);
  const h = Number(display && display.height);
  const long = Math.max(w, h);
  const short = Math.min(w, h);
  let idx = MIN_DECODE_LADDER_INDEX;
  if (Number.isFinite(long) && Number.isFinite(short)) {
    for (let i = RESOLUTION_LADDER.length - 1; i >= MIN_DECODE_LADDER_INDEX; i -= 1) {
      if (long >= RESOLUTION_LADDER[i][0] && short >= RESOLUTION_LADDER[i][1]) { idx = i; break; }
    }
  }
  const [maxLong, maxShort] = RESOLUTION_LADDER[idx];
  // XML: maximum width and height separately (a portrait video has the long side in the height), and the area
  // limit in 16x16 blocks, which is what really leaves out a square of long side x long side.
  const blocks = Math.ceil(maxLong / 16) * Math.ceil(maxShort / 16);
  return { maxLong, maxShort, blocks, label: `${maxShort}p` };
}

function limitXml(limit) {
  if (!limit) return '';
  return `\n            <Limit name="size" max="${limit.maxLong}x${limit.maxLong}" />` +
    `\n            <Limit name="block-count" range="1-${limit.blocks}" />\n        `;
}

function log(msg) { console.log(`[hwenc-integrate] ${msg}`); }

// Stage 3 (see manifest.json and backend/src/lib/moduleRunner.js): what THIS MODULE
// needs at the moment of `docker create`, before the container exists. Until now this
// lived hardcoded by hand in instances.js (`if (img.hwEncCapable)
// binds.push(hwAccel.daemonBind())` + the REQUIRED_BOOT_FLAGS flag added separately,
// and unused anywhere) -- the generic runner calls this function instead of
// instances.js knowing that hwenc exists. The bind of the daemon's socket (hwAccel.js,
// stage 5) is declared here, not there: it is what this instance needs to be able to
// talk to that daemon once started, even though the daemon itself is separate host
// infrastructure.
function prepareCreate() {
  return { binds: [hwAccel.daemonBind()], cmd: REQUIRED_BOOT_FLAGS };
}

// It does not replace the whole media_codecs.xml -- every base image (official, custom,
// whatever) may bring its own includes/entries that we do not want to overwrite. The
// file ALREADY present in the instance is extracted, the lines of the encoder and of
// the decoders the HOST supports in hardware (the ones that are not there yet) are
// added to it, and it is injected back -- without this declaration, MediaCodecList
// never learns that the components exist even though their AIDL store is properly
// registered (Tier 5.6 of redroid-hwenc, confirmed live on 28/09 against the official
// image).
//
// Pure (no I/O) so it can be tested: it returns the new XML, or the same one if there
// was nothing to add.
function addCodecsToXml(original, decoders, limit = null) {
  let xml = original;
  if (!xml.includes(C2_ENCODER_NAME)) {
    const patched = xml.replace(/<Encoders>/, `<Encoders>\n        <MediaCodec name="${C2_ENCODER_NAME}" type="video/avc" />`);
    if (patched === xml) {
      throw new Error('<Encoders> not found in media_codecs.xml -- unexpected format, it could not be patched');
    }
    xml = patched;
  }
  const missing = decoders.filter((d) => !xml.includes(`"${d.name}"`));
  if (missing.length > 0) {
    const lines = missing
      .map((d) => (limit
        ? `        <MediaCodec name="${d.name}" type="${d.type}">${limitXml(limit)}</MediaCodec>`
        : `        <MediaCodec name="${d.name}" type="${d.type}" />`))
      .join('\n');
    // The official image has no <Decoders> in this file (the software decoders live in the
    // <Include>s), so the section is normally CREATED. It goes AT THE END, after the <Include>s:
    // MediaCodecList prefers the first one that matches by type, and while hardware decode is
    // not validated the software one has to stay the default (the hardware one is chosen by
    // name). Moving it to the beginning is the change that "turns on" hardware by default.
    let patched;
    if (/<Decoders>/.test(xml)) {
      patched = xml.replace(/<Decoders>/, `<Decoders>\n${lines}`);
    } else {
      patched = xml.replace(/<\/MediaCodecs>/, `    <Decoders>\n${lines}\n    </Decoders>\n</MediaCodecs>`);
    }
    if (patched === xml) {
      throw new Error('<MediaCodecs> not found in media_codecs.xml -- unexpected format, it could not be patched');
    }
    xml = patched;
  }
  return xml;
}

async function patchMediaCodecsXml(containerId, ctx = {}) {
  // This stage (4, creating the instance) runs BEFORE ensureHostInfraReady (stage 5, where the
  // daemon starts): without this, the first instance of a freshly started backend would ask a
  // daemon that does not exist yet for its capabilities and would register no decoder. It is
  // idempotent.
  await hwAccel.ensureDaemonRunning();
  const caps = await hwAccel.queryHwdecCaps();
  if (caps.codecs.length > 0) {
    log(`host hardware decode (${caps.driver}): ${caps.codecs.map((c) => c.id).join(', ')}`);
  } else {
    log('the host offers no hardware decode (or the daemon did not report it): no decoders are registered');
  }
  const decoders = caps.codecs;
  const tmpPath = path.join(os.tmpdir(), `media_codecs-${containerId.slice(0, 12)}.xml`);
  await execFileAsync('docker', ['cp', `${containerId}:/vendor/etc/media_codecs.xml`, tmpPath]);
  const original = fs.readFileSync(tmpPath, 'utf-8');
  const limit = ctx.display ? decodeSizeLimit(ctx.display) : null;
  if (limit) log(`hardware decode limit: ${limit.label} (screen ${ctx.display.width}x${ctx.display.height})`);
  const patched = addCodecsToXml(original, decoders, limit);
  if (patched === original) {
    log('media_codecs.xml already has all the entries, it is left untouched');
    fs.unlinkSync(tmpPath);
    return;
  }
  fs.writeFileSync(tmpPath, patched);
  await execFileAsync('chown', ['root:root', tmpPath]);
  await execFileAsync('docker', ['cp', tmpPath, `${containerId}:/vendor/etc/media_codecs.xml`]);
  fs.unlinkSync(tmpPath);
}

async function copyIntoContainer(containerId, srcPath, destRelPath) {
  if (!fs.existsSync(srcPath)) {
    throw new Error(`Artifact ${srcPath} is missing -- is REDROID_HWENC_ARTIFACTS_DIR (${ARTIFACTS_DIR}) the right one?`);
  }
  // srcPath is never touched -- chown/chmod act on a temporary copy. This is not
  // cosmetic: the first version of this function did chown/chmod directly on srcPath
  // (the ARTIFACTS_DIR tree itself/the repo), and that broke the next incremental AOSP
  // build live on 28/09 (ckati failed with "Operation not permitted" on files that
  // this module had accidentally left as root).
  const tmpPath = path.join(os.tmpdir(), `hwenc-${containerId.slice(0, 12)}-${path.basename(destRelPath)}`);
  fs.copyFileSync(srcPath, tmpPath);
  await execFileAsync('chown', ['root:root', tmpPath]);
  // init rejects any group/world-writable .rc ("Skipping insecure file") -- the
  // binaries/.so files that come out of the AOSP build already arrive as 0644, but a
  // static file of this very module (e.g. redroid-nodcc.rc, created by hand) may
  // inherit the host's umask and end up 0664. Reproduced live on 29/09 -- the same
  // bug that redroid-hwenc's DEVLOG already documents for this same file. chmod
  // always, not only chown.
  const isExecutable = destRelPath.startsWith('bin/');
  await execFileAsync('chmod', [isExecutable ? '0755' : '0644', tmpPath]);
  await execFileAsync('docker', ['cp', tmpPath, `${containerId}:/vendor/${destRelPath}`]);
  fs.unlinkSync(tmpPath);
}

// containerId has to be of a container that is CREATED but NEVER STARTED (or stopped
// before its first real boot) -- /vendor stops being writable seconds after Android
// boots for the first time.
async function integrate(containerId, ctx = {}) {
  log(`injecting ${FILES.length} files into ${containerId}...`);
  for (const relPath of FILES) {
    await copyIntoContainer(containerId, path.join(ARTIFACTS_DIR, relPath), relPath);
  }
  // redroid-nodcc.rc (a Tier 5.7 fix of redroid-hwenc: without it Mesa enables DCC on
  // SurfaceFlinger's real buffer and VCN cannot encode it -- "VCN - DCC surfaces not
  // supported") does not come out of the AOSP build, it is a static 2-line file -- it
  // lives in this very module, not in ARTIFACTS_DIR.
  await copyIntoContainer(
    containerId,
    path.join(__dirname, 'redroid-nodcc.rc'),
    'etc/init/redroid-nodcc.rc',
  );
  await patchMediaCodecsXml(containerId, ctx);
  log('done -- prepareCreate() already took care of adding the required boot flags to the container\'s Cmd.');
}

// Stage 5 (see manifest.json and moduleRunner.js): host infrastructure that this
// instance depends on to talk to the encoder, independent of any particular
// instance. The real logic (spawning the daemon, detecting whether it is already
// alive, etc.) lives in hwAccel.js and is not duplicated here -- this module only
// exposes the hook with the name the generic runner expects, delegating. It is the
// same decision this module's README already explained before a generic runner
// existed; now it is also hooked into the lifecycle without special-casing in
// instances.js.
async function ensureHostInfraReady() {
  await hwAccel.ensureDaemonRunning();
}

// Stage 6 (see docs/ARCHITECTURE.md): unlike integrate(), this runs AFTER the boot, on
// an already-live instance -- the only one of the 3 bugs found in Tier 5.13 that is
// still unresolved on the image/build side. media.c2.hal.selection defaults to "hidl"
// in this framework (the real gate, see redroid-hwenc's DEVLOG.md -- the aconfig flag
// route is compiled out with #if 0), so Codec2Client never looks for AIDL stores like
// ours until it is forced to "aidl" -- and since GetServiceNames() is cached once per
// process, mediaserver (which already started with the old value) needs to be
// restarted to pick up the new one.
// [PENDING] move this to an init trigger of its own (redroid.c2.rc already does
// something similar gated on a boot flag) so as not to depend on this at runtime.
//
// The name is aligned with the runner's generic convention (STAGE_EXPORT_NAME[6] =
// "ensureRuntimeReady") -- it was called ensureHwencReady() before that convention
// existed.
//
// `docker exec containerId <argv...>` lands as uid=0 both in the official redroid image
// and in the custom images with Magisk (confirmed live on 29-30/09 against both) -- no
// `su -c` wrapper is needed. What is needed is a retry with backoff: the generic
// runner (moduleRunner.js) triggers this stage as soon as runtime.start() resolves,
// without waiting for Android's real boot, so the first attempt (sometimes several)
// fails with "exec setprop: no such file or directory" simply because /system is not
// fully populated yet. The same pattern as ensureWifiConnected in hwsimWifi.js -- the
// generic runner has no reason to know about Android's boot times, it is this module's
// knowledge.
const RUNTIME_READY_MAX_ATTEMPTS = 8;
const RUNTIME_READY_RETRY_DELAY_MS = 3000;

// `noRetryCodes`: exit codes that are a definitive answer of the command (not an "Android
// has not booted yet") and therefore there is no point in retrying.
async function execAndroidWithRetry(containerId, argv, { noRetryCodes = [] } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= RUNTIME_READY_MAX_ATTEMPTS; attempt++) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await execFileAsync('docker', ['exec', containerId, ...argv]);
      return;
    } catch (e) {
      lastErr = e;
      if (noRetryCodes.includes(e.code)) throw e;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, RUNTIME_READY_RETRY_DELAY_MS));
    }
  }
  throw lastErr;
}

async function ensureRuntimeReady(containerId) {
  await execAndroidWithRetry(containerId, ['setprop', 'media.c2.hal.selection', 'aidl']);
  try {
    await execAndroidWithRetry(containerId, ['pkill', 'mediaserver'], { noRetryCodes: [1] });
  } catch (e) {
    // pkill returns exit 1 (not exit 0) when it finds no "mediaserver" process alive at
    // that instant -- confirmed live on 30/09, it is not a real failure: mediaserver may
    // be restarting on its own (common during Android's boot, independent of this pkill).
    // Any other code is a real error (ENOENT if /system was not ready, etc.) and is left
    // to propagate.
    if (e.code !== 1) throw e;
    log(`pkill mediaserver: there was no live process in ${containerId} (it probably already restarted on its own)`);
  }
  log('media.c2.hal.selection=aidl applied, mediaserver restarted');
}

module.exports = {
  prepareCreate, integrate, ensureHostInfraReady, ensureRuntimeReady, addCodecsToXml, decodeSizeLimit, FILES, REQUIRED_BOOT_FLAGS, ARTIFACTS_DIR,
};

if (require.main === module) {
  const containerId = process.argv[2];
  if (!containerId) {
    console.error('Usage: node integrate.js <containerId>');
    process.exit(1);
  }
  integrate(containerId).catch((e) => { console.error(e); process.exit(1); });
}

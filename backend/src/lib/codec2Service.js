'use strict';

// Shared machinery behind the "hwenc" (encode) and "hwdec" (decode) modules -- same Codec2
// VA-API HAL service (redroid-hwenc), same host daemon, same media_codecs.xml file. What
// differs between the two is only WHICH half of that file each one is allowed to add: hwenc
// the encoder entry, hwdec the decoder entries. Split into two user-facing modules (separate
// manifests/contracts/acceptance) on 22/10/2026 because the real risk is not the same for
// each: encode only ever works on AMD/Intel, decode also works on NVIDIA (via its own
// nvidia-vaapi-driver) but has a real, still-unfixed bug there (see hwdec's manifest) -- and
// because encode+decode together have caused a real, reproducible, not-yet-understood hang on
// at least one AMD GPU (Polaris). Both modules call into this file for the parts that are
// genuinely the same regardless of which capability is being turned on.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const hwAccel = require('./hwAccel');

const execFileAsync = promisify(execFile);

// No hardcoded fallback on purpose -- this used to default to this project's own author's
// personal AOSP build path, which silently "worked" only on machines that happened to share
// that exact username and folder layout, and gave a confusing "artifact is missing" error
// (pointing at a path that was never meant to exist) on every other host. See installFiles()
// below for the explicit "not configured at all" error this now produces instead.
const ARTIFACTS_DIR = process.env.REDROID_HWENC_ARTIFACTS_DIR || null;

// Codec2 HAL variant: the AIDL HAL (media/codec2/hal/aidl) does not exist before Android 14 --
// confirmed directly against AOSP source at android-11/12/13's tags, where only
// media/codec2/hidl/{1.0,1.1} exist. Below 14 this project uses its own HIDL port of the same
// VaapiEncComponent/VaapiDecComponent code (end-to-end validated on Android 11, 08/11/2026:
// real VA-API hardware encode through scrcpy, no crashes, h264 output confirmed) -- only the
// registration layer differs (HIDL's registerAsService() vs AIDL's AServiceManager_addService()),
// the vendor component logic itself is untouched.
// `androidVersion` undefined/null (image no longer in the catalog, see instances.js' own
// comments on this) falls through to 'aidl' -- today's only behaviour, unchanged.
function variantFor(androidVersion) {
  return androidVersion != null && androidVersion < 14 ? 'hidl' : 'aidl';
}

// Relative path inside ARTIFACTS_DIR -> the same path inside the instance's /vendor.
// Transitive closure of dependencies computed by hand (readelf -d on the binary + its .so
// files, resolving against this same tree) -- see docs/ARCHITECTURE.md for the detail of how
// this list was built and why it does NOT include libva/libgbm/libdrm/libEGL (those are
// dependencies of the host's daemon, not of this binary).
const FILES_AIDL = [
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

// Same idea, for the HIDL variant (Android 11, so far -- 12/13 not validated yet, see
// variantFor's comment and the manifest). Closure computed the same way, against the real
// Android 11 AOSP tree; notably smaller than the AIDL one -- no libminijail.so/libcap.so/
// libdmabufheap.so/bufferpool@2.0/bufferqueue@2.0/bufferpool2-V2-ndk.so, confirmed NOT present
// under /vendor/lib64 on a live, working instance (this binary links the VNDK copies of those
// instead, reachable from /apex/com.android.vndk.v30 without a vendor-local copy).
// lib64/libion.so here is OUR patched build (dma_heap fallback, see installIonDmaHeapFix) --
// without it, Codec2's ION allocator segfaults the moment a real buffer is encoded
// (C2AllocatorIon::getId() on a null mTraits) because /dev/ion does not exist on any kernel
// that dropped legacy ION (5.10+) -- this vendor copy covers this HIDL service's own process;
// the framework/client side needs the SAME fix applied to the /system and swcodec-apex copies,
// which installIonDmaHeapFix does separately, at stage 6 (those paths are not writable, or do
// not exist yet, before boot).
const FILES_HIDL = [
  'bin/hw/android.hardware.media.c2@1.1-vaapi-service',
  'etc/init/android.hardware.media.c2@1.1-vaapi-service.rc',
  'etc/seccomp_policy/android.hardware.media.c2-vaapi-seccomp_policy',
  'etc/vintf/manifest/manifest_media_c2_vaapi.xml',
  'lib64/libcodec2.so',
  'lib64/libcodec2_hidl@1.0.so',
  'lib64/libcodec2_hidl@1.1.so',
  'lib64/libcodec2_soft_common.so',
  'lib64/libcodec2_vndk.so',
  'lib64/libion.so',
  'lib64/libavservices_minijail.so',
  'lib64/libstagefright_bufferpool@2.0.1.so',
  'lib64/libsfplugin_ccodec_utils.so',
];

// Kept exported as `FILES` for anything (including existing tests) that only ever cared about
// the AIDL/15 list -- the variant that was the only one that existed before 08/11/2026.
const FILES = FILES_AIDL;

// Subfolder of ARTIFACTS_DIR for each variant. The AIDL set keeps the original, flat layout
// (nothing already deployed on Android 15 needs re-pathing); the HIDL set is new and lives in
// its own subfolder, since (a) it is a different, smaller closure and (b) it needs an extra
// file (system-lib64/libion.so) that is not a /vendor path at all.
function artifactsBaseDir(variant) {
  return variant === 'hidl' ? path.join(ARTIFACTS_DIR, 'android11-hidl') : ARTIFACTS_DIR;
}

const C2_ENCODER_NAME = 'c2.hardware.encoder.h264';

// Standard resolution steps (long side x short side), from smallest to largest.
const RESOLUTION_LADDER = [
  [426, 240], [640, 360], [854, 480], [1280, 720], [1920, 1080], [2560, 1440], [3840, 2160],
];
const MIN_DECODE_LADDER_INDEX = 3; // floor: 720p, even if the screen is smaller

// Resolution limit that the hardware decoders advertise: the largest standard step that FITS
// in the instance's screen, rounding down, with a floor at 720p. It is compared in landscape
// orientation regardless of whether the screen is portrait. A player offering UHD on a 720p
// screen is pointless: the compositor rescales it anyway, and the decode and copy of a 4K cost
// 9 times more.
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

function log(msg) { console.log(`[codec2Service] ${msg}`); }

// It does not replace the whole media_codecs.xml -- every base image (official, custom,
// whatever) may bring its own includes/entries that we do not want to overwrite. The file
// ALREADY present in the instance is extracted, the lines of whichever of
// {encoder, decoders} is asked for (and is not there yet) are added to it, and it is injected
// back -- without this declaration, MediaCodecList never learns that the components exist
// even though their AIDL store is properly registered.
//
// `addEncoder`/`addDecoders`: which half this caller is allowed to touch -- hwenc only ever
// passes addEncoder:true, hwdec only ever passes addDecoders:true. Both default to true so a
// direct call (as the existing tests already do) keeps behaving exactly as it did when this
// was one module doing both at once.
// Pure (no I/O) so it can be tested: it returns the new XML, or the same one if there was
// nothing to add.
function addCodecsToXml(original, decoders, limit = null, { addEncoder = true, addDecoders = true } = {}) {
  let xml = original;
  if (addEncoder && !xml.includes(C2_ENCODER_NAME)) {
    const patched = xml.replace(/<Encoders>/, `<Encoders>\n        <MediaCodec name="${C2_ENCODER_NAME}" type="video/avc" />`);
    if (patched === xml) {
      throw new Error('<Encoders> not found in media_codecs.xml -- unexpected format, it could not be patched');
    }
    xml = patched;
  }
  if (addDecoders) {
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
  }
  return xml;
}

async function patchMediaCodecsXml(containerId, ctx = {}, flags = {}) {
  // This stage (4, creating the instance) runs BEFORE ensureHostInfraReady (stage 5, where the
  // daemon starts): without this, the first instance of a freshly started backend would ask a
  // daemon that does not exist yet for its capabilities and would register no decoder. It is
  // idempotent.
  await hwAccel.ensureDaemonRunning();
  const decoders = flags.addDecoders === false ? [] : (await hwAccel.queryHwdecCaps()).codecs;
  if (flags.addDecoders !== false) {
    if (decoders.length > 0) {
      log(`host hardware decode: ${decoders.map((c) => c.name).join(', ')}`);
    } else {
      log('the host offers no hardware decode (or the daemon did not report it): no decoders are registered');
    }
  }
  const tmpPath = path.join(os.tmpdir(), `media_codecs-${containerId.slice(0, 12)}.xml`);
  await execFileAsync('docker', ['cp', `${containerId}:/vendor/etc/media_codecs.xml`, tmpPath]);
  const original = fs.readFileSync(tmpPath, 'utf-8');
  const limit = ctx.display ? decodeSizeLimit(ctx.display) : null;
  if (limit && flags.addDecoders !== false) log(`hardware decode limit: ${limit.label} (screen ${ctx.display.width}x${ctx.display.height})`);
  const patched = addCodecsToXml(original, decoders, limit, flags);
  if (patched === original) {
    log('media_codecs.xml already has what this capability needs, it is left untouched');
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
  // srcPath is never touched -- chown/chmod act on a temporary copy, never on the
  // ARTIFACTS_DIR tree itself (doing that broke an incremental AOSP build once, live).
  const tmpPath = path.join(os.tmpdir(), `hwenc-${containerId.slice(0, 12)}-${path.basename(destRelPath)}`);
  fs.copyFileSync(srcPath, tmpPath);
  await execFileAsync('chown', ['root:root', tmpPath]);
  // init rejects any group/world-writable .rc ("Skipping insecure file") -- the binaries/.so
  // files that come out of the AOSP build already arrive as 0644, but a static file of this
  // very module (e.g. redroid-nodcc.rc) may inherit the host's umask and end up 0664. chmod
  // always, not only chown.
  const isExecutable = destRelPath.startsWith('bin/');
  await execFileAsync('chmod', [isExecutable ? '0755' : '0644', tmpPath]);
  await execFileAsync('docker', ['cp', tmpPath, `${containerId}:/vendor/${destRelPath}`]);
  fs.unlinkSync(tmpPath);
}

// containerId has to be of a container that is CREATED but NEVER STARTED (or stopped before
// its first real boot) -- /vendor stops being writable seconds after Android boots for the
// first time. Idempotent (docker cp always overwrites): safe to call once per capability if
// both hwenc and hwdec are active on the same instance, the second call just re-copies the
// same files.
async function installFiles(containerId, androidVersion) {
  if (!ARTIFACTS_DIR) {
    throw new Error('REDROID_HWENC_ARTIFACTS_DIR is not set -- hwenc/hwdec need a local folder with the '
      + 'AOSP-built Codec2 VA-API artifacts (see backend/src/modules/hwenc/README.md, "Pending"), and there '
      + 'is no default to fall back to.');
  }
  const variant = variantFor(androidVersion);
  const files = variant === 'hidl' ? FILES_HIDL : FILES_AIDL;
  const base = artifactsBaseDir(variant);
  log(`injecting ${files.length} files (${variant}) into ${containerId}...`);
  for (const relPath of files) {
    await copyIntoContainer(containerId, path.join(base, relPath), relPath);
  }
  // redroid-nodcc.rc: without it Mesa enables DCC on SurfaceFlinger's real buffer and VCN
  // cannot encode it ("VCN - DCC surfaces not supported"). Does not come out of the AOSP
  // build, it is a static 2-line file that lives with the hwenc module, not in ARTIFACTS_DIR
  // -- kept there since this file predates the encode/decode split and is encode-specific
  // (decode-only has nothing to do with VCN/DCC), loaded lazily to avoid a require() cycle.
  // Same file regardless of variant -- it is about the host GPU (AMD VCN/DCC), not about which
  // Codec2 HAL registration the component uses.
  // eslint-disable-next-line global-require
  const hwencDir = require('./moduleManifests').moduleDir('hwenc');
  await copyIntoContainer(containerId, path.join(hwencDir, 'redroid-nodcc.rc'), 'etc/init/redroid-nodcc.rc');
}

// Copies a file to an arbitrary absolute path inside a LIVE (already booted) container --
// unlike copyIntoContainer (stage 4, pre-boot, always under /vendor), this is for stage 6
// fixups against paths that do not exist (or are not writable) before Android's own init has
// booted and mounted them. Same chown/chmod dance as copyIntoContainer, parameterized on the
// destination instead of assuming /vendor.
async function copyFileToAbsPath(containerId, srcPath, destAbsPath) {
  if (!fs.existsSync(srcPath)) {
    throw new Error(`Artifact ${srcPath} is missing -- is REDROID_HWENC_ARTIFACTS_DIR (${ARTIFACTS_DIR}) the right one?`);
  }
  const tmpPath = path.join(os.tmpdir(), `hwenc-${containerId.slice(0, 12)}-${path.basename(destAbsPath)}`);
  fs.copyFileSync(srcPath, tmpPath);
  await execFileAsync('chown', ['root:root', tmpPath]);
  await execFileAsync('chmod', ['0644', tmpPath]);
  await execFileAsync('docker', ['cp', tmpPath, `${containerId}:${destAbsPath}`]);
  fs.unlinkSync(tmpPath);
}

// Android 11-13's libion.so only knows legacy /dev/ion -- removed from upstream Linux (5.10+,
// replaced by DMA-BUF Heaps) and confirmed, by reading the AOSP source directly, unfixed and
// byte-identical through android-13.0.0_r83 (not an 11-specific oversight). FILES_HIDL's own
// lib64/libion.so (our patched build, dma_heap fallback) covers the VENDOR copy this service's
// own process links -- but the FRAMEWORK/client side of Codec2 (CCodecBufferChannel, running in
// whatever process opened the MediaCodec) links the /system and swcodec-apex copies instead,
// which come straight from the base image, unpatched. Confirmed by two separate, sequential
// crashes while validating this end-to-end (08/11/2026): C2AllocatorIon::getId() (vendor copy)
// then C2AllocatorIon::setUsageMapper() (system/apex copies, once the first was fixed).
//
// This can only run POST-boot (stage 6), not alongside installFiles (stage 4): the swcodec
// apex overlay this also patches does not exist until Android's own init mounts it during boot,
// and -- once it does exist -- `docker cp` still cannot reach it directly (confirmed: it only
// sees the container's build-time rootfs layers, not a mount created live inside the
// container's own namespace, the same way /tmp or apex paths are invisible to it before boot).
// `docker exec` DOES see the live namespace, so the file is staged on /data first (a normal,
// always-writable volume) and copied into place from there -- the same pattern `adb push` +
// `adb shell cp` proved out by hand this session, without adding an adb dependency to the
// backend.
const APEX_SWCODEC_LIBION_STAGE = '/data/local/tmp/codec2service-libion-fix.so';

async function installIonDmaHeapFix(containerId, androidVersion) {
  if (!ARTIFACTS_DIR) {
    throw new Error('REDROID_HWENC_ARTIFACTS_DIR is not set -- hwenc/hwdec need a local folder with the '
      + 'AOSP-built Codec2 VA-API artifacts (see backend/src/modules/hwenc/README.md, "Pending"), and there '
      + 'is no default to fall back to.');
  }
  const base = artifactsBaseDir(variantFor(androidVersion));
  const src = path.join(base, 'system-lib64/libion.so');
  // Called after waitForBootCompleted (ensureRuntimeReady), so /data/local/tmp should already
  // exist -- mkdir -p kept anyway, idempotent and cheap, as a safety net rather than the
  // readiness gate itself (that used to be this line's job; see waitForBootCompleted's comment
  // for why that was not enough on its own).
  await execAndroidWithRetry(containerId, ['mkdir', '-p', '/data/local/tmp']);
  await copyFileToAbsPath(containerId, src, '/system/lib64/libion.so');
  await execFileAsync('docker', ['cp', src, `${containerId}:${APEX_SWCODEC_LIBION_STAGE}`]);
  await execAndroidWithRetry(containerId, ['cp', APEX_SWCODEC_LIBION_STAGE, '/apex/com.android.media.swcodec/lib64/libion.so']);
  await execAndroidWithRetry(containerId, ['rm', '-f', APEX_SWCODEC_LIBION_STAGE]);
  log(`libion.so dma_heap fix applied to /system and the swcodec apex of ${containerId}`);
}

// Stage 3 (see moduleRunner.js): needed whenever EITHER capability is requested. The
// `androidboot.use_redroid_c2=1` boot flag this used to add here is now part of every instance's
// base cmd regardless of modules (routes/instances.js) -- see its comment there, and
// CHANGELOG.md's v0.7.1 entry, for why it stopped being hwenc/hwdec-specific.
function prepareCreate() {
  return { binds: [hwAccel.daemonBind()], cmd: [] };
}

// Stage 5: host infrastructure (the VA-API daemon), independent of any particular instance.
async function ensureHostInfraReady() {
  await hwAccel.ensureDaemonRunning();
}

// Stage 6: unlike integrate(), this runs AFTER the boot, on an already-live instance. Needed
// whenever EITHER capability is active. The runtime switch that actually turns Codec2 on
// differs by variant (see variantFor):
// - AIDL (15): media.c2.hal.selection defaults to "hidl" in this framework, so Codec2Client
//   never looks for AIDL stores like ours until it is forced to "aidl".
// - HIDL (11-13): debug.stagefright.ccodec gates MediaCodecList wholesale (option 0 drops every
//   Codec2 entry regardless of HAL-level registration -- confirmed by reading
//   Codec2InfoBuilder::buildMediaCodecList() directly; the official Android 11 image ships with
//   it at 0). Forcing it to 4 ("all components, normal ranks") is this variant's equivalent
//   switch. Also needs the dma_heap fix above applied first (installIonDmaHeapFix) -- without
//   it CCodec crashes the moment it actually tries to allocate a buffer, HAL registration alone
//   is not enough to tell.
// Either way, GetServiceNames()/MediaCodecList is cached once per process, so mediaserver
// (already started with the old value) needs restarting to pick up the new one.
const RUNTIME_READY_MAX_ATTEMPTS = 8;
const RUNTIME_READY_RETRY_DELAY_MS = 3000;

// `noRetryCodes`: exit codes that are a definitive answer of the command (not an "Android has
// not booted yet") and therefore there is no point in retrying.
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

// HIDL-only (see below): waits for sys.boot_completed=1 before touching anything else.
// Found for real (08/11/2026, first live run through the actual module system): gating stage
// 6 on /data/local/tmp existing (installIonDmaHeapFix's own retry) is NOT equivalent to boot
// actually finishing -- debug.stagefright.ccodec got set to 4 successfully (no error, no
// retry) but read back as 0 once boot genuinely completed moments later, meaning some late-
// boot step (sys.boot_completed=1's own trigger, presumably) re-asserts the image's default
// AFTER /data is already writable but BEFORE boot is actually done. Waiting for the real
// signal instead of a proxy for it fixes the race at its source.
async function waitForBootCompleted(containerId) {
  await execAndroidWithRetry(containerId, ['sh', '-c', 'test "$(getprop sys.boot_completed)" = 1']);
}

async function ensureRuntimeReady(containerId, androidVersion) {
  const variant = variantFor(androidVersion);
  if (variant === 'hidl') {
    await waitForBootCompleted(containerId);
    await installIonDmaHeapFix(containerId, androidVersion);
    await execAndroidWithRetry(containerId, ['setprop', 'debug.stagefright.ccodec', '4']);
  } else {
    await execAndroidWithRetry(containerId, ['setprop', 'media.c2.hal.selection', 'aidl']);
  }
  try {
    await execAndroidWithRetry(containerId, ['pkill', 'mediaserver'], { noRetryCodes: [1] });
  } catch (e) {
    // pkill returns exit 1 (not exit 0) when it finds no "mediaserver" process alive at that
    // instant -- not a real failure: mediaserver may be restarting on its own (common during
    // Android's boot, independent of this pkill). Any other code is a real error (ENOENT if
    // /system was not ready, etc.) and is left to propagate.
    if (e.code !== 1) throw e;
    log(`pkill mediaserver: there was no live process in ${containerId} (it probably already restarted on its own)`);
  }
  log(variant === 'hidl'
    ? 'debug.stagefright.ccodec=4 applied, mediaserver restarted'
    : 'media.c2.hal.selection=aidl applied, mediaserver restarted');
}

// REMOVED 09/11/2026: this used to warn that the HIDL variant (Android 11-13) was only
// validated on AMD and expected to fail/corrupt video on Intel -- the hand-written-VA-API-
// consumer analogy to daemon.c's own P-frame bug. That analogy turned out to be literally true,
// not just structurally similar: tested directly, Intel on this HIDL path hits the exact same
// bitstream bug (`Overread SPS by N bits`) and the exact same fix (the `ffmpeg` encode backend)
// as the AIDL/daemon.c path. Since hwAccel.encodeBackendRisk's Intel+legacy case already covers
// this -- it is keyed on vendor+backend, not on which Codec2 variant (AIDL/HIDL) is in front of
// it -- a second, HIDL-specific warning saying the same thing was redundant. Removed rather than
// reworded; see redroid-hwenc's DEVLOG.md (2026-11-09 entry) for the actual test.

module.exports = {
  ARTIFACTS_DIR, FILES, FILES_AIDL, FILES_HIDL, C2_ENCODER_NAME,
  variantFor, artifactsBaseDir,
  decodeSizeLimit, addCodecsToXml, patchMediaCodecsXml, installFiles,
  prepareCreate, ensureHostInfraReady, ensureRuntimeReady, installIonDmaHeapFix,
};

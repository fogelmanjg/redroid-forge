'use strict';

// Guest-side machinery for the "nvenc" module (NVIDIA hardware encode) -- what codec2Service.js
// is to hwenc/hwdec, but a genuinely different HAL service/daemon/protocol, so it is its own
// file rather than folded into that one (see that file's own top comment for why it exists: it
// is shared ONLY because hwenc/hwdec share one real binary -- nvenc shares nothing with either
// one at the binary level, only the broader Codec2/media_codecs.xml machinery, reused below via
// plain imports of codec2Service's own pure/generic exports instead of re-deriving them).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const nvencAccel = require('./nvencAccel');
const codec2Service = require('./codec2Service');

const execFileAsync = promisify(execFile);

// Same reasoning as REDROID_HWENC_ARTIFACTS_DIR in codec2Service.js: no hardcoded fallback, a
// clear "not configured" error instead of a path that only ever existed on one machine.
const ARTIFACTS_DIR = process.env.REDROID_NVENC_ARTIFACTS_DIR || null;

// Transitive .so closure of android.hardware.media.c2-nvenc-service, computed the same way
// codec2Service.js's own FILES list was (readelf -d on the binary + its dependencies,
// resolving against the AOSP out tree's vendor/lib64) -- see docs/ARCHITECTURE.md.
const FILES = [
  'bin/hw/android.hardware.media.c2-nvenc-service',
  'etc/init/android.hardware.media.c2-nvenc-service.rc',
  'etc/seccomp_policy/android.hardware.media.c2-nvenc-seccomp_policy',
  'etc/vintf/manifest/manifest_media_c2_nvenc.xml',
  'lib64/android.hardware.common.fmq-V1-ndk.so',
  'lib64/android.hardware.common-V2-ndk.so',
  'lib64/android.hardware.graphics.allocator@2.0.so',
  'lib64/android.hardware.graphics.allocator@3.0.so',
  'lib64/android.hardware.graphics.allocator@4.0.so',
  'lib64/android.hardware.graphics.allocator-V2-ndk.so',
  'lib64/android.hardware.graphics.bufferqueue@2.0.so',
  'lib64/android.hardware.graphics.common@1.0.so',
  'lib64/android.hardware.graphics.common@1.1.so',
  'lib64/android.hardware.graphics.common@1.2.so',
  'lib64/android.hardware.graphics.common-V6-ndk.so',
  'lib64/android.hardware.graphics.mapper@2.0.so',
  'lib64/android.hardware.graphics.mapper@2.1.so',
  'lib64/android.hardware.graphics.mapper@3.0.so',
  'lib64/android.hardware.graphics.mapper@4.0.so',
  'lib64/android.hardware.media.bufferpool@2.0.so',
  'lib64/android.hardware.media.bufferpool2-V2-ndk.so',
  'lib64/android.hardware.media.c2-V1-ndk.so',
  'lib64/android.hidl.memory@1.0.so',
  'lib64/android.hidl.memory.token@1.0.so',
  'lib64/android.hidl.safe_union@1.0.so',
  'lib64/libaconfig_storage_read_api_cc.so',
  'lib64/libaudioutils.so',
  'lib64/libavservices_minijail.so',
  'lib64/libbase.so',
  'lib64/libbinder.so',
  'lib64/libcap.so',
  'lib64/libcodec2_aidl.so',
  'lib64/libcodec2_hal_common.so',
  'lib64/libcodec2_hidl_plugin.so',
  'lib64/libcodec2.so',
  'lib64/libcodec2_soft_common.so',
  'lib64/libcodec2_vndk.so',
  'lib64/libc++.so',
  'lib64/libcutils.so',
  'lib64/libdmabufheap.so',
  'lib64/libdrm.so',
  'lib64/libfmq.so',
  'lib64/libgralloctypes.so',
  'lib64/libhardware.so',
  'lib64/libhidlbase.so',
  'lib64/libhidlmemory.so',
  'lib64/libion.so',
  'lib64/libmedia_helper.so',
  'lib64/libminijail.so',
  'lib64/libsfplugin_ccodec_utils.so',
  'lib64/libspeexresampler.so',
  'lib64/libstagefright_aidl_bufferpool2.so',
  'lib64/libstagefright_bufferpool@2.0.1.so',
  'lib64/libstagefright_foundation.so',
  'lib64/libui.so',
  'lib64/libutils.so',
  'lib64/libz.so',
  'lib64/server_configurable_flags.so',
];

const C2_ENCODER_NAME = 'c2.hardware.encoder.h264';

function log(msg) { console.log(`[nvencService] ${msg}`); }

async function copyIntoContainer(containerId, srcPath, destRelPath) {
  if (!fs.existsSync(srcPath)) {
    throw new Error(`Artifact ${srcPath} is missing -- is REDROID_NVENC_ARTIFACTS_DIR (${ARTIFACTS_DIR}) the right one?`);
  }
  const tmpPath = path.join(os.tmpdir(), `nvenc-${containerId.slice(0, 12)}-${path.basename(destRelPath)}`);
  fs.copyFileSync(srcPath, tmpPath);
  await execFileAsync('chown', ['root:root', tmpPath]);
  // Same "init rejects insecure (group/world-writable) files" reasoning as codec2Service.js's
  // own copyIntoContainer -- chmod always, not conditionally on the source's own mode.
  const isExecutable = destRelPath.startsWith('bin/');
  await execFileAsync('chmod', [isExecutable ? '0755' : '0644', tmpPath]);
  await execFileAsync('docker', ['cp', tmpPath, `${containerId}:/vendor/${destRelPath}`]);
  fs.unlinkSync(tmpPath);
}

const SERVICE_RC_REL_PATH = 'etc/init/android.hardware.media.c2-nvenc-service.rc';
const RENDER_NODE_PATH = '/dev/dri/renderD128';

// The .rc's own "group camera mediadrm drmrpc" line (see its comment) is missing the render
// node's real group on purpose -- patched in here with the actual numeric GID, read straight
// off the host's device node, since that GID has no relationship to whatever Android's own
// compiled-in AID table resolves the *name* "render" to (confirmed empirically on jgustavo47,
// 31/10/2026: the service had groups 1026/1031 with a plain "render" in the .rc, while the
// bind-mounted node itself is owned by the host's real render GID, 992 on that machine -- two
// completely different numbers. Android's init DOES accept a bare numeric GID in a service's
// "group" line, not just AID names, so appending it here is enough).
async function installFiles(containerId) {
  if (!ARTIFACTS_DIR) {
    throw new Error('REDROID_NVENC_ARTIFACTS_DIR is not set -- the nvenc module needs a local folder with the '
      + 'AOSP-built android.hardware.media.c2-nvenc-service artifacts (see backend/src/modules/nvenc/README.md), '
      + 'and there is no default to fall back to.');
  }
  log(`injecting ${FILES.length} files into ${containerId}...`);
  for (const relPath of FILES) {
    if (relPath === SERVICE_RC_REL_PATH) continue;
    await copyIntoContainer(containerId, path.join(ARTIFACTS_DIR, relPath), relPath);
  }
  await installPatchedServiceRc(containerId);
}

async function installPatchedServiceRc(containerId) {
  const srcPath = path.join(ARTIFACTS_DIR, SERVICE_RC_REL_PATH);
  if (!fs.existsSync(srcPath)) {
    throw new Error(`Artifact ${srcPath} is missing -- is REDROID_NVENC_ARTIFACTS_DIR (${ARTIFACTS_DIR}) the right one?`);
  }
  let renderGid;
  try {
    renderGid = fs.statSync(RENDER_NODE_PATH).gid;
  } catch (err) {
    throw new Error(`Could not stat ${RENDER_NODE_PATH} on the host to read its real group id: ${err.message}`);
  }
  const original = fs.readFileSync(srcPath, 'utf-8');
  const patched = original.replace(
    /^(\s*group camera mediadrm drmrpc)\s*$/m,
    `$1 ${renderGid}`,
  );
  if (patched === original) {
    throw new Error(`${srcPath} does not have the expected "group camera mediadrm drmrpc" line -- was it hand-edited?`);
  }
  const tmpPath = path.join(os.tmpdir(), `nvenc-${containerId.slice(0, 12)}-service.rc`);
  fs.writeFileSync(tmpPath, patched);
  await execFileAsync('chown', ['root:root', tmpPath]);
  await execFileAsync('chmod', ['0644', tmpPath]);
  await execFileAsync('docker', ['cp', tmpPath, `${containerId}:/vendor/${SERVICE_RC_REL_PATH}`]);
  fs.unlinkSync(tmpPath);
}

// Reuses codec2Service's own addCodecsToXml (pure, generic, already tested) instead of
// re-deriving the same XML patching logic -- but NOT its patchMediaCodecsXml wrapper, which
// also calls hwAccel.ensureDaemonRunning()/queryHwdecCaps(), the wrong (VA-API) daemon for this
// module entirely.
async function patchMediaCodecsXml(containerId) {
  const tmpPath = path.join(os.tmpdir(), `media_codecs-nvenc-${containerId.slice(0, 12)}.xml`);
  await execFileAsync('docker', ['cp', `${containerId}:/vendor/etc/media_codecs.xml`, tmpPath]);
  const original = fs.readFileSync(tmpPath, 'utf-8');
  const patched = codec2Service.addCodecsToXml(original, [], null, { addEncoder: true, addDecoders: false });
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

// Stage 3: same boot flag hwenc/hwdec need (androidboot.use_redroid_c2=1, see
// codec2Service.js's own REQUIRED_BOOT_FLAGS comment) -- it is a property of the official
// redroid image's own init script, not of VA-API specifically, reused as-is. Plus the bind for
// this module's own daemon socket.
function prepareCreate() {
  return { binds: [nvencAccel.daemonBind()], cmd: codec2Service.REQUIRED_BOOT_FLAGS };
}

async function ensureHostInfraReady() {
  await nvencAccel.ensureDaemonRunning();
}

// Stage 6: same media.c2.hal.selection=aidl + mediaserver restart hwenc/hwdec need (see
// codec2Service.js's own ensureRuntimeReady comment for the full reasoning) -- genuinely
// generic, reused as-is rather than duplicated.
async function ensureRuntimeReady(containerId) {
  await codec2Service.ensureRuntimeReady(containerId);
}

module.exports = {
  ARTIFACTS_DIR, FILES, C2_ENCODER_NAME,
  installFiles, patchMediaCodecsXml, prepareCreate, ensureHostInfraReady, ensureRuntimeReady,
};

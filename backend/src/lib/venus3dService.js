'use strict';

// Guest-side machinery for the "venus3d" module (real 3D acceleration on NVIDIA hosts, ported
// from redroid-nvidia's Tier 4/5 -- see backend/src/modules/venus3d/README.md) -- what
// codec2Service.js is to hwenc/hwdec, but for a genuinely different vendor partition (a Vulkan
// ICD + a gralloc backend, not a Codec2 service), so it is its own file.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const venus3dAccel = require('./venus3dAccel');

const execFileAsync = promisify(execFile);

// Same reasoning as REDROID_HWENC_ARTIFACTS_DIR/REDROID_NVENC_ARTIFACTS_DIR: no hardcoded
// fallback, a clear "not configured" error instead of a path that only ever existed on one
// machine. Unlike those two, this is not an AOSP `out/` tree slice -- the four libraries below
// are built two different ways (see the module's own README): libminigbm_gralloc.so comes from
// this project's own AOSP tree (Soong module "gralloc.minigbm", the patched minigbm backend),
// vulkan.virtio.so from a standalone meson+NDK cross-build of the same tree's patched Mesa (no
// Soong module exists for it here -- see patches/mesa/README.md's own build recipe), and the
// two ANGLE libraries are stock, unpatched, just vendored from the same AOSP tree's /system
// output because the guest's vendor partition needs its own copy (see the README for why).
const ARTIFACTS_DIR = process.env.REDROID_VENUS3D_ARTIFACTS_DIR || null;

// Pure data: relative path under ARTIFACTS_DIR -> relative path under the instance's /vendor.
// Every file here is a real GPU driver component, not a transitive .so closure to resolve --
// unlike nvencService.js's FILES (a Codec2 service binary pulling in ~50 framework libraries),
// none of these need anything beyond what the stock image's /vendor already ships (libc++,
// libdrm, liblog, etc. are already there).
const FILES = [
  ['lib64/vulkan.virtio.so', 'lib64/hw/vulkan.virtio.so'],
  ['lib/vulkan.virtio.so', 'lib/hw/vulkan.virtio.so'],
  ['lib64/libminigbm_gralloc.so', 'lib64/libminigbm_gralloc.so'],
  ['lib/libminigbm_gralloc.so', 'lib/libminigbm_gralloc.so'],
  ['lib64/libEGL_angle.so', 'lib64/egl/libEGL_angle.so'],
  ['lib64/libGLESv2_angle.so', 'lib64/egl/libGLESv2_angle.so'],
  ['lib/libEGL_angle.so', 'lib/egl/libEGL_angle.so'],
  ['lib/libGLESv2_angle.so', 'lib/egl/libGLESv2_angle.so'],
  // Real gap found on real hardware: the standalone meson+NDK cross-build of vulkan.virtio.so
  // (patches/mesa/README.md's own recipe, needed since no Soong module exists for it in this
  // tree) links dynamically against a libdrm.so meson built itself via -Dforce_fallback_for --
  // not shipped anywhere in the stock image (it does not ship ANY /vendor/lib64/libdrm.so by
  // default; nvenc's own FILES list ships its own AOSP-tree-built copy for the exact same
  // reason). dlopen() from the sphal linker namespace failed outright ("library libdrm.so not
  // found") until this module shipped its own, from the SAME AOSP tree build everything else
  // here comes from (confirmed ABI-compatible: it is the exact file nvenc's own, already-working
  // service links against).
  ['lib64/libdrm.so', 'lib64/libdrm.so'],
  ['lib/libdrm.so', 'lib/libdrm.so'],
];

function log(msg) { console.log(`[venus3dService] ${msg}`); }

async function copyIntoContainer(containerId, srcPath, destRelPath) {
  if (!fs.existsSync(srcPath)) {
    throw new Error(`Artifact ${srcPath} is missing -- is REDROID_VENUS3D_ARTIFACTS_DIR (${ARTIFACTS_DIR}) the right one?`);
  }
  const tmpPath = path.join(os.tmpdir(), `venus3d-${containerId.slice(0, 12)}-${path.basename(destRelPath)}`);
  fs.copyFileSync(srcPath, tmpPath);
  await execFileAsync('chown', ['root:root', tmpPath]);
  await execFileAsync('chmod', ['0644', tmpPath]);
  // No mkdir needed: /vendor/lib64/hw, /vendor/lib64/egl and /vendor/lib/egl already exist in
  // the stock image (it already ships gralloc.cros.so and Mesa's own EGL/GLES libraries there)
  // -- and the container is only created, not started, at this stage (stage 4, the one window
  // /vendor is writable), so `docker exec` is not an option here even if a dir were missing.
  await execFileAsync('docker', ['cp', tmpPath, `${containerId}:/vendor/${destRelPath}`]);
  fs.unlinkSync(tmpPath);
}

async function installFiles(containerId) {
  if (!ARTIFACTS_DIR) {
    throw new Error('REDROID_VENUS3D_ARTIFACTS_DIR is not set -- the venus3d module needs a local folder with the '
      + 'patched Mesa/minigbm guest artifacts (see backend/src/modules/venus3d/README.md), and there is no '
      + 'default to fall back to.');
  }
  log(`injecting ${FILES.length} files into ${containerId}...`);
  for (const [srcRel, destRel] of FILES) {
    await copyIntoContainer(containerId, path.join(ARTIFACTS_DIR, srcRel), destRel);
  }
  await patchGpuConfigSh(containerId);
  await patchSurfaceflingerRc(containerId);
}

const GPU_CONFIG_SH_PATH = '/vendor/bin/gpu_config.sh';

// A real, load-bearing gap found deploying this against the stock image (31/10/2026): the
// image's own /vendor/bin/gpu_config.sh picks the gralloc/Vulkan HAL from the host's real DRM
// driver name (read from /sys/kernel/debug/dri/<N>/name) -- but its setup_vulkan() case
// statement has no branch for "nvidia-drm" at all (only i915/amdgpu/virtio_gpu/v3d/vc4/
// msm_drm/panfrost), and gpu_setup_host() unconditionally sets ro.hardware.gralloc=gbm
// (Mesa's native GBM gralloc -- confirmed, on real hardware, that THIS is what was actually
// loaded, not the minigbm/cros_gralloc backend installFiles() above patches; `gralloc.gbm.so`
// fails outright against NVIDIA's proprietary stack with "failed to create gbm device", the
// exact Tier-0 finding redroid-nvidia's own README already documents as the reason this whole
// module exists). Patches both: a new "nvidia-drm" case in setup_vulkan() (ro.hardware.vulkan
// = virtio, same ICD name virtio_gpu already uses -- Venus-over-vtest is the same wire protocol
// regardless of what is behind the host daemon) and gpu_setup_host()'s own gralloc line, made
// conditional so it does not clobber what the nvidia-drm case just set (setup_render_node, and
// therefore setup_vulkan, always runs BEFORE gpu_setup_host in this script's own gpu_setup()).
async function patchGpuConfigSh(containerId) {
  const tmpPath = path.join(os.tmpdir(), `venus3d-${containerId.slice(0, 12)}-gpu_config.sh`);
  await execFileAsync('docker', ['cp', `${containerId}:${GPU_CONFIG_SH_PATH}`, tmpPath]);
  const original = fs.readFileSync(tmpPath, 'utf-8');
  // Also forces SurfaceFlinger's RenderEngine to the Vulkan backend (debug.renderengine.backend,
  // see frameworks/native/services/surfaceflinger/SurfaceFlinger.cpp) -- its own default
  // auto-detect still picked the GL backend in this tree (confirmed: SkiaGLRenderEngine, not
  // SkiaVkRenderEngine, was what actually crashed trying classic DRI2/GBM against /dev/dri/card0,
  // completely bypassing the Venus/vtest Vulkan ICD this module installs). This is the real,
  // final piece that makes the guest's Vulkan path the one actually exercised at all.
  let patched = original.replace(
    /(\n\s*panfrost\)\n\s*setprop ro\.hardware\.vulkan panfrost\n\s*;;\n)/,
    '$1        nvidia-drm)\n            setprop ro.hardware.vulkan virtio\n            setprop ro.hardware.gralloc cros\n            setprop debug.renderengine.backend skiavkthreaded\n            ;;\n',
  );
  patched = patched.replace(
    /(gpu_setup_host\(\) \{\n\s*echo "use GPU host mode"\n\n\s*setprop ro\.hardware\.egl mesa\n)\s*setprop ro\.hardware\.gralloc gbm\n/,
    '$1    [ "$(getprop ro.hardware.gralloc)" = "cros" ] || setprop ro.hardware.gralloc gbm\n',
  );
  if (patched === original) {
    throw new Error(`${tmpPath} (copied from ${GPU_CONFIG_SH_PATH}) did not match the expected shape -- was the image's own script changed?`);
  }
  fs.writeFileSync(tmpPath, patched);
  await execFileAsync('chown', ['root:root', tmpPath]);
  await execFileAsync('chmod', ['0755', tmpPath]);
  await execFileAsync('docker', ['cp', tmpPath, `${containerId}:${GPU_CONFIG_SH_PATH}`]);
  fs.unlinkSync(tmpPath);
}

// Stage 3: this module's own daemon socket bind, plus the boot flag the deployed, validated
// image (redroid-nvenc-snapshot, 2026-09) booted with -- see the module README for why it is
// carried over as-is rather than re-derived (it was already confirmed working end to end on
// real hardware with exactly this flag present).
function prepareCreate() {
  return {
    binds: [venus3dAccel.daemonBind()],
    cmd: ['androidboot.redroid_gpu_node=/dev/dri/renderD128'],
  };
}

async function ensureHostInfraReady() {
  await venus3dAccel.ensureHostInfraReady();
}

const SURFACEFLINGER_RC_PATH = '/system/etc/init/surfaceflinger.rc';

// Real gap found on real hardware: the venus3d.rc `export` approach (global init-level export,
// meant to be inherited by every later-started process) never actually reached surfaceflinger --
// confirmed via /proc/1/environ after boot, VTEST_SOCKET_NAME was simply absent, and no other
// .rc file in this stock image uses `export` at all to compare against (no working precedent to
// check the trigger-timing assumption against). `setenv NAME value` inside the specific
// `service surfaceflinger` block (system/etc/init/surfaceflinger.rc) is the well-documented,
// narrowly-scoped mechanism instead -- applies only to that one service's own forked process,
// confirmed landing (this file is not under /vendor, but still writable the same way at stage 4).
async function patchSurfaceflingerRc(containerId) {
  const tmpPath = path.join(os.tmpdir(), `venus3d-${containerId.slice(0, 12)}-surfaceflinger.rc`);
  await execFileAsync('docker', ['cp', `${containerId}:${SURFACEFLINGER_RC_PATH}`, tmpPath]);
  const original = fs.readFileSync(tmpPath, 'utf-8');
  const patched = original.replace(
    /(\n\s*task_profiles HighPerformance\n)/,
    '$1    setenv VTEST_SOCKET_NAME /vendor/venus.sock\n',
  );
  if (patched === original) {
    throw new Error(`${tmpPath} (copied from ${SURFACEFLINGER_RC_PATH}) did not match the expected shape -- was the image's own script changed?`);
  }
  fs.writeFileSync(tmpPath, patched);
  await execFileAsync('chown', ['root:root', tmpPath]);
  await execFileAsync('chmod', ['0644', tmpPath]);
  await execFileAsync('docker', ['cp', tmpPath, `${containerId}:${SURFACEFLINGER_RC_PATH}`]);
  fs.unlinkSync(tmpPath);
}

module.exports = {
  ARTIFACTS_DIR, FILES, installFiles, prepareCreate, ensureHostInfraReady,
};

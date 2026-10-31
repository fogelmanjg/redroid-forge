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

module.exports = {
  ARTIFACTS_DIR, FILES, installFiles, prepareCreate, ensureHostInfraReady,
};

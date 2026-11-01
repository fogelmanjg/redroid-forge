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
  // Sixth real gap, found replacing gralloc.cros.so itself (see installGrallocCros() below):
  // the new gralloc.minigbm.so build links libdmabufheap.so (minigbm_cros_gralloc_defaults'
  // own shared_libs, not something the stock monolithic gralloc.cros.so ever needed) -- and
  // even though a /vendor/lib64/libdmabufheap.so exists in the stock image at the pre-boot
  // container filesystem level, the booted guest's own adb-visible /vendor cannot stat() it at
  // all (confirmed: ENOENT after boot, despite docker cp seeing it fine before boot) -- same
  // "ship our own copy" fix already proven for libdrm.so above, not re-diagnosed further here.
  ['lib64/libdmabufheap.so', 'lib64/libdmabufheap.so'],
  ['lib/libdmabufheap.so', 'lib/libdmabufheap.so'],
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
  await installGrallocCros(containerId);
  await patchGpuConfigSh(containerId);
  await patchSurfaceflingerRc(containerId);
  await patchLegacyGrallocRc(containerId);
  await installVtestSocketProp(containerId);
}

// Real gap found after the first four (same pass, later): installFiles() above drops
// libminigbm_gralloc.so (the one that DOES contain backend_nvidia_venus, confirmed via
// `strings`) at /vendor/lib64/libminigbm_gralloc.so, but nothing in the stock image ever
// dlopen()s a file by that name -- the image's actual /vendor/lib*/hw/gralloc.cros.so is a
// monolithic, statically-linked minigbm build (no NEEDED entry for libminigbm_gralloc.so,
// confirmed via `readelf -d`) whose own backend list has no nvidia entry at all. There is no
// code path in the stock image that can ever reach nvidia_venus.c through gralloc -- the HAL
// shim itself has to BE the one that links against libminigbm_gralloc.so.
//
// The fix does not need a new Soong module: `external/minigbm/Android.bp` already builds
// exactly this shim -- `gralloc.minigbm` (`cc_library_shared`, `minigbm_cros_gralloc0_defaults`,
// i.e. `cros_gralloc/gralloc0/gralloc0.cc`, the real HAL_MODULE_INFO_SYM entry point) with
// `shared_libs: ["libminigbm_gralloc"]` -- the same artifact already deployed above. Built via
// `m gralloc.minigbm` in the same AOSP tree (confirmed: `readelf --dyn-syms` shows the `HMI`
// symbol, `readelf -d` shows `NEEDED libminigbm_gralloc.so`, resolved at runtime from the exact
// path installFiles() already ships it at). So this module REPLACES the stock
// /vendor/lib(64)/hw/gralloc.cros.so with that build -- not adds a new file.
//
// Keeps a copy of the original first (`gralloc.cros.so.orig`, alongside it in the same `hw/`
// dir) rather than discarding it -- not for an automatic restore-on-disable (no module in this
// project reverts its own /vendor changes today, moduleRunner.js has no such hook; adding one
// here alone would be inconsistent with hwenc/hwdec/nvenc's own behavior) but so a host can
// manually recover the stock file if this module ever needs to be backed out of an existing
// instance by hand. Only replaces at stage 4 (container created, not started) -- `/vendor`
// is already read-only by the time anything could `docker exec` into it.
const GRALLOC_CROS_PATHS = [
  ['lib64/hw/gralloc.cros.so', 'lib64/hw/gralloc.minigbm.so'],
  ['lib/hw/gralloc.cros.so', 'lib/hw/gralloc.minigbm.so'],
];

async function installGrallocCros(containerId) {
  for (const [crosRel] of GRALLOC_CROS_PATHS) {
    const backupTmp = path.join(os.tmpdir(), `venus3d-${containerId.slice(0, 12)}-${path.basename(crosRel)}.orig`);
    await execFileAsync('docker', ['cp', `${containerId}:/vendor/${crosRel}`, backupTmp]);
    await execFileAsync('docker', ['cp', backupTmp, `${containerId}:/vendor/${crosRel}.orig`]);
    fs.unlinkSync(backupTmp);
  }
  for (const [crosRel, patchedRel] of GRALLOC_CROS_PATHS) {
    await copyIntoContainer(containerId, path.join(ARTIFACTS_DIR, patchedRel), crosRel);
  }
}

const VTEST_PROP_RC_SOURCE = path.join(__dirname, '..', 'modules', 'venus3d', 'venus3d-vtest-prop.rc');

// A fourth real gap, and the actual root cause of what two earlier passes misdiagnosed as "the
// legacy HIDL 2.0 Allocator service is dead/superseded code" (it is NOT -- it is the ONLY
// IAllocator implementation this stock image ships at all; no AIDL allocator SERVICE binary
// exists anywhere in it, confirmed via `find /vendor /system -iname '*allocator*'` -- only the
// AIDL *client* stub library, `android.hardware.graphics.allocator-V2-ndk.so`, with nothing to
// talk to). Deleting it (an earlier attempt in this same pass) only traded one failure mode for
// a worse one: SurfaceFlinger's own `GraphicBufferAllocator` -- used for real display/BufferQueue
// buffers, a completely different consumer than the Venus/Vulkan `RenderEngine` path validated
// separately -- then aborts outright: `Abort message: 'Failed to load matching allocator for
// mapper version 2'`, confirmed via a real tombstone backtrace
// (`GraphicBufferAllocator::GraphicBufferAllocator()` <- `GraphicBuffer::initWithSize()` <-
// `SurfaceFlinger::processDisplayAdded()`). So the service has to actually WORK, not disappear.
//
// Why it was crashing (`AllocatorHal: failed to open gralloc0 device: No such device`, i.e.
// ENODEV): traced into `nvidia_venus_bo_create()` in minigbm's own patched backend
// (`external/minigbm/nvidia_venus.c` in this project's AOSP tree) -- it returns `-ENODEV`
// verbatim ("no vtest connection") when `nvidia_venus_connect()` fails to reach the host Venus
// daemon. That function does NOT read the `VTEST_SOCKET_NAME` environment variable Mesa's own
// `vn_renderer_create_vtest()` uses (the one `patchSurfaceflingerRc()` above sets, confirmed
// working for the separate Vulkan/RenderEngine path) -- it reads the **system property**
// `mesa.vtest.socket.name` via `__system_property_get()`, falling back to a hardcoded
// `/dev/venus/venus.sock` if unset (neither path this module actually uses,
// `venus3dAccel.js`'s own `GUEST_SOCKET_PATH` is `/vendor/venus.sock`) -- a different
// author/convention within the same `redroid-nvidia` source tree, confirmed by reading the
// function itself rather than assumed. No `setenv`/`export` in any `.rc` could ever have fixed
// this: it was never an environment-variable problem for this specific consumer. The real fix is
// a plain `setprop`, which -- unlike the `export` propagation-timing gap `venus3dAccel.js`'s own
// comment already documents -- reaches every process equally since it is a global property, not
// inherited environment: `installVtestSocketProp()` below adds a standalone trigger `.rc`
// (`on early-init`, same convention as `redroid-gralloc-fix`'s own `redroid-no-rgb10.rc`) that
// sets `mesa.vtest.socket.name` to the module's real socket path before anything can race it.
// It also sets `mesa.vn.debug` to `vtest` for the exact same reason -- see the .rc file's own
// comment (the EIGHTH real gap): zygote-forked app processes (SystemUI, launcher3, any app
// drawing through HWUI/ANGLE) never see `patchSurfaceflingerRc()`'s `setenv`, since that only
// reaches the one service it is scoped to, but they all read this same property fallback.
async function installVtestSocketProp(containerId) {
  await copyIntoContainer(containerId, VTEST_PROP_RC_SOURCE, 'etc/init/venus3d-vtest-prop.rc');
}

const LEGACY_GRALLOC_RC_PATH = '/vendor/etc/init/android.hardware.graphics.allocator@2.0-service.rc';

// A third real gap, found after the first two: the stock image's legacy HIDL 2.0 Allocator
// service (vendor.gralloc-2-0) is the ONLY IAllocator implementation this image ships (see
// installVtestSocketProp()'s own comment above for why it is required, not superseded) -- but
// it is lazy-HAL started by `hwservicemanager` on demand, and the actual client asking for it is
// **SurfaceFlinger itself** (confirmed via `logcat`: pid 167, the very first surfaceflinger
// instance, is the one spamming "Waited one second for
// android.hardware.graphics.allocator@2.0::IAllocator/default" / "trying to start it as a lazy
// HAL"). It shares the SAME cros_gralloc_driver.cc code this module patches -- so it also needs
// VTEST_SOCKET_NAME/VN_DEBUG, which its own service block never had (only surfaceflinger's did;
// harmless to also set here even though this specific consumer turned out to need the
// `mesa.vtest.socket.name` property instead, per installVtestSocketProp() -- other code paths
// inside the same .so may still consult the env vars). `disabled` additionally stops init's own
// automatic class-start from retriggering it every few seconds; it does NOT stop the lazy-HAL
// `ctl.interface_start` path (confirmed in logcat), which is what actually restarts it on demand
// -- kept anyway since it is harmless and avoids one redundant class-triggered start attempt.
async function patchLegacyGrallocRc(containerId) {
  const tmpPath = path.join(os.tmpdir(), `venus3d-${containerId.slice(0, 12)}-allocator2.0.rc`);
  await execFileAsync('docker', ['cp', `${containerId}:${LEGACY_GRALLOC_RC_PATH}`, tmpPath]);
  const original = fs.readFileSync(tmpPath, 'utf-8');
  let patched = original.replace(/\n\s*onrestart restart surfaceflinger\n/, '\n');
  patched = patched.replace(
    /(\n\s*capabilities SYS_NICE\n)/,
    '$1    setenv VTEST_SOCKET_NAME /vendor/venus.sock\n    setenv VN_DEBUG vtest\n    disabled\n',
  );
  if (patched === original) {
    throw new Error(`${tmpPath} (copied from ${LEGACY_GRALLOC_RC_PATH}) did not match the expected shape -- was the image's own script changed?`);
  }
  fs.writeFileSync(tmpPath, patched);
  await execFileAsync('chown', ['root:root', tmpPath]);
  await execFileAsync('chmod', ['0644', tmpPath]);
  await execFileAsync('docker', ['cp', tmpPath, `${containerId}:${LEGACY_GRALLOC_RC_PATH}`]);
  fs.unlinkSync(tmpPath);
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
    '$1        nvidia-drm)\n            setprop ro.hardware.vulkan virtio\n            setprop ro.hardware.gralloc cros\n            setprop ro.hardware.egl angle\n            setprop debug.renderengine.backend skiavkthreaded\n            ;;\n',
  );
  // A SEVENTH real gap, found after booting all the way through with scrcpy: gpu_setup_host()
  // unconditionally overwrites ro.hardware.egl back to "mesa" right after the nvidia-drm case
  // above already set it to "angle" (setup_vulkan/setup_render_node runs first, same ordering
  // the gralloc line below was already made conditional for -- the egl line sat right next to
  // it, untouched, and nothing exercised it until an app (SystemUI, scrcpy's own virtual
  // display) actually tried to draw through HWUI's EGL path rather than SurfaceFlinger's own
  // direct Vulkan RenderEngine: `EglManager::initialize()` aborts with `EGL_NOT_INITIALIZED`
  // because Android's EGL loader was still looking for libEGL_mesa.so, which fails against
  // NVIDIA the same way gralloc.gbm.so already did, not the libEGL_angle.so this module
  // actually ships at /vendor/lib64/egl/). Made conditional the same way.
  patched = patched.replace(
    /(gpu_setup_host\(\) \{\n\s*echo "use GPU host mode"\n\n)\s*setprop ro\.hardware\.egl mesa\n\s*setprop ro\.hardware\.gralloc gbm\n/,
    '$1    [ "$(getprop ro.hardware.egl)" = "angle" ] || setprop ro.hardware.egl mesa\n'
      + '    [ "$(getprop ro.hardware.gralloc)" = "cros" ] || setprop ro.hardware.gralloc gbm\n',
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
//
// A SECOND, deeper real gap found after that: setting VTEST_SOCKET_NAME alone was still not
// enough -- vn_renderer_create() (src/virtio/vulkan/vn_renderer.h) only even ATTEMPTS the vtest
// transport `if (VN_DEBUG(VTEST))`; without that debug flag it goes straight to
// vn_renderer_create_virtgpu() (the real kernel virtio-gpu device path), which fails outright on
// a host with no such kernel device at all -- producing the exact generic
// VK_ERROR_INITIALIZATION_FAILED (err=-3) this port kept hitting, with ZERO activity on the host
// daemon's own socket (confirmed: the vtest connect code was never reached). VN_DEBUG=vtest
// (src/virtio/vulkan/vn_common.c's debug-string parser) is the real switch.
async function patchSurfaceflingerRc(containerId) {
  const tmpPath = path.join(os.tmpdir(), `venus3d-${containerId.slice(0, 12)}-surfaceflinger.rc`);
  await execFileAsync('docker', ['cp', `${containerId}:${SURFACEFLINGER_RC_PATH}`, tmpPath]);
  const original = fs.readFileSync(tmpPath, 'utf-8');
  const patched = original.replace(
    /(\n\s*task_profiles HighPerformance\n)/,
    '$1    setenv VTEST_SOCKET_NAME /vendor/venus.sock\n    setenv VN_DEBUG vtest\n',
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

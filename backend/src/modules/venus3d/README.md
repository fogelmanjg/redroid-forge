# Module: venus3d

Real GPU-accelerated 3D rendering on NVIDIA hosts, ported from
[`redroid-nvidia`](https://github.com/fogelmanjg/redroid-nvidia)'s Tier 4/5 — the `gpuMode=host`
foundation `hwenc` already had for free on AMD/Intel (Mesa's native GBM path), which never boots
at all on NVIDIA (no driver-table entry for NVIDIA's proprietary stack). This module routes the
guest's Vulkan (Mesa Venus) over a unix socket to a host-side `virgl_test_server` process
instead — see `backend/native/venus3d-daemon/README.md` for that half.

## What's deployed, and where it actually came from (31/10/2026 port)

`redroid-nvidia`'s own source patches are already sitting, applied but never rebuilt, inside
this project's AOSP tree (`~/aosp-redroid-15`) — `external/minigbm/nvidia_venus.c` and its
`Android.bp`/`cros_gralloc_driver.cc` changes, `external/mesa3d`'s four modified files. Getting
working binaries out of them needed two different build paths, not one:

- **`libminigbm_gralloc.so` (lib64 + lib)** — builds cleanly through this tree's own Soong graph
  (`m gralloc.minigbm`, **not** `m gralloc.cros`: the latter is a pure prebuilt-copy rule in
  `device/redroid-prebuilts/Android.mk`, unrelated to `external/minigbm`'s own source entirely —
  a real trap, confirmed by rebuilding it and finding zero `nvidia` strings in the output
  despite a "successful" build). `strings` on the result confirms `backend_nvidia_venus`/
  `nvidia-drm`/`nvidia_venus` are actually linked in. The stock image's existing
  `gralloc.cros.so` HAL shim already `dlopen()`s a library named exactly
  `libminigbm_gralloc.so` — this module overwrites only that file, not the HAL shim itself, so
  no `ro.hardware.gralloc` property change is needed.
- **`vulkan.virtio.so` (lib64 + lib)** — has **no Soong module in this tree at all** (confirmed:
  no `"vulkan.virtio"` string anywhere in any `Android.bp`/`Android.mk`); `redroid-nvidia`'s own
  `patches/mesa/README.md` already says why and already gives the fix — a standalone meson+NDK
  cross-build (`build/mesa/build.sh` in that repo), run directly against this same patched AOSP
  Mesa checkout. Built both ABIs this way, stripped with the NDK's own `llvm-strip`, and
  confirmed the `REDROID-DIAG` diagnostic string the Mesa patch itself adds is present in the
  result (it is **not** present in this tree's own `out/` copy, nor in the one baked into the
  `redroid-nvenc-snapshot:latest` image from the original 2026-09 validation session — both are
  the stock, unpatched prebuilt; whatever guest Vulkan ICD that session's 3D boot actually used,
  it was not either of those files on disk, most likely a loose, undocumented bind-mount that
  did not survive as a committed artifact anywhere. This port's own build is the first one
  confirmed, by direct inspection, to actually contain the sync_file/dma-buf-import patch).
- **`libEGL_angle.so`/`libGLESv2_angle.so` (lib64 + lib)** — stock, unpatched ANGLE, vendored
  straight from this same AOSP tree's own `/system` output into `/vendor/lib(64)/egl/` (the
  guest's vendor partition needs its own copy; redroid-nvidia's own validated image had these at
  the same vendor path, confirmed via a file-listing diff against the plain official image).

None of the four are built by this repo's own `android/build.sh`-style pipeline (unlike
`hwenc`/`nvenc`'s AOSP-tree Codec2 services) — see `backend/src/lib/venus3dService.js`'s own
top comment. `REDROID_VENUS3D_ARTIFACTS_DIR` just needs a flat `lib/`/`lib64/` folder with these
8 files in it (see `venus3dService.js`'s `FILES` for the exact names and destinations).

## Why `gpuMode: ["host"]` (the opposite of `nvenc`'s `["guest"]`)

This is the whole point of the module: it is what actually turns on the guest's real Venus
Vulkan driver instead of redroid's own software gralloc. See `nvenc`'s own manifest/README for
why *that* module needs the opposite value — the two target genuinely different rendering
backends on the same vendor.

## Decision: venus3d and nvenc stay mutually exclusive by gpuMode for now, NOT wired to run together yet

`redroid-nvidia`'s own Tier 7 work (its `patches/codec2/README.md`, 2026-09-26 "part 3"/"part 4"
updates) already discovered that a real `scrcpy`/screen-capture buffer is **never** a
Venus-owned resource even with the 3D pipeline fully active — `VCMD_ENCODE_RESOURCE` cannot
reach it either way, Venus or no Venus; it always needed the separate SCM_RIGHTS dma-buf
transport (exactly what this project's own `nvenc` module already ships). So in principle,
turning venus3d on should not need `nvenc`'s own transport to change *which* mechanism it uses
— only *what kind of buffer* arrives through it changes: with `gpuMode=guest` (today's only
supported case) the capture buffer is a plain `memfd` (redroid's own software gralloc); with
`gpuMode=host` + this module active, the same capture path would instead hand over a **real
GEM-backed dma-buf** from `minigbm`'s own `nvidia_venus.c` backend.

`backend/native/nvenc-daemon/vtest_gpu_encode.c`'s `vtest_gpu_encode_dmabuf()` **only** has the
`mmap()`-the-memfd-directly path today (added un-conditionally when the `nvenc` module was first
validated against `gpuMode=guest`, see that file's own 31/10/2026 comment) — the original,
real `VK_EXTERNAL_MEMORY_HANDLE_TYPE_DMA_BUF_BIT_EXT` import path for a genuine dma-buf was
*replaced*, not kept as a fallback, once it was confirmed to fail specifically on a `memfd`.
Calling `mmap(PROT_READ, MAP_SHARED, fd, 0)` on a real NVIDIA GEM dma-buf fd instead of a memfd
is not confirmed to work (device memory is not generally CPU-mappable this way) and was not
tried here — making `nvenc` actually work *together* with `venus3d` needs that function to
branch on the buffer's real type (`readlink("/proc/self/fd/N")` not starting with `/memfd:` is
the same signal the existing code's own comment already used to diagnose this split in the
first place) and take the dma-buf-import path for one case, the already-working mmap path for
the other. That C-level change, and the real-hardware retest it would need, is this port's own
explicit next step — not attempted in this pass, to avoid shipping an unvalidated change to the
`nvenc` daemon's own already-working path under time pressure. Until then: **`nvenc` stays on
`gpuMode: ["guest"]` unchanged, `venus3d` is `gpuMode: ["host"]`, and enabling one on an instance
means the other cannot also be enabled there** (`manifests.incompatibilityReason` rejects
whichever one does not match the instance's actual `gpuMode`, same mechanism that already keeps
`hwenc` and `nvenc` apart by `hostGpuVendor`).

## Validation (jgustavo47, GTX 1050 Ti, 31/10/2026)

**The core goal is confirmed working; full boot is not, yet.** Five real, load-bearing
integration gaps were found and fixed against the live stock image, each one a genuine blocker
(not a config nicety) — in the order hit:

1. `/vendor/bin/gpu_config.sh` has no `nvidia-drm` case in `setup_vulkan()` and unconditionally
   forces `ro.hardware.gralloc=gbm` (Mesa's native GBM, which fails outright against NVIDIA) —
   patched to set `gralloc=cros`/`vulkan=virtio` for that driver name instead.
2. SurfaceFlinger's RenderEngine auto-detect picked the GL backend, not Vulkan — needs
   `debug.renderengine.backend=skiavkthreaded` forced explicitly.
3. The standalone meson+NDK build of `vulkan.virtio.so` (no Soong module exists for it) links a
   `libdrm.so` meson built itself via `-Dforce_fallback_for`, not shipped anywhere in the stock
   image — ships the AOSP-tree-built one `nvenc` already proved works instead.
4. A single-file bind mount under `/dev` or `/tmp` does not survive — Android's own init
   remounts both as fresh tmpfs during boot. The socket lives under `/vendor` instead (not
   remounted), and **two** env vars have to reach the guest's Vulkan ICD for it to even try the
   vtest transport at all: `VTEST_SOCKET_NAME` (the socket path) and, the real root cause of a
   generic `vkCreateInstance` `err=-3` that produced zero traffic on the host daemon's own
   socket, `VN_DEBUG=vtest` (`vn_renderer_create()` only attempts vtest at all when this debug
   flag is set — without it, it goes straight to the real kernel virtio-gpu device path, which
   doesn't exist here, and fails immediately). Both are `setenv`'d directly on surfaceflinger's
   own service block (a global init-level `export` was tried first and confirmed, via
   `/proc/1/environ` after boot, to never actually reach it).

With all four of those in place, **the actual target is confirmed real and working**: the host
daemon's own log shows a genuine vtest client context being created, and SurfaceFlinger logs
`RenderEngine: Vulkan device supports sufficient external semaphore sync fd features` followed by
`GaneshVkRenderEngine::create: successfully initialized GaneshVkRenderEngine` — real Venus-backed
Vulkan, not software, is what SurfaceFlinger's RenderEngine is running on. This is the module's
whole point, and it is real, not simulated or assumed.

5. **Still unresolved, and still blocking `sys.boot_completed`**: the stock image's legacy HIDL
   2.0 Allocator HAL (`vendor.gralloc-2-0`, superseded by the AIDL/Gralloc4 path `gralloc.cros.so`
   already provides — confirmed it is NOT what RenderEngine actually uses, per point 4 above)
   crash-loops persistently (`exited with status 1`, dozens of times per boot; logd never
   captures any stderr from it, it dies too fast to flush one). Giving it the same
   `VTEST_SOCKET_NAME`/`VN_DEBUG` env vars did not stop the crash. Marking it `disabled` (which
   should stop init's own automatic class-start) reduced but did **not** eliminate the restart
   frequency — something still explicitly `start`s it by name repeatedly, bypassing `disabled`
   (which only blocks the class-triggered path). Each crash trips init's own generic
   "updatable components crashed 4 times" safety policy, which kills `surfaceflinger` and
   `zygote` by name regardless of which specific instance currently holds those service slots —
   this is what actually prevents `sys.boot_completed` from ever being set, even though the one,
   stable, real `surfaceflinger` process (confirmed via the Vulkan/Venus init success above) is
   never itself the thing that fails.

## Pending

- **The `vendor.gralloc-2-0` crash loop above — the single concrete next step.** Next
  diagnostics to try: capture its stderr directly (`strace -f` wrapping its binary, since logd
  does not capture it) rather than guessing from `setenv`/`disabled` alone; check whether some
  other HIDL/AIDL client in this image hardcodes a `start vendor.gralloc-2-0` call outside the
  normal class-start/lazy-HAL paths (both already ruled out); consider whether removing the
  service's binary/`.rc` file entirely (vs. `disabled`) is cleaner than fighting whatever keeps
  restarting it.
- The `nvenc` + `venus3d` simultaneous case above (needs a `vtest_gpu_encode_dmabuf()` dma-buf
  branch, untested on real hardware yet).
- `REDROID_VENUS3D_ARTIFACTS_DIR` points at a local build folder today, same "download a
  release once one exists" TODO `hwenc`/`nvenc` already carry.
- The host daemon binaries (`backend/native/venus3d-daemon/`) are reused, unmodified, from
  `redroid-nvidia`'s own 2026-09 validation session rather than rebuilt in this pass — rebuilding
  them from the patch sources in that project's own `patches/virglrenderer/` is documented there
  if they ever need to change.

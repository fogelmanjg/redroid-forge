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

**Confirmed fully working, end to end, not just the Vulkan/RenderEngine piece: real
`sys.boot_completed=1`, no crash loops, and a genuine scrcpy recording of the home screen (22
decodable H.264 frames at 720×1280, visually confirmed — status bar, Google search widget, dock
icons, nav bar all correctly rendered).** Eight real, load-bearing integration gaps were found
and fixed against the live stock image, each one a genuine blocker (not a config nicety) — in the
order hit:

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

5. **Still unresolved, and still blocking `sys.boot_completed` — root cause now actually found
   (second pass, 31/10/2026 later the same day), overturning point 5's own original framing
   above.** The legacy HIDL 2.0 Allocator (`vendor.gralloc-2-0`) is **not** superseded by anything
   in this image — `find /vendor /system -iname '*allocator*'` confirms there is no AIDL
   allocator *service* binary at all, only the AIDL client stub library. It is the only
   `IAllocator` this image has, and `SurfaceFlinger::GraphicBufferAllocator` (display/BufferQueue
   buffers — a different consumer than `RenderEngine`'s own direct Vulkan path, which bypasses
   gralloc entirely) genuinely needs it. Removing the service (tried this pass) only trades the
   crash loop for a clean `SIGABRT` in `surfaceflinger` itself (`Failed to load matching allocator
   for mapper version 2`) — worse, not better.
   
   The crash itself (`AllocatorHal: failed to open gralloc0 device: No such device`) traces to
   **two separate, real bugs**, both confirmed by reading code and by `strace`/`readelf` against
   the actual files on disk, not assumed:
   
   - `nvidia_venus_connect()` (`external/minigbm/nvidia_venus.c`) reads the socket path from the
     **system property** `mesa.vtest.socket.name` (`__system_property_get`), not the
     `VTEST_SOCKET_NAME` **environment variable** `patchSurfaceflingerRc()` sets (that env var is
     Mesa's own `vn_renderer_create_vtest()` convention — a different author/mechanism within the
     same `redroid-nvidia` source tree). No amount of `setenv` in any `.rc` could ever have
     reached this specific consumer. **Fixed this pass**: `installVtestSocketProp()` adds a
     standalone `on early-init` trigger `.rc` (`venus3d-vtest-prop.rc`) that `setprop`s it to
     `/vendor/venus.sock`, confirmed present system-wide after boot via `getprop`.
   - **Bigger, still unresolved**: fixing the property above did **not** stop the crash, because
     `nvidia_venus_connect()` is never actually reached. `strace -f` on the real service binary
     shows it opens `/dev/dri/renderD128` fine (confirmed separately with a standalone C program
     linked against the host's own `libdrm.so.2`: `drmGetVersion()` on that exact node genuinely
     reports driver name `"nvidia-drm"`, matching `backend_nvidia_venus`'s `.name` field) — but
     `drv_create()` still returns `NULL` ("Failed to initialize driver.", `cros_gralloc_driver.cc`'s
     own log line) and falls through to probing every `/dev/dri/card*` node in vain. The reason:
     **the stock `/vendor/lib64/hw/gralloc.cros.so` actually on this image is not the file this
     module's artifacts are meant to patch at all.** `readelf -d`/`strings` on the real file
     confirms it is a monolithic, statically-linked, *unpatched* minigbm build whose own
     `drv_backend_list[]` only contains `backend_virtgpu`/`backend_i915`/`backend_amdgpu`/
     `backend_radeon` — no `nvidia`/`nvidia-drm`/`nvidia_venus` string anywhere in it, and (the
     README's own prior premise, now disproven by direct inspection) **it never `dlopen()`s a
     separate `libminigbm_gralloc.so` at runtime at all** — a full `strace -f` of its startup
     shows zero attempts to open any file by that name. The `libminigbm_gralloc.so` this module
     *does* deploy (built via `m gralloc.minigbm`) is real and does contain
     `backend_nvidia_venus`/`nvidia-drm` (confirmed via `strings`) — but it is architecturally the
     **wrong kind of artifact** for either consumer in this image: `readelf --dyn-syms` shows it
     exports the modern `cros_gralloc_driver` C++ class API (`get_instance`, `allocate`, `lock`,
     `retain`, …) meant to be linked directly into a modern AIDL IAllocator/IMapper4 *service*
     binary's own code — it has **no `HAL_MODULE_INFO_SYM`** (the `HMI` symbol `hw_get_module()`
     requires), so it could never be loaded as a drop-in `gralloc.<name>.so` replacement even if
     renamed and pointed at directly via `ro.hardware.gralloc`. Put simply: **no code path in this
     stock image can ever reach `nvidia_venus.c` through gralloc, full stop** — independent of any
     `.rc`/env-var/property fix, which is why three separate patch attempts across two passes
     (`disabled`, env vars, now the correct property) all failed to produce a working allocator.
     This is also why, even after this pass's one genuinely new, confirmed-correct property fix,
     `vendor.gralloc-2-0` keeps crash-looping (395 times, unstopped, over one ~4-minute boot
     window) and `system_server` itself keeps restarting too — a cascading symptom of the same
     root cause, not a new, separate bug.

**Point 5 above is now resolved (same day, later pass).** The two options it proposed turned out
to collapse into one: option (a) ("a new Soong module that statically links the patched minigbm
sources behind a legacy HAL_MODULE_INFO_SYM shim") did not need to be written at all — it already
existed. `external/minigbm/Android.bp`'s own `gralloc.minigbm` module (`cc_library_shared`,
`minigbm_cros_gralloc0_defaults`, compiling `cros_gralloc/gralloc0/gralloc0.cc`) exports the
`HMI`/`HAL_MODULE_INFO_SYM` symbol directly and already depends on `libminigbm_gralloc` (via
`shared_libs`), the same library that statically includes `nvidia_venus.c` — confirmed via
`readelf --dyn-syms` (has `HMI`) and `strings` (`backend_nvidia_venus`/`nvidia-drm` present).
Building it (`m gralloc.minigbm`, an incremental build inside the already-configured AOSP tree —
one pre-existing leftover had to be cleared first: a stray, untracked meson-subproject checkout
at `external/mesa3d/subprojects/libdrm-2.4.134/`, left over from the standalone `vulkan.virtio.so`
build above, whose duplicate `Android.bp` module names broke Soong bootstrap with "module X
already defined" until moved entirely out of the AOSP tree) produces the exact legacy-ABI,
NVIDIA-backend-containing drop-in replacement this gap needed — no new module, no shim.

`installGrallocCros()` (`venus3dService.js`) now overwrites the instance's real
`/vendor/lib(64)/hw/gralloc.cros.so` with this build's output, at the same pre-first-boot stage
`installFiles()` already uses for every other file. The original is backed up first, to
`gralloc.cros.so.orig` next to it, for manual recovery — not auto-restored on module disable,
since (confirmed by reading `moduleRunner.js`) no module, `hwenc`/`nvenc` included, has any
disable/revert mechanism today; this follows that existing norm rather than inventing a new one.
Consistent with the project's standing rule: the base Docker image is never touched, only each
instance's own already-created container, with the same contract-based consent `hwenc`/`hwdec`/
`nvenc` already rely on.

6. **Replacing `gralloc.cros.so` alone regressed further**, surfacing a sixth real gap:
   `minigbm_cros_gralloc_defaults`'s own `shared_libs` links `libdmabufheap.so`, which the
   original monolithic `gralloc.cros.so` never needed. `vndksupport` failed to `dlopen` the new
   file from the `sphal` linker namespace with `library "libdmabufheap.so" not found`, and
   SurfaceFlinger itself SIGABRTed outright (`Could not initialize Vulkan RenderEngine!`). The
   file is visible via `docker cp` against the container's pre-boot filesystem but genuinely
   unreachable from inside the booted guest's own `/vendor` view (`adb shell stat`/`ls` both
   report it missing; root cause not further chased). **Fixed** the same way this module's
   `libdrm.so` entries already were: ship the module's own copy via the existing `FILES`/
   `installFiles()` injection mechanism rather than relying on whatever the stock image nominally
   has.
7. **With gap 6 fixed, `sys.boot_completed=1` was reached for the first time ever for this
   module** — confirmed via `dumpsys SurfaceFlinger` (`"------------RE Vulkan (Ganesh)----------"`,
   `"Vulkan device initialized: 1"`) and the venus3d daemon's own log showing
   `vtest_gpu_alloc: allocating on "NVIDIA GeForce GTX 1050 Ti"` — but `scrcpy` recordings still
   came back 0 bytes. Logcat showed `com.android.systemui`'s `RenderThread` crash-looping every
   ~1.2s with `Abort message: 'Failed to create context, error = EGL_NOT_INITIALIZED'`, through
   `libhwui.so`'s `EglManager::initialize()`. Root cause: `getprop ro.hardware.egl` read back
   `mesa` instead of the `angle` the new `nvidia-drm` case in `setup_vulkan()` (gap 1) already
   sets — `gpu_setup_host()` runs after `setup_vulkan()`/`setup_render_node()` in this script's
   own `gpu_setup()` and unconditionally resets `ro.hardware.egl` back to `mesa`, a line that sat
   right next to the `ro.hardware.gralloc` line a prior pass had already made conditional for the
   exact same ordering bug, but was itself missed. **Fixed** by making the `egl` line conditional
   too (`patchGpuConfigSh()`), matching the existing `gralloc` pattern exactly.
8. **Still not enough**: with `ro.hardware.egl=angle` correctly surviving boot, ANGLE itself now
   loaded, but its own Vulkan backend failed with a generic `Internal Vulkan error (-3)`
   (`vk_renderer.cpp:initialize:2228`), still crash-looping every app's `RenderThread`
   (SystemUI, launcher3) and still producing 0-byte scrcpy recordings. Root cause, found by
   reading Mesa's own `os_get_option()` (`src/util/os_misc.c`): on Android it falls back from
   `getenv()` to a system property for every env var it reads, via a fixed name-mangling rule
   (`VTEST_SOCKET_NAME` maps to `mesa.vtest.socket.name`, already set by gap 5's fix; `VN_DEBUG`
   maps to `mesa.vn.debug`, never set). `vn_renderer_create()` only even attempts the vtest
   transport if `VN_DEBUG(VTEST)` is set — without it, it falls through to
   `vn_renderer_create_virtgpu()`, which tries a real virtio-gpu kernel device that does not exist
   here, producing exactly the generic init failure seen. `patchSurfaceflingerRc()`'s own
   `setenv VN_DEBUG vtest` only ever reached SurfaceFlinger's own forked process — every
   zygote-forked app process (SystemUI, launcher3, any scrcpy-driven virtual display) never saw
   it, since zygote does not inherit init's environment the way a directly-forked service does.
   **Fixed** by adding `setprop mesa.vn.debug vtest` to the same `venus3d-vtest-prop.rc`
   `on early-init` trigger gap 5 already uses — a property is readable by every process regardless
   of how it was forked, with no per-service wiring needed. This was the last blocker: boot
   completes cleanly, no RenderThread crashes, and a real scrcpy recording of the home screen
   succeeds.

## `nvenc` + `venus3d` together (31/10/2026, closed)

The `vtest_gpu_encode_dmabuf()` branch this section used to call out as pending is done -- see
`nvenc`'s own README for the full story of the fix (`backend/native/nvenc-daemon/vtest_gpu_encode.c`).
Short version: `nvenc`'s manifest now accepts `gpuMode: ["guest", "host"]` instead of only
`["guest"]`. With `venus3d` active, a capture buffer arrives at the daemon as a real dma-buf
(imported via `VK_EXTERNAL_MEMORY_HANDLE_TYPE_DMA_BUF_BIT_EXT` + an explicit DRM format modifier,
then an image-to-image copy) instead of the memfd this function originally only ever saw; without
`venus3d` (gpuMode=guest), the original memfd/staging-buffer path is unchanged. The daemon tells
the two cases apart per-call via `readlink()` on the received fd, not via `gpuMode` directly --
whichever buffer kind actually shows up is handled correctly either way.

Validation status: see nvenc's own README "Pending" section for the exact, current result of
testing this combination on real hardware (jgustavo47, GTX 1050 Ti) -- updated there, not
duplicated here, so the two files cannot drift out of sync about the same test.

## Pending

- `REDROID_VENUS3D_ARTIFACTS_DIR` points at a local build folder today, same "download a
  release once one exists" TODO `hwenc`/`nvenc` already carry. It now also needs
  `lib/hw/gralloc.minigbm.so`, `lib64/hw/gralloc.minigbm.so`, `lib/libdmabufheap.so`, and
  `lib64/libdmabufheap.so` alongside the original 8 files.
- The root cause of `libdmabufheap.so` (gap 6) being unreachable from the booted guest's own
  `/vendor` view, despite being present pre-boot, was not chased further — shipping the module's
  own copy sidesteps it but does not explain it.
- The host daemon binaries (`backend/native/venus3d-daemon/`) are reused, unmodified, from
  `redroid-nvidia`'s own 2026-09 validation session rather than rebuilt in this pass — rebuilding
  them from the patch sources in that project's own `patches/virglrenderer/` is documented there
  if they ever need to change.

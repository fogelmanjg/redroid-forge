# Module: nvenc

Hardware H.264 encode on NVIDIA hosts, ported from [`redroid-nvidia`](https://github.com/fogelmanjg/redroid-nvidia)'s
Tier 7 (confirmed clean on a GTX 1050 Ti — the only open item in that project, a driver-level
artifact, is specific to the RTX 4060 and doesn't apply here). Same `etapa`/`entry` convention as
`hwenc` (`docs/ARCHITECTURE.md`, `backend/src/lib/moduleRunner.js`), but a genuinely different
HAL service/daemon/protocol — NVIDIA never exposes a VA-API `EncSlice` entrypoint, so `hwenc`'s own
VA-API daemon simply has nothing to talk to on this vendor.

## Why `gpuMode: ["guest", "host"]` — this module doesn't need `venus3d`, but works with it too

Originally shipped as `gpuMode: ["guest"]` only (31/10/2026, first pass): `gpuMode=host` never
boots on NVIDIA at all on its own (`gralloc.redroid.so`'s Mesa GBM has no driver-table entry for
NVIDIA's proprietary stack — see redroid-nvidia's own README, "The problem"), and 3D acceleration
needs a whole separate pipeline (the `venus3d` module, ported later the same day) that this
module's own use case doesn't need. The Codec2 component (`android/nvenc_codec2`) always tries the
Venus-resource path first via `vtest_encode_resolve_res_id()` and, for a genuine Surface-sourced
capture buffer (`scrcpy`, any screen-recording app), it **always** returns 0 regardless of whether
`venus3d` is active — confirmed by reading `redroid-nvidia`'s own Tier 7 findings (its
`patches/codec2/README.md`): a real capture buffer is never a Venus-owned resource either way.
So the component always falls through, by design, to the separate SCM_RIGHTS dma-buf transport
below — meaning this module's own `gpuMode=guest` case (no `venus3d`, where that transport carries
a plain `memfd`) never needed changing. What *did* need changing, once `venus3d` was ported and
could leave a real dma-buf behind instead, is the SCM_RIGHTS transport itself (see "nvenc + venus3d
together" below) — once that was done, `gpuMode: ["host"]` became a second genuinely supported
value, not a replacement for `["guest"]`. See
`backend/native/nvenc-daemon/README.md` for the full transport story. No patched guest image, no
Mesa/minigbm porting, no Venus/3D corruption bug exposure.

## Three real gaps found porting it to the stock image (31/10/2026)

`redroid-nvidia`'s own validation ran against its own patched images; three real, load-bearing
differences surfaced getting a genuine `scrcpy --record` to produce a correct, decodable clip
against the plain official `android-15-official` image on a GTX 1050 Ti (jgustavo47):

1. **The render node's real owning group.** `/dev/dri/renderD128` is bind-mounted straight through
   from the host (the container shares the host's actual device nodes), so its real group is the
   *host's* numeric `render` GID — a number with no relationship to whatever Android's own
   compiled-in AID table resolves the string `"render"` to. The service's own `.rc` can't bake in a
   single correct value at build time (every host's render GID differs); `nvencService.js`'s
   `installFiles()` patches the `.rc`'s `group` line with the real GID, read straight off the host
   node, before each instance's first boot.
2. **The SCM socket's filename.** The guest dials a fixed path, `/dev/venus/nvenc-scm.sock` — the
   daemon has to listen on a file ending in that exact name inside the directory
   `nvencAccel.daemonBind()` mounts at `/dev/venus`, not an arbitrary one (`nvencAccel.js`'s
   `SOCKET_PATH` already reflects this; `backend/native/nvenc-daemon/README.md`'s own "Running it"
   example uses it too).
3. **The capture buffer itself is a plain `memfd`, not a dma-buf.** Confirmed via
   `readlink("/proc/self/fd/N")` on the fd actually received: `/memfd:gralloc-buffer (deleted)`.
   `gralloc.redroid.so` — the gralloc HAL `gpuMode=guest` (the mode this module targets) actually
   uses — allocates plain CPU shared memory here, not a real GEM/dma-buf object the way
   `cros_gralloc`/minigbm would on a real GPU (`gpuMode=host`, `redroid-nvidia`'s own target). There
   is no GPU-side object behind a `memfd` to import via Vulkan's
   `VK_EXTERNAL_MEMORY_HANDLE_TYPE_DMA_BUF_BIT_EXT` (confirmed: that path's `vkAllocateMemory`
   fails outright, every single call, `VK_ERROR_*` aside). `backend/native/nvenc-daemon/
   vtest_gpu_encode.c`'s `vtest_gpu_encode_dmabuf()` was rewritten to `mmap()` the `memfd` directly
   and upload it to `copy_image` through an ordinary host-visible staging buffer +
   `vkCmdCopyBufferToImage()`, instead of importing it as external memory — the rest of the
   pipeline (the copy target, the CUDA/NVENC interop) is unchanged, it only cared about
   `copy_image` ending up with the right pixels, not how they got there. Caught and fixed with
   `VK_LAYER_KHRONOS_validation` enabled (`vulkan-validationlayers`, not installed by default): a
   missing `VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT` on the command pool and a couple of
   invalid access-mask/pipeline-stage combinations on the image barriers were real,
   validation-confirmed bugs surfaced by the switch away from the original (device-local,
   same-process) image-to-image copy — all fixed in the same pass. See that file's own comments at
   each fix for the specifics.

## What it does (stages 3–6)

Same shape as `hwenc`/`codec2Service.js`, implemented in `backend/src/lib/nvencService.js` and
`nvencAccel.js` instead (see those files' own comments for why they're separate from
`codec2Service.js`/`hwAccel.js` rather than folded in — genuinely different binary/daemon/protocol,
sharing only the generic Codec2/`media_codecs.xml` plumbing, reused via plain imports):

- **`prepareCreate()`** (stage 3): the bind for this module's own daemon socket
  (`nvencAccel.daemonBind()`, mounted at the fixed path the guest component dials, `/dev/venus`)
  plus the same `androidboot.use_redroid_c2=1` boot flag hwenc/hwdec need.
- **`integrate(containerId)`** (stage 4): copies the AOSP-built service into `/vendor` (same
  `REDROID_NVENC_ARTIFACTS_DIR`-rooted pattern as `REDROID_HWENC_ARTIFACTS_DIR`) and adds
  `c2.hardware.encoder.h264` to `/vendor/etc/media_codecs.xml` if it isn't there yet — same entry
  name/type `hwenc` uses; the two are mutually exclusive by `compatibleCon.hostGpuVendor`, never
  both installed on the same host.
- **`ensureHostInfraReady()`** (stage 5): checks the daemon's socket answers — **does not spawn
  it**, unlike `hwAccel.ensureDaemonRunning()`. See `nvencAccel.js`'s top comment: the backend
  image is Alpine/musl, the daemon `dlopen()`s three proprietary glibc blobs
  (`libcuda.so.1`/`libnvidia-encode.so.1`/`libvulkan.so.1`) a musl process cannot be relied on to
  load. Install it as the systemd unit in `backend/native/nvenc-daemon/` instead, on the host.
- **`ensureRuntimeReady(containerId)`** (stage 6): delegates straight to `codec2Service.js`'s own
  `ensureRuntimeReady` (the `media.c2.hal.selection=aidl` + `mediaserver` restart) — genuinely
  generic, not duplicated.

## Why this does not violate the license policy (section 6 of REQUIREMENTS.md)

Same reasoning as hwenc's own README: the integrated component (`redroid-nvidia`, Apache-2.0, same
author) is our own free code, not GApps/Magisk. It's a separate artifact only because it's an
Android/bionic binary needing the full AOSP toolchain to build.

## `nvenc` + `venus3d` together (31/10/2026)

With `venus3d` active, `NvencEncComponent.cpp`'s own `looksLikeCrosGralloc` branch (already in
place before this change — see its own comment) parses a genuine `cros_gralloc_handle_t` for a
real capture buffer instead of falling into the generic/stock-redroid wrapper branches: a real,
non-zero `format_modifier` and a real per-plane BYTE stride (`strides[0]`, confirmed against
`cros_gralloc_handle.h` directly — distinct from `pixel_stride`, and from the memfd wrapper's own
stride convention, which is pixels). `vtest_encode_resolve_res_id()` still returns 0 for it either
way (see above), so it still reaches `vtest_encode_via_scm()` → the daemon's
`vtest_gpu_encode_dmabuf()` — just with a genuinely different kind of fd this time.

`vtest_gpu_encode_dmabuf()` (`backend/native/nvenc-daemon/vtest_gpu_encode.c`) now tells the two
cases apart itself, per call, the same way this project's own comments already diagnosed the split
in the first place: `readlink("/proc/self/fd/N")` on the received fd starts with `/memfd:` for the
`gpuMode=guest` case, and does not for a real dma-buf. For the real-dma-buf case, it:

- Imports the fd directly as a Vulkan image via `VK_EXTERNAL_MEMORY_HANDLE_TYPE_DMA_BUF_BIT_EXT`,
  using `VkImageDrmFormatModifierExplicitCreateInfoEXT` (not the `...List...` variant used
  elsewhere in this file for *fresh* allocations) — this describes the layout the memory *already*
  has (the real modifier + the real byte `rowPitch`), rather than letting the driver pick one for
  a new allocation.
- Copies it into the existing `copy_image` with `vkCmdCopyImage` (device-local image → device-local
  image), instead of the `mmap()` + host-visible staging buffer + `vkCmdCopyBufferToImage` path the
  memfd case still uses (CPU-mapping a real GEM/dma-buf object is not generally possible — the
  whole reason that path exists for the memfd case specifically never applied here).
- On a successful import, does **not** close the fd — per the Vulkan spec, ownership transfers to
  the driver on success (it is still closed on any failed import, where ownership never transferred).

No change was needed in the guest-side Codec2 component or in the wire protocol — `width`/`height`/
`modifier`/`stride` already flowed through correctly for both cases before this change; only the
daemon's own handling of them needed to branch.

## Pending

- `REDROID_NVENC_ARTIFACTS_DIR` points at a local AOSP build folder today, same as
  `REDROID_HWENC_ARTIFACTS_DIR` — same "download a release once one exists" TODO.
- **Validated end to end on a GTX 1050 Ti (jgustavo47), 31/10/2026**, against an unmodified
  `android-15-official` instance: `scrcpy --list-encoders` shows `c2.hardware.encoder.h264 (hw)
  [vendor]`, and a real 10-second `scrcpy --record` produced a 231-frame H.264 clip,
  `ffprobe`-valid, visually correct and undistorted on every frame sampled (home screen, search
  bar, wallpaper, nav bar all fully recognizable, zero tiling/corruption artifacts). Not yet tried
  on an RTX 4060 or any other NVIDIA generation.
- **`nvenc` + `venus3d` together, validated end to end on the same GTX 1050 Ti (jgustavo47),
  01/11/2026**: a fresh instance (`coexist-test`) with both modules active, `gpuMode=host`, real
  boot (`sys.boot_completed=1`). `dumpsys SurfaceFlinger` confirmed genuine `RE Vulkan (Ganesh)` /
  `Vulkan device initialized: 1` RenderEngine throughout, both before and after recording — venus3d
  never got displaced. A one-shot debug print in `vtest_gpu_encode_dmabuf()` (added, exercised,
  then reverted before commit — not part of this diff) confirmed the new branch actually ran:
  `fdlink_target=/dmabuf: is_real_dmabuf=1 modifier=0 stride=3072` (3072 = 720px width padded to a
  768px/64-aligned stride at 4 bytes/px — an ordinary GPU allocator alignment, not a bug). Two
  `scrcpy --record` passes while actively swiping the launcher/app-drawer (real motion, not a
  static screen) produced 144-frame and 58-frame clips, both `ffprobe`-valid; sampled frames
  (including mid-animation, app drawer half-open) are crisp and correct, zero tiling/corruption.
  Not yet tried on an RTX 4060.
- The daemon (`backend/native/nvenc-daemon/nvenc_scm_daemon`) is currently running on jgustavo47
  as a plain background process, **not yet installed as the systemd unit** — `install`ing
  `nvenc-daemon.service.example` into `/etc/systemd/system/` was blocked by the host's own
  automation guard (unattended persistent-service installs need explicit sign-off), same as the
  binder-perms unit earlier in this project's history. Needs that install (one command, see
  `backend/native/nvenc-daemon/README.md`) before this survives a reboot.
- No image in `backend/images.json` declares this module as a default yet (unlike hwenc on
  `android-15-official`'s `hwEncCapable`) — it's opt-in only (`OPTIONAL_PER_INSTANCE` in
  `moduleGate.js`) until it's seen more real-world mileage.

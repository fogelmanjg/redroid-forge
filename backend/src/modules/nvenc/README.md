# Module: nvenc

Hardware H.264 encode on NVIDIA hosts, ported from [`redroid-nvidia`](https://github.com/fogelmanjg/redroid-nvidia)'s
Tier 7 (confirmed clean on a GTX 1050 Ti — the only open item in that project, a driver-level
artifact, is specific to the RTX 4060 and doesn't apply here). Same `etapa`/`entry` convention as
`hwenc` (`docs/ARCHITECTURE.md`, `backend/src/lib/moduleRunner.js`), but a genuinely different
HAL service/daemon/protocol — NVIDIA never exposes a VA-API `EncSlice` entrypoint, so `hwenc`'s own
VA-API daemon simply has nothing to talk to on this vendor.

## Why `gpuMode: ["guest"]`, not `["host"]` like hwenc

`gpuMode=host` never boots on NVIDIA at all (`gralloc.redroid.so`'s Mesa GBM has no driver-table
entry for NVIDIA's proprietary stack — see redroid-nvidia's own README, "The problem"). That
project's real fix for 3D acceleration is a Venus-proxy pipeline (patched guest Mesa/minigbm, a
host-side `virgl_test_server`) — genuinely needed for *rendering* 3D content inside the guest, but
**not for this module's use case**: the Codec2 component (`android/nvenc_codec2`) always tries the
Venus-resource path first and it always fails cleanly (`ENOMEM` — there's no virtio-gpu device in
this container architecture at all, only NVIDIA's own render node), falling through by design to a
plain SCM_RIGHTS dma-buf transport that works against a genuine Surface-sourced capture buffer
(`scrcpy`, any screen-recording app) with `gpuMode=guest` (plain software rendering) alone — see
`backend/native/nvenc-daemon/README.md` for the full transport story. No patched guest image, no
Mesa/minigbm porting, no Venus/3D corruption bug exposure.

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

## Pending

- `REDROID_NVENC_ARTIFACTS_DIR` points at a local AOSP build folder today, same as
  `REDROID_HWENC_ARTIFACTS_DIR` — same "download a release once one exists" TODO.
- Validated end to end on a GTX 1050 Ti (jgustavo47) with an unmodified official redroid image.
  Not yet tried on an RTX 4060 or any other NVIDIA generation.
- No image in `backend/images.json` declares this module as a default yet (unlike hwenc on
  `android-15-official`'s `hwEncCapable`) — it's opt-in only (`OPTIONAL_PER_INSTANCE` in
  `moduleGate.js`) until it's seen more real-world mileage.

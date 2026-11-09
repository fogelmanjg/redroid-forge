# venus3d-daemon

The host-side half of the "venus3d" module (real 3D acceleration on NVIDIA hosts, ported from
[`redroid-nvidia`](https://github.com/fogelmanjg/redroid-nvidia)'s Tier 4/5) — a patched
`virgl_test_server` (plus its `virgl_render_server` helper it `fork()`s per Venus context, and
the `libvirglrenderer.so.1` both link against). The guest's Mesa Venus Vulkan driver
(`backend/src/modules/venus3d/README.md`'s own guest artifacts) dials this over a unix socket
instead of talking to a real virtio-gpu device (there is none in this container architecture) —
this process is the thing that actually calls into NVIDIA's real driver on its behalf.

## Why this is not something this backend spawns itself

Same reasoning as `backend/native/nvenc-daemon/README.md`: this backend's own image is
Alpine/musl, and this daemon links against the real NVIDIA userspace stack (EGL/Vulkan, and
transitively CUDA/NVENC for the `VCMD_ENCODE_RESOURCE` command it also carries, see below) —
proprietary glibc targets a musl process cannot be relied on to load. It runs as its own
systemd unit on the host; `backend/src/lib/venus3dAccel.js` only ever connects to its socket
(`ensureHostInfraReady`, not `ensureDaemonRunning`).

## Where the binary comes from

Three files: `virgl_test_server`, `virgl_render_server`, `libvirglrenderer.so.1`. Built from
real upstream `gitlab.freedesktop.org/virgl/virglrenderer` plus
[`Shiro836/waydroid-nvidia`](https://github.com/Shiro836/waydroid-nvidia)'s own vtest patches
(sync_file export, dma-buf import, a GPU-alloc helper) and this project's own `VCMD_ENCODE_RESOURCE`
addition — see `redroid-nvidia`'s own `patches/virglrenderer/README.md` for the exact patch
list and build recipe (`meson setup build -Dvenus=true -Dunstable-apis=true`). These exact
binaries were already built and confirmed working end to end on real NVIDIA hardware during
that project's own validation (2026-09, GTX 1050 Ti) — ported here unchanged rather than
rebuilt from scratch, same "reuse what is already proven" criterion the `nvenc` module's own
artifacts follow. They are **not** committed to this repo (same reasoning as
`REDROID_HWENC_ARTIFACTS_DIR`/`REDROID_NVENC_ARTIFACTS_DIR`: proprietary-adjacent binaries,
build-host-specific) — deploy them to a fixed path on each host that will run this module and
point the systemd unit below at that path.

## Running

```sh
./virgl_test_server --venus --rendernode /dev/dri/renderD128 --socket-path /dev/nvenc-helper/venus.sock
```

Needs `LD_LIBRARY_PATH` (or an install into a system lib dir) to find `libvirglrenderer.so.1`
and, transitively, `virgl_render_server` next to it (it execs that helper by relative lookup on
`PATH`/its own directory — keep the three files together). The socket path has to be the file
`backend/src/lib/venus3dAccel.js`'s `HOST_SOCKET_PATH` expects (`$REDROID_FORGE_NVENC_DIR/venus.sock`,
default `/dev/nvenc-helper/venus.sock` — the same directory the `nvenc` module's own daemon
already uses for its own, differently-named socket file, so both can run on the same host at
once without colliding).

See `venus3d-daemon.service.example` for the systemd unit (same shape as
`nvenc-daemon.service.example`).

## Known issue: content-dependent texture corruption on the RTX 4060 (01/11/2026)

Real app testing on jgustavo48 (RTX 4060) with a real game (CIFI, a Unity idle game) found two
related symptoms that don't show up on simple screens (login, static text) but do on
content-heavy ones (a dialog with its own icon/texture, a screen with lots of simultaneous
draws): some textures render as solid black (missing), and text/UI elements show a mild-to-severe
double-exposure/shear artifact. Confirmed via `gpuMode=guest` + `nvenc` alone (no venus3d): **zero
corruption, zero missing textures** — isolates this to venus3d's own rendering, not to nvenc's
capture/encode path (nvenc only encodes whatever SurfaceFlinger already composited).

**Ruled out as a build regression**: swapped jgustavo48's `virgl_test_server` +
`libvirglrenderer.so.1` for jgustavo47's exact, already-proven-working binaries (byte-for-byte,
md5-verified) — same corruption still reproduced on content-heavy screens on the 4060. Simple
screens (login, "offline income") looked clean or near-clean with either binary. This points at
a real, content/load-dependent NVIDIA driver gap specific to the RTX 4060 (Ada) — not a bug in
this project's own code — consistent with the already-documented VA-space mapping bug
(`compatibleCon`/manifest notes, NVIDIA's own open-gpu-kernel-modules issues #1364/#1165/#1140/#1396),
though this specific texture-corruption signature hasn't been tied to one of those issue numbers
yet.

Host currently left with jgustavo47's binaries in place (`/opt/redroid-forge/venus3d-daemon/`) —
not worse than this project's own from-source build, and a known-good baseline to keep testing
against.

**Not yet done, next concrete step**: instrument `virgl_test_server`/`vtest_renderer.c` (or
Venus's own `vkr_queue_sync_submit`/`vtest_submit_cmd2` fence-bookkeeping, per
`redroid-nvidia/DEVLOG.md`'s 2026-09-24 race-condition lead) specifically around whatever command
sequence a dialog-with-new-texture triggers, to catch the real moment the corruption is
introduced — not yet attempted.

### The GTX 1050 Ti had this exact symptom too, and it got fixed (worth re-checking before anything else)

The user's own recollection (01/11/2026): the 1050 Ti showed this same "textures missing /
corrupted under real content" symptom at some point, and it was fixed — possibly as a side effect
of something that wasn't aimed at this specific bug ("de rebote"). Worth keeping in mind every
time this resurfaces: NVIDIA's own undocumented behavior here means a fix found for one real
problem can silently close a different one, so re-reading old fixes with fresh eyes is cheap and
has already paid off once.

The best-documented candidate is `redroid-nvidia/DEVLOG.md`'s 2026-09-26 "checkerboard bug,
solved" entry (five real bugs fixed in `nvenc_scm_daemon.c`/`vtest_gpu_encode.c`, the NVENC
*capture* daemon, not venus3d's own renderer): wrong DRM modifier candidate picked (took the
first of six instead of probing which one the driver actually assigned), `rowPitch` computed by
arithmetic instead of read back from the real image layout, display-width confused with the
buffer's real (padded) width, a reported `modifier == 0` wrongly overridden by a guessed non-linear
one instead of trusted as genuinely linear, and `copy_image`'s own modifier wrongly tied to the
source's. After these, DEVLOG explicitly confirms (2026-09-26, "cross-machine GPU/driver
comparison" entry) the 1050 Ti came out clean end to end.

**Checked tonight whether `vtest_gpu_alloc.c` (this project's own venus3d code path — this is what
allocates CIFI's own GPU-only render-target textures, the actual thing going black) has an
analogous, unfixed version of that same bug class**: it does not. It already probes the real
candidate list via `VkImageDrmFormatModifierListCreateInfoEXT` + reads back the driver's real
choice via `vkGetImageDrmFormatModifierPropertiesEXT` (the "wrong turn 1" fix), reads the real
`rowPitch` via `vkGetImageSubresourceLayout` after binding (the "wrong turn 2" fix), and never
conflates display width with buffer width (the "wrong turn 3" fix) — this file was ported from
`waydroid-nvidia`'s own already-fixed vtest patches, not written fresh, so it inherited these three
fixes from the start. **So the nvenc-capture fix doesn't translate here by simple analogy** — if
the 1050 Ti's fix really is what's keeping it clean today, the mechanism must be something other
than these three specific modifier/stride bugs (maybe the GEM-handle-leak fix, maybe the
`force_idr` session-reset fix, maybe something in how `mediaswcodec`/the HIDL-vs-AIDL codec
selection interacts with Venus being active at the same time — none of these three checked yet).
Next time this comes up: check those three instead of re-deriving the modifier/stride reasoning
again, since that specific angle is now ruled out.

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

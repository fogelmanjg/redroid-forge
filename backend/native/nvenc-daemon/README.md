# nvenc-daemon

A direct port of [`redroid-nvidia`](https://github.com/fogelmanjg/redroid-nvidia)'s Tier 7 daemon
(`patches/nvenc-daemon/nvenc_scm_daemon.c`), no logic changes — same binary, same protocol. See
that project's README/DEVLOG for the full design history (why SCM_RIGHTS instead of a Venus
resource id, why this is a standalone process and not a thread inside `virgl_test_server`, the
driver-level artifact that's open on the RTX 4060 specifically and absent on the GTX 1050 Ti).

H.264 encode through NVENC, for a plain (non-Venus) dma-buf a real Surface-sourced capture
(`scrcpy`, any screen-recording app) actually hands the Codec2 component — this project's own
`nvenc` module never boots the Venus/3D pipeline (patches/mesa, patches/minigbm in
redroid-nvidia) at all: `gpuMode=guest` is enough, this daemon only speaks the encode half.

## Build

```sh
make
```

No special headers needed — `libvulkan.so.1`, `libcuda.so.1` and `libnvidia-encode.so.1` are all
`dlopen()`'d at runtime (see `vtest_gpu_encode.c`), not linked. The binary itself depends on
nothing but libc.

## Who starts it — and why NOT the backend, unlike vaapi-daemon

`vaapi-daemon`'s binary is spawned and supervised by `backend/src/lib/hwAccel.js`, as a child
process of the backend container. This one is **not**: the backend image is Alpine/musl
(`node:22-alpine`, see the repo's Dockerfile), and `libnvidia-encode.so.1`/`libcuda.so.1`/
`libvulkan.so.1` are proprietary glibc blobs — dlopen()-ing a glibc `.so` from a musl-linked
process is not something to rely on in production. The daemon has no such constraint itself (it is
glibc, like everything else on the host), so it runs as a plain host-level process (a systemd unit,
see `nvenc-daemon.service.example`), independent of any container.

`backend/src/lib/nvencAccel.js` only ever **connects** to its socket — the same bind-mount pattern
`hwAccel.js` uses for `/dev/vaapi-helper`, but on the supervision side it behaves exactly like
`hwAccel.js`'s own "a daemon of another forge already serves this socket: adopt it" fallback,
unconditionally, every time: if the socket doesn't answer, the error message points at the systemd
unit instead of trying to `spawn()` a binary redroid-forge's own container cannot reliably run.

## Running it

```sh
./nvenc_scm_daemon /dev/nvenc-helper/socket
```

The directory (`/dev/nvenc-helper` by default, `REDROID_FORGE_NVENC_DIR` to override — same
override reasoning as `REDROID_FORGE_VAAPI_DIR` in `hwAccel.js`, for a scenario runner isolating
several forges on one host) is bind-mounted into every instance that needs it at the fixed path the
guest component dials, `/dev/venus/nvenc-scm.sock` (see `android/nvenc_codec2/component/
vtest_encode_client.cpp`) — `nvencAccel.js`'s `daemonBind()` mounts the host directory straight at
`/dev/venus` inside the instance, same trick `binder.js`/`hwAccel.js` already use elsewhere. No
real Venus socket (`venus.sock`) ever needs to exist alongside it: this project's own guest
component always fails the Venus-resource-id resolve step first (there is no virtio-gpu device in
this container, only NVIDIA's real render node — see redroid-nvidia's DEVLOG, 2026-09-26) and falls
through to the SCM path unconditionally, by design.

## Install as a systemd service

See `nvenc-daemon.service.example` — copy it to `/etc/systemd/system/nvenc-daemon.service`, adjust
`ExecStart`'s socket directory if not using the default, `systemctl daemon-reload && systemctl
enable --now nvenc-daemon`.

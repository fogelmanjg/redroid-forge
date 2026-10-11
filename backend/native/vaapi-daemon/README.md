# vaapi-daemon

A direct port of the daemon of [`redroid-hwenc`](https://github.com/fogelmanjg/redroid-hwenc)
(tier5-vaapi-daemon), with no logic changes to the encode path — same binary, same protocol. See that
project's README for the full design (why a host-side daemon instead of native VA-API inside Android, the
socket protocol, and the per-GPU compatibility table).

H.264 encode through VA-API on AMD/Intel (`VAEntrypointEncSlice`), H.264 decode through NVDEC on NVIDIA
(`VAEntrypointVLD`, `nvidia-vaapi-driver` driver), and — new in this project — **vendor-agnostic hardware
decode** (H.264, HEVC, VP9, ...) on AMD and Intel. One process, independent backends, none of them required
for the others to work.

## Build

```sh
make
```

It requires the development headers of `libva`, `libva-drm`, `libgbm` and `libEGL` (see the backend's
Dockerfile for the exact packages in the production image). `make HWDEC=1 daemon` adds the hardware decode
(it needs FFmpeg's libavcodec/libavutil and libdrm too).

## Who starts it

It is not run by hand — `backend/src/lib/hwAccel.js` launches and supervises it as a child process of the
redroid-forge backend (which runs `--privileged --pid=host --network=host`, see `docker-compose.yml`), and
exposes its socket (`/dev/vaapi-helper/socket`) bind-mounted both in the backend's own container and in
every redroid instance that needs it — the same pattern as `binder.js` with `/dev/binderfs`. If the daemon
dies (for example, a GPU reset aborts it with SIGABRT) the backend relaunches it by itself, waiting 1 s and
doubling up to 30 s if it keeps dying right after starting.

## hwdec: vendor-agnostic hardware decode

`hwdec.c`/`hwdec.h` are a hardware decode session with **libavcodec + VA-API** (AMD and Intel; see
`docs/ROADMAP.md`, Phase 2, step 5). The daemon serves it to the Android Codec2 components
(`android/vaapi_codec2`) over the `VAAPI_CMD_HWDEC` protocol described below.

Design rules:
- **Everything the host offers is used in hardware.** `hwdec_probe()` asks VA-API what the DRM node decodes
  (without libavcodec) and `hwdec_open()` only opens sessions for those codecs.
- **There is never a silent fallback to software.** If the hardware cannot handle the stream, the session
  fails and the caller falls back to its software decoder.
- **A stateful session:** one access unit per `hwdec_send()`; `hwdec_receive()` returns the already
  reordered frames (B-frames), one at a time. Output is compact NV12 (8-bit) or P010 (10-bit).

### Try it (on any host with Docker and `/dev/dri`)

```sh
cd backend/native/vaapi-daemon
docker run --rm --device /dev/dri -v "$PWD":/src -v /path/to/clips:/clips:ro -w /src alpine:latest sh -c '
  apk add -q --no-cache build-base pkgconf ffmpeg ffmpeg-dev libva-dev libva-utils \
      mesa-va-gallium intel-media-driver &&
  cp -r /src /build && cd /build && make hwdec-test &&
  ./hwdec-test --probe &&
  ./test/hwdec-verify.sh /dev/dri/renderD128 /clips/*'
```

`hwdec-verify.sh` decodes every clip in software (ffmpeg) and in hardware (`hwdec-test`) and compares frame
by frame in output order. **Note:** the `cpu=` it prints includes the MD5 hash and the download of every
frame to RAM (at 10-bit 4K that is ~25 MB per frame), so it **does not measure the cost of the decode**;
the real CPU measurements are in `docs/ROADMAP.md`.

For this experiment Alpine's FFmpeg is used, built with `--enable-gpl`: it is fine for testing, but it is
**not distributed**. The project's image will build its own LGPL libavcodec.

### Results (06/10/2026)

Clips: H.264 High with B-frames and 4 references (720p30 and 1080p30), HEVC Main10 HDR10 2160p30, VP9
profile 2 (10-bit) 2160p30. `✓` = all frames identical to software.

| GPU (driver) | H.264 720p | H.264 1080p | HEVC 4K 10-bit | VP9 4K 10-bit |
|---|---|---|---|---|
| Polaris RX 480 (radeonsi) | ✓ | ✓ | ✓ | rejected: no hardware |
| Iris Xe (iHD) | ✓ | ✓ | ✓ | ✓ |
| Vega 8 of the 5700G (radeonsi) | ✓ | ✓ | ✓ | ✓ |

What `hwdec_probe()` advertises per GPU: Polaris: h264, hevc (+10), mpeg2, vc1. Vega 8: h264, hevc (+10),
vp9 (+10), mpeg2, vc1. Iris Xe (iHD 26.2): h264, hevc (+10), vp9 (+10), vp8, mpeg2, vc1, **av1** (+10); AV1
and VP8 are **advertised but untested** (there are no clips).

### Protocol v2 through the daemon

Built with `make HWDEC=1 daemon`, the daemon serves two new commands (see `protocol.h`): `VAAPI_CMD_HWDEC` (a
persistent connection per stream, one thread per session) and `VAAPI_CMD_HWDEC_CAPS` (what the host
decodes). The DRM node comes from `REDROID_FORGE_DRM_NODE` (by default `/dev/dri/renderD128`).
`hwdec_client.c` is the reference client (the same contract the Android component uses). Without `HWDEC=1`
the daemon behaves as before and does not depend on FFmpeg.

```sh
# inside the same container as above, after `make hwdec-test`:
make HWDEC=1 daemon     # it also needs: libdrm-dev mesa-dev vulkan-headers mesa-gbm mesa-egl
./test/hwdec-stream-verify.sh /dev/dri/renderD128 /clips/*      # capabilities, decode through the socket, 2 streams at once
```

Result (06/10/2026): Polaris 3 of 3 supported clips + VP9 rejected; Iris Xe 4 of 4; Vega 8 of the 5700G
4 of 4, all identical to software through the socket.

### Frame transport: shared memory

A client that sets `VAAPI_HWDEC_OPEN_SHM` in `HwDecOpenRequest.flags` receives a `memfd` (512 MiB virtual,
only what the frames write is resident) attached to the open response through `SCM_RIGHTS`; every frame is
downloaded straight into it and the frame headers carry no payload. The frames of one response overwrite
those of the next, so the client copies them before its next request. Without the flag the frames travel
inline through the socket, as before.

### Encoder rate control

The encoder runs in constant-QP mode; `ratectl.h` picks the QP of every frame so the average reaches the bitrate in
`EncodeRequest.bitrate` (what MediaCodec/scrcpy asked for). Without a bitrate (an older Android component) it keeps its
historical QP 26. Check the controller on its own with
`cc -O2 -o /tmp/ratectl-test test/ratectl-test.c -I. -lm && /tmp/ratectl-test`.

### P frames (`REDROID_FORGE_ENCODE_IDR_PERIOD`)

By default every frame is an IDR (all-intra: stateless, simple, but it compresses far worse than any normal encoder: on busy
content at 8 Mbps the QP climbs to 30–48). With `REDROID_FORGE_ENCODE_IDR_PERIOD=N` (N > 1; 120 is about 2 s at 60 fps) the
encoder makes an IDR every N frames and **P frames in between** (one reference frame, no B frames, so no reordering or extra
latency). Off by default until it has been validated on every GPU.

- A request has no stream identity, but the process that sends it is known from the socket (`SO_PEERCRED`): every instance runs
  its own encoder service, so `(pid, width, height)` identifies the stream and the protocol and the Android component did not
  change. One stream at a time holds the reference; a frame from another stream, a resolution change, a pause longer than
  1.5 s or a failed frame is an IDR, which is always correct (two interleaved streams simply stay all-intra). The policy is in
  `gop.h` with its own test: `cc -O2 -o /tmp/gop-test test/gop-test.c -I. && /tmp/gop-test`.
- Two reconstruction surfaces alternate (the previous one is the reference of the next); the P slice header is written by hand
  like the IDR one (`nal_unit_type` 1, `frame_num` modulo 16, sliding-window reference marking, `cabac_init_idc` 0).
- Rate control: an IDR may use 3x the budget of a frame (not counted as debt) and the complexity of P frames is estimated
  separately from the intra one (`ratectl.h`, `gop` field).
- `REDROID_FORGE_ENCODE_INTRA_ONLY=1` forces the old behaviour even with a period set.

Measured on the Polaris (RX 480, VCE) with the scenario runner, `encode-low` (a scrolling screen, 2 Mbps asked; 2.49 Mbps reaches
the daemon): all-intra delivered 2.35 Mbps at **QP 31**; with P frames, 1.59 Mbps at **QP 14** (the quality floor: the content
fits in the budget at the best quality). A 18 s capture of scrcpy: 525 P frames and 5 IDR, no decode errors with
`ffmpeg -err_detect aggressive+explode`, Constrained Baseline, 1 reference.

### Runtime options (environment variables)

| Variable | Effect |
|---|---|
| `REDROID_FORGE_DRM_NODE` | DRM render node to use (default `/dev/dri/renderD128`). |
| `REDROID_FORGE_HWDEC_DOWNLOAD` | How a decoded frame is brought from the GPU to RAM: `derive-sse` (default: `vaDeriveImage` + SSE4.1 non-temporal loads), `derive`, `getimage` (`vaGetImage`) or `ffmpeg` (`av_hwframe_transfer_data`). The first frame of every session is also downloaded through ffmpeg and compared byte by byte; if the direct download fails or differs, that session goes back to the ffmpeg path and says so on stderr. |
| `REDROID_FORGE_HWDEC_STATS` | If set, every session prints its average time per stage (send, GPU wait, download, copy) when it closes, and the daemon prints the wait/queue/socket averages. |
| `REDROID_FORGE_ENCODE_STATS` | If set, the daemon prints the real encoded bitrate (against the target) every 5 s, and how many IDR and P frames it made (`gop-stats`). |
| `REDROID_FORGE_ENCODE_IDR_PERIOD` | Frames per IDR; > 1 turns the P frames on (see above). Default 1: all-intra. |
| `REDROID_FORGE_ENCODE_INTRA_ONLY` | `1` forces all-intra even if a period is set. |
| `REDROID_FORGE_HWDEC_DEBUG` | If set, logs the first bytes of every access unit that arrives (to see how Android delivers it). |

# redroid-forge — Phase roadmap

**Languages:** English only. This document is the project's working log and is kept in English like the
`DEVLOG` of `redroid-hwenc`; the stable specifications also have a Spanish copy (see the README).

> Complements `REQUIREMENTS.md` (what and why). This document is the how and in what order — with no
> estimated times, every phase with its concrete steps and a relative difficulty. The **gate** is the
> condition to move on to the next phase, not a date.

## Phase 0 — Repo bootstrap

**Difficulty: Low** — all the code already exists and works, it is rearranging.

**Steps:**
1. Create the public repo on GitHub as `redroid-forge` (name confirmed — verified free on GitHub, npm
   and Docker Hub; already hosted locally at `~/redroid-forge`).
2. Add `LICENSE` (Apache-2.0), a minimal README, a credits/attribution section for redroid and the
   projects of origin.
3. Set up the monorepo structure (`backend/`, `frontend/`, `docs/`).
4. Port `redroid-manager` as is into that structure, without rewriting logic: instance lifecycle,
   Doctor, Android ID/GApps registration, `binder.js`/`hwsimWifi.js`/`androidIdentity.js`.

**Gate:** `docker compose up` in the new repo gives the same behavior as `redroid-manager` today,
running from the new location.

## Phase 1 — Redroid 15 as the official tier + support tiers

**Difficulty: Low** — it is adding a metadata field and already-documented checks, not discovering
anything new. It is no longer "restricting", it is declaring.

**Steps:**
1. Add the `soporte` field (`oficial`/`comunidad`) to every entry of `backend/images.json`. ✅ done.
2. Port the host prerequisites checklist (legacy binder/binderfs, `loop`, `ext4`) as new Doctor checks.
   ✅ done (ext4 is new; the binderfs fix now also documents the legacy binder fallback).
3. Show the tier of the chosen image in the UI (official/community badge). ✅ done, in the instance
   creation selector.
4. Validate that the catalog and the Doctor return the right tier against real Docker, and that no image
   is blocked by version. ✅ done.
5. `compatibleCon` in the module manifest (Android version, GPU mode) **is deferred to Phase 4** — it
   makes no sense to build it before the manifest/contract system that will read it exists.

**Gate:** a complete lifecycle of a Redroid 15 instance (official tier) working end to end with only the
new app; a Redroid 11/13 instance (community tier) can still be created without blocking, with the tier
visible in the UI.

## Phase 2 — Hardware acceleration (hwenc + nvidia)

**Difficulty: High** — two native daemons that are already complex on their own (multi-vendor VA-API,
Venus-proxy, NVENC), with already-known driver quirks (e.g. the scanline artifact on the 4060 with driver
595.91.07) that have to be preserved/not reintroduced when integrating.

**Steps:**
1. Port `redroid-hwenc` (AMD/Intel VA-API encode + NVDEC decode) as a component the backend can
   launch/monitor per instance.
2. Port `redroid-nvidia` (Venus-proxy 3D + NVENC) the same way.
3. Add GPU mode selection (host/soft) and vendor detection to the instance creation flow.
4. Validate on a real AMD/Intel host and on a real NVIDIA host.
   - ✅ **AMD Polaris (RX 480, jgustavo46) validated on 05/10/2026** with the official image
     `redroid/redroid:15.0.0-latest` + the hwenc module: green Doctor (legacy binder), the daemon picks
     the pre-modifier VA-API import on its own (Tier 5.12), `c2.hardware.encoder.h264` encoder
     registered, `screenrecord` 5 s = 74 H.264 frames with a correct image.
   - ✅ **Intel Iris Xe (TigerLake-LP, n02) validated on 05/10/2026**, the same official image + hwenc,
     legacy binder slot 0, a 1000x600 instance capped at 3 GB (real use ~1.6 GB): daemon with `iHD`,
     `screenrecord` to MP4 = 209 valid H.264 frames. Two real bugs found and fixed here: (1) the
     backend's image did not ship `intel-media-driver` (only `mesa-va-gallium`, which covers
     AMD/nouveau) and the daemon died in `vaInitialize`; (2) `iHD` emits Annex-B start codes of **3
     bytes** and radeonsi of 4, and `MPEG4Writer`'s CSD parser requires 4 (it aborted with `FORTIFY:
     write: count -1`); the daemon now normalizes to 4 bytes. NVIDIA is still missing.
5. **Hardware decoding (VA-API) on AMD and Intel** — a goal added on 05/10/2026 (not a port: it is new
   work), with the scope extended on 06/10/2026.

   **Principle (decided 06/10/2026): every instance uses in hardware everything the host's hardware
   offers.** There is no single capability package: a host with Iris Xe decodes H.264, HEVC (8/10/12
   bits), VP9 and VP8; one with Polaris, H.264 and HEVC; one with Vega/Cezanne, H.264, HEVC and VP9;
   newer hardware will keep adding (AV1, etc.). That is normal and it is declared, not hidden: the Doctor
   shows which codecs the host decodes in hardware, and only the decoders the host really supports are
   registered in Android (the same criterion as the modules' `compatibleCon`). **Encode is not touched
   for now: it is picked up after finishing the first version.**

   Today the daemon on AMD/Intel **only encodes**; the only decode that exists is NVIDIA's (NVDEC via
   `nvidia-vaapi-driver`, validated bit by bit only on a GTX 1050 Ti) and it only decodes **a single
   loose intra frame** (SPS + PPS + one IDR slice per request: no references or B-frames), so it is a
   proof of the mechanism, not a decoder. Starting point, verified by reading the code:
   - `decode_h264_init()` forces `LIBVA_DRIVER_NAME=nvidia` and opens `/dev/dri/renderD128` hardcoded: on
     AMD/Intel it never initializes.
   - The `hwenc` module only registers the encoder in `media_codecs.xml`, and its manifest is only offered
     for `amd`/`intel` hosts (the `VaapiDecComponent` component exists in the old project, but forge does
     not wire it).

   **Measured on 06/10/2026** (ffmpeg + VA-API, pure decode, `-threads 1` in software; 0 frames
   different from software in all cases): 720p30 High with B-frames: Polaris 1.77 s of CPU in software
   against 0.33 s in hardware; Iris Xe 4.56 s against 0.49 s. 2160p30 10-bit (5 s): HEVC Main10 HDR10
   Polaris ×14, Iris Xe ×22, 5700G ×7.5 (server01 loaded); VP9 profile 2 Iris Xe ×17, 5700G ×10; **VP9
   not supported on Polaris** (no hardware block). In software, 4K needs 2 to 2.7 cores to run in real
   time; in hardware, 0.1 to 0.26.

   **Approach (decided 06/10/2026): libavcodec with the VA-API hwaccel inside the daemon**, not an own
   H.264 parser. It covers High, B-frames, multiple slices and, where the hardware supports it, HEVC and
   VP9, without writing a parser per codec (extending the own parser would have been ~1,500–2,500 lines
   and H.264 only). **License:** Alpine's FFmpeg is built with `--enable-gpl --enable-version3`; linking it
   would make the image a GPLv3 work, incompatible with publishing an Apache-2.0 image. That is why the
   `Dockerfile` **builds its own minimal libavcodec (LGPL, `--disable-gpl`)**, only with the necessary
   decoders and the VA-API hwaccel, from a tarball pinned by version.

   **✅ implemented 23/10/2026** (until then this paragraph described the plan, not the actual
   `Dockerfile`, which still used Alpine's GPL package behind a "development only" `HWDEC=0` default).
   New multi-stage build (`ffmpeg-lgpl`): configures FFmpeg 8.0.1 with `--disable-gpl --disable-nonfree
   --disable-everything`, enabling only the 7 decoders hwdec.c actually calls (h264/hevc/vp8/vp9/
   mpeg2video/vc1/av1) plus their `*_vaapi` hwaccels — no avformat/avfilter/avdevice/swscale/swresample,
   no encoders. FFmpeg's own `configure` confirms the resulting build as `License: LGPL version 2.1 or
   later`, same source release Alpine ships, zero API/behavior difference in `hwdec.c`. Validated full
   `docker build` + real decode against server01's AMD Renoir (`h264 hevc(+10b) vp9(+10b) mpeg2 vc1`,
   same capability already proven with Alpine's GPL package). Resulting libs are smaller too (~8 MB vs
   Alpine's full 19 MB package). **`HWDEC` default flipped from `0` to `1`** — no longer dev-only, this
   removes the last blocker to it being on by default in a public Apache-2.0 image.

   Sub-steps: (1) ✅ **done on 06/10/2026**: a vendor-agnostic decode session with libavcodec
   (`backend/native/vaapi-daemon/hwdec.c`, not wired to the daemon yet), tested only on the host with a
   command-line client. **12 of 12 supported cases give frames identical to software** (H.264 High with
   B-frames at 720p and 1080p, HEVC Main10 4K HDR10 and VP9 profile 2 4K, on Polaris, Iris Xe and the
   5700G), and the only case without hardware (VP9 on Polaris) is rejected without falling back to
   software. Detail and how to repeat it in the daemon's README. Pending in this sub-step: testing AV1
   and VP8 (Iris Xe advertises them) and measuring the real decode CPU; (2) protocol v2 with one session
   per stream (a persistent connection served in its own thread of the daemon, so as not to block the
   encode), one access unit per request, output of 0 to N frames already reordered, flush and end of
   stream, plus a command for the backend to ask what the host decodes. **(2a) ✅ done on 06/10/2026**,
   host only: `protocol.h` (`VAAPI_CMD_HWDEC`, `VAAPI_CMD_HWDEC_CAPS`), the daemon built with `HWDEC=1`
   and a reference client in C (`hwdec_client.c`) that serves as a guide for the Android component.
   Verified on Polaris, Iris Xe and the 5700G: all supported clips give frames identical to software
   **through the daemon**, two simultaneous streams run at once, and a codec without hardware (VP9 on
   Polaris) is rejected. **(2b) zero-copy frames: pending, and only if needed.** Frames currently travel
   as bytes (compact NV12/P010): up to 1080p it is cheap (~93 MB/s in NV12, a few % of one core); the
   copying only hurts at 10-bit 4K (~25 MB per frame, ~750 MB/s at 30 fps). With a 720p or 1080p screen,
   YouTube rarely asks for 4K, so it is measured before building it. The natural route is the inverse of
   the encoder's: Android allocates the output buffer and passes its fd to the daemon, which decodes and
   blits with VPP there; (3) on the Android side, a Codec2 component with delayed output for the
   B-frames, rebuilt with AOSP, and dynamic registration in `media_codecs.xml` according to what the host
   supports; (4) validate bit by bit against software and measure CPU on Polaris, Iris Xe and 5700G, with
   real content (SmartTube); (5) record the per-codec capabilities in the combinations database (one
   `chequeo` per codec, e.g. `hwdec.h264`, `hwdec.hevc10`, `hwdec.vp9`).

   **Difficulty: High** — with VA-API, whoever decodes has to build the buffers of every frame and handle
   references and reordering, and the Codec2 component goes from one-request-one-frame to delayed output.
   **Its own gate** (it does not block the one below): play H.264 High at 720p/1080p, and VP9/HEVC where
   the hardware supports it, on an instance on AMD and on Intel with hardware decode, with output
   equivalent to software's and a clearly lower CPU use.

   **Results on n02 (Iris Xe) with SmartTube, 06/10/2026** (hardware decoders in the instance, a
   1280x720 screen, scrcpy connected at the same time): 720p and 1080p at 24 fps smooth (0 dropped
   frames), 720p at 60 fps AVC smooth, a higher-resolution 60 fps H.264 with stutter (more than half the
   frames dropped), 2160p VP9 does not keep up, and **HDR (VP9 profile 2, 10-bit) fails** because the
   component rejects 10-bit output. The current path does GPU→RAM→socket→copy to
   gralloc→compositor (which rescales to the screen)→conversion→encode, all in one thread per stream.

   **Critical finding (06/10/2026): P010 restarts the whole of Android in redroid.** Gralloc's allocator
   service (`gralloc_gbm_bo_create`, gralloc.gbm.so) dies with SIGFPE (division by zero) when allocating
   a P010 buffer, and since the allocator is critical, zygote and system_server restart: on the n02
   instance (Iris Xe) scrcpy was left pointing at the old system and looked hung. It was triggered by
   `getHalPixelFormatForBitDepth10` / `isHalPixelFormatSupported`, which allocate a test buffer. The
   component now **neither requests nor queries P010**: 10-bit output (HEVC Main10, VP9 profile 2) is
   delivered as 8-bit YV12 with the high 8 bits (verified bit by bit against ffmpeg on Polaris). No real
   HDR or 10-bit range, which scrcpy does not preserve either. Pending: Android's software decoders make
   the same query with 10-bit VP9 and will probably bring the system down on this image (untested); it
   is a redroid gralloc bug to report upstream.

   **Known limitation of this stage (decided 06/10/2026):** SmartTube keeps offering UHD and HDR formats
   in its menu even though the instance's screen is 720p and does not declare HDR (it does not filter by
   screen). Provisional solution: set the default maximum quality in SmartTube (e.g. 1080p 60 fps VP9
   without HDR), which the player respects. HDR is deliberately not hidden: the decoder accepts it and
   delivers it as 8-bit, whereas removing those profiles would send the video to software decoders that
   would probably restart Android. It is reviewed once the advertised-resolution limit exists (point 3).

   **Per-stage measurement (06/10/2026, Polaris on jgustavo46, through the full Android path;
   `REDROID_FORGE_HWDEC_STATS=1` prints these averages when each session closes).** Milliseconds per
   frame, daemon side:

   | clip | MB/frame | GPU wait (decode) | GPU→RAM download | compact copy | build queue | socket write | daemon total |
   |---|---|---|---|---|---|---|---|
   | H.264 720p60 | 1.4 | 0.5 | 2.5 | 0.1 | 0.6 | 1.2 | ~5.2 (31 % of a core at 60 fps) |
   | H.264 1080p | 3.1 | 0.7 | 4.3 | 0.2 | 0.9 | 3.2 | ~9.6 |
   | HEVC 4K | 12.4 | 2.6 | 13.6 | 1.6 | 2.9 | 4.6 | ~26 (ceiling ~38 fps) |

   **What dominates is the GPU→RAM download (50-55 %), not the decode** (0.5-2.6 ms, the GPU has plenty of
   headroom). 12.4 MB in 13.6 ms is ~0.9 GB/s: slow video-memory reads, typical of mapping the surface
   with `vaDeriveImage` on a discrete GPU (the `av_hwframe_transfer_data` route). Next come the CPU copies
   (queue + socket + conversion in Android, serial in one thread) and, last, the decode. At 60 fps the
   budget is 16.7 ms per frame: 720p and 1080p fit, 4K does not. Intel was not measured (n02 paused for
   RAM) nor the Android side (socket read and copy into the block), which adds to the total.

   **Improved GPU→RAM download (06/10/2026, Polaris).** `av_hwframe_transfer_data` (ffmpeg) was compared
   against `vaGetImage`, `vaDeriveImage` + a normal copy and `vaDeriveImage` + SSE4.1 non-temporal loads
   (`REDROID_FORGE_HWDEC_DOWNLOAD=ffmpeg|getimage|derive|derive-sse`). The three direct modes give frames
   identical to ffmpeg. Download + compact copy per frame and end-to-end fps through Android: 720p60
   2.4→1.0 ms (160→188 fps), 1080p 4.3→1.9 ms (82→134 fps), 4K 14.6→8.3 ms (31→37 fps). **`derive-sse` is
   the default**, with a self-check: the first frame of each session is also downloaded through ffmpeg and
   compared byte by byte; if the direct download fails or differs (Intel tiling, another driver) the
   session goes back to the ffmpeg path and reports it on stderr. **Not tested on Intel (Iris Xe) or the
   5700G**: it may fall back to ffmpeg there, or gain less, and it has to be measured. With this, what is
   left as the daemon's most expensive parts are the queue and the socket (~3 ms per frame at 1080p).

   **Frames through shared memory (06/10/2026, Polaris).** The daemon creates one memfd per session (512 MiB
   virtual, it only occupies what the frames write), sends it through SCM_RIGHTS in the open response
   (`HwDecOpenRequest.flags = VAAPI_HWDEC_OPEN_SHM`) and downloads every frame directly there; the component
   maps it read-only and copies from there into the gralloc block. Two copies fewer per frame remain (the
   daemon's queue and the `write`/`read` through the socket) and the queue + socket time goes from ~3 ms to
   ~0. Without the flag the protocol is still the inline one as before. Frames identical to the reference in
   all clips (8 and 10 bits). Pure performance (`NO_HASH=1`, without verifying pixels), hardware against
   Android's software decoder on the same machine: H.264 720p60 431 vs 298 fps, H.264 1080p 222 vs 125,
   HEVC 1080p 196 vs 196, HEVC 4K 55 vs 70. **The value is the CPU it leaves free, not the fps:** total host
   CPU per 100 frames (it includes the tool and the framework in both cases): H.264 1080p 0.64 s with
   hardware against 2.44 s with software (3.8x less), HEVC 1080p 0.72 against 2.14 (3.0x less), HEVC 4K 1.69
   against 5.62 (3.3x less). Pending: the seccomp `.policy` now carries `recvmsg` (it is not enforced in
   redroid, but it is on a real device); and measuring Intel and the 5700G.

   **Validation in real use (06/10/2026): success.** SmartTube on an instance of jgustavo46 (Polaris, El
   Cóndor), viewed through scrcpy from Patagones (two cities, two ISPs, no direct Tailscale connection: it
   goes through a DERP relay), playing a 1080p 60 fps AVC 7.7 Mbps video from a 16K test channel: hardware
   decode and encode at the same time, 0 frames dropped by the player, the daemon at 10-20 % of a core,
   impeccable quality and a very slight stutter in scrcpy. What is recorded as an improvement, not as a
   blocker:
   - ✅ **Done (07/10/2026): the encoder now honors the bitrate.** It used to ignore it (fixed QP 26; `EncodeRequest` did not carry it
     and the Android component did not read it). Now the component declares `C2_PARAMKEY_BITRATE` and sends it with every frame
     (`EncodeRequest.bitrate`; an older component without the field is accepted as "not specified" and keeps QP 26), and
     the daemon steers the QP of every frame (`ratectl.h`: all-intra sizes follow `C * 2^(-QP/6)`, complexity re-estimated
     per frame, a decaying debt term, budget measured in time so variable-rate sources work). The hardware stays in CQP, so
     it works the same on any driver. Measured on Iris Xe with `screenrecord` over scrolling content: asked 2 / 8 Mbps
     -> 2.3 / 7.5 Mbps (it was ~50 Mbps at 720p60); a bitrate above what the content needs just floors at QP 14. Simulation
     test: `test/ratectl-test.c`; `REDROID_FORGE_ENCODE_STATS=1` prints the real bitrate every 5 s. Original finding: scrcpy asks for 8 Mbps and the daemon encodes at ~50 Mbps
     at 720p60: it explains the very high quality and the slight stutter on the remote upload. Solution:
     CBR/VBR control in the daemon (bitrate and fps field in the protocol, a rate-control attribute in
     `vaCreateConfig`, VA-API miscellaneous parameter buffers). Encode phase, after the first version. A
     possible quick test: an environment variable to raise the QP.
   - **Intermittent hang of the Polaris VCE** (`ring vce0 timeout`, attributed to `daemon:cs0`, GPU reset with
     `VRAM is lost`), **2 times in ~16 min** of 1080p60 playback + scrcpy (22:33 and 22:49): after the reset,
     surfaceflinger and systemui abort in Mesa and Android restarts. On the second, the daemon had been idle
     for ~10 s (0 % CPU) and hung with the first frame on resuming: suspected VCE reactivation after idling
     (power gating) or the 300→2000 MHz memory clock jump, unverified. The low clock (300 MHz) is stable on
     that GPU. If it repeats: cross-check with `pp_dpm_mclk`, try disabling the VCE power gating
     (`amdgpu.ppfeaturemask`) or pinning the power state. No repro with decode alone.
   - **The daemon was not relaunched** after dying (the GPU reset aborts it with SIGABRT: "The CS has
     cancelled because the context is lost"), leaving all instances without encode or decode until the next
     `ensureDaemonRunning()`. ✅ Done: a supervisor in `hwAccel.js` that relaunches it with increasing wait
     (1 s, doubling up to 30 s; back to 1 s if it lived more than a minute). Tested by killing it with
     SIGKILL: it comes back in 1 s.

   **Intel Iris Xe (n02, 07/10/2026): all verified.** H.264 720p/1080p, HEVC 1080p, HEVC Main10, VP9 and VP9
   profile 2 (10-bit): frames identical to the reference (0 different) in the three codecs, with shared
   memory and the direct download through `vaDeriveImage`+SSE: **on Intel it did not fall back to the ffmpeg
   path** (the first-frame self-check passed). Bug fixed in this test: the VP9 CSD that Android delivers (the
   WebM `CodecPrivate`, which starts with 0x01) was being prepended to the first frame as if it were
   SPS/PPS and libavcodec rejected it (`frame_sync_byte_0 out of range`); now only H.264 and HEVC get the
   configuration prepended. Total host CPU per 100 frames (test tool, which also copies every frame into a
   ByteBuffer: a player with a surface does not pay that), hardware against Android's software decoder:
   H.264 1080p 1.99 s against 5.32 s (2.7x less), HEVC 1080p 1.80 against 4.87 (2.7x less), VP9 1080p 1.72
   against 2.46 (1.4x less), VP9 720p 1.02 against 1.26 (1.2x less). **The VP9 saving is modest**: libvpx is
   very efficient and the fixed cost of the path (copying 1.4-3 MB per frame into gralloc, and the
   framework) weighs. In fps, VP9 software wins (116 against 93 fps at 1080p) and HEVC ties. n02 uses a
   laptop CPU and had its development stack running in the background.

   **AMD 5700G / Vega (server01, 07/10/2026): all verified, without touching production.** A test instance
   (backend on port 8099, adb 5700, binder slot 5, its own containers and volume) coexisting with the 6
   dashboard instances, which stayed **identical** (the same containers and dates, the same binderfs, the same
   ports); when finished, everything was dismantled, including the binderfs nodes and the official image that
   had been pulled. The 5700G registers H.264, HEVC and VP9: the three codecs, in 8 and 10 bits, give 0
   frames different from the reference, with shared memory and direct download (without falling back to
   ffmpeg). Decode only, short clips, no scrcpy, so as not to load the GPU shared with the production
   instances (a GPU reset would affect all of them); CPU was not measured because of production's background
   noise. To coexist with another orchestrator `REDROID_FORGE_BINDER_RESERVED` was added (a list of binder
   slots not to reuse): the backend only knows the slots of its own registry and, with an empty registry, it
   would have picked slot 1 and reused the binder of a foreign instance. Incidental: on this machine
   Android's software decoders give a 1080p different from the reference (the hardware ones, identical).
   **Verified platforms: AMD Polaris (jgustavo46), Intel Iris Xe (n02) and AMD 5700G (server01).** NVIDIA is
   left for last, as decided.

   **Next batch of hwdecode (order decided 06/10/2026):**
   1. ✅ Measure time per stage (table above). The Android side and Intel are missing.
   2. ✅ 10-bit output in the component: HEVC Main10 and VP9 profile 2, as 8-bit (see the finding above).
   3. **Advertised-resolution limit = the largest standard step (240/360/480/720/1080/1440/2160p) that fits
      in the instance's screen, rounding down, with a floor at 720p**, and never above what the hardware
      decodes (the daemon reports that). It is applied when the instance is created (`media_codecs.xml` and
      the size limit of the Codec2 interface); a screen change requires recreating or re-patching. To check
      with SmartTube: the software decoders keep declaring 4K and a player that looks at the maximum across
      all of them could keep offering UHD.
   4. Cheap gains according to the measurement (✅ download through `vaDeriveImage`+SSE done; ✅ shared memory
      done; the staged threads and SIMD on U/V are missing): staged threads (decode N+1 while N is downloaded
      and sent), `vaCopy` instead of reading video memory with the CPU, shared memory (memfd) instead of a
      socket, SIMD in the U/V separation.
   5. If that is not enough, 2b (zero-copy): it keeps the frame on the GPU end to end; the compositor
      rescales it without going through the CPU. Risk: whether redroid's gralloc accepts the format and
      tiling modifier.
   Scaling inside the daemon before downloading the frame saves a copy but changes the size the app sees:
   only as an explicit option, never by default.

   **HDR (noted 06/10/2026): it is not preserved through scrcpy today, and it blocks nothing.** Redroid's
   screen does not declare HDR (`supportedHdrTypes=[]`, no wide color), scrcpy 4.1 has no HDR/10-bit
   options, and the encoder is 8-bit H.264: HDR video arrives as SDR. Preserving it end to end would be
   another project (an HDR display in Android, HEVC Main10 encode, a scrcpy and a client that handle it).
   **scrcpy changes fast:** it is a point to **review periodically**, because a new version could cover part
   of this. The value of this goal is the CPU saving and codec compatibility, not HDR fidelity.

**Gate:** an instance created from `redroid-forge` reproduces the same acceleration behavior already
validated separately, on at least one real AMD/Intel host and one real NVIDIA host.

## Phase 3 — Fake WiFi + device profile spoofing

**Difficulty: Medium** — code already written and tested elsewhere (`jg-dashboard`); the work is porting it
and adapting the `build.prop` paths that are already known to vary per image.

**Steps:**
1. Port `DEVICE_PROFILES`/`buildDeviceProfileScript` from `jg-dashboard` (`redroid.service.ts`) to the new
   backend. ✅ done — `backend/src/lib/deviceProfile.js` (`samsung` profile, revert to `redroid` restoring
   from backup), wired into `POST /instances/:id/device-profile` (gated by its manifest, see
   `assertDeviceProfileReady` in `routes/instances.js` — it is opt-in per request, not a module required by
   any image, so it does not go through `moduleGate.check` but through `moduleAcceptance.isAccepted`
   directly). Coverage in `backend/test/deviceProfile.test.js`.
2. Confirm that the fake WiFi ported in Phase 0 remains intact. ✅ done — the same behavior and log messages
   as before, covered by the existing `hwsimWifi.js` tests plus the new concurrency ones (step 4).
3. Validate applying/reverting a profile (e.g. `samsung`) from the new UI. **[PENDING]** — no UI has been
   added yet (this round of work was limited to the HTTP endpoint), and in any case this needs a host with
   real Docker to be validated, not available in the environment where this port was done.
4. **Fix the known race condition of `ensureHwsimWifi`**. ✅ done in code — `hwsimWifi.js` now serializes
   every claim of a phy/iface pair through a module-level promise queue (`hwsimClaimTail`/`runHwsimClaim`),
   with the same nuance of "do not reload `mac80211_hwsim` if another instance still has phys in use".
   **Correction to this very entry:** when writing the code, the reference method
   `claimHwsimPhyPair`/`hwsimClaimTail` that this entry said already existed in
   `jg-dashboard/redroid.service.ts` was looked for — **it does not exist there** (the repo was cloned and
   the whole file reviewed). What does exist in that file is the nuance of "0 free phys, is any other
   instance using them?" inside `ensureHwsimWifi` (with no queue/serialization — that file has the same
   race today) and the general promise-queue pattern at service level (`bootQueueTail`, used for something
   else, the startup order). The fix here was designed by applying that same pattern to the hwsim problem,
   not by copying a method that does not exist. **Validated only with a mocked unit test**
   (`backend/test/hwsimWifiConcurrency.test.js` — it mocks `child_process.execFile`/`dockerRuntime`,
   simulates 2 concurrent calls against a shared host state and verifies disjoint claims); **not yet tested
   against a real dual-instance startup race on hardware** — attempted on 22/10/2026 directly against
   `jg-dashboard` v1's production instances on server01 (not redroid-forge's own port, there is no catalog
   image wiring `needsHwsimWifi` yet to create a real redroid-forge instance with it) by reloading
   `mac80211_hwsim`, which **broke 3 real production instances** (destroyed the phys already living in their
   netns) — recovered via the dashboard's own stop/start API, no data lost. **Do not reload
   `mac80211_hwsim` on a host with other live hwsim users again** — if this needs re-testing, do it on an
   isolated host or during an announced maintenance window, never opportunistically next to production.
   Real root cause of the *operational* symptom this gate cares about (several restarts needed before WiFi
   takes) turned out to be different from the race itself — see the dashboard-side bug found and fixed the
   same day, next paragraph.

5. **Real root cause of the "needs several restarts" symptom, found and fixed in `jg-dashboard` v1 (not
   redroid-forge) on 22/10/2026 — port the fix here too when wiring an instance's `needsHwsimWifi`.** Phys
   moved into a container's netns tie their lifecycle to it: if Docker tears the netns down while a phy is
   still inside (a plain `stop()`), the kernel frees the phy instead of returning it to the host's default
   netns — confirmed for real (`iw phy` showed them gone after a stop, back after adding the fix). With a
   pool sized exactly to the number of WiFi-capable instances (no slack), any one leaked phy permanently
   starves one instance until every WiFi instance happens to be down at once (the only path that re-triggers
   a full `modprobe` reload). Fixed in `jg-dashboard/api/src/remote/redroid/redroid.service.ts`
   (`releaseHwsimPhys`, called before `stop()`/`delete()`/the two device-profile-triggered `restart()`s) —
   validated with 3 consecutive real stop/start cycles on a live production instance, WiFi connected on the
   first try every time (previously intermittent). **`hwsimWifi.js` here has the same gap** (only ever moves
   phys IN via `claimHwsimPhyPair`, never OUT before a stop) — port the same fix (release on stop, using
   `nsenter -t <pid> -n iw dev` + `iw phy <phy> set netns 1`, matching `parsePhyIfacePairs`) once an instance
   actually uses this module for real, before trusting it in production.

6. **Found and fixed on 22/10/2026, validated against real Docker (the Phase 3 gate's "needs a host with
   real Docker" is now met for this part): `dockerRuntime.exec()` never set `Env`, so a bare `docker exec`
   got a generic Linux `PATH` without `/system/bin`/`/system/xbin` — every `su`/`ip`/`getprop` call failed
   with "executable file not found in $PATH" despite the binaries being right there.** Fixed centrally in
   `dockerRuntime.js` (`ANDROID_EXEC_ENV`), not per caller. **Second, separate bug found in the same pass:
   toybox's `su` (the official redroid image) parses its first argument as a WHO/uid, not a `-c` flag** —
   `su -c '...'` fails with `su: invalid uid/gid '-c'`; the portable form is `su 0 sh -c '...'`. Fixed in all
   4 call sites (`deviceProfile.js`, `hwsimWifi.js` ×3) and their test (`deviceProfile.test.js`'s index-based
   assertions updated to the new 5-element array shape). **Validated for real**: applied the `samsung`
   profile to a live instance via the real API, confirmed with `getprop ro.product.brand` → `samsung`;
   reverted, confirmed back to `redroid`. Not yet known whether this exact `su` syntax issue also affects
   `jg-dashboard`'s own `su -c` calls — checked by hand for its wifi-v3 image (a different, Magisk-ish `su`
   that DOES accept `-c`) and it does not reproduce there; don't assume it's fine on every image without
   checking its `su` the same way.

7. **Renamed to "wifi-interno" and wired as a real per-instance optional module, 23/10/2026** (the
   catalog's own `needsHwsimWifi` flag/field keeps its name -- only the user-facing module id
   changed, matching `kernel/virt_wifi/README.md`'s naming note: "wifi-interno" over "fake-wifi"/
   "wifi-falso", same idea, no negative framing). `wifi-falso.json` → `wifi-interno.json`; added to
   `moduleGate.OPTIONAL_PER_INSTANCE` (an image can still FORCE it via `needsHwsimWifi`, same dual
   pattern as gapps/`hasGapps`, but any image can now also have it opted into per instance). Exposed
   in the frontend both at creation (a checkbox next to gapps/arm-translation) and on an existing
   instance (its own column + edit row, reusing the exact `/:id/display` recreate route and 428
   contract-gate flow already used by the hwenc/hwdec codec toggle). `scheduleWifiFixes` (the trigger
   that actually runs `hwsimWifi`'s claim) now reads `requiredModuleIds` directly instead of a
   separately-cached `needsHwsimWifi` boolean that was never recomputed on an edit -- the previous
   field would have gone stale the moment someone toggled this through the new edit UI.
   **Validated for real** against this host's real Docker: created an instance with `wifi-interno`
   (428 contract gate fired correctly, accepted, created, 2 phys claimed into its netns, confirmed via
   `iw dev`), toggled it off through the edit route (recreated, no new claim), stopped/deleted it
   (host phy count back to the full pool of 6 both times).
   **Attempted but not actually working: porting jg-dashboard's `releaseHwsimPhys` (phy-release-
   before-teardown) fix**, flagged as needed in step 5 above "once an instance actually uses this
   module for real" -- which, as of this step, it now does. Wired into stop/restart/delete/the
   display-recreate path (`hwsimWifi.releaseHwsimPhys`, same `nsenter -t <pid> -n iw dev` discovery
   as jg-dashboard). The move itself (`iw phy <phy> set netns <target>`, also nsentered into the
   instance's netns so the phy is visible to the caller) **reproducibly fails** on this host with
   "No such file or directory (-2)" -- tried the plain non-nsentered form, a valid non-"1" target
   pid, and confirmed `iw dev` succeeds in the exact same nsenter call right before it; root cause
   not found (likely some nl80211 netns-ownership check on the SET_WIPHY_NETNS path that the claim
   direction, which always moves FROM the caller's own current netns, never exercises). Despite that,
   phys were empirically observed to correctly return to the host's default netns on their own after
   both a plain stop() and a display-triggered recreate on **this** host/kernel -- so whatever bug
   jg-dashboard hit there may simply not reproduce here, or only under conditions these two tests
   didn't exercise. Left in place as a harmless best-effort (logs at `log()`, not `warn()`, so it
   does not cry wolf on every stop -- see the function's own comment in `hwsimWifi.js`), **not** as a
   trusted safety net -- re-investigate (strace/kernel source, or just re-test on whichever host ends
   up running this in anger) before relying on it. The actual safety net today is still
   `claimAndAssignHwsimPair`'s own "0 free phys → reload mac80211_hwsim" fallback.

**Gate:** the profile spoof can be applied/reverted from the new UI, with the correct `build.prop` files
according to the image, and restarting two or more instances with fake WiFi at the same time leaves none
without radios. **Partial:** the concurrency fix, the profile spoof (via API, now verified against real
Docker, not just a mock), the exec PATH/su-syntax bugs, the phy-leak-on-stop root cause, and wiring
`wifi-interno` as a real per-instance module (step 7) are all done; missing to close the gate completely:
re-validating the concurrency fix (two instances claiming at once) on real hardware under a safe
(non-production) setup, and resolving the phy-release-on-stop gap above for good (it may simply not be a
real problem on this host, but that has not been confirmed either way under the exact conditions
jg-dashboard's incident happened under).

## Phase 4 — Generic module contract system

**Difficulty: Medium** — new design, but bounded: a manifest schema, a generic modal, and a record of the
accepted version. There is no ambiguity of scope, it only has to be built.

**Steps:**
1. Define the manifest schema (section 5 of `REQUIREMENTS.md`). ✅ done — a hand-written validator (without
   adding a JSON Schema dependency) in `backend/src/lib/moduleManifests.js`, one JSON manifest per module in
   `backend/src/modules/manifests/`.
2. Build the generic contract modal that renders it (frontend). ✅ done — `frontend/contracts.js`, a single
   dialog for the 6 modules.
3. Implement the per-version acceptance record in the backend, and the blocking of execution without a
   current acceptance. ✅ done — `backend/src/lib/moduleAcceptance.js` (record) +
   `backend/src/lib/moduleGate.js` (blocking), hooked into create/start/restart of `routes/instances.js`.
   With no auth yet (Phase 6), the acceptance holds for the whole installation, not per user.
4. Retrofit: move GApps, Magisk, fake WiFi, device profile, GPU mode, CPU/RAM to this generic contract
   instead of ad hoc toggles. ⚠️ partial — GApps and fake WiFi (which did have ad hoc enablement logic tied
   to image flags) are retrofitted and gated; Magisk adds its flag (`hasMagisk`) and goes through the same
   gate for the first time. Device profile, GPU mode and CPU/RAM **had no execution logic ported yet**
   (they remain pending from Phases 2/3) — they have their manifest and can already be queried via `GET
   /api/modules` (including `compatibleCon`), ready to be hooked to `moduleGate` as soon as their real
   execution exists.
5. Implement `compatibleCon` (deferred from Phase 1): the manifest declares the compatible Android
   version/GPU mode, and the backend does not offer the module if the chosen image does not meet it. ✅ done
   — `moduleManifests.isCompatible`/`incompatibilityReason`, reusing the `androidVersion`/`gpuMode` fields
   the catalog has had since Phase 1 (without duplicating that metadata). `moduleGate.check` applies it
   before creating/starting; `GET /api/modules?imageId=` exposes it so that a future optional-module
   selector can query it.

**Gate:** activating GApps (the non-free reference case) requires reading and accepting a contract generated
from a manifest before the backend runs anything.

## Phase 5 — User-defined modules + CIFI pilot

**Difficulty: High** — there is no prior convention inside the project for this (it is design from
scratch, although with external references), and the pilot case (CIFI) is a script with known subtle bugs
(inheritance of the `adb` lock after reboot) that must not be reintroduced when migrating it.

**Steps:**
0. ⬜ Open — **Known-combinations database + GApps/Magisk modules on top of the official image** (decision
   05/10/2026, see `REQUIREMENTS.md` section 2). It replaces the catalog's custom images (`gapps-official`,
   `wifi-v3`): the base is the official image pinned by digest, and GApps/Magisk are injected per instance
   from packages with a known version and `sha256`, verified before use. It includes: the database format,
   a snapshot included in every release, an optional update from the external repo with verification, and
   an "unsupported" tier for whatever is not in the database. Design in `docs/KNOWN-COMBINATIONS.md` (a
   7-sub-step plan). Sub-step 1 ✅ done: the pure core `backend/src/lib/knownDb.js` (validation, support
   resolution, anti-rollback `serial`, ed25519 signature) + the seed snapshot `backend/db/snapshot.json` +
   tests. **It is not yet wired** into instance creation. Sub-step 2 ✅ done: a read-only API (`/api/db`,
   `/api/db/combinaciones`), loading by `serial` with a fallback (`knownDbStore.js`) and a Doctor check;
   snapshot at `serial` 2 with the Intel Iris Xe validation. Sub-step 3 ✅ done: download + ed25519
   signature verification + anti-rollback + atomic update (`knownDbUpdate.js`) and the signing tool
   `backend/scripts/db-sign.js`. The maintainer's key was generated on 05/10/2026
   (`backend/db/trusted-keys.json`) and the `fogelmanjg/redroid-forge-db` repo was created; without trusted
   keys nothing is queried or applied. The images used by `jg-dashboard`'s redroid keep being maintained
   there, but are not relevant to `redroid-forge`: they are separate projects and do not have to be
   compatible with each other.
1. ✅ **Done, partial** — Designed and implemented the convention for modules with execution logic tied to
   the **lifecycle of an instance** (stages 3-6, see `docs/ARCHITECTURE.md` section "Phase 5: the generic
   runner and the `etapa`/`entry` convention"): a manifest with `etapa`/`entry`, `entry` resolved relative
   to the module's folder, a fixed export name per stage (`prepareCreate`/`integrate`/
   `ensureHostInfraReady`/`ensureRuntimeReady`). It is **not** yet the "user module" convention this step
   originally asks for (periodic cron-style schedule + pause/resume/status, CIFI reference) — that one is
   still undesigned. What was solved is the most urgent and already real case of the project: `hwenc`
   (Phase 2) had integration logic written but wired by hand in `instances.js`, without any generic hook
   point.
2. ✅ **Done, including persistent scheduling (22/10/2026)** —
   `backend/src/lib/moduleRunner.js` orchestrates stages 3-6 from `instances.js` (create/start/restart),
   replacing the special-casing of `hwenc`/`hwAccel` that existed there. The **periodic scheduling**
   mechanism this step asked for (run every N minutes, persistent pause/resume/status, for CIFI-style
   watchdogs) is now designed and implemented too: stage 7 (`etapa: [7]`, a manifest `schedule.intervalMs`,
   an entry exporting `runTick(instanceId, containerId)`) plus `backend/src/lib/moduleScheduler.js` (one
   `setInterval` per instance+module, pause flag persisted on the instance record, `GET`/`POST
   /api/instances/:id/watchdogs(/:moduleId/pause|resume)`) — full design rationale in `docs/ARCHITECTURE.md`
   section "Phase 5: stage 7, the periodic watchdog". This phase's runner now covers both "what runs at the
   moment of creating/starting an instance" (3-6) and "what runs in a loop while the instance lives" (7).
3. ✅ **Done (22/10/2026)** — Ported the CIFI watchdog (`backend/src/modules/cifi/`) onto the stage-7
   convention, replacing the cron script + `flock` conceptually (the script itself,
   `~/scripts/cifi-watchdog.sh`, was not touched/removed — this is the redroid-forge side, a separate
   project per the Phase 7 clarification above). The original's exact tap positions/retries/timing were
   kept; what changed is talking to the instance via `dockerRuntime.exec()` instead of spawning real `adb`
   — which also means the **inherited-lock bug from step 4 cannot recur here**: there is no `adb` daemon
   for a watchdog tick to spawn or inherit a file descriptor from, dockerode's exec API never shells out.
4. **Superseded by step 3's design, not separately validated.** The inherited-lock bug was specific to
   spawning real `adb` from a cron job (see the original script's own top comment) — moving the watchdog
   to `dockerRuntime.exec()` removes the mechanism that bug depended on, so there is nothing of that
   specific kind left to validate live for days. What IS still open: a real multi-day run of the CIFI
   module itself against a live instance with the actual game, to catch anything else unrelated to the
   adb-lock bug (see the `[PENDING]` note below).
5. ⬜ Open — A second pilot, the same mechanism: the persistent fake-WiFi reconnection watchdog (today
   hardcoded in `jg-dashboard`, see `claimHwsimPhyPair`/`wifiWatchdogs` in `redroid.service.ts`) migrates
   to a script-module instead of being ported as is. Good next exercise of the now-implemented stage 7,
   since the logic to port already exists and is already proven in production.

**In addition to what was originally asked in steps 1-2** (a positive side effect of leaving the lifecycle
runner properly generic, not ad hoc for hwenc): `hwenc` went through the same contract gate as
GApps/Magisk/fake WiFi, derived from `img.hwEncCapable`. **Update 10/10/2026:** `hwEncCapable` now only
says "this image supports hwenc", and hwenc is an **optional module of each instance**, on by default
when the image supports it: `POST /api/instances {"modules": [...]}` lists exactly the optional modules
(`gapps`, `hwenc`) the instance gets, and omitting `modules` keeps the previous behavior (hwenc on). An
instance that opts out stays out across restarts (its choice is persisted in `requiredModuleIds`).
`GET /api/modules` also reports `hostCompatible` (the host's GPU vs `compatibleCon.hostGpuVendor`), so
the UI offers the option only where it can work. The create form exposes width, height, dpi and fps,
validated on the server (`lib/instanceParams.js`: they end up in the kernel command line).

**[PENDING] nothing of what was done in steps 1-2 was validated against a real host with Docker/redroid**
— there is only unit-test coverage with fixtures/mocks (`backend/test/moduleRunner.test.js`,
`backend/test/moduleContract.test.js`). Before using this with real hardware, run the complete flow
(create → inject into `/vendor` → start → post-boot fixup) against the official redroid image on an
AMD/Intel host. The same caveat applies to stage 7/step 2-3 (22/10/2026 addition): unit-tested only
(`backend/test/moduleScheduler.test.js`, `backend/test/cifiWatchdog.test.js`), not run yet against a
real host.

**Gate:** CIFI runs as a module inside `redroid-forge` (pause/resume/status from the app, no manual cron
editing), validated live without the known bug reappearing. **Partial** — CIFI runs as a module with
real pause/resume/status via the API (steps 1-3 done), and the specific bug the gate names (the adb-lock
inheritance) cannot reappear by construction (step 4). **Not met yet**: no live validation against a real
host with the actual game (steps 3-4's remaining half), and step 5 (the second pilot) is still open.

## Phase 6 — Network exposure: local by default, interfaces opt-in

**Redefined (24/10/2026)** from the original "Optional authentication (Keycloak)" into a broader
**"Security and integration with external tools"** theme, split across this phase and the next three.
Written for anyone running this, not tuned to any one deployment: someone on a Debian desktop running one
or two instances to play a game gets a locked-down, zero-config default and never has to think about any
of this; someone running a farm of instances as a sysop gets every knob below, documented well enough to
use them.

**Difficulty: Low-Medium** — no new dependency, it is tightening defaults that are already wrong and
adding a per-resource choice on top.

**Problem, confirmed in code, not hypothetical:** `redroid` itself has no access control of any kind — ADB
on 5555 answers anyone who can reach it. Today, nothing stops that reach: `dockerRuntime.js`'s `create()`
hardcodes `HostIp: '0.0.0.0'` on every instance's port binding (reachable from every host interface, LAN
included), and the app's own UI/API runs under `network_mode: host` in `docker-compose.yml` with no bind
address of its own either — so even an instance that *is* properly locked down doesn't help if the thing
that can create/delete/start/stop it is itself reachable from anywhere.

**Steps:**
1. The app binds to `127.0.0.1` by default; an env var overrides it for whoever deliberately wants it
   reachable beyond the host.
2. Each instance's ADB port binds to `127.0.0.1` by default too (fix the hardcoded `0.0.0.0`).
3. Discover the host's network interfaces (name + address) and surface them in the UI.
4. Per-instance interface selection (multi-select — Docker supports binding the same container port to
   several host interfaces at once, e.g. localhost **and** a Tailscale IP simultaneously), applied through
   the existing recreate mechanism (another sub-section in the "Configure" panel, same pattern as
   resolution/codec/WiFi).
5. A clear, non-blocking warning wherever an interface other than localhost is chosen while no auth
   (Phase 7) is configured — warn, never hard-block, consistent with how the rest of the app already
   handles risky-but-legitimate combinations (known-combinations tiers, restore mismatches).

**Gate:** a fresh install with zero configuration answers only on localhost, for both the app and every
instance; any interface can be opened deliberately, per instance and for the app itself, with a visible
warning when that combination has no auth behind it.

**✅ Done (24/10/2026).** Steps 1-4 implemented and live-tested against real containers on this host (not
only unit tests): confirmed the app and a fresh instance both bind to `127.0.0.1` only by default, that an
instance opened on a LAN address is genuinely reachable there, and that a LAN address stays unreachable
when not opted into. Step 5's warning is unconditional for now rather than gated on "no auth configured" —
Phase 7 (the only thing that could make it conditional) does not exist yet. **Found and fixed along the
way, not anticipated by the original design:** `0.0.0.0` is not additive with a specific address on the
same port — Docker either rejects the combination outright (CLI) or silently publishes no port at all
(the Engine API dockerode uses, confirmed live, the more dangerous failure mode since nothing errors).
Both `instanceParams.parseBindHosts` and the Configure panel's "Network" checkboxes now treat
`0.0.0.0`/`::` as exclusive with everything else instead of letting that combination reach Docker.

## Phase 7 — Access control: roles, per-instance ownership, pluggable auth

**Difficulty: High** — a real permission model plus a generic (not Keycloak-specific) auth abstraction.

**Design:** "admin / user / instance owner" is not three flat roles — it is two independent axes. A
**global role** (what you can do at all: create for anyone, see/manage every instance, touch settings) and
**per-instance ownership** (a new `ownerId` field on each instance, set to whoever created it, or
reassignable by an admin). The example that motivated this: a user who can only see/start/stop the
instances they own, not create or delete any — that is a role with no create/delete capability, combined
with the ownership scope, not a fourth role.

**Steps:**
1. A small, fixed permission model: roles × a capability list (view, start/stop, create, delete,
   configure, backup/restore, manage settings) × ownership scope (own vs. any). Admin bypasses ownership
   checks.
2. `ownerId` persisted per instance; every protected route checks role + ownership before acting, and the
   UI hides/disables actions the current user cannot perform rather than only failing after the fact.
3. Pluggable auth backend, selected via an env var, default `none` (today's behavior, unchanged):
   - `none` — zero auth, any user sees/does everything (the Phase 6 default case keeps working exactly
     as before).
   - `local` — a minimal built-in account store (no external dependency) for someone who wants a login
     wall without standing up an identity provider.
   - `oidc` — a **generic OIDC client**, not a Keycloak-specific integration. Keycloak, Authentik, Auth0,
     Zitadel, etc. all speak OIDC, so supporting the protocol covers "any authenticator" without a
     per-provider integration. Maps OIDC roles/claims onto the permission model from step 1.
4. Confirm `none` stays behaviorally identical to today — this phase adds capability, it does not remove
   the zero-friction default.

**Gate:** with auth `none`, identical to today, any user sees everything. With `local` or `oidc`, two
different accounts genuinely get different capabilities, verified live (not just by code review) — one
limited to its own instances with no create/delete, another with broader access.

**✅ Done (24/10/2026).** Steps 1-4 implemented. `backend/src/lib/permissions.js` (role × capability ×
ownership, admin bypass, 404-not-403 for an instance invisible to the caller so IDs cannot be probed to
tell "not yours" apart from "does not exist"), `userStore.js` (`local` accounts, scrypt-hashed, no new
dependency), `session.js` (stateless HMAC-signed cookies, no `express-session`), `oidc.js` (generic OIDC
via `openid-client@5.7.1`, pinned to the last CommonJS release — v6 is ESM-only and this backend has no
build step), `auth.js` + `routes/auth.js` (the Express wiring and `/api/auth/*` routes), all gating every
route in `routes/instances.js`/`settings.js`/`backups.js`, plus a login screen, a logout button, an
admin-only Users panel, and per-capability hide/disable throughout the frontend. **Live-verified
end-to-end in `local` mode** (not just unit tests, same discipline as Phase 6): an admin, an operator and
a viewer account against the real running container — admin saw every pre-existing instance (created
before this phase, so ownerless) while operator/viewer saw none of them; the operator created its own
throwaway instance and could see/stop/delete it, the viewer could not see it at all (404, not 403) nor
create one of its own (403); `none` mode re-confirmed behaviorally identical to before this phase.
**Redesigned 25/10/2026 — OIDC is identity-only, roles are never read from the IdP.** The original design
in step 3 above ("maps OIDC roles/claims onto the permission model") conflated two things kept separate
on purpose from here on: proving WHO someone is (the IdP's actual job) and deciding WHAT they can do here
(this project's own job). User-driven redesign, same motivation as this project's own federation plans
below (Phase 8) — identity and permissions are meant to end up as two separable concerns, possibly
resolved by two different systems, not one IdP token doing both. `oidc.js`'s `handleCallback` now returns
only `{id, username}` (the `sub`/`preferred_username`), nothing role-shaped — `mapRole`, `rolesClaimPath`
and the three `*_ROLE` env vars are gone. A new `roleAssignments.js` is the actual "permissions backend"
for OIDC identities: a local table (`data/role-assignments.json`), keyed by the external id, admin-managed
through a new "Identities" panel (parallel to the local-mode "Users" one). **A brand new identity that has
never logged in before starts with NO role (pending) and cannot log in until an admin assigns one** —
deliberate, confirmed with the user: nobody gets in just by having an account on the IdP.
`REDROID_FORGE_OIDC_BOOTSTRAP_ADMIN_ID` solves the obvious chicken-and-egg (nobody could ever approve the
very first admin otherwise) the same way `REDROID_FORGE_LOCAL_ADMIN_USER/_PASSWORD` does for `local` mode,
except re-checked on every login rather than once, so logging in once to discover your own `sub` in the
data file, setting the var, and logging in again works without a restart in between. **Forward-looking
seam, not built yet:** `roleAssignments.resolveRole()` is the one function a later integration would need
to change to delegate to a real separate permissions service (e.g. Plenum, see Phase 8's own "reusing
Plenum's roles") instead of this local table — `oidc.js`, `auth.js` and the routes would not need to
change at all. Verified: unit tests only (`oidc.test.js`, `roleAssignments.test.js`) — no live IdP in this
environment, same gap as the paragraph below.

**Redesigned again, same day (25/10/2026) — OIDC is also multi-provider now.** User's own framing: "ask
Keycloak, ask Google, ask Plenum, ask Rio Negro's federation, whichever one actually vouches for this
person right now" — any number of trust sources configured at once, picked by the person logging in, not
one fixed provider baked into a handful of singular env vars. `REDROID_FORGE_OIDC_PROVIDERS` replaces
`REDROID_FORGE_OIDC_ISSUER_URL`/`_CLIENT_ID`/`_CLIENT_SECRET`/`_REDIRECT_URI` with a JSON array, one object
per source (`id`/`label`/`issuerUrl`/`clientId`/optional `clientSecret`); `REDROID_FORGE_OIDC_REDIRECT_BASE_URL`
derives every provider's own callback URL from its `id`, so adding a provider is one JSON object, never a
second place to register/keep a callback URL in sync by hand. The login screen fetches
`GET /api/auth/oidc/providers` (public) and shows one "Log in with X" link per configured source.
Because the same `sub` is only unique WITHIN one issuer's own namespace, every identity's external id is
now the composite `${providerId}:${sub}`, never the bare `sub` — `roleAssignments.js`'s rows gained
`providerId`/`providerLabel` (purely informational, shown in the admin "Identities" panel) but its actual
key, bootstrap-admin matching, and everything else about role resolution is unchanged, still per full
composite id. ⚠ Breaking, same deployment this applies to as the identity-only redesign above (none yet,
no live IdP ever configured in this project) — `REDROID_FORGE_OIDC_BOOTSTRAP_ADMIN_ID` now has to be the
full composite id, not a bare `sub`.

**Known gap, not yet verified:** `oidc` mode's live callback against a real IdP — no IdP was available in
this environment, so only its pure parts (enablement detection, PKCE/state bookkeeping, and now role
assignment in isolation) are unit-tested; worth a real pass against an actual Keycloak/Authentik instance
before relying on it. **✅ Closed 26/10/2026, see below.**

**Live e2e pass against a real IdP, plus five follow-on features (26/10/2026).** A throwaway Keycloak
(`redroid-forge-test` realm) stood in for "a real IdP" — this drove the first-ever actual callback
through `oidc.js` end to end, which immediately surfaced a real bug unit tests never could: the callback
route passed `oidc.handleCallback()`'s `{id, ...}` straight into `roleAssignments.upsertSeen()`, which
expects `{externalId, ...}` — `externalId` was always `undefined`, so `undefined === undefined` silently
collapsed every distinct OIDC identity onto the single first-ever-created row, and
`REDROID_FORGE_OIDC_BOOTSTRAP_ADMIN_ID` could never match anything real. Fixed by mapping the fields
explicitly at the call site. Confirmed live: login → "pending" (no role) → admin approval → re-login →
admin UI, exactly as designed.

That same live pass led to five more pieces, all user-driven mid-session:

- **`both` mode** — local accounts and OIDC providers on the same login screen at once (`auth.js`'s
  `LOCAL_ENABLED`/`OIDC_ENABLED`, derived from mode instead of a single string compare everywhere).
- **Unified Identities panel** — one table/API (`GET /api/auth/identities`) merging local accounts and
  OIDC identities (`source: 'local'|'oidc'`), plus a completed local ABM that did not exist before
  (`email`, `resetPassword`, `setRole` on `userStore.js` — previously create/delete only).
- **Explicit account linking** (`backend/src/lib/accountLinks.js`) — lets one person reach the same
  local account through several OIDC identities too. Design question the user raised first and wanted
  settled before building anything: should a self-claimed/IdP-claimed email ever be trusted to mean "same
  person" as an existing local account? No — an email is a claim, not proof, and claims can be reused,
  recycled or spoofed. The only safe proof of sameness is the person being logged in as BOTH sides at
  once, so a link can only ever be created from `/api/auth/me/links/:providerId/start` while already
  authenticated as the local account being linked TO — never derived from matching any field after the
  fact. Once linked, logging in via that external id mints a session AS the local account (same id, same
  role), bypassing `roleAssignments.js` entirely for that identity.
- **First-run setup wizard** — `none` mode previously had no in-app way to even create the first admin
  before flipping `REDROID_FORGE_AUTH`; `POST /api/auth/setup/admin` creates one live (no restart needed,
  `userStore.js` was always mode-agnostic), the Identities tab (now shown in `none` mode too, since the
  synthetic admin-bypass user already satisfies `isAdmin()`) shows the exact `.env` line and restart
  command (`REDROID_FORGE_REPO_DIR`, a new display-only env var threaded through from `docker-compose.yml`'s
  own `${PWD}`, so the instructions name a real path instead of a vague "find your .env somewhere"), and
  polls `GET /api/auth/me` until the mode actually flips — the subsequent login IS the end-to-end
  validation.
- **Self-lockout guard** — the wizard above only shows itself in `none` mode, so setting `local`/`both`
  with zero local users and no `REDROID_FORGE_LOCAL_ADMIN_USER`/`_PASSWORD` used to mean a permanently
  locked login screen with no way back in short of editing `data/users.json` by hand. `auth.js` now
  downgrades to `none` (or leaves `both` alone when an OIDC provider is configured — that half still has
  a working login button) whenever it computes, once at require time, that nothing configured could ever
  actually let someone in. Self-heals the instant a restart sees a real way in.

**Verified:** live, end to end, for every item above (the live-IdP OIDC flow, `both` mode, account
linking round-tripped through a real second login, the wizard's full create → instructions → poll →
restart → login cycle, and the lockout guard actually tripping and un-tripping on a real restart) — not
just unit tests, same discipline as every other phase. Unit coverage: 411/411 passing
(`accountLinks.test.js` new, `auth.lockout.test.js` new, `userStore`/`quotas`/`auth` tests extended).

**Redesigned again, same day (25/10/2026) — `ownerId` is a list, `createdId` is new, and operators get
resource quotas.** User's own motivating example: a household's shared TV instance of a game, meant to be
usable by more than one person at once ("romina y yo", later possibly a third person) — the old single
`ownerId` could not express that at all. Resolves the "reassign owner" gap this same paragraph used to
describe as unsolved.

- **`ownerId`** is now an array — every id in it can see/use the instance, scoped by their own role's
  capabilities exactly as before (`permissions.js`'s `ownerIds()` normalizes a legacy bare string or a
  missing field to an array too, so nothing from before this breaks). Always at least one id: an edit that
  would empty the list is rejected outright (`PUT /api/instances/:id/owners`, full replace, "transfer-
  ownership" capability) — there is no way to leave an instance ownerless or lock everyone out of it by
  mistake.
- **`createdId`** is a deliberately DIFFERENT question from `ownerId`: who the instance's resource usage
  counts against, for the quota below — "`createId` dice a quien le cuenta la cuota, `ownerId` quien lo
  puede usar" (the user's own framing). Set once at creation (the creator), mutable only through
  attribution (`PUT /api/instances/:id/created-by`): an operator can only "atribuírselo" to THEMSELVES, and
  only on an instance they already have access to (same ownership-scoped capability) — they can never
  attribute it to a third party, which would let them dump their own usage onto someone else's quota
  without that person's own action. Admin has no such restriction (admin already bypasses quotas
  entirely) — including attributing an instance to themselves as a deliberate "rescue", which exempts it
  from every quota from then on.
- **Operator resource quotas** (`backend/src/lib/quotas.js`) — two independent, both-optional ceilings,
  whichever is reached first blocks the request: a PER-OPERATOR cap (`backend/data/quotas.json`, admin-
  managed per person from the Users/Identities tab) and a shared POOL cap across every operator at once
  (`settings.json`'s `operatorPoolMaxVcpus`/`operatorPoolMaxMemoryMb`, one value, admin-managed from
  Settings). Neither configured = unlimited, same as every optional limit elsewhere in this project.
  Checked live on create and on `POST /:id/resources` (live resize), never as a running counter — always
  the real sum of `cpusetCpus`/`memoryMb` across every other instance sharing the same `createdId` (or,
  for the pool, every instance whose `createdId` currently holds the operator role at all), read fresh
  from the store every time. vCPU counting had to grow a small backend-side helper
  (`instanceParams.countCpus`) mirroring the frontend's existing `parseCoreSet`, because `cpusetCpus`
  already accepted ranges (`"4-7"`), not just flat comma lists — confirmed in the actual validation regex,
  not assumed. A new `GET /api/auth/directory` (any logged-in user, not just admin) exists purely so an
  operator sharing an instance has a way to pick a target by username, without needing admin's own
  account-management view. **Verified:** unit tests only (`permissions.test.js`, `quotas.test.js`,
  `store.test.js`'s migration coverage, `instanceParams.test.js`'s `countCpus`) — the new routes
  (`/owners`, `/created-by`, `/api/quotas`, `/auth/directory`) have no route-level test, consistent with
  every other route in this project (verified live by hand against real Docker, not supertest); that live
  pass has not happened yet for this specific feature.

## Phase 8 — Federation mode: `jg-dashboard` and Plenum as consumers

**Difficulty: Medium-High** — two real integrations against two different codebases (Angular/NestJS in one
case, Plenum's federated module in the other), coordinated with no real downtime over instances in use.

**Context:** see [[project_redroid_forge_origen_arquitectura]] in memory — `redroid-forge` exists
specifically so it never has to be embedded as a library inside Plenum or `jg-dashboard` to be useful
there; it stays its own process/container always. "Federated" only changes which identity provider it
trusts and whose roles it reuses — it is a mode switch (env var), on top of Phase 7's auth, not a
different architecture. `plenum-redroid` (the direct port into Plenum, started 08/2026) and `jg-dashboard`'s
own `redroid.service.ts` are both already **deprecated** by this: `redroid-forge` is the only place new
redroid work happens, and each predecessor gets removed only once `redroid-forge` reaches parity with
what that specific predecessor did (gradual, piece by piece — not a single cutover).

**Clarification (05/10/2026, still holds):** `redroid-forge` and `jg-dashboard`'s redroid are two separate
projects that do not have to be compatible with each other (neither images, nor instances, nor state) —
tests happen on `jgustavo46`, not on server01. There is no migration of images or instances from the old
dashboard.

**Steps:**
1. `jg-dashboard` starts calling `redroid-forge`'s API instead of using its own `redroid.service.ts`.
2. Plenum does the same (`plenum-redroid`'s replacement) — pointed at Plenum's **existing** Keycloak realm
   via Phase 7's `oidc` backend, reusing Plenum's roles rather than defining new ones.
3. Document exactly what "has everything configured" means for each (which realm, which roles map to
   which `redroid-forge` permissions).
4. The old code in both stays in place untouched (the coexistence policy, section 4) during the whole
   run-in period.

**Gate:** both operate real instances exclusively through `redroid-forge` during a run-in period, with no
regressions, authenticating through each host's own existing identity provider.

## Phase 9 — Advanced: optional port-knocking companion (research first)

**Difficulty: Medium-High, and explicitly research-first** — `(to) investigate`, not commit to, per the
original ask.

**Reality check before committing to this:** classic port knocking (a fixed port sequence) is obscurity,
not real security — a patient observer can still find it. A real version (`fwknop`, Single Packet
Authorization with actual crypto) is stronger, but it needs to manipulate `iptables` **on the host**, which
from inside a container means either `NET_ADMIN` or running the daemon outside the container entirely —
real tension with "lives in one container, no host setup". For anyone already using Tailscale (or any
private overlay network) for exposure, picking that interface in Phase 6 already gets most of the same
outcome — nothing outside the private network can even see the port — with none of this complexity. Worth
having for the sysop who genuinely wants it on a raw LAN/public interface; not worth defaulting toward.

**Steps:**
1. Design as a **separate, optional companion** (its own `docker-compose` profile/container), never baked
   into the main image — the simple default stays simple regardless of whether this exists.
2. `redroid-forge`'s UI detects and configures it when present (which instances/interfaces it guards), but
   never requires it.
3. Document the host prerequisites clearly — this is the one piece in this whole theme that genuinely
   needs host-level changes, unlike everything in Phases 6-8.

**Gate:** an instance exposed on a non-localhost interface can optionally require a valid SPA knock before
the port responds at all, with zero effect on every instance that does not opt in.

## Phase 10 — Removal of the old code + public polish

**Difficulty: Low** — it is cleanup and documentation, not new technical work.

**Steps:**
1. **Secure the old code on GitHub before deleting anything.** ✅ Done on 05/10/2026: `jg-dashboard` was
   pushed (the 2 pending commits, including `27bd149`, the last redroid work) and `plenum-redroid` — which
   was not a git repo nor existed on GitHub — was uploaded, frozen, to `fogelmanjg-plenum/plenum-redroid`
   (private, with a README marking it as archived and replaced by `redroid-forge`; without `.env` or
   runtime data). **Still missing**, right before deleting: commit/push again any new redroid change in
   `jg-dashboard` (it currently has uncommitted files unrelated to this decision) and leave a tag on the
   last commit (e.g. `redroid-legacy-<date>`) to find it easily.
2. Remove **all** the redroid code from `jg-dashboard` and `plenum-redroid` (only here, never before the
   Phase 7 gate), including the dead code of the `ws-scrcpy`/oauth2-proxy viewer. Decision (05/10/2026):
   that code stays on GitHub as an old project, dead and replaced by `redroid-forge`; nothing is ported as
   compatibility.
3. Write the definitive README/CONTRIBUTING/attribution, issue templates.

**Gate:** the project is in a condition to be called **beta 0.9** — from here the donations/support
mechanism is picked up again (section 8 of `REQUIREMENTS.md`), not before.

## Outside the phases (on demand, they block nothing above)

- Other "large" projects to read that could add something (pending in `REQUIREMENTS.md` section 10) — they
  are evaluated and inserted in the corresponding phase when identified, they do not generate a phase of
  their own.
- **Android does not see the container's real RAM limit (idea, 22/10/2026).** `dumpsys meminfo`
  inside a redroid container reports the HOST's total RAM (e.g. 63GB, "status moderate"), not the
  Docker cgroup's actual `memoryMb` ceiling — confirmed with real numbers on a production
  `jg-dashboard` v1 instance (3030MB used of a 4096MB limit, 74%, after under an hour of uptime; see
  [[project_redroid_forge_meminfo_cgroup_visibility]] for the full writeup). Because Android never
  sees the real ceiling, its own low-memory killer/cache trimming never engages preventively — growth
  goes unchecked until the host kernel's cgroup OOM killer intervenes abruptly, which reads as a
  stutter/freeze inside whatever app is running, not a video/network symptom. **Counter-intuitive,
  confirmed by the user with real usage: raising `memoryMb` makes this WORSE, not better** (more
  visible headroom just lets Android accumulate more before anything stops it — same pattern already
  seen with the CIFI instance, and with a physical Android phone that needs a manual background-app
  purge every ~2 days). Likely fix: overlay a container-local `/proc/meminfo` reflecting the real
  `memoryMb` instead of the host's, so `ActivityManager`'s own memory-pressure handling activates in
  time. Not designed yet — candidate for a module alongside `cpu-ram`/`AndroidProvisioning`. Likely
  contributing factor for this specific case: a user used to abundant hardware who never manually
  closes apps, eventually running into a limit that was always there but never enforced gracefully.
- **Configurable ad blocker (idea, 04/10/2026).** At system level and per application. It fits as a Phase 5
  user module (manifest + script), not as part of the core. Design to be decided; options seen:
  - *Local VPN client* (NetGuard tested by hand, it needs no root): it allows per-app (uid) rules. Platform
    requirement: Android opens `/dev/tun`, not `/dev/net/tun`; the container must be created with
    `--device /dev/net/tun:/dev/tun` (or `mknod /dev/tun c 10 200`, which does not survive recreating the
    container). Without that node `Vpn.jniCreate` fails with "Cannot create interface" and the VPN is never
    established.
  - *Side effect to solve:* the VPN also captures `adbd` (uid 2000); with blocking active, TCP adb becomes
    unreachable. The module must allow `com.android.shell` by default.
  - *Alternative without a VPN:* private DNS / host network-level filtering (blocking by domain, without
    per-app granularity).
  - Per-app rules: decide whether they are stored in the module's manifest or per instance.
- **More audio codecs (idea, 06/10/2026).** Today audio over scrcpy only works with `--audio-codec=aac`; the
  default (opus) fails. scrcpy offers opus, aac, flac and raw, so the limit is in the encoders the Android
  image exposes, not in scrcpy. It is not for the first version.
  - *Prior check (~5 min, on the jgustavo46 instance):* scrcpy's log with opus and `dumpsys media.codec`, to
    confirm why it fails. Unverified hypothesis: the official image's `media_codecs.xml` does not register
    the `c2.android.opus.encoder` encoder (AOSP ships it as software), just as happened with the decoders.
  - *If that is it:* it is registered from the integration module when the instance is created (the same
    mechanism as `addCodecsToXml` for the decoders), without a custom image. With opus as the default (lower
    latency and bitrate than aac).
  - `raw` needs no encoder (more bandwidth; useful on a LAN and for diagnostics). `flac` is an AOSP software
    encoder: test whether it is registered.
  - No hardware acceleration: the CPU cost of audio is negligible.
- **Zero-copy decode and 4K at 60 fps (decided 06/10/2026: after the first complete functional version, like
  the audio codecs).** Today the frame goes from the GPU to RAM and is copied into gralloc; at 1080p that is
  more than enough (>200 fps, ~3x less CPU than software), but 4K has a ceiling of ~55 fps because of the
  copy of 12 MB per frame. Design thought out: the inverse of the encoder. Android reserves the output
  buffer (gralloc, a dma-buf of the same GPU) and passes its fd to the daemon through `SCM_RIGHTS`; the
  daemon imports it as a VA surface and performs a VPP step on the GPU (copy, conversion to NV12 and scaling
  to the instance's screen); it synchronizes with `vaSyncSurface` or a fence. The current shared memory
  stays as a fallback with the same first-frame self-check. Advantages: no GPU→RAM download or copy into
  gralloc (almost zero CPU per frame), 4K and 10-bit become realistic, scaling on the GPU, the compositor
  consumes the buffer without uploading it again. Risks: redroid's gralloc is fragile (P010 restarts
  Android; NV12 has to be tried carefully), Intel tiling modifiers that gralloc does not report, and it is
  driver-specific (AMD, Intel, NVIDIA). **First step, a ~1-day spike:** see whether gralloc allocates NV12
  without breaking anything and whether the daemon can import that fd and write into it, before committing
  to the design.
- **"Is this build genuine?" check (idea, 23/10/2026).** Apache-2.0 means anyone can fork this and add
  something the project itself never will (e.g. a Play Integrity spoofing module, once Magisk is already a
  supported module) -- expected if the project ever gets popular, and not something a license can prevent.
  The goal is NOT to block forks (impossible, and not the point: whoever forks already knows they forked) --
  it is to give a good-faith user an easy, voluntary way to confirm whether the specific build they are
  running came from this repo unmodified. **Self-reporting inside redroid-forge proves nothing on its own**
  (a modified fork can just hardcode "yes I'm official"): the real anchor has to be something a fork cannot
  forge. GitHub's native build provenance attestations (Sigstore/OIDC, already free, no private key to
  manage) are the right primitive -- CI produces a signed statement tying an exact image digest to an exact
  commit, repo and workflow; a fork's own CI run would attest to ITS OWN repo identity, which is publicly,
  cryptographically distinguishable from `fogelmanjg/redroid-forge`. A small Plenum-hosted page/endpoint
  (receives an image digest, looks up its public attestation) would be a convenience layer on top of that
  public verification, not the trust root itself -- nice for a fleet-wide dashboard and for a casual user who
  does not want to run `gh attestation verify` by hand. Entirely opt-in by design, same ceiling as any
  "verified" badge: it only helps whoever chooses to check.
- **`aurora-store` module: implemented and live-verified, 24/10/2026** (see `backend/src/modules/aurora-store/`,
  `CHANGELOG.md`). What is below is the design/validation history that led to it; the module itself matches
  everything "Validated by hand" found, except device-spoofing for catalog visibility, which is Aurora's own
  in-app setting, not something the module automates. Module categories (`categoria`) and the
  `conflictsWith`/`relatedModules` fields are still NOT implemented -- only `aurora-store` itself is.
- **Module categories + an `aurora-store` module (idea, 23/10/2026).** With ~8 modules already
  (`redroid-gralloc-fix`, `hwenc`, `hwdec`, `gapps`, `arm-translation`, `cifi`, `wifi-interno`/
  `wifi-interno-virtwifi`) the flat checkbox list in the "new instance" form is getting crowded. Two
  separate additions, not one:
  - A `categoria` field in the manifest (`codec`, `compat`, `network`, `store`, `utility`), purely for
    grouping the catalog/form UI -- no behavior tied to it.
  - `aurora-store`: an open-source (GPLv3) client for Google Play's real backend -- unlike `gapps`/
    `arm-translation` it CAN be redistributed by this project (no "you provide the files" dance), and
    unlike every other module so far it needs no `/system` write before boot (install it after first
    boot like any user app, no `moduleRunner` stage-4 involvement). Found while chasing a real
    "may not have purchased this app" error on a test PvZ2 install (manual `adb push` of the APK/OBB
    has no Play purchase record attached to it; downloading through Aurora with a real logged-in
    account does, since it is the same backend Play itself uses). Caveat: depends on a community-run,
    reverse-engineered Play API (token dispenser services) that Google can break at any time -- much
    less solid than the hash-pinned official SDK images `gapps`/`arm-translation` use, so this would
    ship as a convenience option, not with the same guarantee level as the rest.
  - **`gapps` and `aurora-store` are not alternatives, they are complementary** -- Aurora only
    downloads the APK legitimately, it does not provide Play Services at runtime, so apps that need
    those still need `gapps` too. This is the actual reason the "category" idea needs a second,
    separate field: `conflictsWith` (hard exclusion, enforced by `moduleGate.js` -- the first real use
    would be formalizing what `wifi-interno-virtwifi`'s own manifest already says in prose today, "do
    not enable both wifi modules on the same instance", never actually checked in code) vs
    `relatedModules` (soft, informational only -- what `gapps` and `aurora-store` need between them).
    Neither field exists yet; design only, nothing implemented.
  - **Flagged as worth doing soon (24/10/2026), now that `aurora-store` exists.** This was a hypothetical
    pairing when first designed; now it is a real one (both modules shipped, both can be requested on the
    same instance, right now with zero cross-module information shown to the user). Natural next candidate
    for whichever of `conflictsWith`/`relatedModules` gets built first: it would surface, on the `aurora-store`
    checkbox/contract, that it is complementary to (not a substitute for) `gapps` -- the actual gap today is
    that nothing tells a user requesting `aurora-store` alone that apps needing Play Services still need
    `gapps` too, it is only written in the manifest's `descripcion` prose.
  - **Validated by hand, 23/10/2026.** Two more real findings from testing Aurora manually on a
    throwaway instance (host GPU, 2 vCPU, 4 GB RAM, `arm-translation` only, no `gapps`/wifi): (1) Aurora
    4.8.4 crashes on its own app-list screens with `IllegalArgumentException: Key "..." was already
    used` (a Jetpack Compose `LazyColumn` duplicate-key bug introduced by that version's UI rewrite,
    confirmed against the official changelog -- 4.8.3, the last pre-Compose release, does not have it);
    (2) a *second*, unrelated crash the first time Aurora's own WebView-based screen (login) opened --
    same native `SIGSEGV` in the sandboxed WebView renderer that `gapps` already works around by writing
    `/data/local/tmp/webview-command-line` (`--no-sandbox --single-process
    --disable-features=WebViewSandboxedRenderer`); applying the exact same fix by hand resolved it.
    **Any real `aurora-store` module needs both: pin 4.8.3 (or whatever the next pre-crash release
    turns out to be) and write the webview-command-line fix itself, independent of `gapps`.**
    Separately: Aurora talks to the same Play catalog backend as the Play Store app, with the same
    device identity, so by itself it does NOT fix an app missing from the catalog on an uncertified
    device (confirmed: PvZ2 was missing from Aurora's listing too, same as Play Store). Aurora's own
    **device-spoofing setting** (present itself as a different device model) does fix catalog
    visibility -- tested, PvZ2 appeared and downloaded normally after spoofing to a different device
    profile. Worth exposing as a documented option of the module, not left for the user to find.

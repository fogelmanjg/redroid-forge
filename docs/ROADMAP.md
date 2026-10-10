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
   decoders and the VA-API hwaccel, from a tarball pinned by version and `sha256`.

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
   against a real dual-instance startup race on hardware**, which remains pending before trusting this in
   production.

**Gate:** the profile spoof can be applied/reverted from the new UI, with the correct `build.prop` files
according to the image, and restarting two or more instances with fake WiFi at the same time leaves none
without radios. **Partial:** the concurrency fix and the profile spoof (via API) are done and have a unit
test; the UI (step 3) and the validation on real hardware with two instances starting/restarting at once
are missing to close the gate completely.

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
2. ✅ **Done for the lifecycle mechanism, open for persistent scheduling** —
   `backend/src/lib/moduleRunner.js` orchestrates stages 3-6 from `instances.js` (create/start/restart),
   replacing the special-casing of `hwenc`/`hwAccel` that existed there. What remains unimplemented: the
   **periodic scheduling** mechanism (run every N minutes, persistent pause/resume/status) that this step
   asks for CIFI-style watchdogs — this phase's runner solves "what runs at the moment of creating/starting
   an instance", not "what runs in a loop while the instance lives".
3. ⬜ Open — Port the CIFI watchdog on Redroid 15 using the scheduling convention (still undesigned, see
   step 2), replacing the current cron script + `flock`. **Not** touched in this iteration.
4. ⬜ Open — Validate live for several days with no reappearance of the inherited-lock bug. It requires real
   hardware and days of observation; not attempted here.
5. ⬜ Open — A second pilot, the same mechanism: the persistent fake-WiFi reconnection watchdog (today
   hardcoded in `jg-dashboard`, see `claimHwsimPhyPair`/`wifiWatchdogs` in `redroid.service.ts`) migrates
   to a script-module instead of being ported as is.

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
AMD/Intel host.

**Gate:** CIFI runs as a module inside `redroid-forge` (pause/resume/status from the app, no manual cron
editing), validated live without the known bug reappearing. **Not met yet** — steps 3-5 are still open.

## Phase 6 — Optional authentication (Keycloak)

**Difficulty: Medium** — the pattern is already agreed and tested in other projects of ours (Keycloak admin
API, an optional bolt-on with Plenum), it is not unknown ground.

**Steps:**
1. Implement the auth bolt-on: Keycloak directly, or delegated through Plenum/`jg-dashboard`.
2. Confirm that with the environment variable off the behavior is identical to today (zero auth).

**Gate:** with auth off, behavior identical to today; with auth on, Keycloak filters access.

## Phase 7 — `jg-dashboard` and `plenum-redroid` become consumers

**Difficulty: Medium-High** — two real integrations against two different codebases (Angular/NestJS in one
case, Plenum's federated module in the other), and the migration has to be coordinated with no real
downtime over instances that are in use.

**Clarification (05/10/2026):** `redroid-forge` and `jg-dashboard`'s redroid are treated as **two separate
projects that do not have to be compatible with each other** (neither images, nor instances, nor state).
That is why `redroid-forge`'s tests are done on `jgustavo46` and not on server01. When `redroid-forge` is
working, the dashboard's redroid is **removed and replaced** by `redroid-forge`; only at that moment do we
go back to server01. There is no migration of images or instances from the old dashboard.

**Steps:**
1. `jg-dashboard` starts calling `redroid-forge`'s API/embed instead of using its own `redroid.service.ts`.
2. `plenum-redroid` does the same.
3. The old code in both stays in place untouched (the coexistence policy, section 4) during the whole
   run-in period.

**Gate:** both operate real instances exclusively through `redroid-forge` during a run-in period, with no
regressions.

## Phase 8 — Removal of the old code + public polish

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

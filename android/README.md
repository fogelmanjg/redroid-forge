# redroid-forge's Android code (Codec2)

`vaapi_codec2/` is the Codec2 service (`android.hardware.media.c2-vaapi-service`) that runs **inside** the
Android instance and talks to the host's VA-API daemon through the socket `/dev/vaapi-helper/socket`
(protocol in `backend/native/vaapi-daemon/protocol.h`):

- `component/VaapiEncComponent.*`: the H.264 encoder (`c2.hardware.encoder.h264`).
- `component/VaapiDecComponent.*`: the hardware decoders `c2.hardware.decoder.{h264,hevc,vp9}`, one
  persistent session per component (hwdec protocol v2, with frames through shared memory), with delayed
  output for B-frames. 10-bit streams are decoded in hardware and delivered as 8-bit YV12 (redroid's gralloc
  cannot allocate P010 safely, see `docs/ROADMAP.md`).
- `service/`: the service, its `.rc`, the VINTF manifest and the seccomp policy.
- `test-client/`: test tools (`real_gralloc_*`, `vaapi_daemon_test_client`, and `hwdec_mediacodec_test`,
  which decodes a file through `MediaCodec` and prints a CRC per frame).
- `test/`: `run_on_instance.sh` decodes test clips with the hardware decoders and with Android's software
  ones inside an instance, and `verify_mediacodec.py` compares each frame with ffmpeg's decode.

The code **is built inside the AOSP tree** (`~/aosp-redroid-15/external/vaapi_codec2`, 142 GB) in the
`redroid-build-persist` container. The scripts in this folder sync this code into the tree and build.

## Two ways to build (read this before touching anything)

| Script | When | Cost |
|---|---|---|
| `android/ninja.sh <path-in-/out>` | You changed only `.cpp`/`.h` files already listed in an `Android.bp` | **~13 s** |
| `android/build.sh <module>` | You added a source file, a module, or touched an `Android.bp` | **~5 min** (Soong analysis ~2.5 min + compiling), memory bounded by `GOMEMLIMIT` |

`ninja.sh` skips Soong by calling `ninja` directly on the combined file the last full build left. Typical
service output: `/out/target/product/redroid_x86_64/vendor/bin/hw/android.hardware.media.c2-vaapi-service`.

### Traps learned on 06/10/2026
- **Always build as `jgustavo`** (the scripts already use `docker exec -u jgustavo`). As root, Soong sees a
  different `BUILD_USERNAME` and redoes ALL of the analysis, and leaves root files in `/out` that then block
  the normal user.
- **Soong's analysis was eating >37 GB** because Go's garbage collector does not know the container's cap and
  lets the heap grow up to double what is live. `build.sh` wraps `soong_build` in a script that sets
  `GOMEMLIMIT=26GiB` (Soong launches it with `env -i`, so exporting it is not enough): the analysis went from
  dying to finishing in ~2.5 min. A memory cap on the container is still advisable (`docker update --memory
  36g --memory-swap 36g ...`) so that, if something overshoots, the kernel kills the build and not other
  host processes.
- **Do not use `rsync --delete`** toward the AOSP tree: it would delete files that only exist there.
- **Do not walk `/out` with `find`** (105 GB): it hangs.
- `docker exec` needs `-i` to read a script from stdin.

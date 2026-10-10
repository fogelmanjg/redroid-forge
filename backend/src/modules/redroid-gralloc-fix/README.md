# redroid-gralloc-fix

> **This is a workaround for a known bug of redroid, not a feature of redroid-forge.** It is what has to be done to redroid's own
> `gralloc.gbm.so` until redroid fixes it; remove the module then. Reported upstream:
> [remote-android/redroid-doc#930](https://github.com/remote-android/redroid-doc/issues/930). Affects redroid 15 in host GPU mode
> on **AMD** (reported, `RGBA_1010102`) and **Intel** (the same function dies with `P010` on an Iris Xe). The module does nothing on
> other GPUs.

The `gralloc.gbm.so` of the official redroid 15 image computes the bytes per pixel of a buffer with a table that stops at
`HAL_PIXEL_FORMAT_FLEX_RGBA_8888` (0x2A) and only knows `YV12` above it. Any other format, such as `RGBA_1010102` (0x2B:
10-bit colour, asked for by Unity 6 games, benchmarks, HDR), ends with `bpp = 0` and the stride computation divides by it:
`SIGFPE` in `android.hardware.graphics.allocator@2.0-service`. That service is critical, so zygote and system_server restart
and **the whole of Android restarts** inside the container (a connected scrcpy is left pointing at the old system).

Found and documented in [redroid-doc#930](https://github.com/remote-android/redroid-doc/issues/930). The module applies the
binary workaround described there: in the stopped instance it changes `31 c9` (`xor ecx,ecx`) to `b1 04` (`mov cl,4`) at
file offset `0x57d2` of `/vendor/lib64/hw/gralloc.gbm.so`, so an unknown format is allocated as 32 bits per pixel.

- It is bound to the image (`needsGrallocFix` in `images.json`), not an option of the instance, and it only acts on AMD/Intel hosts.
- It only patches if the bytes **around** the change are exactly the known ones; any other version of the file is left as it is
  (with a warning), and an already patched file is recognised.
- Free software, applied to the instance's own copy: the Docker image is not modified and nothing is redistributed.

How to recognise the crash: `/data/tombstones` of the instance has `android.hardware.graphics.allocator@2.0-service` with
`gralloc_gbm_bo_create+621`, and the log shows `Process ... has died` for the system processes right after.

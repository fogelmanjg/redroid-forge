# arm-translation

Lets an x86_64 instance run apps and games that carry only ARM64 native code (most mobile games), through the
`ndk_translation` native bridge (binary translation ARM64 → x86_64, "Berberis") that Google ships in the Android SDK
emulator images.

It is **non-free third-party software**: redroid-forge neither includes, hosts nor downloads it. You get the files from the
system image of the Android SDK (the same zip as the `gapps` module) and the module verifies the sha256 of every one
before injecting.

```
node backend/scripts/sdk-extract.js arm-translation x86_64-35_r09.zip     # -> backend/data/arm-translation (REDROID_FORGE_ARM_DIR)
```

Then tick "ARM translation" when creating the instance (or `{"modules": ["arm-translation"]}` in `POST /api/instances`).
`GET /api/modules/arm-translation/status` says whether the folder is ready.

## What it injects (82 files, 27 MB)

| where in the instance | what |
|---|---|
| `/system/lib64/libndk_translation.so`, `libberberis_exec_region.so` | the translator and its runtime |
| `/system/lib64/libndk_translation_proxy_lib*.so` (20) | one proxy per system library an ARM app can call: they forward the call to the native x86_64 one (GLES, EGL, Vulkan, audio, binder…) |
| `/system/lib64/arm64/*.so` (56) | the ARM side of the system: an ARM libc, libm, libdl, liblog… that the translated code is linked against |
| `/system/bin/arm64/{app_process64,linker64}` | ARM's process and dynamic linker (the translator opens `app_process64` when it starts) |
| `/system/etc/{cpuinfo,ld.config}.arm64.txt` | what the translated code sees as `/proc/cpuinfo`, and its linker namespaces |

Stage 3 adds three boot properties to the container (`ro.dalvik.vm.native.bridge=libndk_translation.so`,
`ro.dalvik.vm.isa.arm64=x86_64`, `ro.dalvik.vm.isa.arm=x86`); stage 4 copies the files while the container is created and
stopped (the only moment `/system` is writable).

## Decisions

- **No `binfmt_misc`.** The AOSP emulator image also registers ARM executables in the kernel (`ro.enable.native.bridge.exec`).
  That table is one for the whole host, shared by every container, so a container must not touch it; and it is only for
  running ARM *programs* from a shell. Apps go through the native bridge, which is what games need.
- **64-bit only.** The SDK image has no 32-bit translator, so `armeabi-v7a` apps are not covered (the same as a plain
  `libndk_translation` build of AOSP).
- **Only the names of the translation can be injected** (`ALLOWED_FILE` in `integrate.js`), whatever a package definition
  says, and the files' modes are part of the check (`app_process64` and `linker64` must be executable).
- In the image, `ro.dalvik.vm.native.bridge` is `0`/`libnb.so` in its own `build.prop`; the container argument wins, and
  the "Could not set ... Read-only property was already set" line of the log is that file losing.

## Validated

Android 15 official image on AMD Polaris (jgustavo46, 10/10/2026): the instance boots, Berberis starts for each ARM app
(`berberis: Initialized Berberis (aarch64)`), and *Plants vs Zombies 2* (`primaryCpuAbi=arm64-v8a`, no x86_64 code at all)
installs and draws its screens. Not yet in the known-combinations database (it works as an "unsupported" combination until
the package and the combination are published and signed).

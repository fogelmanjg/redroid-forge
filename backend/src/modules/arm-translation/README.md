# arm-translation

Lets an x86_64 instance run apps and games that carry only ARM64 native code (most mobile games), through the
`ndk_translation` native bridge (binary translation ARM64 → x86_64, "Berberis") that Google ships in the Android SDK
emulator images.

It is **non-free third-party software**: redroid-forge neither includes, hosts nor downloads it. You get the files from the
system image of the Android SDK and the module verifies the sha256 of every one before injecting.

The catalog of builds (by hash), the compatibility matrix, how a build is traced to its image and the standalone extraction tools live in their own project: **[redroid-ndk-translation](https://github.com/fogelmanjg/redroid-ndk-translation)**. This module is the part that injects the files into an instance.

**Use `x86_64-35-ext15_r01.zip` for the ARM translation** (not the `x86_64-35_r09.zip` that `gapps` uses): see "Which image" below.

```
node backend/scripts/sdk-extract.js arm-translation x86_64-35-ext15_r01.zip   # -> backend/data/arm-translation (REDROID_FORGE_ARM_DIR)
```

Then tick "ARM translation" when creating the instance (or `{"modules": ["arm-translation"]}` in `POST /api/instances`).
`GET /api/modules/arm-translation/status` says whether the folder is ready.

## Which image

The translator is **Google's** (the ARM front-end of Berberis is not in AOSP, which only has the riscv64 one), shipped inside the
Android SDK system images, so which image you take it from matters. Compared on 10/10/2026, by the md5 of
`libndk_translation.so` and by the source line numbers that the binary keeps in its `CHECK failed` strings (they change with
every version of the code):

| image (`google_apis_playstore`, x86_64) | `libndk_translation.so` md5 | source (`native_bridge.cc` checks) | Loop Sort (Unity IL2CPP, arm64) |
|---|---|---|---|
| `35_r06` | `f7ceaac2…` | older | not tried |
| `35_r07`, `35_r08` | `65148744…` | lines 616, 629 | not tried |
| `35_r09`, `35-ext14_r01` | `3f1d2639…` | lines 616, 629 | **crashes** at ~11 s inside the translator (`libndk_translation.so +0x2df110`, deterministic) |
| `34_r14` / `36_r07` | `ff473474…` / `1f3d8b1c…` | other API level | not tried |
| **`35-ext15_r01`** | **`fa529513…`** (3,893,208 bytes) | **lines 625, 638** | **works** (also PvZ2) |

Only 2 of the 82 files differ from the r09 set in a way that matters for this (the translator and `libndk_translation_proxy_libnativehelper.so`;
the two text files `cpuinfo.arm64.txt` and `ld.config.arm64.txt` also differ in text). The ext15 image is not in Google's
current index (`sys-img2-1.xml`) but is still served from `dl.google.com/android/repository/sys-img/google_apis_playstore/x86_64-35-ext15_r01.zip`.
Tried without effect for the crash: `ro.berberis.flags=accurate-sigsegv`, the Samsung device profile, a different Google account.

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
installs and draws its screens (with the r09 translator). *Loop Sort* (arm64 Unity) crashes with the r09 translator and runs
(past level 4) with the ext15 one. Not yet in the known-combinations database (it works as an "unsupported" combination until
the package and the combination are published and signed).

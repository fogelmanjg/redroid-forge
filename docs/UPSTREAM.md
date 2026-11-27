# Giving fixes back to redroid

redroid-forge works around several bugs and gaps of redroid itself, applied on each instance's own copy of the image. Whatever can be fixed at the source is offered back upstream, with the code and with tests on real hardware. When redroid ships a fix, the matching workaround here can be retired.

| Forge workaround | Problem in redroid | Upstream | Status |
|---|---|---|---|
| `redroid-gralloc-fix`, 10-bit part | `gralloc.gbm` divides by zero on `RGBA_1010102`: the allocator dies and Android restarts | Issue [redroid-doc#930](https://github.com/remote-android/redroid-doc/issues/930), PR [gbm_gralloc#1](https://github.com/remote-android/gbm_gralloc/pull/1) | PR open (25/11/2026) |
| `redroid-gralloc-fix`, YV12 part | `gralloc.gbm` lays out YV12 with pitches the GPU cannot import: video aborts surfaceflinger | Issue [redroid-doc#942](https://github.com/remote-android/redroid-doc/issues/942), PR [gbm_gralloc#2](https://github.com/remote-android/gbm_gralloc/pull/2) | PR open (25/11/2026) |
| `redroid-no-rgb10.rc` (in `redroid-gralloc-fix`) | Mesa's EGL offers 10-bit configurations that gralloc then allocates as 8-bit: garbled picture | `vendor_redroid` (init) | On hold. With gbm_gralloc#1 a 10-bit buffer renders correctly (native test, 25/11/2026), and this Mesa offers no 10-bit EGL configs even without the rc. 3DMark Wild Life (Vulkan) runs with a correct picture, but it is not confirmed that it picked a 10-bit swapchain |
| `psiFix.js` | lmkd reads the host's memory pressure (`/proc/pressure/memory` is not namespaced) and kills apps when the host stalls | PR [vendor_redroid#6](https://github.com/remote-android/vendor_redroid/pull/6) | PR open (25/11/2026) |
| `cpuFix.js` | Android sees every host CPU, not the container's cpuset | PR [vendor_redroid#6](https://github.com/remote-android/vendor_redroid/pull/6) | PR open (25/11/2026) |
| `meminfoFix.js` | Android sees the host's total RAM, not the container's limit | lxcfs guide: PR [redroid-doc#943](https://github.com/remote-android/redroid-doc/pull/943) (it needs a host-side daemon, so it cannot live inside the image) | PR open (25/11/2026) |
| `wifi-interno` | No WiFi: apps that require it refuse to run | `device_redroid` + framework patches | Only after talking with the maintainer (large change) |
| `hwenc` / `hwdec` (VA-API Codec2) | No hardware video encode or decode | [`redroid-c2`](https://github.com/remote-android/redroid-c2) (unmaintained since 2022) | Only after talking with the maintainer (large change) |

## How a fix is offered

- One PR per problem, against the repository and branch the images are built from.
- The PR states the cause, what changes, and a before/after test on real hardware. Name the GPU, the image and how it was reproduced.
- It links the redroid-doc issue, and the issue links back to the PR.
- The forge keeps its workaround until an official image ships the fix. Then the workaround is removed in its own release, with a note in the CHANGELOG.

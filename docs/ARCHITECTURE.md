# redroid-forge — How the pieces fit together

**Languages:** English | [Español](ARCHITECTURE.es.md)

> This project's official language is **English**. The Spanish file is provided for convenience and
> may not be perfectly accurate or up to date — if in doubt, this file is the source of truth.

> Complements `REQUIREMENTS.md` (what and why) and `ROADMAP.md` (in what order). This document is the
> mental model: what each piece is, where it physically lives, and at which point of an instance's
> lifecycle it is touched. Meant for anyone who arrives at the project without the context of how it
> was put together — the intuition of "this is a folder you keep adding things to" is not obvious
> until you see it laid out in layers like this.

## Base principle: we never host third-party binaries

This is not a style preference — it is the reason this whole document exists. `redroid-forge` (the
repo, the image we distribute, anything we publish) **never contains or redistributes third-party
non-free software** (GApps, Magisk, whatever it may be). "We don't put it in a Docker image" is not
enough — neither is "we download it separately and package it as our own tarball". The real rule is:
**the binary of a non-free component always has to come from its real official source, at the
moment the user asks for it** — never from a server or repo of ours.

This includes the Android source tree that builds the base image itself: if GApps (or anything else
non-free) is mixed into the source code we compile, the resulting image already breaks this rule
even if we later handle it "properly" with Docker — the problem is not where the file ends up, it is
where it came from. See "Found on 28/09" below for the real case that triggered this clarification.

## A Docker image is not a file — it is a folder

Before the 6 stages, the physical basis: a Docker image is a stack of layers, each one a real
directory on the host's disk (`/var/lib/docker/overlay2/<hash>/diff/`). When a container is created,
Docker overlays those layers into a single view (`merged/`) that becomes the container's `/`. There
is nothing binary/opaque about it — they are ordinary files, browsable with `ls`/`cat` like any host
folder. `docker import` takes a `.tar` and turns it into the first layer; `docker commit` freezes a
container's current state as a new layer on top.

## The 6 stages

### 1. Standard redroid image

The official image from [`remote-android/redroid`](https://github.com/remote-android/redroid-doc),
exactly as that project publishes it. `redroid-forge` does not host or redistribute it — the user
pulls it straight from the official source (or Docker already has it in its local cache if it was
pulled before). Unmodified.

### 2. Things added to that folder before any instance exists

Building a **derived image** (via `docker commit` on an already-patched container) to reuse it across
many future instances instead of repeating the work every time. It is a legitimate optimization for
100% free modules or content of our own — **never** for anything non-free (see the base principle).
Real example (28/09): `redroid-jg-15:hwenc-poc`, an image with the hardware-acceleration component
already injected, to avoid repeating the injection of ~50 files every time it is tested.

### 3. The instance is created

`docker create` (not started yet) from whichever image — the standard one from stage 1, or a derived
one from stage 2.

### 4. Things added/modified in that instance before starting it

One-off injection, for **that** instance only — it is not saved in any shared image. This is where
the integration of non-free modules (GApps, Magisk) lives: the module's script downloads them from
their official source at this moment and places them in the container while it is still stopped.

**Hard technical constraint, confirmed live on 28/09:** `/vendor` (and probably `/system`/`/product`,
not yet confirmed) becomes read-only almost the instant Android boots for the first time — the window
to write there is exactly between `docker create` and the first `docker start`, never after. Any
module that needs to touch those partitions (the hwenc component, for example) has to declare this in
its manifest, so that the backend knows it cannot create the instance already started — it has to go
through this stage first.

Modules that only touch `/data` (which survives restarts and is always writable) do not have this
restriction — they can be applied here or directly at stage 6.

### 5. Things that run on the host, which the instance depends on to communicate

Server-side infrastructure, independent of any particular instance — it runs on its own, waiting for
something to connect. It is not part of any image or any container. Real example: the VA-API daemon
(`backend/native/vaapi-daemon/`) running on the host, listening on `/dev/vaapi-helper/socket`. If it
is not running, an instance with the hwenc component already injected (stage 4) still boots, but has
nobody to talk to — the encoder just sits there, mute.

### 6. Things injected/executed with the instance already running

Actions the backend triggers **against** an instance that is already alive (via `docker exec`/`adb
shell`) — not files that stay saved permanently, but commands that are repeated every time they are
needed. Real examples already ported: assigning the fake WiFi radios (`ensureHwsimWifi`), forcing the
WiFi reconnection (`ensureWifiConnected`, and its persistent version, the periodic watchdog). This is
repeated on every boot of every instance — it is not "saved" anywhere no matter how many times it
runs.

## The distinction that matters most: stage 4 vs. stage 6

- **Stage 4** = once, before the first boot, and it persists as long as that instance exists (it is
  part of the container's filesystem).
- **Stage 6** = repeated every time it is needed, and it leaves no permanent trace if the process that
  triggers it dies or the container is recreated.

A module's manifest (section 5 of `REQUIREMENTS.md`) has to declare which stage(s) it operates in —
that determines whether the backend needs to create the instance without starting it (stage 4) or can
work on one that is already alive (stage 6).

## Phase 5: the generic runner and the `etapa`/`entry` convention

Up to Phase 4, "etapa" (stage) and "entry" were manifest fields that no code interpreted yet — `hwenc`
(the first module with real execution logic, see `backend/src/modules/hwenc/`) was wired by hand in
`instances.js`, with an explicit `if (img.hwEncCapable)`. Phase 5 generalizes that:
`backend/src/lib/moduleRunner.js` is the orchestrator that, for any module declaring `etapa`/`entry`,
does a dynamic `require()` of its `entry` (resolved relative to **the module's own folder**, via
`moduleManifests.moduleDir(id)` — never relative to `moduleRunner.js`) and calls the function that
corresponds to it by a fixed naming convention:

| Stage | Exported name          | When it is called                                  | Arguments       |
|------:|-------------------------|----------------------------------------------------|-----------------|
| 3     | `prepareCreate`         | before `runtime.create()`                          | none            |
| 4     | `integrate`             | between `runtime.create()` and `runtime.start()`   | `containerId`   |
| 5     | `ensureHostInfraReady`  | before `start`/`restart` (create included)        | none            |
| 6     | `ensureRuntimeReady`    | after `start`/`restart`, fire-and-forget          | `containerId`   |

A module only needs to export the hooks of the stages it declares in its manifest — "pure contract"
modules (GApps/Magisk/fake WiFi, with no execution logic of their own yet) do not declare `entry`, and
the runner simply does not touch them; `moduleGate.js` remains what decides whether they can be
enabled at all (compatibility + consent), without overlapping with this.

**Design decisions taken while generalizing (they were not specified beforehand, documented here so
there is a trace of why):**

- **Stage 3 is additive, it replaces nothing:** `prepareCreate()` returns `{ binds?, cmd? }` and
  `instances.js` concatenates them to those it already builds for any instance
  (width/height/dpi/fps/gpu\_mode) — a module can never override what the core already decided, only
  add. This replaces `hwenc`'s `REQUIRED_BOOT_FLAGS`, which had been exported since Phase 2 but was
  never read anywhere (dead code) until now.
- **Stage 5 (host infrastructure) lives in the exports of the same `entry`, not in a separate
  convention.** The alternative — letting `instances.js` keep calling `hwAccel.ensureDaemonRunning()`
  by hand, gated by `img.hwEncCapable` — would have left `hwenc` as a special case forever, exactly
  what Phase 5 aims to eliminate. Instead, `hwenc/integrate.js` exports `ensureHostInfraReady()` as a
  one-line wrapper that delegates to `hwAccel.js` (the real owner of that logic, not duplicated) — the
  runner does not need to know that "hwenc" and "the VA-API daemon" have anything to do with each
  other, only that the module declared stage 5 and exposes the hook under the expected name. See
  `backend/src/modules/hwenc/README.md` for the detail.
- **`requiredModuleIds` is persisted on the instance at creation**, it is not recalculated from the
  catalog on every start/restart — the same criterion the per-instance `hwEncCapable` field already
  used before this phase: if `images.json` changes or the image is removed from the catalog after an
  instance is created, its already-injected modules keep running their stage 5/6 anyway (the consent
  gate, on the other hand, is revalidated against the current catalog — they are two different
  concerns, see `revalidateModulesIfImageKnown` in `instances.js`).
- **Manifest discovery in two locations, not one.** The existing flat manifests
  (`backend/src/modules/manifests/*.json`) were not moved into a per-module folder —
  `moduleManifests.loadAll()` scans that folder AND `backend/src/modules/<id>/manifest.json` (used by
  `hwenc`), validating `id` uniqueness across both sources. Smaller change surface and less conflict
  with other work touching those same files in parallel.
- **Stage 4 runs serially and end to end** (not `Promise.all`): if a future module fails halfway
  through injecting files into `/vendor`, there is no point in continuing with the next one, let alone
  starting the instance with half of the modules silently applied.
- **Stage 6 is fire-and-forget**, the same pattern `scheduleWifiFixes`/`hwsimWifi.js` already used: a
  post-boot fixup that fails must not bring down a start/restart that otherwise worked — the instance
  is already alive, this is an adjustment on something that already started, not a precondition for
  it to start.

**[PENDING]** none of this runner has been validated yet against a real host with Docker/redroid
running — there is only unit-test coverage with fixtures and mocks (`backend/test/moduleRunner.test.js`).
The user-defined module pilots (CIFI, fake-WiFi watchdog — section 5 of `REQUIREMENTS.md`,
"Extensibility: user-defined modules") are a *different* mechanism (periodic scheduling +
pause/resume/status) and are still undesigned — this runner solves a module's creation/startup
lifecycle, not continuous scheduling.

## Found on 28/09: the AOSP tree itself had GApps mixed in

While mapping these stages against the real project, a concrete case of the violated base principle
showed up: `~/aosp-redroid-15/vendor/gapps` is a complete GApps project (MindTheGapps-style, with its
own `proprietary-files*.txt`) **mixed directly into the Android source code**, compiled as part of the
same `m` that builds the rest of the system. The images `redroid-jg-15:gapps-official`/`wifi-v3` (and
any image derived from that build, `hwenc-poc` included) already have GApps inside from the very first
layer — no matter what is done afterwards with `docker commit`/per-instance injection.

**Implication for v1 of `redroid-forge`:** the "standard" image (stage 1) has to come from an AOSP
build **without** `vendor/gapps` mixed in, or directly use the official `remote-android/redroid` image
with no build of our own in between. The GApps module (stage 4) has to download the `.apk`s from the
real source (MindTheGapps/OpenGApps, whichever is chosen) at that moment, never from anything
`redroid-forge` hosts. **[PENDING]** decision on which GApps source to use and whether this applies in
the next AOSP build or is resolved entirely through post-build injection.

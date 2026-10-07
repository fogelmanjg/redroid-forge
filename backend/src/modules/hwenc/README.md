# Module: hwenc

The first real case of the convention for modules with execution logic described in
`docs/ARCHITECTURE.md` (stages 3, 4, 5 and 6) and in section 5 of `docs/REQUIREMENTS.md`. Since Phase 5, it
is also the first module that runs through the generic runner (`backend/src/lib/moduleRunner.js`) instead of
being wired by hand in `instances.js` — any future module with the same shape (`etapa`/`entry` in its
manifest) integrates without touching `instances.js`.

From manifest version 4 the module covers hardware video **decode** as well as encode: stage 4 also
registers in `media_codecs.xml` the decoders (`c2.hardware.decoder.h264|hevc|vp9`) that the host's GPU
decodes in hardware (the backend asks the daemon, see `hwAccel.queryHwdecCaps`), each with a size limit
derived from the instance's screen (`decodeSizeLimit` in `integrate.js`: the largest standard step that fits
the screen, rounding down, with a floor at 720p). To do that, `moduleRunner.integrate` passes stage-4 hooks a
second argument, `{ display: { width, height } }`.

- **`manifest.json`** — the module's contract (what it touches, what it is compatible with), the same schema
  Phase 4 already validates (`moduleManifests.js`), plus two fields that system discovers but does not
  interpret: `etapa` (at what moment of the instance's lifecycle it operates, see `ARCHITECTURE.md`) and
  `entry` (the script that does the real work, resolved relative to this same folder). It lives in
  `backend/src/modules/hwenc/manifest.json` (not in `backend/src/modules/manifests/`) —
  `moduleManifests.js` scans both locations, see the comment of `loadAll()` there.
- **`integrate.js`** — exposes one hook per stage, with the fixed name `moduleRunner.js` expects for each
  (see `STAGE_EXPORT_NAME` there):
  - `prepareCreate()` (stage 3): what to add to `binds`/`cmd` before `docker create` — the bind of the VA-API
    daemon's socket and the boot flag `androidboot.use_redroid_c2=1`. It used to live hardcoded by hand in
    `instances.js`; `REQUIRED_BOOT_FLAGS` was exported but nobody read it.
  - `integrate(containerId, ctx)` (stage 4): copies the VA-API Codec2 component into the `/vendor` of a
    freshly created instance (not started yet) and registers its encoder and decoders. It can also be run
    on its own for manual debugging (`node integrate.js <containerId>`).
  - `ensureHostInfraReady()` (stage 5): delegates to `backend/src/lib/hwAccel.js` (`ensureDaemonRunning`) —
    the daemon's real logic keeps living there, not duplicated here. This hook is only the hook point the
    generic runner needs to call it at the right moment (before `start`/`restart`), without `instances.js`
    having to know that hwenc exists.
  - `ensureRuntimeReady(containerId)` (stage 6): the `setprop` + `mediaserver` restart that used to have to
    be run by hand after every fresh boot (it was called `ensureHwencReady` before this convention). The
    runner schedules it fire-and-forget after `start`, the same pattern as
    `scheduleWifiFixes`/`hwsimWifi.js`.

## Design decision: why is stage 5 exposed here if it already lives in hwAccel.js?

For the generic runner to be truly generic, it cannot know that "hwenc" needs "the VA-API daemon" — it only
knows how to call the function a module's manifest declares for the corresponding stage. The alternative
(letting `instances.js` keep calling `hwAccel.ensureDaemonRunning()` by hand, gated by `img.hwEncCapable`)
would have left hwenc as a special case forever. Instead, `ensureHostInfraReady()` is a one-line wrapper
that delegates to `hwAccel.js` — no logic is moved or duplicated, it is only given the name the convention
expects.

## Why this does not violate the license policy (section 6 of REQUIREMENTS.md)

The component this module integrates is our own code (`redroid-hwenc`, Apache-2.0, the same author) — it is
not GApps/Magisk. The "never host the binary" restriction is about non-free third-party software; this is
free and ours, so in principle it could be packaged without any legal problem. The only reason it is still
downloaded as a separate artifact instead of being built in `redroid-forge`'s normal build is technical:
they are Android/bionic binaries that need the full AOSP toolchain, not something a `docker build` of a
Node/Alpine image can do.

## Pending

- `REDROID_HWENC_ARTIFACTS_DIR` today points to a local AOSP build folder (`~/aosp-out-redroid15/...`) —
  when `redroid-hwenc` publishes a release, this module should download it from there.
- `integrate.js` uses the `docker` CLI through `child_process`; the backend's image installs `docker-cli` for
  exactly that reason (see the `Dockerfile`). Porting to `dockerode`'s `putArchive()` (with uid/gid=0 in the
  tar headers) would remove that dependency; it is a cleanup, not a blocker.
- The unit tests alone (`backend/test/`, with mocks) do not validate the four hooks
  (`prepareCreate`/`integrate`/`ensureHostInfraReady`/`ensureRuntimeReady`); the full flow (create →
  integrate → start → fixup) has however been exercised against the official redroid image on AMD Polaris,
  Intel Iris Xe and AMD 5700G hosts (see `docs/ROADMAP.md`, Phase 2).
- `android-15-official` in `backend/images.json` declares `hwEncCapable: true`, so the gate requires this
  module for it and the runner executes it on creation; no other catalog image declares it.

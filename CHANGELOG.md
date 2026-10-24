# Changelog

**Languages:** English only, same reasoning as `docs/ROADMAP.md` -- this is a working/historical log, not
a stable specification.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning follows
[SemVer](https://semver.org/), with this policy while the project stays pre-1.0 (`0.MINOR.PATCH`):

- **MINOR** bump: anything a user can newly do -- a new module, a new API route, a new frontend section.
  Also any breaking change (SemVer allows those in a MINOR before 1.0), called out with a `⚠ Breaking`
  bullet so it is never missed just because the version number alone did not say so.
- **PATCH** bump: bug fixes, internal refactors, tests, docs, UI rewording/reorganizing that adds no new
  capability.
- **1.0.0**: reserved for the Phase 10 gate in `docs/ROADMAP.md` ("the project is in a condition to be
  called beta 0.9") -- not claimed before that milestone is actually reached.
- Every tag stays available forever (nothing gets deleted); "stable" means it also has a non-prerelease
  GitHub Release. Given this project already verifies live against a real backend before every commit
  (see git log), most tags qualify by default -- a tag only gets marked as a GitHub pre-release when it is
  explicitly experimental (e.g. something tied to `wifi-interno-virtwifi` as a default, or a deliberately
  unfinished checkpoint).

## [Unreleased]

### Added

- Network exposure, local by default (`docs/ROADMAP.md` Phase 6): the app itself now binds to
  `127.0.0.1` by default (`REDROID_FORGE_BIND_HOST` to override), and so does every instance's ADB
  port (`dockerRuntime.create`'s `bindHosts`, previously hardcoded to `0.0.0.0` -- reachable from
  every host interface by default, with `redroid` itself having no access control of its own). A new
  "Network" sub-section in the instance Configure panel lists the host's real interfaces
  (`GET /api/network/interfaces`) and lets each instance opt into any combination of them, with a
  live warning once anything beyond localhost is selected. "All interfaces (0.0.0.0)" is mutually
  exclusive with the rest (confirmed live that Docker does not support binding both at once for the
  same port -- it is a superset, not an addition).
- Access control: roles, per-instance ownership, pluggable auth (`docs/ROADMAP.md` Phase 7). New
  `REDROID_FORGE_AUTH` env var (`none` default, `local`, `oidc`); a fixed three-role model (admin,
  operator, viewer -- `backend/src/lib/permissions.js`) with per-instance ownership (`ownerId`,
  admin bypasses it); every instance route checks role + ownership, a non-admin never even sees
  another user's instance (404, not 403, for one invisible to them, so IDs cannot be probed to tell
  "not yours" apart from "does not exist"); the UI hides/disables actions the current user cannot
  perform instead of only failing after the fact. `local` mode is a minimal built-in account store
  (scrypt-hashed passwords, no new dependency) with a bootstrap admin from
  `REDROID_FORGE_LOCAL_ADMIN_USER`/`_PASSWORD` and an admin-only Users panel. `oidc` mode is a
  generic OIDC client (`openid-client@5.7.1`, pinned to the last CommonJS-compatible release --
  v6 is ESM-only) against any standard IdP, not Keycloak-specific, with the role claim's path and
  the three role names all configurable (`REDROID_FORGE_OIDC_*`). Verified live end-to-end in
  `local` mode with three real accounts of different roles; `oidc` mode's live callback against a
  real IdP was not verified (no IdP available in this environment) -- covered by unit tests for its
  pure parts (role mapping, PKCE/state handling) only.

## [0.1.0] - 2026-10-24

First tagged release. Covers Phases 0-5 of `docs/ROADMAP.md` plus everything built on top of them since.

### Added

- Instance lifecycle (create/start/stop/restart/delete) against real `redroid` containers, with a Doctor
  diagnostics page for host prerequisites (binder/binderfs, loop, ext4) and per-image support tiers
  (official/community, `backend/images.json`).
- Hardware acceleration: `hwenc` (VA-API encode, AMD/Intel) and `hwdec` (VA-API/NVDEC decode), GPU mode
  selection (host/guest) per instance, a VA-API daemon supervisor, bitrate control and P-frame support.
- Fake WiFi (`wifi-interno`, hwsim-backed) and device profile spoofing (`backend/src/lib/deviceProfile.js`
  -- a Samsung Galaxy A55 profile, revert to the `redroid` default), both applicable live while the
  instance is running or staged for the next start while stopped.
- A generic per-module contract system: manifest schema, a contract modal (`frontend/contracts.js`), and
  a persisted acceptance record -- gates any module that is not 100% free software (GApps, ARM
  translation) or needs explicit host compatibility (`compatibleCon`: Android version, GPU mode, host GPU
  vendor) before it can be activated.
- A read-only known-combinations database (`backend/src/lib/knownDb.js`) resolving a "soporte" verdict
  (official/community/unsupported) per instance, synced from a signed (ed25519) external snapshot.
- User-defined modules (stage 7): a generic runner for per-game/situation automations with their own
  pause/resume/status and persistent scheduling, with CIFI as the first real one.
- Instance backup/restore: whole-`/data`-volume tar.gz backups (not gated to the instance that made
  them -- restoring onto a different/migrated instance is supported), with a metadata sidecar that warns
  (never blocks) on image/module mismatches, and an opt-in Android ID/GSF identity reset on restore.
- Settings (default backup folder) and per-instance real storage location (Docker volume + host
  mountpoint), surfaced in the frontend.
- Instances table redesign: two rows per instance (a big "just let me connect" line, a detail/actions
  line) instead of one row of columns; CPU/RAM live editing and resolution/GPU/codec/WiFi/device-
  profile/optional-modules editing split into two panels by whether applying them interrupts the
  instance.
- `scrcpy` connector scripts (`connect.sh`/`connect.ps1`) and a troubleshooting/shortcuts guide
  (`docs/SCRCPY-TIPS.md`).

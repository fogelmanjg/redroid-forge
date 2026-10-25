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

- `oidc` auth mode is now identity-only AND multi-provider. Identity-only: no provider is ever asked for
  a role claim any more (the old `REDROID_FORGE_OIDC_ROLES_CLAIM`/`_ADMIN_ROLE`/`_OPERATOR_ROLE`/
  `_VIEWER_ROLE` are gone). A new `backend/src/lib/roleAssignments.js` is the actual permissions backend
  for OIDC identities: a local table keyed by a stable external id, managed through a new admin-only
  "Identities" panel -- a brand new identity that has never logged in before has no role and cannot log
  in until an admin approves it (deliberate; nobody gets in just by having an account on an IdP). Why:
  identity (who someone is) and permissions (what they can do here) are kept as two separable concerns on
  purpose now, so that a later integration (e.g. with Plenum, see `docs/ROADMAP.md` Phase 8) only has to
  change where `roleAssignments.resolveRole()` looks, not `oidc.js`/`auth.js`/the routes. Multi-provider:
  `REDROID_FORGE_OIDC_PROVIDERS` (a JSON array) replaces the old single
  `REDROID_FORGE_OIDC_ISSUER_URL`/`_CLIENT_ID`/`_CLIENT_SECRET`/`_REDIRECT_URI` -- any number of trust
  sources configured at once (Google, your own Keycloak, Plenum, another federation, ...), the login
  screen lists every one of them and the person picks which to use; `REDROID_FORGE_OIDC_REDIRECT_BASE_URL`
  derives each provider's own callback URL from its id, so adding one is a single JSON object, never a
  second place to keep in sync by hand. Because a bare `sub` is only unique within one issuer's own
  namespace, every identity's external id is the composite `${providerId}:${sub}`.
  `REDROID_FORGE_OIDC_BOOTSTRAP_ADMIN_ID` solves the chicken-and-egg of approving the very first admin
  (nobody else could), the same role `REDROID_FORGE_LOCAL_ADMIN_USER`/`_PASSWORD` plays for `local` mode.
  ⚠ Breaking: any existing `REDROID_FORGE_AUTH=oidc` deployment loses every account's role on upgrade
  (nothing maps the old role claim any more) and has to migrate its provider config to the new JSON array
  shape -- every identity has to be re-approved once through the new Identities panel.

- `meminfoFix.js`: Android inside a capped instance was always reading the HOST's full RAM from
  `/proc/meminfo` (Linux never virtualizes that file per-container), never its real cgroup memory
  limit -- so it never triggered its own proactive low-memory trimming, and the cgroup OOM killer
  ended up doing that job abruptly instead once the real limit was hit. Confirmed as the root
  cause of a real mid-game stutter on `jg-dashboard` v1's `pvz2-tv` production instance (3030/4096
  MB actually used while `dumpsys meminfo` still reported the host's 63 GB and "status moderate").
  Fix: a generated `/proc/meminfo`-shaped file, `MemTotal` fixed to the instance's memory cap and
  `MemFree`/`MemAvailable`/`Cached` kept live by a 5 s tick that reads the container's own cgroup v2
  `memory.current`/`memory.stat` on the host, laid over `/proc/meminfo` via a `mount --bind` run
  from inside the container once Android has booted (a direct bind at container-create time gets
  shadowed by Android's own boot-time `/proc` remount -- found live). Deliberately not a
  module/contract (see the file's own comment): it is an unconditional correctness fix tied to
  whether an instance has a memory cap at all, the same category as the Memory/MemorySwap pairing
  already in `dockerRuntime.create()`, not a user-facing opt-in. Needs two new things the app
  container did not have before: a real HOST path for its generated files (`REDROID_FORGE_MEMINFO_FIX_DIR`,
  same reasoning as `REDROID_FORGE_BACKUPS_DIR`) and read-only visibility into the HOST's real
  cgroup v2 tree (`/sys/fs/cgroup`, which Docker's default private cgroup namespace otherwise hides
  behind this container's own single-slice view). Live-verified end to end against a real 4096
  MB-capped instance on this host: before, `dumpsys meminfo` reported "Total RAM: 63,646,788K"
  (status moderate, unconditionally); after, "Total RAM: 4,194,304K" with `MemFree`/`Cached`
  tracking the instance's actual real-time cgroup usage and `status` correctly reflecting it.

- `aurora-store` module: Aurora Store (GPLv3), a client for Google Play's real catalog/download
  backend, installed after boot (stage 6 only, no `/system` write) with no files for the user to
  provide -- unlike `gapps`/`arm-translation`, this project downloads the pinned 4.8.3 release
  itself from its official F-Droid mirror and verifies it against a sha256 fixed in the manifest
  before installing anything. Pinned below latest (4.8.4 crashes on its own app-list screens, a
  Jetpack Compose bug in that release) and applies the same WebView command-line fix `gapps` uses
  for its own sign-in screen, independently of whether `gapps` is also enabled -- complementary to
  it, not an alternative (Aurora gets the APK, it does not provide Play services at runtime).
  Live-verified end to end: created a throwaway instance with it requested, accepted the contract
  through the real `428` flow, confirmed Aurora Store installed itself and the WebView fix was
  applied, deleted the instance.

- Settings gained an "App network" section (`appBindHost`, admin-only): which address this app's
  own server (not any instance's) listens on, picked from the same filtered interface list as
  the per-instance picker, instead of only the `REDROID_FORGE_BIND_HOST` env var from
  `docs/ROADMAP.md` Phase 6. Takes effect only after a restart (an `http.Server` cannot rebind
  itself to a new address live) -- the UI says so rather than pretending it is immediate, and
  warns more strongly when exposing it beyond localhost while `REDROID_FORGE_AUTH=none`, since
  that is the whole app (every instance, every account), not just one instance. Live-verified: set
  it to this host's real LAN address, confirmed the server stayed on `127.0.0.1` until actually
  restarted and then bound to the new address, reverted the same way.
- `GET /api/network/interfaces` now hides Docker/container-internal interfaces (`docker0`,
  `br-*`, `veth*`, CNI/k8s bridges -- `backend/src/lib/networkInterfaceFilter.js`) by default, so
  a host running many containers does not drown the instance Configure panel's "Network"
  section in dozens of irrelevant bridges. A new "Network interfaces" section in Settings
  (backed by `GET /api/network/interfaces/all` and a `networkInterfaceOverrides` field on
  `PUT /api/settings`, admin-only) lets an admin correct the heuristic per interface, in either
  direction, for their own host. Live-verified against this real host's own interfaces (11
  distinct interfaces out of 78 raw addresses, correctly narrowed to the 3 that matter: loopback,
  the real LAN bridge and Tailscale).
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

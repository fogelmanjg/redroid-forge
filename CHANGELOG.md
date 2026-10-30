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

## [0.3.1] - 2026-10-30

### Changed

- Auth mode (`none`/`local`/`both`) and OIDC providers (add/edit/remove) can now be switched and
  managed live from the Identities panel, instead of only via `.env` with no visibility into what
  is configured. `PUT /api/auth/mode` enforces the same safety rules either way -- `none → local`
  requires an admin to already exist, any `→ both` requires at least one OIDC provider configured,
  `both → local` requires an existing local admin, `local → none` requires explicit confirmation --
  a restart is still required to apply (`AUTH_MODE`/providers are read once at process start, same
  rule as every other setting in this app). Both now persist in `backend/data/settings.json` (never
  committed, same as every other instance-specific data file), with the env var only acting as the
  bootstrap default before the UI is ever touched -- same precedence pattern as `appBindHosts`
  (Phase 6). Live-verified end to end against two real OIDC providers (a Keycloak realm and Google)
  by an actual login round trip through each, not just unit tests -- the specific provider
  configuration/secrets used for that test are not part of the repo.

### Fixed

- The restart command the UI tells you to run after a settings change (setup wizard, `appBindHost`,
  and now auth mode) said `docker compose up -d` everywhere, which does nothing when only
  `backend/data/*.json` changed (no `.env`/image diff for Compose to notice) -- corrected to
  `docker compose restart` in all three places.

### Added

- Known-combinations resolver: a new `piezas-validadas` support tier, between `oficial` and
  `comunidad`. Found necessary the first time the resolver was checked live against this host's
  real instances: all 3 landed in the old catch-all `comunidad` bucket, which was quietly mixing
  "every piece has its own real evidence somewhere, just never combined" with the much weaker
  "some piece has never actually worked on this hardware at all". No new database fields -- the
  resolver now also checks, when no exact combination match exists, whether every individual
  requested piece (GApps/Magisk package, each module at its exact requested version) has an `ok`
  validation for the host's GPU vendor in *some* existing combination. See
  `docs/KNOWN-COMBINATIONS.md` section 3.

## [0.3.0] - 2026-10-29

Phase 9: port-knocking (SPA, via `fwknop`) for ADB/scrcpy access, per instance and per bound interface --
actually works end to end, on every interface, once the real bug (below) was found and fixed.

### Added

- `fwknopd` runs as a supervised process inside the existing container (`backend/src/lib/fwknop.js`),
  its own key generated once and persisted. `knockRequiredHosts` (a subset of an instance's own
  `bindHosts`) marks which bound interfaces require a knock before the ADB port answers at all --
  localhost and the wildcard address can never be marked (see `instanceParams.parseKnockRequiredHosts`).
- `PUT /api/instances/:id/knock-hosts` (no container recreate -- the guard rules are host-level, keyed by
  an IP:port that stays stable across one), `POST`/`GET /api/instances/:id/adb-access` (opens access by
  having the backend itself send the knock on behalf of an already-authenticated, already role-checked
  session -- never the connecting device). Network panel UI: per-interface toggle + request-access
  control (IP pre-filled from the request, editable; minutes, default 1, no cap -- a longer window only
  ever warns, never blocks).
- An already-open connection survives the knock window's expiry; only a new connection attempt needs a
  fresh knock (one permanent `ESTABLISHED,RELATED` exception rule per guarded interface+port).
- Doctor check `fwknop`: `fail`/`warn` if this project's own `fwknopd` is not running (`fail` only if some
  instance actually has an interface gated, since that interface is then unreachable with no way left to
  open it), plus an informational note -- never escalated past `ok` -- when a foreign `fwknopd` is found
  on the host (`fwknop.detectForeignFwknopd()`, `pid: host`-aware `pgrep` filtered by this project's own
  config path), with the one instruction that matters if this project's own chain name ever changes.
  Also downgrades to `warn` and names the exact rule/instance when `fwknop.detectBypassingRules()` finds
  an earlier rule that already accepts a gated instance's container/port before this project's own
  `DROP` is ever reached -- i.e. `knockRequiredHosts` says "gated" but the knock has no actual effect at
  the firewall.

### Fixed

- This host already runs its own, unrelated `fwknop-server.service` protecting SSH. Sharing
  `network_mode: host` + `pid: host` with it meant `fwknop`'s library-default chain name
  (`FWKNOP_INPUT`) collided with that pre-existing service, and this project's `FLUSH_IPT_AT_EXIT: Y`
  (also a library default) would have deleted the host's live SSH access rule on every container stop.
  Fixed with a chain name unique to this project and `FLUSH_IPT_AT_INIT`/`_EXIT: N` -- verified live,
  twice, that a full container restart leaves the host's own SSH chain untouched.
- `fwknopd` refuses to start unless its config files are `0600` (now `chmod`'d right after being
  written), and the `fwknop` client's `--no-home-dir` flag refuses to run without also setting
  `--rc-file` -- replaced with `--no-rc-file`, which needs neither.
- `pid: host` means an uncleanly-stopped container can leave a real orphaned `fwknopd` outliving it.
  `server.js` now kills it on `SIGTERM`/`SIGINT`, and `fwknop.js`'s own `start()` defensively kills a
  stale one (matched by this project's own config file path only) before spawning a new one.
- ⚠ **The knock gate never actually worked, on any interface, for any real instance.** First testing it
  live against a running instance (not just the unit suite) showed a LAN connection getting through with
  the knock correctly required and never requested. Root cause, confirmed with kernel packet counters
  (temporary `nft` probes, removed right after): an instance's ADB port is published through Docker's
  bridge network, which DNATs in `PREROUTING` -- before `INPUT` (where the guard rules lived) ever runs
  -- then forwards the rewritten packet via `DOCKER-USER`, never delivering it locally. `INPUT` was the
  wrong chain from the start; the Tailscale-specific symptom found earlier the same day was real but was
  never the actual cause, just the first thing that happened to surface it. Fixed by moving
  `ensureGuardRules`/`removeGuardRules`/`detectBypassingRules` to `DOCKER-USER`, matching the instance's
  own container bridge IP (`dockerRuntime.getBridgeIp`) + its fixed internal ADB port (5555) + the
  packet's ORIGINAL pre-NAT destination (`-m conntrack --ctorigdst`/`--ctorigdstport`) to keep the gate
  scoped to one host interface. `fwknopd`'s own dynamic rule insertion could not be reused for the
  temporary "access granted" rule either (wrong chain, and it cannot tell containers apart -- every one
  exposes the same internal port) -- replaced with this project's own comment-tagged temporary `ACCEPT`
  rule (embedding its own expiry) plus a `sweepStaleTempRules()` restart-survival sweep, since the
  container's bridge IP is only assigned while running and is not guaranteed to be the same across
  restarts -- `routes/instances.js` now applies/releases these rules at every point in an instance's own
  lifecycle (start, stop, restart, recreate, delete), not just when `knockRequiredHosts` itself changes.
  Actually live-verified end to end this time, from a real second host, over both the LAN and the
  Tailscale interface: blocked without a knock, let through immediately after one, blocked again once
  the window elapsed for real. See `docs/ROADMAP.md`'s Phase 9 for the full incident writeup.

Unrelated (found while debugging why a local tool on this host could no longer reach the app's API at
all, Phase 6/7):

### Changed

- ⚠ Settings' `appBindHost` (a single address) is now `appBindHosts` (an array), matching an instance's
  own `bindHosts` -- `127.0.0.1` is implicit and can never be left out. An existing install's legacy
  `appBindHost` is migrated transparently the first time settings are read, so nothing already chosen is
  lost. Settings' "App network" section is now a checklist (localhost pinned) instead of a `<select>`,
  sourced from the same already-filtered interfaces list the per-instance Network picker uses.

### Fixed

- This app's own server only ever bound ONE address -- picking a non-default one (e.g. a Tailscale IP, to
  reach the UI remotely without a reverse proxy) silently gave up `127.0.0.1` too, breaking any local tool
  on the same host that assumes the app is always reachable on localhost. `server.js` now calls
  `app.listen()` once per configured address, localhost included unconditionally.
- A local tool with no session cookie (`local`/`oidc`/`both` auth) got `"Not logged in"` even over
  loopback. `auth.js`'s `attachUser` now treats any loopback request (`req.ip`, never a spoofable header)
  as the same fixed admin-bypass user as "none" mode, regardless of configured auth mode -- whoever can
  already reach this app from the same host has strictly more power anyway (reads `data/*.json` directly,
  manages Docker, ...).

### Changed

- The "open access" control moved out of the Configure panel into its own quick-access row next
  to "Storage" -- opening access is something done every time someone wants to connect, not a
  configuration change like deciding which interfaces require a knock at all (which stays in
  Configure).
- The source-IP field in "Open access" now has a hint explaining when it needs editing: it is
  pre-filled from the panel's own detected address, which is only right when the device opening
  access is also the one connecting, over the same network path -- confirmed live opening access
  for a LAN interface from a panel reached over Tailscale, left at the auto-filled Tailscale
  address, did not let the LAN connection through (the temporary rule matches the real source
  address, not which interface the panel itself was reached on).

## [0.2.0] - 2026-10-26

First live pass of `oidc` mode against a real IdP, plus everything it led to.

### Fixed

- The `oidc` callback route passed `oidc.handleCallback()`'s `{id, ...}` straight into
  `roleAssignments.upsertSeen()`, which expects `{externalId, ...}` -- `externalId` was always
  `undefined`, so `undefined === undefined` silently collapsed every distinct OIDC identity onto
  the single first-ever-created row, and `REDROID_FORGE_OIDC_BOOTSTRAP_ADMIN_ID` could never match
  anything real. Only found by actually driving a login through a real IdP for the first time --
  the unit tests call `upsertSeen` directly with the correct shape, so they never exercised this
  call site. Fixed by mapping the fields explicitly at the call site.

### Added

- `REDROID_FORGE_AUTH=both`: local accounts and OIDC providers on the same login screen at once --
  e.g. an admin who wants a password-based account for themselves (no IdP dependency to go down)
  while everyone else logs in through a real identity provider.
- A unified Identities panel/API (`GET /api/auth/identities`) merging local accounts and OIDC
  identities into one table (`source: 'local'|'oidc'`), plus a completed local account-management
  API that did not exist before: `email`, password reset, and role change on an existing local
  account (previously create/delete only).
- Explicit account linking (`backend/src/lib/accountLinks.js`): a local account's login can be
  reached through one or more OIDC identities too, from `PUT/DELETE /api/auth/me/links/*` (self-
  service) or the admin-only Identities panel (view/revoke only). A link is only ever created
  while already logged in as the local account being linked TO, by then completing a real login
  with the OIDC provider being linked -- proving control of both sides at once is the only thing
  this project treats as proof that they are "the same person". A claimed or even IdP-asserted
  email is deliberately never enough on its own: it is a claim, not proof, and claims can be
  reused, recycled or spoofed. Once linked, logging in via that external id mints a session AS the
  local account (same id, same role) and never touches `roleAssignments.js` for it again.
- A first-run setup wizard: while `REDROID_FORGE_AUTH=none`, the Identities tab (now reachable in
  `none` mode too) lets you create the first local admin live, with no restart needed
  (`POST /api/auth/setup/admin`), then shows the exact `.env` line and restart command to actually
  turn security on -- including the real path to that `.env` file, via a new display-only
  `REDROID_FORGE_REPO_DIR` env var set from `docker-compose.yml`'s own `${PWD}` -- and polls
  `GET /api/auth/me` until the mode actually changes, so the login that follows doubles as an end-
  to-end check that the whole chain worked.
- A self-lockout guard: `local`/`both` with no local account yet and
  `REDROID_FORGE_LOCAL_ADMIN_USER`/`_PASSWORD` not set used to mean a permanently locked login
  screen, since the setup wizard above only shows itself in `none` mode. `auth.js` now computes,
  once at startup, whether anything configured could actually let someone in; if not, it runs as
  `none` for that boot instead (or stays `both` if an OIDC provider alone still has a working login
  button) -- logged loudly, and it self-heals the instant a restart sees a real way in.

- `ownerId` (who can see/use an instance) is now a list, not a single id -- an instance can be shared by
  more than one account at once (e.g. a household's shared TV instance). A new `createdId` tracks a
  DIFFERENT thing: who its resource usage counts against for the new operator quota below -- it can be
  attributed to yourself (if you already have access to the instance) or, for admin, to anyone. New
  `PUT /api/instances/:id/owners` and `PUT /api/instances/:id/created-by` manage both, and a new "Owners"
  panel in the instance table exposes them. Operators now get optional resource quotas
  (`backend/src/lib/quotas.js`): a per-operator cap (Users/Identities tab) and a shared pool cap across
  every operator at once (Settings tab) -- either, both, or neither, whichever is reached first blocks a
  create or a live resize. A new `GET /api/auth/directory` lets any logged-in user (not just admin) look
  up an id by username, needed to pick who to share an instance with.

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

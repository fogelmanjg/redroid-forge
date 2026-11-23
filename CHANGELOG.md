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
- No third tier between MINOR and PATCH (considered and deliberately rejected, 14/11/2026): once a
  release needs a judgment call on "how big" a fix is, the one unambiguous signal this policy
  gives (MINOR means something new, full stop) erodes. The MINOR counter climbing well past, say,
  0.15 before Phase 10's gate is expected and fine -- that counter and the "beta 0.9" label above
  are independent by that gate's own wording (a maturity description, not a literal version target);
  there is no reason to keep them in sync.
- Every tag stays available forever (nothing gets deleted); "stable" means it also has a non-prerelease
  GitHub Release. Given this project already verifies live against a real backend before every commit
  (see git log), most tags qualify by default -- a tag only gets marked as a GitHub pre-release when it is
  explicitly experimental (e.g. something tied to `wifi-interno-virtwifi` as a default, or a deliberately
  unfinished checkpoint).

## [Unreleased]

## [1.0.0-beta.9] - 2026-11-23

### Added
- **Instances tab: filter, search and order, in the three views (Full, Minimal, Viewers).** With many
  instances the one you want was hard to find. Above the list: All / Active / Stopped, each with
  how many it would show; a search by name; and "Hide locked". Active means running, restarting or
  paused (still using CPU/RAM). An instance in trouble (dead, container missing) or with a
  backup/restore in progress is shown whatever the filter, so it cannot go unnoticed. Every view
  now lists the active ones first, then alphabetically. When the filter leaves nothing, a "Show
  all" link says so instead of an empty page. The filter and the checkbox are remembered per
  browser; the search is not.
- **Viewers view: stopped instances as small cards.** An instance that is not running has no image:
  instead of an empty tile it gets a small card under the previews, with its state and the start
  button. Previews hidden by the filter close their capture session.
- **OIDC login: a real page when it cannot log you in.** Logging in with a Google/Plenum account
  that is not linked to a user and has no role ended on one line of plain English text with no way
  back. Now a page in the browser's language (es/en) says which account came in and the two ways
  forward -- log in with your own user and link it from your profile, or ask an admin (it already
  shows up as pending) -- with a link back to the login. The other callback errors get the same page.

### Security
- **OIDC callback: no HTML from the provider.** Its error answers were sent as text/html and one
  included the username the provider returned without escaping. All of them now go through the
  new page, which escapes everything.

## [1.0.0-beta.8] - 2026-11-23

### Added
- **Backups: "Back up (stops it, starts it again)".** A backup of a running instance copies /data
  while Android keeps writing to its databases, and can catch one half written -- which only shows
  when it is restored. On a running instance the Storage panel now offers stopping it for the
  backup (and starting it again, unless it is locked) or a live backup with that warning.
- **Backups and restores run in the background, with progress.** They used to run inside the HTTP
  request: minutes with no feedback for a big /data. Now the panel shows the phase, how much has been
  written out of how much data, and how long it has been; it picks a running one up again after a
  reload. Starting or restarting an instance is refused while a restore or a stop-first backup owns
  it.
- **Settings > Backups to keep per instance.** After each new backup, older backups of that same
  instance beyond the number are deleted (0 = keep all, the default). Never touches another
  instance's backups or ones made before this version.
- **Persistent log** at `backend/data/logs/forge.log` (rotated by size), because Docker's own log
  of the container is deleted on every update. Docker's log is now capped too (it had no limit).

### Fixed
- **A big backup or restore was cut off after 5 minutes** (a whole /data of several GB takes
  longer). The limit is now 6 hours. A backup that fails or is cut off no longer stays in the list
  looking like a good one: it is written under a hidden temporary name and only renamed when tar
  finished.
- **Post-start steps kept `docker exec`-ing an instance that had already stopped**, every few
  seconds for minutes (seen live: an instance locked 22 s after starting got ~60 execs over 2.5
  minutes). They now stop at the first "container is not running".

### Security
- **The login page no longer gives away account names.** `GET /api/auth/setup/status` answers
  before login and returned every local username plus the repo path. Now those only go to "none"
  mode (the first-run wizard) or a logged-in admin.
- **Sessions follow the account.** The role used to travel inside the 7-day session cookie, so
  deleting an account, lowering its role or changing its password left its open sessions working as
  before, and a stolen cookie could not be cut off. Now every request reads the account's current
  role; a deleted account or an OIDC identity without a role ends its sessions at once; a password
  change ends every older session of that account. New **Log out everywhere** button in the header.
- **Backups belong to their instance's owners.** Any operator could list, restore (into their own
  instance -- taking someone else's Google accounts and app data with it) and delete every backup.
  Now a backup records the instance and its owners, and a non-admin only sees, restores and deletes
  backups of instances they own or owned when the backup was made. Backups made before this version
  have no owners recorded: admin only.

## [1.0.0-beta.7] - 2026-11-23

### Added

- **Settings > ADB address for clients.** The host name or IP other computers use for the
  instances' ADB ports -- shown in every instance's address and used by the 📲 links and their
  test. Empty = the name the page was opened with (as before); set it when the page goes through a
  name ADB cannot reach, e.g. a public domain behind a reverse proxy while ADB is only on the LAN
  or VPN address. `REDROID_FORGE_ADB_HOST` is the fallback.

### Fixed

- **Internal WiFi (fake wifi) never connected on an instance's first boot; a restart fixed it.**
  Root cause: on connect, the WiFi HAL patch takes its static IP from
  `/data/local/tmp/.jg-netinfo`, which `jg_netfix.sh` only wrote after the interface swap -- and
  the swap waited for that very connect. On a first boot the file did not exist yet, so Android
  fell back to DHCP (there is none on this network), gave up after ~18 s and disconnected; the
  forge had already seen "connected" and stopped retrying. A restart worked only because the file,
  in `/data`, survived into the next boot. Now the forge writes that file from eth0's address
  before every connect attempt (which also corrects a stale address after a recreate), waits for
  Android's boot to complete before trying, and only counts the connection once it still holds 25
  s later. Verified on a brand-new instance: connected 36 s after creation and stayed up.

### Changed

- Live previews can be captured up to 1080px (was 480): the "Viewers" grid now uses the whole
  window, and with 1-2 per row the previews were stretched and blurry. Each grid still asks for
  its real column width, so small previews stay small.

### Security

- **Cross-site requests are refused.** Over HTTPS the session cookie is `SameSite=None` (needed
  for the Plenum iframe embed), so a browser attached it to requests another site's page fired at
  redroid-forge: a page visited by a logged-in admin could POST body-less actions (restart the
  hwenc daemon, apply the known-combinations database, start/stop/lock an instance whose id it
  knew) or open a viewer WebSocket. Every state-changing `/api` request and every WebSocket
  handshake whose `Origin` is not redroid-forge's own now gets 403. Requests with no `Origin`
  (curl, scripts, local tools) and the Plenum embed (same origin) are unaffected; extra trusted
  origins go in `REDROID_FORGE_ALLOWED_ORIGINS`.
- **Login attempts are limited**: 10 wrong passwords within 15 minutes from the same client and
  further attempts get 429 until the window passes (behind a reverse proxy on the same host, the
  client is the address the proxy reports). The password check no longer blocks the server while
  it runs, and a wrong username takes as long as a wrong password.
- **`GET /api/settings` is admin only, and never returns OIDC client secrets.** It answered any
  logged-in account (a viewer too) with the whole settings file, including the `clientSecret` of
  every OIDC provider added from the UI. A new `GET /api/settings/client` gives any logged-in page
  the one setting it needs (`adbHost`, below).
- The "Test local scrcpy" temporary firewall rule only admits private and CGNAT/Tailscale source
  ranges (10/8, 172.16/12, 192.168/16, 100.64/10) instead of any address;
  `REDROID_FORGE_LAUNCHER_TEST_SOURCES` overrides them. A leftover rule from a crashed process is
  found by its comment whatever its source.
- Checked, no change needed: restoring a backup cannot write outside the instance's `/data` --
  alpine's tar strips `../` and `/` from member names and refuses a symlink to `/`, and it runs in
  a throwaway container anyway (tested with a hostile archive).
- **Accepting a module contract records who accepted** -- the logged-in user. It used to record
  `local` for everyone (and took the user from the request body), and any logged-in account could
  accept; it now needs the `create` or `configure` permission.

## [1.0.0-beta.6] - 2026-11-22

### Fixed

- **Local scrcpy (📲) did not open on most instances.** scrcpy asks for Opus audio by default, and
  redroid's Android images have no Opus encoder: the scrcpy server died on its audio thread and
  took the video with it, on 3 of 4 instances tried. The launcher (v3) now adds
  `--audio-codec=aac` unless your config already chooses an audio codec or `--no-audio`. And a
  scrcpy that exits with an error now gets the same error dialog as a failed `adb connect`, with
  scrcpy's own last error line -- before, the window just never appeared. Reinstall the launcher
  (same commands as the first time) to get it.
- Opening an instance in local scrcpy (📲) left an empty tab behind in Firefox: the link is now
  handed to the system the way "open in the app" pages do (a top-level navigation), not through a
  link click.
- **"Viewers" with 3 or 4 per row left the sides empty.** The page is capped at 960px; the grid
  split those same 960px among more columns. The viewers view now uses the whole window.
- The live preview size slider ("Auto" per row) and the preview's centering had stopped applying
  since 1.0.0-beta.2: the terminology rename turned the CSS names `--ventanita-size` and
  `viewer-ventanita-wrap` into invalid ones with a space. Now `--preview-size` and
  `viewer-preview-wrap`.

### Changed

- In the "Viewers" cards, ⛶ and 📲 sit in the same row as start/stop/restart/delete/lock instead
  of a row of their own.

## [1.0.0-beta.5] - 2026-11-22

### Added

- **Open an instance in scrcpy on your computer (📲), with a real test first.** A local launcher
  (`launcher/linux/`, Linux only for now, installed per user without root, also served by the
  forge at `/launcher/linux/`) handles `scrcpy-redroid://` links. A browser cannot tell whether a
  URL scheme has a handler, so nothing is guessed from the user agent: the new **▶ Test local
  scrcpy** button (Instances toolbar) proves the whole path -- the forge opens a temporary fake ADB
  device (`REDROID_FORGE_LAUNCHER_TEST_PORT`, default 15599) plus, when it has iptables access, a
  temporary firewall rule, and hands out a one-time code; the launcher connects with the local
  `adb` and answers with it. Only then is the feature turned on, in that browser
  (localStorage), and every running instance shows 📲. A failed test shows the install steps with
  this forge's address filled in and a link to the guide (docs/HOWTO.md). The port and the rule
  exist only while a test runs. The launcher only ever runs `adb connect` + scrcpy (or the test
  echo) for a validated `host:port`, never options taken from the link; your own scrcpy flags
  (e.g. `--hwdec=disabled`) go in `~/.config/redroid-forge-launcher/config`. Not offered on
  Android/iOS. On an instance published only on 127.0.0.1 the 📲 is disabled with the reason (no
  other computer can reach it). Launcher errors (e.g. adb cannot connect) open a dialog you have to
  close (kdialog/zenity, a notification otherwise), and the page shows a short note when 📲 is
  pressed -- it cannot tell by itself whether scrcpy connected. `POST /api/scrcpy-launcher/test`,
  `GET /api/scrcpy-launcher/test/:code`.
- **The "Viewers" view can open the expanded viewer** (⛶) from each card; before, only the "Full"
  view's rows had the button.

## [1.0.0-beta.4] - 2026-11-22

### Changed

- The hwenc daemon is now built from **redroid-hwenc v0.4.0** (`REDROID_HWENC_VERSION`). The daemon
  itself is unchanged from v0.3.0; the release's Android 11-13 (HIDL) component now sends a
  per-session `stream_id` too, so two viewers of the same Android 11 instance get one encoder each
  -- point `REDROID_HWENC_ARTIFACTS_DIR` at the v0.4.0 artifacts and recreate those instances.
- **Doctor: "Active ADB connections" is now "Active video sessions (scrcpy)"** and actually means
  it. The old check counted TCP connections to each instance's ADB port, which the host's shared
  adb server (also used by this app for live previews and watchdogs) always held -- it warned for
  every instance anyone had viewed. It now counts the scrcpy-server processes inside each running
  instance and says who started them: this forge's expanded viewer, an external scrcpy client,
  or a session that looks like an expanded viewer's but is not tracked by this app (flagged as
  left behind, with a fix).

### Added

- **Settings > hwenc: the shared daemon's state and a "Restart daemon" button** (admin only).
  Shows whether the VA-API daemon runs, for how long and how much RAM it uses (or that another
  forge on the host owns it), and restarts it with a confirmation -- it cuts hardware encode on
  every instance for a few seconds. Before, the only way from the UI was changing the encode
  backend. `GET /api/settings/hwenc-daemon`, `POST /api/settings/hwenc-daemon/restart`.
- **Lock an instance.** A 🔒 Lock button (`configure` permission) stops the instance and keeps it
  from being started, restarted or deleted until it is unlocked -- e.g. the original of a
  migration, kept for safety, whose copy already runs elsewhere with the same Google identity.
  The reason, who and when show on a 🔒 locked chip and on the disabled buttons; a recreate
  (display/resources) of a locked instance leaves it stopped; the Doctor lists locked instances.
  If a locked instance is found running when the app starts (started by hand with `docker
  start`), it is stopped. `POST /api/instances/:id/lock` (`{ reason }`) and `/unlock`.
- **Containers started outside the app are reconciled live.** `docker start` by hand, or Docker
  itself (`unless-stopped` after a crash, a Docker restart or a host reboot / power cut), used to
  bring an instance up without any of what the app's own start does -- no hwenc daemon, no
  watchdogs, no fake-wifi radios -- and without respecting a lock. The app now follows Docker's
  event stream: a start it did not ask for gets the same post-start steps as the start button,
  and a locked instance is stopped within seconds (2 s grace). Preventing such starts outright is
  planned for 1.0.1 or 1.1.
- **Doctor: the known-combinations database checks for a newer one when you open it, with an
  Update button.** It used to only repeat the last daily check and say "update it with POST
  /api/db/update" -- there was no button anywhere. Now opening the Doctor asks GitHub right then
  (same conditions as the daily check), and if a newer signed database is published the check
  turns to warn with "Update to serial N", which downloads, verifies the signature and applies it.

### Fixed

- `POST /api/db/check` and `POST /api/db/update` were open to any logged-in user; they are admin
  only now (applying replaces the database every instance's support level comes from).

## [1.0.0-beta.3] - 2026-11-21

### Added

- **Watchdogs can be turned on and off from the instance row.** A watchdog module's chip (cifi
  today) shows its real state -- `cifi ● on` / `cifi ○ off` -- and clicking it opens a small
  panel with the last pass (time, OK or the error) and an on/off button (`configure` permission).
  Turning it on restarts the watchdog from zero and runs one pass right away instead of waiting a
  whole interval. The pause/resume API existed already; the UI had no way to reach it, so the
  only choices were accepting the contract or removing the module. `GET /api/instances` now
  carries each instance's `watchdogs` state.

### Fixed

- Turning a watchdog on stored the choice by deleting its key, which made the next recompute of
  the instance's modules (any recreate) treat it as new and re-pause it for modules that start
  paused by default; it is an explicit `false` now.

## [1.0.0-beta.2] - 2026-11-21

### Added

- **Expanded viewer: rotate the device** -- a ⟳ button sends scrcpy's own `ROTATE_DEVICE` control message
  (portrait <-> landscape, same start-stop permission as every other input); the browser decoder
  is reconfigured when the stream restarts at the swapped size.
- **Expanded viewer: move the button bar** between the bottom (default) and the right edge, so in
  portrait the bar does not eat into the picture; remembered per browser.
- **Visores: "Per row"** -- `Auto (size)` keeps the original layout (as many cards as fit at the
  slider's size); 1/2/3/4/6 lays the cards out in that many equal columns over the full width,
  each preview filling its column and captured by the backend at that real width.

### Changed

- **Terminology: "ventanita" is now the *live preview* and "expandida" the *expanded viewer*** in
  every doc, log message and code identifier (Spanish docs: *vista previa en vivo* / *vista
  expandida*) -- the Spanish nicknames had leaked into the English docs and code. The
  per-browser list of previews turned on moved from the `ventanitaIds` to the `previewIds`
  localStorage key; the old one is still read, so nobody loses their selection. Older entries
  below were updated to the new terms too.
- README/CONTRIBUTING: status updated for the 1.0 pre-release cycle, and the freeze clarified: it
  holds back big features only -- bug fixes, annoyances and missing UI bits that should already be
  there keep landing.

### Fixed

- The test suite is hermetic: 519/519, nothing skipped. One binder test read the real store and
  failed on a host with a dev instance on binder slot 3; one codec2Service test was skipped
  unless `REDROID_HWENC_ARTIFACTS_DIR` was set (so it never ran); one live preview test could
  flake under load and, when it failed, hang the whole run.
- **After a backend restart or update, running instances lost their hwenc daemon and their
  watchdogs** until each one was restarted by hand: the VA-API daemon is only launched on demand
  and dies with the old app container, and watchdog timers live in memory. At boot, every
  instance whose container is running now gets both back (the same two steps the start route
  runs), without touching the container.
- **Watchdogs restart from zero on every start, restart, recreate and backend boot** (a fresh
  timer and fresh last-run state; the pause state is kept -- it is the instance's own choice).
  Before, starting an instance kept whatever timer it already had.
- **A recreated instance's watchdog ticked against the deleted container.** The recreate path
  (`POST /:id/display`: display, resources, gpuMode, bind hosts) never stopped the instance's
  module scheduler, and `start()` skipped a module already scheduled -- after recreating both
  cifi instances on prod, the cifi watchdog failed every 5 min with "No such container" and never
  reopened the game. The route stops it first now, and `start()` replaces a timer bound to another
  container.

## [1.0.0-beta.1] - 2026-11-21

First pre-release of 1.0, decided by the user on 21/11/2026 after the hwenc work below. Still
inside the Phase 10 feature freeze (`docs/ROADMAP.md`): bug fixes and docs, plus the per-stream
hwenc change, which fixes a real multi-viewer bug. Three planned UI items (rotate button and
movable button bar in the expanded viewer, columns/full-width in the visores grid) are deferred to a
later beta.

### Fixed

- **hwenc daemon memory leak** (redroid-hwenc v0.3.0, now the pinned `REDROID_HWENC_VERSION`):
  the legacy encoder never destroyed its per-frame VA parameter/packed-header buffers, ~27 KB per
  encoded frame, never returned -- the "daemon gets heavy" seen on prod (55 MB -> 3-4.5 GB in
  12-17 h). Measured flat over 5.7k frames on the dev forge.
- **Two viewers of the same instance gave black/frozen video** (e.g. the scrcpy app on a tablet
  plus the browser's expanded viewer). The daemon identified a stream by (process, resolution), so two
  encoders in the same instance crossed P-frame references. The Codec2 component
  (`android/vaapi_codec2`) now sends a per-session `stream_id` and the daemon keeps one encoder per
  stream (same model as Android's software encoder: one per viewer). Needs the new hwenc artifacts
  (the redroid-hwenc v0.3.0 release tarball); an older component keeps working, with the old
  behaviour. Android 11 (HIDL) does not send `stream_id` yet.
- **hwenc daemon isolation** (redroid-hwenc v0.3.0): one thread per connection, socket timeouts,
  connection caps, a per-process circuit breaker, and `SIGPIPE` no longer kills the daemon when a
  client hangs up early (which cut the encoder for every instance until the supervisor relaunched
  it).
- `versionCheck.isNewer` understands SemVer pre-releases: `1.0.0` is newer than `1.0.0-beta.1`
  (the old loose compare said no, so a host on this beta would never have been told about 1.0.0).
- `android/build.sh`/`ninja.sh` copied `protocol.h` from `backend/native/vaapi-daemon/`, gone since
  the daemon is built from redroid-hwenc; they take it from `REDROID_HWENC_DIR` now.
- **Expanded viewer: the scrcpy-server it starts is now always torn down when the viewer goes
  away** (21/11/2026). Three ways it could outlive its viewer and keep encoding at 60 fps through
  the host's shared VA-API daemon with nobody watching (the suspected source of that daemon's
  memory growth on prod, which only happens while encode sessions are active): (1) the WS 'close'
  handler was registered only after `viewerSession.start()` resolved, so a viewer gone during
  startup was never noticed; (2) `wsServer.js` never pinged, so a client that vanished without a
  FIN (sleeping tablet, dropped Wi-Fi, a frozen PC) was only noticed by TCP keepalive, ~2 h --
  it now pings every 10 s and drops the connection after 30 s of silence; (3) the kill was one
  unchecked `pkill -f` with its errors swallowed, and the host-side `adb shell` child was never
  ended -- now SIGTERM, verify, SIGKILL, and a log line if it still survives. Also: a failed start
  now closes the WS instead of writing an HTTP 500 into an already-upgraded socket, and
  `OpusTranscoder.close()` is idempotent.
- **Live preview: one shared capture per instance instead of one per viewer** (21/11/2026,
  `lib/captureHub.js`). Every open frontend ran its own `screencap` loop per instance; now the
  backend runs at most one per instance, only while someone is watching, shrinks it once per
  distinct size requested, and hands every viewer the latest frame (a late joiner gets it right
  away). After 3 failures in a row every viewer of that instance is told to give up at once,
  instead of each one hammering adb against an instance that is gone.
- meminfoFix forces mode 644 on the copied `.rc` instead of trusting the source's permission; the
  core picker visually aligns SMT sibling pairs.
- Modules tab and User modules tab: sort modules worst-first (never accepted, then
  accepted-but-outdated, then accepted) -- same "don't bury what needs attention" pattern as the
  Doctor tab's own sort (0.9.1), which this one was meant to have had from the start.
- `README.md`/`README.es.md` no longer claim "no bundled web viewer yet" or describe the project
  as covering only Phases 0-7/9 at tag `v0.3.0` -- both stale since Phase 11 (the built-in
  live preview/expanded viewer) shipped in 0.9.0/0.9.1/0.10.0. Added a credit for `scrcpy`
  (Genymobile) alongside the existing `redroid` credit.

### Added

- Known-combinations: user modules are excluded from the match, and cifi's real combination is
  validated. cifi watchdog starts enabled by default, with a first-use warning. A dedicated column
  for the eye/preview/expand buttons in the "completo" view; a floating help over the expanded viewer's
  keyboard button.
- `docs/TROUBLESHOOTING.md` and `docs/HOWTO.md`, seeded with real cases (including the YV12 crash
  watching Play Store video in landscape, root cause confirmed and linked upstream, and "never give
  an instance a single CPU").
- `CONTRIBUTING.md` and `.github/ISSUE_TEMPLATE/` (bug report, feature request) -- Phase 10 step 3
  of `docs/ROADMAP.md`, the project's own 1.0 gate. States the current feature freeze up front.

## [0.10.0] - 2026-11-15

### Added

- Instances: a new "expanded viewer" viewer mode -- full-screen, real-time video (H.264 via
  `VideoDecoder`), audio (Opus via `AudioDecoder`), and input (pointer → touch, a hidden text
  field, a nav bar for back/home/recent-apps/volume/fullscreen), reachable from a new ⛶ button
  next to the existing live preview toggle. Drives the real `scrcpy-server.jar` this project already
  pushes and launches itself through a new WS route (`/api/instances/:id/viewer/full`,
  `backend/src/routes/viewerExpanded.js`) and a new frontend module (`frontend/viewerExpanded.js`)
  -- not screencap polling like the live preview, the actual streaming-quality experience that mode
  explicitly isn't. Reuses the existing `permissions.js` model as-is (`view` to watch, `start-stop`
  to send input). See `docs/ROADMAP.md`'s Phase 11 for the full design.

### Fixed

- Audio encode: no Android image/host combination tried across this project ships a working Opus
  audio ENCODER (the vendor's own `media_codecs_google_audio.xml` declares the decoder, never the
  encoder -- confirmed down to that file, and matching an already-documented identical gap on
  `redroid11_x86_64` and on the `nvenc`+`venus3d` combination). AAC does encode on-device, but an
  earlier attempt at decoding it in the browser had already failed. Worked around by requesting
  raw/uncompressed PCM from scrcpy-server instead (no on-device MediaCodec involved at all) and
  encoding it to Opus ourselves, in process, before relaying to the browser
  (`backend/src/lib/scrcpy/opusTranscoder.js`, one `opusscript` instance per viewer session).
- Doctor: findings are now sorted worst-first (fail, then warn, then ok) instead of the backend's
  raw order, so anything needing attention is never buried below a page of green checks.
- Instance creation: the image dropdown now defaults to the "oficial"-tier image instead of
  whichever image happens to be first in `images.json`'s own order (previously
  `android-11-official` by list-order accident, not by design).

### Changed

- `backend/src/routes/viewer.js`'s WS upgrade handler no longer answers 404 for a path under
  `/api/instances/` that isn't its own `/viewer` -- found live building the route above: every
  `onUpgrade` handler this project registers sees every upgrade request regardless of path, so a
  broad "looks like mine" prefix check was enough to let this handler steal and kill a sibling
  route's socket before that other handler ever got a turn. A non-match now falls through
  silently, same posture already taken for a path outside `/api/instances/` entirely.

## [0.9.1] - 2026-11-15

### Fixed

- Instances: the live preview ("live preview"/"visores", added in 0.9.0) could fail to start with
  "Upstream capture failing" on a host where its instance had never been `adb connect`-ed under
  the exact `127.0.0.1:<port>` string before -- `adb -s host:port` matches an already-connected
  serial literally, with no IP normalization, so a device already reachable only as
  `localhost:<port>` (e.g. via `scripts/connect.sh`'s own default host string) was invisible to
  it. Found live updating prod to 0.9.0: its one instance had only ever been connected as
  `localhost`, never `127.0.0.1`, so the preview never worked there even though scrcpy/adb
  against the same instance worked fine directly. The capture loop now calls the same
  `ensureConnected()` the real scrcpy pipeline already used for this (`scrcpy/forward.js`)
  before every capture, which is also self-healing if the device ever drops off adb's list
  mid-session.

## [0.9.0] - 2026-11-15

### Added

- Instances: an embedded live preview ("live preview") right in the dashboard, toggled per instance
  with a 👁 button next to its address. Backed by a periodic screenshot (`adb exec-out screencap`)
  rather than a real scrcpy video session: the shared hardware-encode daemon's VA-API path was
  found to fail intermittently under host-wide concurrent load (the exact same request that
  worked three times in a row failed three times in a row minutes later), killing the whole
  scrcpy-server process rather than just degrading one connection -- and the preview was never
  meant to be smooth to begin with. Each capture is shrunk and recompressed server-side to a
  small, heavily-lossy JPEG before going out over a small hand-rolled WebSocket (no `ws`
  dependency, same posture as the rest of this project's auth/session code).
- Instances tab: a view-mode switch above the table -- "Completo" (today's full row, unchanged),
  "Mínimo" (name, address, and only the start/stop/restart/delete buttons that apply -- nothing
  else, for whoever wants zero detail), and "Visores" (a grid of live preview cards, one per
  instance, wrapping into as many columns/rows as fit the window). The chosen mode is remembered
  per browser.
- "Visores" grid: a preview-size slider (60-400px) that drives the actual backend capture size,
  not just a CSS stretch of a small fixed image -- dragging it live-resizes every open preview on
  its very next capture tick, with no reconnect needed.
- Backend groundwork (not yet exposed in the UI) for a future full-screen, full-video+audio
  viewer mode: a from-scratch client of the real scrcpy-server protocol (push the official
  `scrcpy-server.jar` into the container, launch it directly with `app_process`, speak its
  video/audio/control socket framing) -- reserved for later, independent of the screenshot-based
  live preview above, which does not and will not depend on it.

## [0.8.2] - 2026-11-14

### Added

- Doctor: a new "ADB port range availability" check. Found live on server01 (10/11/2026) setting
  up a second checkout: the default `ADB_PORT_START`/`ADB_PORT_END` range (5555-5595) silently
  overlapped with ports an unrelated, non-redroid-forge orchestrator already running on that host
  held, and the only symptom was Docker's own "port is already allocated" failing mid-`docker
  create`. The check now looks at every port actually listening on the host (`network_mode: host`
  makes this a real check, not a container-local one) and warns/fails *before* that, naming the
  exact ports already taken.
- README/`.env.example`: extended the "second instance on a host" guidance (added in 0.6.1) to
  cover two things a second checkout does NOT inherit from the first, both hit for real on
  server01 the same day: the ADB port range (see above) and the optional modules' host data
  (gapps, arm-translation, hwsim-wifi-overlay, `REDROID_HWENC_ARTIFACTS_DIR`) — all local,
  gitignored content that a fresh checkout starts without, even on a host where a sibling
  checkout already has it.
- Settings: the ADB port range (`ADB_PORT_START`/`ADB_PORT_END`, previously `.env`-only) is now
  also a UI field, with a live check against the real host as you type it ("From"/"To" in
  Settings) and no restart needed to apply -- `portAllocator.js` already read it fresh on every
  call, and `fwknop.js`'s on-disk `access.conf` (OPEN_PORTS) is now regenerated and reloaded
  right after saving. The three previous readers of `ADB_PORT_START`/`ADB_PORT_END`
  (`portAllocator.js`, `fwknop.js`, `doctor.js`'s own range check) now share one implementation
  (`portAllocator.range()`/`rangeStatus()`) instead of three copies of the same `ss` parsing.
- Instance create dialog and Configure panel: an optional "ADB port" field, with the same live
  host check (`GET /instances/adb-port-check`) -- a taken port is now caught with a clear 409
  before `docker create`, not Docker's own generic "port is already allocated". Omitted at
  creation = still auto-allocated (`portAllocator.nextPort()`); omitted while editing = keeps the
  instance's current port, unchanged. Changing it always means the same real recreate as
  width/height/gpuMode (`POST /:id/display`) -- Docker's own port publishing is immutable once a
  container exists, there is no live-update path for it either.

## [0.8.1] - 2026-11-14

### Fixed

- The VA-API daemon's source (`backend/native/vaapi-daemon/`) was a hand-copied, vendored checkout
  of redroid-hwenc's `tier5-vaapi-daemon` ("a direct port, no logic changes") -- every real upstream
  fix or addition needed porting by hand, file by file, and there was no clean way to try a newer
  redroid-hwenc and roll back if it regressed a GPU this project already had working. The Dockerfile
  now builds the daemon from a pinned redroid-hwenc tag (`REDROID_HWENC_VERSION`, default `v0.2.0`,
  the same version the vendored copy matched), overridable per host in that host's own `.env`
  independently of every other host. Same binary, same protocol -- verified live: rebuilt the image,
  confirmed the daemon still detects VA-API/the real GPU and starts encode+hwdec exactly as before.
  The now-dead vendored source and its own `test/` directory were removed (that build/verification
  tooling lives in redroid-hwenc now).
- Doctor's "HW acceleration (hwenc, VA-API)" check now shows which redroid-hwenc tag the running
  daemon was actually built from (`REDROID_FORGE_HWENC_DAEMON_VERSION`, frozen from the build ARG
  above into the image) -- a build ARG alone is invisible once the image exists, so there was no way
  to see this at runtime before.

### Added

- Doctor: a new "Active ADB connections (possible scrcpy)" check. Recreating the redroid-forge
  container (e.g. for the `REDROID_HWENC_VERSION` change above, or any other image rebuild) briefly
  drops the hwenc daemon's socket -- if an instance has an active scrcpy session right at that
  moment, that one in-flight frame fails. There is no way to tell from the host side whether an
  established ADB connection is a shell, logcat, or actually scrcpy (ADB multiplexes everything over
  one connection, no separate port to tell them apart), so this is a heads-up, never a blocker:
  matches each instance's `adbPort` against `ss -Htn state established` and names whichever
  instance(s) have one right now.

## [0.8.0] - 2026-11-14

### Added

- Android 11 support for the `venus3d` module (real NVIDIA 3D via Venus/vtest), completing the
  port started 11-12/11/2026: enabled in the module's own manifest for `androidVersion: 11`,
  guest-artifact injection made version-aware (same split pattern `codec2Service.js` already used
  for `hwenc`/`hwdec`'s AIDL/HIDL variants) instead of assuming a single Android-15 artifact
  layout, plus the SurfaceFlinger-vs-Vulkan-loader boot deadlock fix that was blocking Android 11
  from booting at all with this module active. Confirmed stable boot (no crash loop, no ANR) with
  the `lib64` guest artifact rebuilt against its real SDK level (30, not Android 15's 34) --
  **actual on-screen 3D-accelerated rendering is not yet confirmed** (RenderEngine logs an EGL
  native fence sync failure at startup, `screencap` returns blank after boot); the 32-bit (`lib/`)
  artifact is also not yet rebuilt against SDK 30. Tracked as a known-incomplete state, not
  reported as fully working.
- A browser-tab icon for the dashboard (previously none at all) -- SVG favicon, `favicon.ico`
  fallback, and an apple-touch-icon for home-screen shortcuts.

### Fixed

- The session cookie was always `SameSite=Lax`/non-secure, which breaks login the moment this app
  is shown cross-site in an iframe (Plenum's dashboard embeds it from a different registrable
  domain) -- the browser accepts the cookie on login but refuses to send it back, so the login
  dialog reappeared forever even with correct credentials. Now reads `X-Forwarded-Proto` (set by
  Caddy) to use `SameSite=None; Secure` behind TLS, keeping the original behavior for plain-HTTP
  access.
- README overstated NVIDIA decode as confirmed on the RTX 4060 (redroid-hwenc's own table says
  that GPU's decode was never actually run) and understated encode/decode/3D as "just a proof of
  mechanism" when both have since been validated end to end on GTX 1050 Ti and RTX 4060 (host mode
  + nvenc + venus3d), with only a minor, transient, self-resolving tiling artifact on the 4060.
  Also found: Opus audio doesn't register in the nvenc+venus3d combination (unresolved, noted in
  the module READMEs).
- The bundled-web-viewer absence and the "no reverse proxy/auth stack bundled" note both read as
  permanent, deliberate design decisions in the README; corrected to "not built yet" and "not
  incompatible, just not set up by this project", respectively.

## [0.7.1] - 2026-11-09

### Fixed

- Opus audio (scrcpy's own default codec) failed on every instance with `Failed to initialize
  audio/opus` / `NAME_NOT_FOUND` -- a real bug, investigated in depth on 31/10/2026
  (`MediaCodec.createEncoderByType` traced, `mediaswcodec` `strace`d, HAL registration checked)
  without finding the cause. Root-caused today by diffing a full `getprop` dump between a working
  and a failing instance: the only relevant difference was `ro.boot.use_redroid_c2` (a read-only
  boot-time property), which triggers the official image's own `/vendor/bin/redroid.c2.sh` --
  nothing but two `setprop`s (`debug.stagefright.ccodec=4`,
  `debug.stagefright.c2inputsurface=-1`). It used to be added only by the `hwenc`/`hwdec`/`nvenc`
  modules, on the mistaken assumption that it was VA-API-specific -- it is not: isolated in a
  disposable container with zero modules and default `gpuMode`, confirmed purely additive
  (`scrcpy --list-encoders` before/after: same OMX-named aliases stay working exactly as before,
  plus the native `c2.android.*` entries, HEVC, AV1, and Opus encode, which has no OMX-era
  software encoder to fall back to -- the actual reason this was the one codec that failed while
  AAC/FLAC worked). Made a default for every instance regardless of modules
  (`routes/instances.js`); `hwenc`/`hwdec`/`nvenc` no longer contribute it themselves.
  `scripts/connect.sh`/`.ps1` no longer force `--audio-codec=aac` -- scrcpy's own default (Opus,
  lower latency/bitrate) now works as-is.

## [0.7.0] - 2026-11-09

### Added

- `hwenc`/`hwdec`/`redroid-gralloc-fix`: Android 11 (and, by AOSP source-level inspection, 12/13)
  support, via a HIDL port of the Codec2 VA-API component (AIDL does not exist before Android 14)
  plus a `dma_heap` fallback for `libion.so` (legacy `/dev/ion` does not exist on modern host
  kernels). Validated end-to-end through the real instance API -- not a hand-patched container --
  on both AMD (Ryzen 5700G/Renoir) and Intel (Iris Xe). Intel on this HIDL path hits the exact
  same malformed-bitstream bug (`Overread SPS by N bits`) as the AIDL/daemon.c path on Android 15,
  confirmed to be the same underlying Intel/iHD driver issue -- fixed the same way (the `ffmpeg`
  encode backend), already covered by the create-instance dialog's existing encode-backend
  warning, no separate HIDL-specific one needed. Android 12/13 are assumed to work the same way
  (same AOSP-source gap, same component), not separately tested yet.
- `gapps`/`aurora-store`/`arm-translation`: extended to Android 11 (the `x86_64-30_r10` SDK
  system image) alongside the existing Android 15 one -- plain ext4 partitions instead of erofs,
  a few renamed/missing file paths in the gapps set, and an older, pre-"berberis"
  `ndk_translation` generation for `arm-translation`. Confirmed end to end on real hardware
  (Iris Xe/host): gapps boots and signs in, aurora-store installs, and `arm-translation` runs a
  real ARM64-only app correctly. None of these three combinations are in the known-combinations
  registry yet -- manifests document them as locally-extracted, unsupported-combination packages
  for now.

### Fixed

- `hwenc`'s Android 11 runtime fixups (stage 6) used to race Android's own boot sequence: a
  `setprop` could apply with no error and then get silently reset moments later by a later boot
  step, because the readiness check used (`/data/local/tmp` existing) was not the same thing as
  boot actually finishing. It now waits for `sys.boot_completed=1` first.
- `hwenc`: dropped the stale, Android-11-HIDL-specific Intel risk warning (`hidlIntelRisk`) now
  that Intel is confirmed working there with the `ffmpeg` encode backend -- superseded by the
  more general `encodeBackendRisk` the create-instance dialog already shows.

### Security

- Closed a loopback-auth bypass: a local reverse proxy (e.g. `plenum-caddy`, via manual routes)
  relaying external traffic to this app's own loopback address made every relayed request look,
  at the TCP level, identical to a trusted local tool (like `scrcpy-redroid.sh`) -- so visitors
  arriving through that route silently got `NONE_MODE_USER` regardless of `AUTH_MODE`, never
  asked to log in. The loopback bypass now also requires the absence of an `X-Forwarded-For`
  header -- a proxy relaying someone else's traffic always adds that header; a tool running
  directly on this host never does, and nothing off-host can set it here since it can't reach
  `127.0.0.1` in the first place.

## [0.6.3] - 2026-11-08

### Fixed

- `appBindHosts` (Settings' "App network" addresses) used to require a full container restart to
  take effect -- it was only ever read once, at process start. Saving a change now closes and
  reopens this app's own HTTP listeners in place, in process, within a few seconds -- no manual
  restart needed any more.
- The ADB "open access" (port-knock) panel's source-IP field used to silently pre-fill from the
  backend's own view of the connecting address (`req.ip`) -- behind this app's own Caddy route,
  that is always the proxy's own address, not the browsing device's, so the suggestion was
  actively wrong there. Dropped that pre-fill; the row now labels the server's own fixed listening
  address and the editable source-IP field separately and explicitly, and offers a collapsed,
  per-OS terminal command (with a copy button) to find the browsing device's own address instead,
  hinted to the right address family (Tailscale vs. private LAN) for that particular server
  address. (A WebRTC-based in-page detection was tried first; confirmed live that no major browser
  -- Firefox, Chrome, Edge, Brave, Safari -- exposes this to a page any more, so there was nothing
  reliable left to read in-page.)

## [0.6.2] - 2026-11-07

### Added

- A new H.264 encode path for `hwenc` (hardware video encode), built on FFmpeg's `h264_vaapi`
  encoder instead of this project's own hand-rolled bitstream writer. The original path could not
  do P-frames on Intel (iHD) GPUs without corrupting the image, so every frame had to be a full
  keyframe there -- fine at a high bitrate, visibly worse at the low bitrates this project's
  typical use (scrcpy over a slow link) needs. The new path encodes P-frames correctly on Intel,
  and is also validated on AMD Cezanne-family APUs (e.g. Ryzen 5700G). Not yet enabled on AMD
  Polaris (RX 400/500): it causes real GPU hangs there, still under investigation -- Polaris keeps
  using the original path, which is solid on that hardware. NVIDIA is unaffected (it uses the
  separate `nvenc` module).
- A **Settings** control to choose the `hwenc` encode backend (`legacy`/`ffmpeg`) for the whole
  host, plus a matching warning -- shown in Settings, the instance creation dialog, and the
  Doctor tab -- whenever the active backend is a known-risky choice for the host's own GPU (today:
  `ffmpeg` on Polaris, `legacy` on Intel). Never blocks the choice, same "warn, don't gate"
  approach as `docs/KNOWN-COMBINATIONS.md`. Changing it relaunches the shared VA-API daemon with
  the new backend -- hardware encode/decode is briefly unavailable for every instance on that host
  while it restarts.

## [0.6.1] - 2026-11-07

### Fixed

- Running a second checkout of this app on a host that already has one (e.g. a disposable/dev
  deployment alongside a stable one) hit three separate walls, found by deliberately installing
  this project from scratch, README-only, as if it were a brand new user:
  - `git clone ... && cd redroid-forge` collided if a checkout already existed at that default
    path -- README now shows cloning into a differently-named directory instead.
  - `container_name` was hardcoded to `redroid-forge` with no override, so even a second checkout
    in its own directory still collided on the container name. Now reads `${CONTAINER_NAME:-redroid-forge}`
    -- same default as before, so a single-instance host sees no change.
  - A failed `app.listen()` (e.g. the default `PORT=8080` already taken by something else on the
    host) was silently swallowed by the generic `uncaughtException` handler meant to survive a bug
    in a single request, not a startup failure -- the container stayed "Up" (`fwknopd` alive) with
    the Express server never actually listening, no real signal anything was wrong. A failed bind
    is now fatal (`process.exit(1)`), so `restart: unless-stopped` shows it honestly as a
    crash-looping container instead.

### Added

- `.env.example` -- no such file existed; every env var was only discoverable by reading
  `docker-compose.yml`'s own comments. Documents `PORT`/`CONTAINER_NAME` up front (the two that
  matter on a host already running another instance) plus the rest.

## [0.6.0] - 2026-11-07

### Fixed

- Doctor's loop-device check reported "ok" from a stale/static `/dev/loop-control` node alone,
  without the `loop` kernel module actually loaded behind it -- found live on n02, 02/11/2026: an
  instance (and even a plain `docker run` of the official redroid image, redroid-forge not
  involved) booted and died within seconds every time, apexd-bootstrap unable to create loop
  devices. Now also requires `/sys/module/loop` or a real `/dev/loop0` before reporting ok. Fixed
  on n02 with `modprobe loop`.

- `binder.js`'s legacy (non-binderfs) checks read this container's OWN auto-populated
  `/dev/binder*` copy (always `0600`, independent of the host's real node) instead of the host's
  -- found live on a fresh n02 install (Debian trixie, legacy `binder_linux` mode): `chmod 0666` on
  the host's node had zero visible effect, and a correctly-configured host could have been
  refused an instance as "broken". Now reads these specific checks through `/proc/1/root` (this
  container runs `pid: host`) instead of the bare path.

- Doctor's binderfs fix text led with the mount command (guaranteed to fail on a kernel without
  `CONFIG_ANDROID_BINDERFS`, e.g. Debian trixie) before ever explaining why, and the legacy
  fallback's two files were only distinguished by an easily-misread bare comment. Reordered to
  explain first, and both files are now labeled explicitly.

### Added

- The header now shows the installed version (`GET /api/version`, no network call, safe on every
  page load) plus a manual "Check for updates" button (`GET /api/version/check`) -- the only thing
  that ever calls GitHub, only on that exact press, never on a timer or on startup. Added because
  the fleet had drifted to different versions across hosts with no way to tell from the UI.

## [0.5.0] - 2026-11-01

### Fixed

- A watchdog module (e.g. `cifi`) now starts PAUSED by default the first time an instance gets
  it -- at creation, or whenever it's added later through `/display`'s `modules` param
  (`moduleScheduler.defaultPauseForNewModules`). A module an instance already had keeps whatever
  pause state it already had; this only seeds the default for one it never had before. Found for
  real, 01/11/2026 (jgustavo47): a fresh `cifi` install hit a one-time first-run "Privacy Policy"
  gate the watchdog's tap sequence (calibrated for "reopen after crash", not "never seen this
  screen") has no way to recognize -- had the process also died and restarted during that window,
  the watchdog would have reopened it and tapped blindly into a screen it does not understand. The
  human now has to get a freshly-added watchdog module's app through its own first run once, then
  explicitly resume it (`POST /api/instances/:id/watchdogs/:moduleId/resume`, already existed).

- Intermittent "fetch failed" installing `aurora-store` on a host that had never cached its APK
  before (`backend/src/server.js`). Root cause: every host in the fleet has a global-scope IPv6
  address from Tailscale, which makes Node's `fetch()` race real public IPv6 candidates too
  (Happy Eyeballs) whenever it resolves a dual-stack external host -- even though that IPv6 is
  Tailscale-only, not internet-routable. Node's default per-attempt timeout (250ms) is shorter
  than the real RTT to many external hosts from here, so the real, working IPv4 address got
  abandoned as "timed out" before it could answer. Fixed by raising
  `net.setDefaultAutoSelectFamilyAttemptTimeout` to 1500ms at startup -- confirmed with a live
  repro (`node -e` against f-droid.org) failing intermittently at the default and succeeding 5/5
  at the new one. Not specific to `aurora-store` -- it is the only module today that fetches
  anything live over the network at module-apply time, but the fix is global (any future outbound
  fetch benefits).

### Changed

- `venus3d`'s checkbox moved from the encode/decode section to right under the `gpuMode` select,
  in both the new-instance dialog and the Configure panel -- it is the 3D acceleration that
  `gpuMode=host` means on an NVIDIA host, not an independent capability alongside encode/decode.
  Still opt-in (never auto-checked, same as `hwdec`): picking `host` without it is not blocked,
  since deliberately reproducing/diagnosing the known-broken path is a legitimate reason to do it
  on purpose. Left unticked while `gpuMode=host` on an NVIDIA host, it now shows a loud red "!
  not recommended" warning instead of staying silent -- plain host mode never boots at all on
  this GPU without it (stock GBM/Mesa gralloc crash-loops SurfaceFlinger). Found for real,
  01/11/2026 (jgustavo47): an instance was switched to host without it and hit exactly that
  crash loop.

- `cifi`'s manifest (`queToca`, both languages) now discloses that its watchdog can't tell a real
  crash apart from the instance simply running a different app in the foreground -- it only
  checks `pidof` for CIFI's own process, so on any tick where something else is running instead,
  it force-relaunches CIFI over it and taps through its own launch screens regardless. Only
  recommended on an instance dedicated to CIFI alone. Version bumped 1 -> 2 so anyone who already
  accepted it is re-prompted with the new disclosure before their instance's next
  start/restart. Prompted by testing another app (Loop Sort) on a `cifi`-enabled instance,
  01/11/2026 (jgustavo47) -- not confirmed as the actual cause of anything there, the module's own
  logic alone is enough to document the risk regardless.

- A light, non-alarming `muted` note added right under the `gpuMode` select, both dialogs: guest
  always boots fine and is the safe default, but some apps genuinely need host's real GPU to work
  correctly -- never previously stated as the actual tradeoff in one place, only implied
  separately by each option's own label.

- ⚠ **`nvenc` + `venus3d` together, on the same instance: documented as NOT YET RELIABLE**, not
  removed or blocked. Testing Loop Sort against a real instance running both (01/11/2026,
  jgustavo47) reproduced the Android guest's own `system_server` going unresponsive and
  restarting under load (`ActivityManager: Low on memory`, `lmkd` re-running its own
  boot-completed handling, `DeadSystemException` on every input event meanwhile) -- NVIDIA DRM
  fence-import errors (`nv_drm_prime_fence_context_create_ioctl ... Failed to import fence
  semaphore surface`) appear in the same window, suspected (not confirmed) to trace back to
  `nvenc`'s own per-frame Vulkan dma-buf import/export cycle with `venus3d` active. The dma-buf
  import itself is NOT the problem -- a temporary diagnostic log in
  `backend/native/nvenc-daemon/vtest_gpu_encode.c` confirms every frame is correctly identified
  and imported as a real dma-buf, never falling back to the memfd path. Both manifests'
  `queToca` (EN+ES) now disclose this plainly, and both versions bumped 1 -> 2 so anyone who
  already accepted either is re-prompted. The frontend also shows a loud red warning (both
  dialogs) whenever `nvenc` + `venus3d` are selected together. Investigation paused here, not
  closed -- resume from the diagnostic log and the fence-import correlation before trying
  anything else.

### Added

- New module, `venus3d`: real GPU-accelerated 3D rendering on NVIDIA hosts
  (`gpuMode=host`), ported from
  [`redroid-nvidia`](https://github.com/fogelmanjg/redroid-nvidia)'s Tier 4/5. Plain
  `gpuMode=host` never boots at all on NVIDIA (Mesa's GBM has no driver-table entry for NVIDIA's
  proprietary stack, confirmed via a reproducible `SurfaceFlinger` crash loop) -- this module
  routes the guest's Vulkan (Mesa Venus) over a unix socket to a host-side
  `virgl_test_server`/`virglrenderer` process that speaks to the real NVIDIA driver instead of
  any direct GPU passthrough. Confirmed clean end to end on a GTX 1050 Ti (real, GPU-accelerated
  `SurfaceFlinger` RenderEngine, `Vulkan device initialized: 1`); the RTX 4060 has a known,
  currently-open NVIDIA driver bug outside this module's own code (VA-space mapping assertion,
  NVIDIA's own `open-gpu-kernel-modules` issues #1364/#1165/#1140/#1396), not fixed here. See
  `backend/src/modules/venus3d/README.md` for the eight real gaps found getting a clean boot
  (gralloc replacement, EGL/Vulkan `ro.hardware.*` property ordering, a missing
  `libdmabufheap.so`, and more).

- New module, `nvenc`: hardware H.264 encode on NVIDIA hosts, ported from
  [`redroid-nvidia`](https://github.com/fogelmanjg/redroid-nvidia)'s Tier 7 (confirmed clean on a
  GTX 1050 Ti). Unlike `hwenc` (VA-API, AMD/Intel, needs `gpuMode=host`), this one works on top of
  plain `gpuMode=guest` -- the Codec2 component's Venus-resource path always fails cleanly in this
  container architecture (no virtio-gpu device) and falls through by design to a plain SCM_RIGHTS
  dma-buf transport, which is all a real `scrcpy`/screen-recording capture buffer ever needs. See
  `backend/src/modules/nvenc/README.md` and `backend/native/nvenc-daemon/README.md` for the full
  design (including why, unlike `hwenc`'s own VA-API daemon, this backend never spawns the NVENC
  daemon itself -- it's a systemd unit on the host, not a child process of this Alpine/musl image).
  Validated end to end on a GTX 1050 Ti (jgustavo47): `scrcpy --list-encoders` reports the hardware
  encoder, and a real recording produces a correct, `ffprobe`-valid, visually undistorted clip. The
  stock image's capture buffer turned out to be a plain `memfd` (not a dma-buf as on
  `redroid-nvidia`'s own patched image) -- the daemon's GPU upload path was rewritten to `mmap()` +
  stage through a host-visible buffer instead of a Vulkan external-memory import; see
  `backend/src/modules/nvenc/README.md`'s "Three real gaps" section for this and two smaller fixes
  (the render node's real group GID, the SCM socket's exact filename) found getting there.

## [0.4.1] - 2026-10-31

### Fixed

- The `/proc/meminfo` fix (an instance's reported RAM matching its real Docker cap, see
  `backend/src/lib/meminfoFix.js`) could silently never apply on a heavier-boot instance.
  The final bind-mount ran via `docker exec` right after start, retried for ~20s on the theory
  that Android's shell just was not reachable yet -- found for real against a real instance
  with a lot to install/start on first boot (gapps+aurora+arm-translation+wifi-interno) that
  20s was not always enough, and nothing ever retried again: Android was stuck reporting the
  host's full RAM (not its 3072MB cap) until the next full recreate, with no error surfaced
  anywhere. Confirmed no actual OOM kill had happened yet (`memory.events`' `oom_kill: 0`) before
  fixing it, but the mechanism was silently broken regardless.
- Replaced with a cleaner mechanism instead of just a bigger retry budget: a `.rc` file dropped
  into `/vendor/etc/init/` at stage 4 (same mechanism `redroid-gralloc-fix` already uses), which
  Android's own init runs natively on `post-fs-data` -- after Android's own procfs remount, with
  init's own ordering guarantee, no host-side polling race at all. Live-verified end to end on
  two hosts (server01, jgustavo46) through the real creation route, and against the actual
  previously-broken instance (`cifi-nuevo-nuevo`) after a recreate.

## [0.4.0] - 2026-10-30

A second real install (jgustavo46, AMD Polaris) brought up from scratch and exercised end to end
against this release line -- not just server01 any more. Every bug below was found live on that
second machine, several only because it exists: a hardcoded personal path, a missing per-host env
var, a rename-then-restart sequence nobody had tried yet.

### Added

- Instance rename (pencil icon next to the name, `PUT /api/instances/:id/name`): renames the
  instance and, cosmetically, the underlying Docker container's own `--name` too (nothing in this
  codebase looks a container up by name). Validates and uniqueness-checks the new name; id, data
  volume and running state are untouched either way. Names are normalized automatically instead of
  being rejected outright (lowercased, spaces/underscores to hyphens, disallowed characters
  stripped) -- applies at creation too, not just rename.
- RAM can now actually be lowered on a running instance: stops it, applies the lower cap, restarts
  it, with a confirmation prompt first. Previously this was simply blocked ("does not reliably take
  effect"). Raising RAM live is unchanged.
- Doctor warns when hwenc is encoding all-intra (`REDROID_FORGE_ENCODE_IDR_PERIOD` unset, AMD only
  for now) instead of using P-frames -- see the colour-matrix misdiagnosis below, this is the real
  fix for it, and the next install should not have to rediscover it live.

### Fixed

- Renaming an instance could permanently break its ability to ever restart. `meminfoFix`'s
  bind-mounted file was keyed by the renamable `name`, but a container's `HostConfig.Binds` is a
  path string frozen at creation time -- the next (re)start after a rename re-resolved that
  now-missing old path, and Docker silently created a *directory* there instead of finding the
  expected file, which then fails to bind-mount at all. Keyed everything off `volumeName` instead,
  which a rename never touches, so there is nothing left to keep in sync.
- An instance that gained the `gapps` module after creation (via the Configure panel) never had
  `hasGapps` recomputed on recreate -- hid the Android-ID registration UI and never scheduled the
  Android ID fetch. The `/display` recreate route now recomputes it the same way it already did
  `needsHwsimWifi`, and schedules the fetch when it newly becomes true.
- The auto-refresh poll (every few seconds) closed the inline rename editor mid-type.
- A washed-out/low-quality picture over scrcpy, reported live against the second install, was
  live-misdiagnosed first as an H.264 colour-matrix bug (missing VUI signalling in the SPS) --
  two different VUI/matrix attempts changed nothing, which was the tell. The real cause: hwenc
  defaults to all-intra (every frame a full IDR) until `REDROID_FORGE_ENCODE_IDR_PERIOD` is set
  per host, and the second install never had it -- fine at a high bitrate, visibly degraded at the
  low ones this project's typical use (scrcpy over a slow link) actually needs. Confirmed live at
  both 8Mbps and 1Mbps once set. See the new Doctor warning above.
- `REDROID_HWENC_ARTIFACTS_DIR` silently defaulted to this project's own author's personal AOSP
  build path when unset -- worked by accident only on a machine with that exact username and
  folder layout, and gave a confusing "artifact is missing" error pointing at a path that was
  never meant to exist on every other host. Now required explicitly, with a clear error naming
  what is actually missing.
- VA-API daemon's native build (`Makefile`) was missing `-lm`, a link failure on at least one
  host's toolchain (unresolved `exp` symbol from the H.264 decoder).
- Doctor's fix message for a missing catalog image, and the README's "Bringing the redroid image
  to this PC" section, both assumed the image had to be custom-built elsewhere or pushed to your
  own registry -- neither ever mentioned that the catalog's default image
  (`redroid/redroid:15.0.0-latest`) is public on Docker Hub, so a plain `docker pull` is all almost
  anyone needs. Found doing a from-scratch install on a machine with nothing pre-configured,
  following only the public README (no fleet-specific shortcuts) -- the README was also missing
  the `git clone` step entirely, jumping straight to `docker compose up -d --build`.
- README's feature table now flags AMD Polaris as not recommended for hardware decode at the same
  time as hwenc -- known driver instability (GPU reset, `VRAM is lost`) already documented in
  `docs/ROADMAP.md` Phase 2, repeated enough times in real use to move from "investigate root
  cause" to an operational recommendation. Encode alone is unaffected; this does not change any
  code (`HWDEC` stays a build-time choice either way).

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

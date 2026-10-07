# redroid-forge — Requirements and project policy

**Languages:** English | [Español](REQUIREMENTS.es.md)

> This project's official language is **English**. The Spanish file is provided for convenience and
> may not be perfectly accurate or up to date — if in doubt, this file is the source of truth.

> Living draft. It is adjusted as more decisions come up. Everything marked **[PENDING]** is an open
> decision, not an assumption.

## 1. Goal

To give end-to-end closure to the redroid projects that currently work separately, consolidating them
into a single independent application (`redroid-forge`), with its own backend and frontend, that:

- Replaces the need to touch each project separately to manage redroid instances.
- Can be embedded or shown inside `jg-dashboard` and Plenum, but does not depend on either of them to
  work standalone.
- Aims to be a public and popular project, not an internal tool.

**Why "forge" and not just "manager" or "hub":** the project is more than a central management point —
deep per-instance customization (modules, device profiles, hardware acceleration) and export/import of
instances between different PCs. It is an instance forge, not just a control panel.

## 2. v1 scope

- **Redroid 15 is the only version with official support** (all modules validated: hwenc, nvidia, fake
  WiFi, device profile). It is not a hard restriction in code — other versions are not blocked, they are
  marked as **community** (see "Support tiers per image" below).
- **Everything already tested and working is ported**, it is not redone from scratch:
  - VA-API hardware encode (AMD/Intel) + NVDEC decode — from `redroid-hwenc`.
  - 3D acceleration (Venus-proxy) + NVENC encode for NVIDIA — from `redroid-nvidia`.
  - Instance lifecycle (create/start/stop/restart/delete), read-only host Doctor, Android ID/GApps
    registration — from `redroid-manager`.
  - Fake WiFi (hwsim) and device profile spoofing — currently spread between `redroid-manager` and
    `jg-dashboard`.
  - A host prerequisites checklist (legacy binder/binderfs, `loop`, `ext4`) documented for
    Debian/btrfs.
  - Everything reusable from the redroid module of `plenum-redroid` (the same reuse logic as with
    `jg-dashboard`, see section 4).

- **Additional goal (not a port): hardware decoding on AMD and Intel** (added 05/10/2026; scope
  extended 06/10/2026). Every instance uses in hardware **everything the host's hardware offers**
  (H.264, HEVC, VP9... depending on the GPU): there is no single capability package, and newer
  hardware will keep adding. Today hardware decode only exists on NVIDIA, and limited to a single loose
  intra frame. Encode is revisited after the first version. Detail, measurements and approach (libavcodec
  built as LGPL) in Phase 2 of `ROADMAP.md` (step 5).

### Support tiers per image (not a hard restriction)

**Maintained versions (decided 05/10/2026):** the catalog keeps the **official Redroid 11, 13 and 15
images, and probably also 12 and 14** — always the unmodified official image (see "Known-combinations
database" below), never hand-built images. **Only Redroid 15 has full support** ("official" tier); the
rest is "community" tier: they are offered and they run, but with no guarantee that the modules work. A
version moves up a tier only when a validated combination enters the database.

Redroid 11 and 13 work for some things (11 boots and runs basic instances; 13 was tested and works with
`gpuMode: guest`), but without the rest of the modules (hwenc, nvidia, fake WiFi) validated on those
versions — they were never tested there. Instead of blocking their use, the catalog and the modules
declare this as metadata, not as special per-version code:

- Every image in the catalog (`backend/images.json`, which already has `androidVersion`/`gpuMode` per
  entry) adds a **`soporte`** field: `"oficial"` (Redroid 15 only) or `"comunidad"` (11, 13, any other
  that gets added), with a short note of what is known to work (e.g. "13: only `gpuMode: guest`, hwenc
  and fake WiFi not tested").
- Every module (the manifest of section 5) declares **what it is compatible with** (Android version, GPU
  mode). If the chosen image does not meet it, the module is simply not offered for that instance —
  it never breaks silently, it explains why it is not available.
- The UI/Doctor shows the tier of the chosen image prominently (e.g. "✅ Official" vs "⚠️ Community, no
  full support") — the same transparency criterion that governs the rest of the project: never hide
  limitations.

### Known-combinations database (decided 05/10/2026)

**Base rule:** redroid-forge **always starts from the official Redroid 15 image, unmodified**. GApps,
Magisk, hwenc, fake WiFi and the rest are integrated **per instance, when creating it, only if
needed**, as modules. Pre-built/customized images are not used: they tie the project to a build host,
mix non-free content (GApps) inside a redistributable image, and make it impossible to reason about
what is actually running.

**Support = known combination, not "image".** The project maintains a database of **validated**
combinations. Every entry fixes:

- **Base:** an official image identified by its **`sha256` digest**, not by tag (`15.0.0-latest` is a
  moving tag: two hosts may pull different things).
- **GApps package:** known version, source and `sha256`.
- **Magisk version** (if applicable): version and `sha256`.
- **Modules** and their manifest versions validated on that base.
- **Hardware** it was validated on (an `redroid-hwenc`-style table: AMD Polaris/Vega, Intel Iris Xe,
  NVIDIA...) and the validation date.

Consequences:

- A combination present in the database is **"official" tier**: it is what the project validated and
  what it answers to on a bug report. **It is not a guarantee** (free software, no warranty): it means
  "validated with verifiable evidence" — the user can repeat the checks on their host (see
  [`docs/KNOWN-COMBINATIONS.md`](KNOWN-COMBINATIONS.md) §1.1). The first filter of any report is "is it
  a known combination?".
- A base image, GApps package or Magisk version **outside the database** is not blocked (consistent with
  the tiers above), but it is left **unsupported** with a visible warning in the UI/Doctor, and only the
  modules that can be guaranteed on it are offered.
- Third-party binaries (GApps, Magisk) are **verified against the database's `sha256` before being
  used**; if it does not match, they are not injected. "The latest version" is never downloaded without
  pinning it.
- The GApps/Magisk module receives its source and checksum **from the database**, it does not carry them
  hardcoded in its manifest.

**The database lives in an external repository**, separate from the redroid-forge code, and is
**updatable** by the user:

- Every redroid-forge release **includes a snapshot** of the database with the latest known at release
  time (so it works offline and is reproducible per version).
- Optionally (an explicit user action, never silent) the **database can be updated** from the external
  repository to see combinations validated after that release, without waiting for a new version.
- The updated database is **verified** (a signature or published hash) before replacing the snapshot;
  if that fails, the previous one is kept.
- **[PENDING]** exact format (JSON/YAML), name and location of the repository, verification mechanism
  (signature vs. hash), and how new combinations are contributed (a PR with validation evidence).

- **CIFI (the auto-reopen watchdog) migrates from Redroid 11 to Redroid 15.** It had been left on 11
  because of lower resource consumption compared with the software encoder that 15 required at that
  time — but with 3D acceleration + hardware decode + hardware encode already solved in 15
  (`redroid-hwenc` + `redroid-nvidia`), the expectation is that 15 consumes less than 11 with software
  encoding. It is already confirmed to run well on 15. It also serves as a real pilot case for the
  user-extensibility module (section 5).

## 3. Architecture

- **Monorepo.** All the code of the consolidated projects lives together in `redroid-forge`, not as
  submodules or separate external dependencies.
- **Independent application** with its own backend and frontend — it does not require Plenum or
  `jg-dashboard` to operate (the same principle that already governed `redroid-manager`: "one `docker
  compose up` and you're running"). This separation from Plenum was never to avoid complexity — it is
  so that it is useful to anyone, not just to our own installations. Consistent with the goal that the
  project can interest more people, not just personal use.
- **Integrable, not dependent:** it exposes what is needed (API, embed, SSO) so that Plenum or
  `jg-dashboard` can show/orchestrate it if the user wants, without that integration being mandatory.
- **Technical stack: Node.js + Express**, with no heavy framework or mandatory build step, `dockerode`
  for container management. Direct continuity with `redroid-manager` (already tested end to end) — the
  existing code (`binder.js`, `hwsimWifi.js`, `androidIdentity.js`) is ported instead of rewritten.
  Vanilla HTML/CSS/JS frontend; if the module contract modal (section 5) needs more interactivity, a
  light step up (e.g. Alpine.js/htmx) is taken before jumping to a full SPA framework.

## 4. Relationship with jg-dashboard and plenum-redroid (migration and coexistence)

- **`jg-dashboard` stops having redroid integrated and becomes a consumer** of `redroid-forge` (through
  its API/embed), instead of having its own redroid instance-management code.
- When porting, **as much as possible is reused** of the real code `jg-dashboard` already has (e.g.
  device profile spoofing —`DEVICE_PROFILES`, `buildDeviceProfileScript`, etc. in
  `redroid.service.ts`) instead of rewriting it.
- **`plenum-redroid` follows the same policy as `jg-dashboard`**: it stops having the integrated module,
  becomes a consumer of `redroid-forge`, and what is possible of its logic is reused when porting.
- **Explicit coexistence during the transition:** the current redroid code and windows in
  `jg-dashboard` and in `plenum-redroid` **are neither touched nor removed** until `redroid-forge` is
  fully functional. Both paths coexist in parallel for the duration of the migration — only when the
  replacement works end to end is the old code retired.
- **Fate of the old code (decided 05/10/2026):** when `redroid-forge` replaces it, **all the redroid
  code of `jg-dashboard` and `plenum-redroid` is removed** from those projects. It is not maintained or
  kept as a compatibility path. The previous code stays **on GitHub as an old project, dead and
  replaced by `redroid-forge`** (as history only). Before removing it, it must be **made sure that code
  is really on GitHub** (see Phase 8 of `ROADMAP.md`; `plenum-redroid` was already archived at
  `fogelmanjg-plenum/plenum-redroid`, private, as a project that did not achieve its goals).
- **The `ws-scrcpy` web viewer is not ported.** It has been deprecated since 2026-07-02 (it was created
  when scrcpy could not be accessed from Android; today scrcpy is used directly and the viewer no longer
  makes sense). No dashboard instance uses it and its infrastructure (redis, OAuth secrets) no longer
  exists.
- `jg-escritorio` (xpra + Docker) **is not relevant to this project for now** — it is out of scope.

## 5. Modularity and explicit consent

Every component that is not 100% free software, or that depends on a choice of the host, is treated as
an **external module**, never as a fixed part of the core:

- CPU/RAM assigned to the instance.
- GPU mode: host vs soft (guest).
- Fake WiFi (hwsim) yes/no.
- GApps yes/no.
- Magisk yes/no.

**Mandatory flow for any non-free or third-party module:**

1. The frontend shows the module's **contract** before enabling it: what it is, what it does, which
   permissions/resources it touches, and that it **is not part of the project** (an explicit notice).
2. The user accepts explicitly.
3. Only then does the backend run the script or download/integrate the component.

None of this is skipped for usability — usability is solved by making the flow easy to accept, not by
making it invisible.

### Two module levels

- **Own modules** (fake WiFi, device profile spoofing, CPU/RAM choice, host/soft GPU mode) — project
  code, not third-party. The contract is purely informative: what it implies technically and what risks
  it has, without the "it is not part of the project" disclaimer.
- **Non-free third-party modules** (GApps, Magisk) — the same informative content, plus the mandatory
  disclaimer of section 6: the real license, the source, and that it is not part of `redroid-forge`.

### Contract format: a manifest per module

Every module is described with a structured (JSON/YAML), versioned manifest, read generically by the
frontend to render the same contract modal without programming a special screen per module. (The field
names are the real format, which is why they stay in the project's original Spanish: `nombre` = name,
`esTerceroNoLibre` = is a non-free third party, `licencia` = license, `origen` = source,
`descripcion` = description, `queToca` = what it touches, `compatibleCon` = compatible with.)

```yaml
id: gapps
nombre: "Google Apps (GApps)"
esTerceroNoLibre: true
licencia: "Proprietary (Google)"
origen: "https://opengapps.org"
descripcion: "Installs Google Play services on the instance."
queToca:
  - "modifies /system inside the container"
  - "downloads a package from an external server (not controlled by this project)"
compatibleCon:
  androidVersion: [15]
  gpuMode: ["host", "guest"]
version: 1
```

The backend only runs the module's integration if there is a record of "user accepted manifest version
N"; if the manifest goes up a version (the disclaimer or what it touches changes), acceptance is asked
for again. `compatibleCon` is what decides whether or not the module is offered for the chosen image
(see "Support tiers per image" in section 2) — if the image does not meet it, the module does not
appear as an option, with an explanation of why.

### Extensibility: user-defined modules

The module catalog **is not a closed list** (GApps/Magisk/wifi/GPU/CPU-RAM) — there has to be a generic
convention so that anyone can add their own module without touching the core, of the same kind as a
watchdog or any per-instance automation script.

**Real reference case:** the CIFI watchdog (it reopens a game that crashes, ADB taps, runs every 15 min)
currently lives as a loose cron script + `flock` on the host, completely outside any app — exactly the
kind of thing that should be declared as a module instead of living as ad hoc infrastructure:

- The same manifest as the previous section (name, description, what it touches) plus an **entry
  script/binary** that the backend invokes with the instance's context (ADB port, serial, etc.).
- Expected lifecycle: schedulable (periodic, like the current cron) and it exposes at least
  pause/resume/status — just like `cifi-watchdogctl.sh` already has by hand today.
- Being the user's own code (not the project's), it still goes through the consent contract — it runs
  under their responsibility.

**[PENDING]** exact convention: which environment variables/arguments the script receives, how the
scheduling is registered, whether it runs inside the instance's container or outside, in the backend
process. The CIFI watchdog is the pilot case to validate this in practice when porting it.

**References from other projects, for when this is picked up again (no decision taken yet):** Home
Assistant Add-ons (manifest + typed options schema + explicit declaration of capabilities/permissions,
auto-generated config UI); the drop-in convention of the `cron.d`/`sites-enabled` kind (a self-contained
folder per module, no installation); Docker CLI plugins (a binary discovered by naming convention,
context via flags/env); Docker labels in the Traefik/Watchtower style (a module hooks in by reading the
labels of the container itself). A community "app store" in the HACS style is left for when there is a
community, not for v1.

## 6. License policy and third-party content

- **No third-party software inside the code or the images**, unless it is 100% free (a real FOSS
  license, not "gratis" or "freeware").
- GApps, Magisk, and any other non-free component are **never packaged** — they are integrated at
  runtime as an external module (see section 5), under the user's explicit consent, running on their own
  infrastructure.
- No legal shortcut for convenience: if a module is not free, it goes through the contract + consent flow
  without exception, no matter how much it complicates the UX.
- **The rule is about the origin of the binary, not about the packaging.** "We don't put it in a Docker
  image" is not enough if the binary still comes from something `redroid-forge` hosts (our own tarball,
  a derived image, or — the real case found on 28/09 — the very AOSP source tree we compile). The
  non-free component always has to be downloaded from its real official source, at the moment the user
  asks for it. See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the complete model (the 6 stages of an
  instance's lifecycle) and the concrete case of `vendor/gapps` mixed into the AOSP source that
  motivated this clarification.

## 7. Authentication and integration with Plenum / jg-dashboard

- **Optional security** — the core works without auth (for simple standalone use), just like
  `redroid-manager` today.
- When activated, it can consume:
  - Keycloak directly.
  - Keycloak through Plenum or `jg-dashboard` (delegated SSO).
  - Or whatever replacement is chosen in the future (not tied to Keycloak by design).
- It is a *bolt-on* enabled by configuration, not a hidden dependency of the core (the same principle
  already agreed for `redroid-manager` with Plenum).

## 8. Monetization

- **100% open source, Apache License 2.0** — the goal is adoption/popularity, not protecting the code.
  The same family redroid uses for its main project (consistency with upstream) and with an explicit
  patent grant, relevant for the hardware video encode/decode (VA-API, NVENC) the project touches.
- **Nothing hidden or necessary-but-unavailable**: everything needed for the project to work completely
  is in the public repo.
- Monetization through **donations** and **selling support** (for the hard stuff or what someone does not
  want to do on their own) — never paid features, never separate premium code.
  - **No progress on this yet.** It is picked up only in a 0.9 beta, when the project is at a point where
    it can be said that it is "reasonably safe" to download and install.
- No flow makes the user feel "used" — no hidden telemetry, no artificial friction to push toward paying.
- **No upstream project can feel used/attacked either** (redroid and any other project whose code or
  functionality is used):
  - `redroid-forge` is explicitly positioned as a **convenient frontend/manager on top of what those
    projects already built**, not as a replacement or a competitor.
  - Clear and visible recognition and attribution (README, credits in the app, original licenses
    preserved) to every project of origin.
  - Collaborating with those projects when it makes sense (reporting bugs, sending PRs, letting them know
    about the project) instead of only consuming in silence.

## 9. Decisions already taken

| Topic | Decision |
|---|---|
| Code structure | Monorepo |
| Name | `redroid-forge` (verified free on GitHub, npm and Docker Hub — `jg-redroid-manager` was discarded as too personal, and plain `redroid-manager` for being taken and an already-populated space) |
| Location | A new standalone repo on GitHub (not inside Plenum) |
| Visibility | **Public** (implied by the popularity goal — see section 8) |
| Target Android version | Official images 11, 13 and 15 (probably 12 and 14); full support only on 15 = "official" tier; the rest "community", not blocked (section 2) |
| `jg-dashboard` | Stops having redroid integrated, becomes a consumer of `redroid-forge`; the old code coexists until the new one is complete |
| `plenum-redroid` | The same policy as `jg-dashboard` |
| `jg-escritorio` | Out of scope, not relevant to this project |
| Donations/support | Picked up in the 0.9 beta, not now |
| License | Apache License 2.0 |
| Module contract | A structured (JSON/YAML) manifest versioned per module, see section 5 |
| Technical stack | Node.js + Express + `dockerode`, no build step; vanilla HTML/CSS/JS frontend |
| CIFI | Migrates from Redroid 11 to 15; enters as the pilot case for the user-extensibility module |
| Base images | Only the official Redroid 15 image, unmodified; GApps/Magisk/etc. are integrated per instance. Support = known combination (base by digest + GApps + Magisk + modules) in a database in an external repo, updatable, with a snapshot per release (section 2) |
| Module catalog | Not closed — there is a convention for user-defined modules, see section 5 |

## 10. Pending / open

- **[PENDING] Known-combinations database** (section 2, design in
  [`docs/KNOWN-COMBINATIONS.md`](KNOWN-COMBINATIONS.md)). Decided: external repo `redroid-forge-db`,
  ed25519 signature (first signing when releasing the first complete usable version), a daily check and
  on opening the app (applying is explicit). Missing: the final file format and the model of maintenance
  at scale (§6.1 of the doc) when there are more collaborators.
- **[PENDING] Donations/support mechanism** — decided only in the 0.9 beta (GitHub Sponsors, Open
  Collective, a direct support contract, etc.).
- **[PENDING] Exact convention of user-defined modules** (section 5) — script contract, scheduling,
  instance context.
- **[PENDING] Other "large" projects to read beyond those already confirmed** (fake-wifi/android-identity,
  host prerequisites/doctor, `jg-dashboard`, `plenum-redroid`, the CIFI watchdog).

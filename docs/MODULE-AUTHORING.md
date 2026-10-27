# Writing a module

This is the single reference for "I want to add a module" — native vs. module vs.
user module, the manifest schema, and the full stage-by-stage hook contract. The
policy behind all of this lives in `REQUIREMENTS.md` §5 and §6; the design
narrative (why each decision was taken, in chronological order) lives in
`ARCHITECTURE.md`. This document only restates what is needed to **build**
something, pulled from the real schema validator (`moduleManifests.js`) and
runner (`moduleRunner.js`), not from prose.

## 1. Native, own module, or user module?

Three different things get called "a module" loosely in conversation. They are
not the same decision, and conflating them is how you end up either bloating the
core or over-engineering a toggle.

| | **Native (core)** | **Own module** | **User module** |
|---|---|---|---|
| Who writes it | The project | The project | Anyone, outside the repo |
| Optional? | No — exists for every deployment, policy can still turn its *behavior* off (e.g. single-user/no-login mode) | Yes — an instance can be created without it | Yes, by construction |
| Example | auth/users/OIDC, the capability engine, instance lifecycle itself | fake WiFi, device profile spoofing, CPU/RAM choice, GPU mode, hwenc/hwdec, arm-translation, redroid-gralloc-fix, GApps, Magisk | the CIFI watchdog (pilot case) |
| Goes through the consent contract? | No | Yes (§5) | Yes (§5) — explicitly "runs under their own responsibility" |
| Mechanism | plain code, no manifest | manifest + optional `etapa`/`entry` (§2 below) | the exact same manifest + `etapa`/`entry` convention as an own module |

**The test for "native vs. module" is not "is this optional in principle" — it is
"does other code need to depend on this existing, regardless of whether it is
turned on."** Auth is the canonical example (decided 27/10/2026): every route
needs *a* decision from the capability engine, even when that decision is
"allow, no login configured" — so the enforcement spine is native, and
single-user/no-login is a policy flag on top of it, not a missing module. A
module, by contrast, is something whose complete absence is a valid, common
configuration (an instance with no GPU-mode override, no GApps, no watchdog —
most instances skip most modules).

**The test for "own vs. user module" is authorship/trust, not mechanism.** A user
module uses the identical manifest/`etapa`/`entry` contract an own module does —
nothing in the runner or the gate distinguishes them. What differs is that it
was not written or reviewed by the project, so the consent screen for it carries
the same "this is not part of the project" framing non-free third-party modules
get (§5, "Two module levels"), even if the module itself is free software. If
you are writing something for the catalog, it is an own module. If you are
writing something for your own instance only, it is a user module — same
format, drop it in `backend/src/modules/<id>/` (or point `MANIFESTS_DIR`-style
loading at it, see `moduleManifests.loadAll()`) and it works the same way.

## 2. The manifest

One manifest per module, `backend/src/modules/<id>/manifest.json` if it has an
`entry`, or a flat file under `backend/src/modules/manifests/<id>.json` if it is
a "pure contract" module with no execution logic of its own (see §4). Both
locations are scanned the same way — this split exists only to avoid merge
conflicts between unrelated modules, not because the schema differs.

Field names are Spanish — this is the real, enforced format, not a translation
layer (`nombre`=name, `descripcion`=description, `queToca`=what it touches,
`licencia`=license, `origen`=source, `compatibleCon`=compatible with).

```json
{
  "id": "my-module",
  "nombre": "Human-readable name",
  "esTerceroNoLibre": false,
  "descripcion": "What this does, for the consent screen.",
  "queToca": [
    "one bullet per concrete thing it touches — files, processes, network calls"
  ],
  "compatibleCon": {
    "androidVersion": [15],
    "gpuMode": ["host", "guest"]
  },
  "version": 1,
  "etapa": [4],
  "entry": "./integrate.js",
  "i18n": { "es": { "nombre": "...", "descripcion": "...", "queToca": ["..."] } }
}
```

**Required for every manifest** (enforced by `moduleManifests.validateManifest`,
throws and refuses to load otherwise): `id`, `nombre`, `descripcion` (non-empty
strings), `esTerceroNoLibre` (boolean), `queToca` (non-empty array),
`compatibleCon.androidVersion` and `compatibleCon.gpuMode` (non-empty arrays),
`version` (integer ≥ 1). `id` must be unique across both manifest locations
combined — a duplicate throws at load time.

**Required only if `esTerceroNoLibre: true`:** `licencia`, `origen` — this is
what populates the mandatory third-party disclaimer (§6 of `REQUIREMENTS.md`).
A free own-module or user-module should leave this `false`.

**Optional:**
- `compatibleCon.hostGpuVendor` (array, e.g. `["amd", "intel"]`) — only checked
  if present; triggers a real `lspci` detection (`hwAccel.detectGpuVendor()`) the
  first time any required module of an instance declares it, cached for that
  check.
- `etapa` + `entry` — see §3/§4. A module with neither is a "pure contract"
  module: it shows the consent screen and nothing else, the runner never
  touches it.
- `i18n.es.*` — Spanish translations of `nombre`/`descripcion`/`queToca`, used
  by the frontend consent modal. Not validated as required, but every shipped
  module has it.

**Versioning:** bump `version` whenever `queToca` or the disclaimer-relevant
fields change. `moduleGate.check()` compares the manifest's current version
against the user's last recorded acceptance (`moduleAcceptance.isAccepted`) —
a version bump re-triggers consent on the next create/start, it is not only
asked once ever.

## 3. The 7 stages

Stages 1-2 are about **images** (the official redroid image, and a derived
image built once via `docker commit` to reuse across instances) — there is no
per-module hook for them, a module that wants to live there is a build step,
not a runtime hook. Stages 3-7 are what a manifest's `etapa` array can declare,
each with a fixed export name the runner looks up on `entry` by convention —
nothing is registered by name anywhere else:

| Stage | Export name | Called | Arguments | Execution |
|------:|---|---|---|---|
| 3 | `prepareCreate()` | before `docker create` | none | serial, awaited; return `{ binds?, cmd? }`, purely additive (deduped, never overrides core) |
| 4 | `integrate(containerId, ctx)` | between `docker create` and `docker start` | `containerId`, `ctx = { display: { width, height } }` | serial, awaited end-to-end — a failure here stops the whole create, nothing after it runs |
| 5 | `ensureHostInfraReady()` | before start/restart (create included) | none | serial, awaited; must be idempotent — called on every start, not just the first |
| 6 | `ensureRuntimeReady(containerId)` | after start/restart | `containerId` | fire-and-forget — does not block the HTTP response, a failure here must not fail the instance's startup |
| 7 | `runTick(instanceId, containerId)` | every `schedule.intervalMs`, for as long as the instance runs | `instanceId`, `containerId` | awaited by the scheduler (for status), but a thrown error is caught and recorded, never propagated — one bad tick cannot stop the timer |

**Why 4 vs. 6 is the distinction that matters most:** stage 4 runs once, before
first boot, and persists as part of the container's filesystem (this is the
only window `/vendor` — and likely `/system`/`/product` — is writable; it goes
read-only almost immediately after the first boot). Stage 6 runs every time
it's needed and leaves no permanent trace — if the container is recreated, it
simply runs again next boot. Pick 4 for "write files into the image," 6 for
"fix up a running instance."

**Stage 7 extra manifest field:** `"etapa": [7]` requires `"schedule": {
"intervalMs": N }` in the same manifest — the only stage with no sensible
lifecycle point to default to, so `validateManifest` makes it mandatory. The
scheduler (`moduleScheduler.js`) keeps one `setInterval` per
`(instanceId, moduleId)` pair, started right after stage 6 on create/start/
restart and cleared on stop/delete. Pause/resume is a real, persisted flag
(`GET`/`POST /api/instances/:id/watchdogs`) — survives a backend restart; a
paused tick still fires on schedule but is skipped before calling `runTick`,
so the module itself never has to know it was skipped.

**A module only exports the hooks for the stages it declares.** Nothing breaks
if a stage-4-only module has no `runTick` — the runner never looks for it.

**Talk to a running instance via `dockerRuntime.exec()` (dockerode), never a
real `adb` process spawned from your module.** This is not a style preference —
CIFI's original cron-based watchdog hit a real, documented incident where a
spawned `adb start-server` inherited a lock file descriptor and never released
it after a host reboot. Going through dockerode's exec API (what every stage
3-7 hook already uses) sidesteps that whole bug class.

## 4. Pure-contract modules (no `entry`)

If your module is just "show this consent screen, then flip a flag the core
already reads" (GApps, Magisk, the fake-WiFi toggle today) — no `etapa`, no
`entry`. `moduleGate.js` still gates it (compatibility + consent), it just never
reaches `moduleRunner.js`. Only add real execution logic (`etapa`/`entry`) once
there is an actual hook to run; do not add a no-op `entry` "for consistency."

## 5. Making it choosable per instance

Declaring a manifest is not enough to let someone request your module on
`POST /api/instances {"modules": ["my-module"]}` — it has to be added to
`OPTIONAL_PER_INSTANCE` in `moduleGate.js`. A module can instead (or also) be
**bound to specific catalog images** via `requiredModuleIdsForImage()` in the
same file, reading flags already on `backend/images.json` (the pattern
`hasGapps`/`needsHwsimWifi`/etc. follows) — that's the right place for "this
image doesn't work at all without X," as opposed to "the user may want X."

## 6. If your module depends on another module/engine

Declare it in your own manifest so it enters the same consent contract the user
already sees — never a plain `require()` that pulls something in invisibly.
(Decided 22/10/2026, not yet mechanized — no `dependeDe` field exists in the
validator yet; if you hit this, the policy is fixed, the field name is not.)

## 7. Reference implementations, read in this order

1. **`backend/src/modules/manifests/magisk.json`** — the simplest possible case:
   pure contract, non-free third party, no `entry` at all.
2. **`backend/src/modules/cifi/`** (`manifest.json` + `watchdog.js`) — the
   cleanest single-stage example: stage 7 only, real `schedule`, real
   pause/resume. Best starting point if you're writing a watchdog-shaped
   module (own or user).
3. **`backend/src/modules/hwenc/`** (`manifest.json` + `integrate.js` +
   `README.md`) — the deepest example, all four of stages 3/4/5/6 in one
   module, plus a worked explanation of why stage 5 is a thin wrapper around
   logic that actually lives elsewhere (`hwAccel.js`). Read its README after
   this document, not instead of it.

## 8. Minimal scaffold

```
backend/src/modules/my-module/
├── manifest.json      # id, nombre, descripcion, queToca, compatibleCon,
│                       # version, etapa, entry
└── integrate.js        # module.exports = { integrate(containerId, ctx) { ... } }
```

Then: add `my-module` to `OPTIONAL_PER_INSTANCE` in `moduleGate.js` (§5 above)
if it should be requestable per instance, or wire it into
`requiredModuleIdsForImage()` if a catalog image should always require it.
Nothing else needs to know your module exists — no changes to `instances.js`,
no special-casing in the runner. That genericity is the entire point of Phase 5.

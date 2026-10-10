# Known-combinations database — design

**Languages:** English | [Español](KNOWN-COMBINATIONS.es.md)

> This project's official language is **English**. The Spanish file is provided for convenience and
> may not be perfectly accurate or up to date — if in doubt, this file is the source of truth.

Status: **design draft (05/10/2026)**. Implements the decision of `REQUIREMENTS.md` section 2
("Known-combinations database") and step 0 of Phase 5 of `ROADMAP.md`. Pending decisions: see §10 of
`REQUIREMENTS.md`.

> **Note on field names.** The data format is signed and versioned, so its field names are kept in
> the project's original Spanish: `bases` (base images), `paquetes` (packages), `combinaciones`
> (combinations), `modulos` (modules), `soporte` (support level: `oficial` = official, `comunidad` =
> community), `validaciones` (validations), `chequeos` (checks), `resultado` (result), `evidencia`
> (evidence), `problemasConocidos` (known problems), `estado` (state: `vigente` = current,
> `reemplazada` = replaced, `retirada` = withdrawn), `origen` (source URL), `tamano` (size),
> `licencia` (license), `integracion` (integration), `construidaEn` (built on), `notas` (notes),
> `detalle` (detail), `omitido` (skipped). Renaming them would break every already-published signed
> database, so they are not translated.

## 1. What problem it solves

`redroid-forge` always starts from the official Redroid image and integrates GApps, Magisk, hwenc,
etc. into it per instance. That produces combinations (base × GApps × Magisk × modules × hardware)
and **support can only be promised on the ones somebody validated**. This database is the list of
the validated ones, and the mechanism that decides, for each instance, whether the user is on known
ground or not.

Principles (already decided):

- Support = **known combination**, not "image".
- Outside the database: **it is not blocked**, it is left as "unsupported" with a warning.
- The database lives in an **external repository**, with a **snapshot inside every release** and an
  **optional, explicit update**.
- The database **does not redistribute** third-party binaries: it stores *pointers* (source URL +
  `sha256`), never the contents of GApps/Magisk.

## 1.1 Scope of the promise: verifiable, not guaranteed

redroid-forge is free software, with no warranty (Apache-2.0), and **cannot assure that the database
is correct**. What it does offer is that **anyone can check for themselves** what the database
claims:

- **Signature = authenticity, not correctness.** The signature (4.3) proves who published the
  database and that it was not tampered with. It does not say the combinations work. The UI and the
  documentation do not present the signature as a quality seal.
- **"Official" means "validated with evidence", not "guaranteed".** It is the label for the
  combinations the project tested and for which it can show evidence (validations with hardware,
  date and result). The visible text says "validated by the project" and links to that evidence;
  never "supported" or "safe" on its own.
- **Local verification.** Every combination declares a list of *reproducible automatic checks* (e.g.
  hwenc: the `c2.hardware.encoder.h264` encoder is registered and `screenrecord` produces N H.264
  frames; GApps: the Android ID gets registered; Magisk: `su` responds). The user can **run them on
  their own host** and see the result (step 8 of the plan). That way the claim "this works" stops
  being an act of faith: it can be repeated.
- **Everything checkable is checkable without trusting anybody:** the database's `digest` is
  compared against what the user actually has, each package's `sha256` against what was actually
  downloaded, and the validations link to their public evidence.
- **Community reports come in as what they are:** third-party evidence, which a maintainer may
  decide to promote or not (6.1).

## 2. Data model

A single JSON document (`schemaVersion` 1) with four collections. It is split into one file per
entity in the external repo and **compiled into a single `database.json`** on every database release
(so the snapshot and the download are one file, and the signature covers everything).

```jsonc
{
  "schemaVersion": 1,
  "serial": 12,                       // monotonic integer: anti-rollback
  "generatedAt": "2026-10-05T00:00:00Z",
  "minForgeVersion": "0.1.0",         // minimum redroid-forge that understands this database
  "bases": [ ... ],
  "paquetes": [ ... ],
  "combinaciones": [ ... ]
}
```

### 2.1 `bases` — official images

```jsonc
{
  "id": "redroid-15-2025-06-27",
  "androidVersion": 15,
  "imagen": "redroid/redroid",        // repository
  "tag": "15.0.0-latest",             // informational/for pulling ONLY; it does not identify
  "digest": "sha256:8188985244…c991ad", // this is what truly identifies (RepoDigest)
  "arch": "amd64",
  "construidaEn": "2025-06-27T15:38:04Z",
  "estado": "vigente"                 // vigente | reemplazada | retirada
}
```

The **digest** is what is compared against what is on the host (`docker image inspect` →
`RepoDigests`). The tag is only used to pull the image. An image with no `RepoDigests` (built
locally, imported with `docker load` without a repo) **never matches** a base → unsupported.

### 2.2 `paquetes` — GApps and Magisk (pointers, not binaries)

```jsonc
{
  "id": "gapps-<name>-<version>-<arch>",
  "tipo": "gapps",                    // gapps | magisk
  "nombre": "…", "version": "…",
  "androidVersion": [15], "arch": "x86_64",
  "origen": "https://…",              // where it is downloaded from, exactly as the author publishes it
  "sha256": "…", "tamano": 123456789,
  "licencia": "Proprietary (Google)",
  "integracion": "zip-flashable"      // packaging type; defines which module knows how to apply it
}
```

`sha256` is **mandatory**. A package without a hash does not enter the database.

#### Packages defined by files (`archivos`) — the GApps case

GApps for Android 15 on x86_64 is **not one archive**: it is a fixed set of files (Google Play
services, Play Store, Google Services Framework, Partner Setup and their permission/config XMLs)
that the user extracts from the *Google Play* x86_64 system image that Google publishes for the
Android SDK emulator (`backend/scripts/gapps-extract-sdk.js`). Such a package lists its files and
carries, as its `sha256`, the **digest of the whole set** (`sha256` of the sorted lines
`<sha256>  <path>\n`; `lib/fileBundle.js`), so the two cannot disagree:

```jsonc
{
  "id": "gapps-sdk35-r09-x86_64",
  "tipo": "gapps",
  "androidVersion": [15], "arch": "x86_64",
  "origen": "https://dl.google.com/android/repository/sys-img/google_apis_playstore/x86_64-35_r09.zip",
  "licencia": "Proprietary (Google)",
  "integracion": "sdk-system-image",
  "sha256": "<digest of archivos>",
  "archivos": [
    { "path": "product/priv-app/PrebuiltGmsCore/PrebuiltGmsCore.apk", "sha256": "…", "tamano": 239885506 },
    { "path": "system_ext/priv-app/GoogleServicesFramework/GoogleServicesFramework.apk", "sha256": "…" }
  ]
}
```

Allowed paths are only `product/` and `system_ext/` (`priv-app`, `app`, `etc`, `framework`,
`lib64`): a package definition can never make the module write anywhere else. The `gapps` module
**never downloads** these files: it verifies the user's folder against `archivos` and refuses to
inject anything that does not match, or any extra file the definition does not list. A package
that is **not** in the database but whose folder carries its own `package.json` is injected
anyway and reported as **unsupported**.

**Why this exact set (validated 09/10/2026).** GApps of different generations do not mix: GMS 22
with a GSF 15 crashes at start, and GMS 21 with a GSF 12 starts but cannot update itself
(`INSTALL_FAILED_CONFLICTING_PROVIDER`). The set GmsCore 24 + Phonesky 41 + GSF 15 of the
Android 15 image boots, signs in, and Play updates itself to GMS 26 without errors.

### 2.3 `combinaciones` — the unit of support

```jsonc
{
  "id": "redroid15-hwenc",
  "base": "redroid-15-2025-06-27",
  "gapps": null,                      // package id, or null
  "magisk": null,                     // package id, or null
  "modulos": { "hwenc": 3 },          // module id -> validated manifest version
  "soporte": "oficial",               // oficial | comunidad
  "validaciones": [
    {
      "hardware": { "vendor": "amd", "gpu": "Radeon RX 480 (Polaris10)",
                    "driver": "radeonsi" },
      "fecha": "2026-10-05",
      "forgeVersion": "0.1.0",
      "resultado": "ok",              // ok | parcial | falla
      "chequeos": [                   // reproducible by the user (see 1.1)
        { "id": "doctor", "resultado": "ok" },
        { "id": "hwenc.encoder-registrado", "resultado": "ok" },
        { "id": "hwenc.screenrecord-frames", "resultado": "ok", "detalle": "74 frames" }
      ],
      "notas": "Green Doctor (legacy binder), c2 encoder registered, 74 H.264 frames.",
      "evidencia": "https://github.com/fogelmanjg/redroid-forge/pull/4"
    }
  ],
  "problemasConocidos": []
}
```

- `soporte: "oficial"` requires **at least one `ok` validation**.
- A combination can be `oficial` for one piece of hardware and untested on another: that is why
  validations carry hardware, and the resolver crosses it with the host's vendor (see 3).
- `comunidad` combinations document "known to boot/partially work" (e.g. Redroid 13 only with
  `gpuMode: guest`), with no promise.

## 3. Resolution: is this instance "known"?

Input: what the user chose when creating the instance + what is on the host. Output: a **verdict**
that the backend stores on the instance and the UI displays.

```
resolver({ baseDigest, gappsId, magiskId, modulos, hostGpuVendor }) -> {
  nivel: "oficial" | "comunidad" | "sin-soporte",
  combinacion: <id> | null,
  motivos: [ "…" ]          // in user language, never empty if nivel != oficial
}
```

Rules, in order:

1. **Unknown base** (the digest is not in `bases`, or `estado: retirada`) → `sin-soporte`, reason
   "base image not recognized".
2. **Unknown package** (a GApps/Magisk choice that is not in `paquetes`) → `sin-soporte`, reason with
   the package.
3. There is an **exact combination** (same base, same packages, same set of modules with the
   validated manifest versions):
   - with an `ok` validation on the **host's vendor** → its `soporte` (normally `oficial`);
   - validated only on **another vendor** → `comunidad`, reason "validated on AMD, your host is
     Intel";
   - with no `ok` validation → `comunidad`.
4. Everything known separately but **no exact combination** → `comunidad`, reason "every piece is
   known but this combination was not validated together".
5. `base.estado == "reemplazada"` downgrades to `comunidad` with the reason "there is a newer
   validated base".

The resolver is **pure** (no I/O): it receives the already-loaded database, so it can be tested
without Docker.

## 4. File lifecycle

### 4.1 Where it lives

| Location | What it is | Trust |
|---|---|---|
| `backend/db/snapshot.json` (in the repo/image) | snapshot of the release | it comes **inside the release**: it needs no signature of its own |
| `backend/data/db/database.json` (persistent volume) | last downloaded and verified database | requires a valid signature |

When loading, the one with the **highest `serial`** is used (if the cached one is older than the
snapshot of a newer release, the snapshot wins — so updating redroid-forge never leaves an old
database overriding a newer one).

### 4.2 Detection and update

- **Detection (decided 05/10/2026):** redroid-forge **checks whether there is a newer database once
  a day and when the app is opened**. It is only a light query (the published `serial`), it does not
  download or apply anything; if there is a newer one, the UI/Doctor shows a notice. It can be turned
  off in the configuration (for anyone who does not want the app to make any connection on its own).
- **Applying** is always **explicit**: `POST /api/db/update` (a button in the UI). It is never
  applied in the background.

1. Download `database.json` + `database.json.sig` from the configured URL (by default, the latest
   release of the external repo; configurable for whoever maintains a mirror).
2. **Verify the signature** (ed25519, see 4.3). It fails → it is discarded, nothing is touched.
3. Verify the supported `schemaVersion` and `minForgeVersion` ≤ the installed version. If the
   database requires a newer redroid-forge: it is reported, not applied.
4. Verify **`serial` greater** than the current one (prevents someone with access to the channel from
   serving an old but valid database to reintroduce a withdrawn combination).
5. **Atomic** replacement (write to a temporary file + `rename`), keeping the previous one as
   `database.prev.json`.

### 4.3 Integrity verification: a signature, not just a hash

A hash published next to the file, in the same place, adds nothing if that place is compromised. An
**ed25519 signature of `database.json`** is proposed:

- The public key is **embedded in redroid-forge**; the private one is held by whoever releases the
  database.
- It supports **more than one public key** (a list) so they can be rotated.
- It is verified with Node's `crypto` (native ed25519): **no new dependencies**, consistent with the
  stack decision.

**Decided (05/10/2026):** the key is generated and **first signed when releasing the first complete
usable version** of redroid-forge, not before (until then the database travels only as a snapshot
inside the release, which needs no signature).

**A dedicated key, not an existing one (decided 05/10/2026).** The SSH key of any server is not
reused: that key is an identity for access to machines and to GitHub (if it leaks or is rotated,
access breaks; if the signing one leaks, access would have to be rotated), it lives on an
always-on server within reach of processes and agents, and its comment (`user@host`) would end up
published in a public project. The signing key is new, with a **passphrase**, and the private key
lives **only on the machine of whoever releases** (never on a shared server or in CI, see 6.1). The
`backend/scripts/db-sign.js` tool (`keygen`/`sign`/`verify`, dependency-free) generates it and
signs; it will move to the `redroid-forge-db` repo. The authorized **public** keys go in
`backend/db/trusted-keys.json`. **The maintainer's key was generated on 05/10/2026**
(`mantenedor-2026-10`, with a passphrase; the private key lives in `~/.redroid-forge-keys/` of
whoever releases, outside any repo). A fork or own mirror uses its own list with
`REDROID_FORGE_DB_TRUSTED_KEYS_FILE`; if the list is empty, the app neither queries nor applies
downloaded databases. The databases are published in the **`fogelmanjg/redroid-forge-db`** repo (see
its `RELEASING.md`). At first it is signed by hand; the model for when there are more collaborators
is in 6.1.

### 4.4 Package download (GApps/Magisk)

The corresponding module receives `origen`+`sha256` **from the database**, never from its own
manifest:

1. Content-addressed cache: `backend/data/paquetes/<sha256>`. If it exists, the **hash is verified
   again** anyway (the disk is not trusted).
2. If it does not exist, it is downloaded to a temporary file, the `sha256` is computed while
   downloading, and **only if it matches** is it moved to the cache. If it does not match: it is
   deleted and the creation is aborted with a clear error (what was expected, what arrived).
3. **Manual import:** if the source disappeared (links die), the user can supply a local file; it is
   accepted **only if its `sha256` matches** a package in the database.
4. No network and no cache → the instance is not created with that package; an explicit message,
   never a silent fallback to "the latest version".

## 5. Integration with the rest of the system

- **Catalog (`images.json`)**: becomes derived from `bases` (one entry per current base, with `tag`
  for pulling). `soporte`/`notaSoporte` stop being written by hand.
- **Instance creation** (`routes/instances.js`): chooses base + packages → calls the resolver → stores
  the `veredicto` (verdict) on the instance. If it is not `oficial`, the API returns it and the UI
  shows it prominently (same transparency criterion as the tiers of section 2).
- **GApps/Magisk modules** (`stage 4`, see `ARCHITECTURE.md`): receive the resolved package (path in
  the already-verified cache). Their manifests stop carrying a hardcoded `origen` as the download
  source (they keep declaring it for the contract shown to the user).
- **Doctor**: a new check "Known-combinations database" — version (`serial`/date), origin (snapshot
  or updated), and whether the daily check (4.2) detected a newer database. It is a notice: it never
  fails because of this.
- **Read-only API** for the UI: `GET /api/db` (state/statistics), `GET /api/db/combinaciones`.

## 6. External repository

Name: **`redroid-forge-db`** (confirmed 05/10/2026). Structure:

```
bases/*.json          one per base image
paquetes/*.json       one per GApps/Magisk package
combinaciones/*.json  one per combination + its validations
schema/               JSON Schema (reference; the backend validates by hand)
tools/build.js        compiles everything into database.json (+ validates references)
tools/sign.js         signs (ed25519)
```

Contributing = a **PR with evidence** (which hardware, which result, logs or a link). The repo's CI
validates: schema, that references exist (`combinacion.base` ∈ bases, etc.), that `soporte: oficial`
has an `ok` validation, and that every package `origen` **still downloads to the declared
`sha256`** (detects dead or changed links).

## 6.1 Maintenance at scale (who updates the list)

If nobody uses redroid-forge, this is trivial; if many people use it, it **cannot depend on a single
person doing everything by hand**. The design aims for human work not to grow linearly with users:

1. **Graceful degradation.** If the database gets out of date or has no maintainer, nothing breaks:
   the unknown falls into "community"/"unsupported" and the app keeps working. The only thing lost
   is that there are fewer "official" combinations.
2. **Two trust levels to enter the database:**
   - **`comunidad`**: enters with **automatic** checks (schema, references, hashes of downloadable
     packages). Minimal human review.
   - **`oficial`**: requires a maintainer's review (there is a promise of support behind it). It is
     the intentional bottleneck, and the only one.
3. **Reports generated by the app itself.** A "report validated combination" button builds the JSON
   (digests, module versions, hardware, result of the Doctor and of the automatic checks) ready to
   open a PR/issue. The contributor does not write by hand nor get the format wrong; the maintainer
   reviews structured evidence instead of free text.
4. **Bots for the repetitive.** A scheduled job in the repo detects new digests of the official
   images and opens a "new unvalidated base" PR; it checks that the package `origen`s still
   download to the declared `sha256` and opens an issue if not.
5. **More than one maintainer able to sign.** The verifier already accepts a *list* of public keys:
   each maintainer signs with their own key and a single one can be revoked without invalidating the
   others. Cost: every key in the list can publish any database, which is why the list is kept short
   and lives inside the release's code (it is not updated from the database itself).
6. **Signing in CI, only when it is worth it.** With several maintainers and real volume, signing
   can be done in CI with the key as a protected secret (protected branches + mandatory review
   before the release). It is a conscious trade-off against the risk in 4.3; it is not done before
   it is needed.

## 6.2 Known risks

- **Source links that die or change content.** Mitigation: the hash detects it; manual import covers
  it; the repo's CI watches it. Mirroring the binaries is not an option (license).
- **An `oficial` base that becomes false** (a new driver breaks something). Mitigation:
  `problemasConocidos` + `estado` and publishing a database with a higher `serial`; the user sees
  the degradation on updating.
- **Maintenance.** The database is continuous validation work; hence the evidence-based contribution
  model and the `redroid-hwenc`-style hardware table.

## 7. Implementation plan (small steps, each one mergeable)

1. ✅ **This document + seed + pure core** (`knownDb.js`: validate the document, resolve, compare
   `serial`, verify the signature) with tests. Without touching the creation flow.
2. ✅ **Done (05/10/2026)** Read-only API (`GET /api/db`, `GET /api/db/combinaciones`) + a "Known-
   combinations database" check in the Doctor. Loaded with `backend/src/lib/knownDbStore.js`: it
   chooses by `serial` between the snapshot and a downloaded copy (nobody downloads one yet), warns
   about and ignores an invalid/rollback copy or one that requires a newer forge, and never brings the
   app down because of it. The snapshot moved to `serial` 2: it adds the **Intel Iris Xe** validation
   and the `chequeos` of both validations.
   **`serial` 4 (07/10/2026):** the hwenc module moves to version 4 (hardware decode) and both
   validations add per-codec decode checks (`hwenc.decode-h264`, `-hevc`, `-hevc-10bit`, `-vp9`,
   `-vp9-10bit`, `hwenc.decoders-registrados`), with their measurements, and the combination declares
   `problemasConocidos` (intermittent Polaris VCE timeout, encoder without bitrate control, 10-bit/HDR
   delivered as 8-bit). A check with result `omitido` means the hardware does not offer it (VP9 on
   Polaris).
3. ✅ **Done (05/10/2026)** Download and update with full verification
   (`backend/src/lib/knownDbUpdate.js`): the **signature is verified over the downloaded bytes before
   parsing anything**, then shape + `serial` (anti-rollback) + `minForgeVersion`, and only then is it
   written (atomically, the previous one stays as `database.prev.json`). `GET /api/db` reports the
   state; `POST /api/db/check` queries (only `latest.json`); `POST /api/db/update` applies (always an
   explicit action). Automatic check on open and every 24 h (query only), which can be turned off with
   `REDROID_FORGE_DB_CHECK=0`; URL configurable with `REDROID_FORGE_DB_URL` (mirrors). With no trusted
   keys there are no network queries.
4. Package cache and verification (download, `sha256`, manual import).
5. Wiring into instance creation: `veredicto` persisted and shown; `images.json` derived from `bases`.
6. Real GApps and Magisk modules on top of the official image (consume 4).
7. External `redroid-forge-db` repo + build/signing tools + first signed release.
8. **Local verification** (1.1): every module declares its reproducible checks; the app runs them
   on an instance and compares against the combination's `chequeos`. Without this, "validated" is only
   a claim of the repo; with it, the user can repeat it.

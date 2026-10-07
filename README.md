# redroid-forge

**Languages:** English | [Español](README.es.md)

> This project's official language is **English**. The Spanish file is provided for convenience and
> may not be perfectly accurate or up to date — if in doubt, this file is the source of truth.

A standalone app (frontend + backend in a single container) to manage
[redroid](https://github.com/remote-android/redroid-doc) instances on any PC that only has Docker,
without depending on any other infrastructure.

> Work in progress — it consolidates several separate projects in one place (`redroid-manager`,
> `redroid-hwenc`, `redroid-nvidia`, and what currently lives spread across
> `jg-dashboard`/`plenum-redroid`). See [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) (what and
> why), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (how the pieces fit together — base image,
> modules, and at which point of an instance's lifecycle each one is touched) and
> [`docs/ROADMAP.md`](docs/ROADMAP.md) (in what order) for the full picture. What exists today
> covers **Phases 0, 1, 2 and 4** of the roadmap: the full port of `redroid-manager`, support tiers
> per image, the first real module (hwenc, with hardware video **encode and decode** on AMD and
> Intel), the generic module-contract system, and the signed known-combinations database
> ([`docs/KNOWN-COMBINATIONS.md`](docs/KNOWN-COMBINATIONS.md)).

It solves two things:

1. **Instance lifecycle**: create, start, stop, restart and delete redroid containers from a web
   UI, including what does not travel with the image (per-instance `binderfs` devices, and the
   `mac80211_hwsim` wiring for the images with fake WiFi).
2. **Doctor**: host diagnostics — shows what is missing to configure and the exact command to fix
   it. It never runs anything by itself, it only diagnoses.

## ⚠️ Images with GApps: register the Android ID within 48 hours

Images with Google Apps (`hasGapps: true` in the catalog) receive an Android ID (GSF) from Google
as soon as they boot. **If that ID is not registered by hand at
[google.com/android/uncertified](https://www.google.com/android/uncertified) within 48 hours of
the first boot, Google blocks GApps access on that instance** — it is an uncertified device
(redroid + Magisk), and that registration is the way to avoid the block. It is not something the
code can do on its own, it is a human step.

The app helps make sure it does not get overlooked:
- The **Instances** tab shows the Android ID of every instance with GApps, with a direct link to
  register it and an "I already registered it" button once done.
- The **Doctor** tab lists as pending (⚠️, and ❌ if the deadline has passed) any GApps instance
  that is not registered.

## Third-party / non-free modules: a contract before enabling them

Everything that is not 100% free software (GApps, Magisk) or that depends on a choice of the host
(fake WiFi and, in the future, device profile/GPU mode/CPU-RAM) is declared with a versioned
**manifest** (`backend/src/modules/manifests/*.json`) instead of having its own enablement logic.
The backend never creates or starts an instance that requires a module without a current
acceptance of its manifest — if it is missing, it answers `428` with the pending contract, the
frontend shows it (the same generic dialog for all of them, `frontend/contracts.js`), and only
after it is accepted is the request retried. See the **Modules** tab in the UI and section 5 of
[`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) for the full detail (it includes `compatibleCon`:
a module is not offered if the chosen image does not support it).

## Host requirements

- Docker installed and its daemon running.
- A kernel with `binder` support (standard in recent Ubuntu kernels) and `binderfs` mountable at
  `/dev/binderfs`.
- If you will use images with fake WiFi (`needsHwsimWifi`): a loadable `mac80211_hwsim` module.
- If you want GPU acceleration (`gpuMode=host`): GPU drivers installed on the host.

There is no need to install Node, special sudoers entries, or anything else on the host — the
`redroid-forge` container itself runs `--privileged --pid=host --network=host` and does everything
from there.

## Bringing the redroid image to this PC

If the image was built on another machine:

```bash
docker save <image> | gzip > image.tar.gz
# copy the file to this PC, then:
gunzip -c image.tar.gz | docker load
```

If it is pushed to your own registry:

```bash
docker pull <your-registry>/<image>
```

The catalog of known images lives in [`backend/images.json`](backend/images.json) — add any new
image there (id, Docker tag, label, `gpuMode`, `needsHwsimWifi`).

## Starting the app

```bash
docker compose up -d --build
```

The UI is available at `http://<this-pc-ip>:8080` (or the port you set in `PORT`, since it runs in
`network_mode: host`). Go to the **Doctor** tab first: it tells you exactly what is missing on this
host and the command to fix it before creating the first instance.

## Viewing the screen from another PC (scrcpy) — e.g. a TV with an old laptop

scrcpy repository: https://github.com/Genymobile/scrcpy

Every instance exposes its ADB port on the host (`adbPort` in the `GET /api/instances` response,
the same one shown in the "ADB" column of the UI). From any other machine on the network that has
scrcpy and `adb`:

```bash
adb connect <server-ip>:<adbPort>
scrcpy -s <server-ip>:<adbPort> --audio-codec=aac
```

This is useful for reusing an old laptop + TV as a light "client": the laptop only runs `scrcpy`
(far less demanding than running Android locally), while the real instance runs on a server with
more resources. If the laptop is old and its distro ships an outdated `scrcpy` in its repositories
(Debian, for example, only has an old version in `backports`), downloading the newest official
binary from [GitHub Releases](https://github.com/Genymobile/scrcpy/releases) is usually simpler
than compiling it — note that the `scrcpy-server` version must match the `scrcpy` client's version
exactly.

### From an Android phone/tablet instead of a PC

If the client you have at hand is an Android device (not a PC/laptop), there is a scrcpy port that
runs as an Android app: **ScrcpyForAndroid** (https://github.com/Miuzarte/ScrcpyForAndroid).
Conceptually it is the same: the app connects over the network to the instance's ADB port
(`<server-ip>:<adbPort>`) and decodes the video there, without needing a PC in between.

## Layout

```
backend/src/server.js    Express, serves /api/* and the static frontend
backend/src/lib/          dockerRuntime, binder, hwsimWifi, androidIdentity, doctor, store,
                           portAllocator, moduleManifests, moduleAcceptance, moduleGate, hwAccel,
                           knownDb*
backend/src/routes/       instances, doctor, images, modules, db
backend/src/modules/      manifests/*.json (each module's contract, section 5 of REQUIREMENTS.md)
                           + hwenc/ (first real module: integration script, not just a manifest)
backend/native/           vaapi-daemon — host daemon of the hwenc module (see docs/ARCHITECTURE.md)
backend/db/               bundled seed of the known-combinations database + trusted signing keys
backend/images.json       catalog of the available redroid images
backend/data/             persistent state (instances.json, module-acceptances.json)
backend/test/             tests (node --test, no new dependencies)
android/                  Codec2 components (hardware encoder/decoders) and their test tools
frontend/                 vanilla frontend (no build step); contracts.js = generic contract modal
docs/                     REQUIREMENTS.md (what and why), ARCHITECTURE.md (how the pieces fit
                          together), KNOWN-COMBINATIONS.md and ROADMAP.md (in what order)
```

## Credits and attribution

This project is a frontend/manager on top of what other projects have already built — not a
replacement or a competitor. Explicit acknowledgement:

- **[redroid](https://github.com/remote-android/redroid-doc)** (remote-android) — the
  Android-in-Docker itself that all of this runs on. Apache License 2.0 (kernel modules under
  GPL v2).
- The logic of `binder.js` and `hwsimWifi.js` is ported from `plenum-redroid`
  (`host-resource-allocator.service.ts` and `fake-wifi-networking.service.ts`), simplified:
  without the coexistence assumptions with `jg-dashboard v1` (fixed port offset, hwsim fallback
  disabled) that do not apply in a single-purpose deploy like this one.

## License

Apache License 2.0 — see [`LICENSE`](LICENSE).

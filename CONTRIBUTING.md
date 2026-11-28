# Contributing to redroid-forge

This project's official language is English (see `README.md`). Keep that in mind for issues, PRs
and commit messages — Spanish is fine for an informal report, but a PR's own description/commit
message should be in English, same as the rest of the codebase and docs.

## Current status: 1.0 released, open again (since 02/12/2026)

**Everything is open again: bug fixes, documentation, and new features.** Since `1.0.0` the
project follows [SemVer](https://semver.org/) in full (see the versioning policy in
`CHANGELOG.md`): fixes are PATCH releases, a new capability is a MINOR release, and anything that
breaks an existing setup is a MAJOR release, called out as such.

What is planned next is in the issues of the
[After 1.0](https://github.com/fogelmanjg/redroid-forge/milestone/1) milestone. Picking one of those
is a good way in. So is a bug fix or a docs fix, as always.

## Before opening a PR

1. **Open an issue first for anything non-trivial** (more than a one-line fix) — this project has
   a lot of hardware-specific, host-specific context (GPU vendor quirks, Android version
   combinations, module interactions) documented across `docs/*.md` that is easy to miss; an issue
   lets that context surface before you spend time on an approach that already has a documented
   reason it does not work.
2. **Read the doc for the area you're touching before changing it**, not just the code:
   - `docs/REQUIREMENTS.md` — what and why (scope, license policy, module consent model).
   - `docs/ARCHITECTURE.md` — how the pieces fit together (base image, the 6/7-stage module
     lifecycle, the known-combinations database).
   - `docs/MODULE-AUTHORING.md` — writing a module (native vs. own vs. user module, the manifest
     schema, the stage-7 watchdog convention).
   - `docs/ROADMAP.md` — what is already decided, what is still an open idea, and why things are
     sequenced the way they are. A lot of "why isn't X done the obvious way" is answered here,
     often with the exact investigation that ruled the obvious way out.
   - `docs/TROUBLESHOOTING.md` / `docs/HOWTO.md` — real problems people hit and the recipes for
     common tasks, grown from actual questions rather than written speculatively. If you fix a bug
     or clarify a confusing step, consider whether it belongs here too.
3. **Run the tests**: `npm test` from `backend/` (`node --test test/` under the hood — no test
   framework dependency beyond Node's own built-in runner, by design). A PR that only adds
   behavior without a test for it will be asked to add one, same bar the existing code is held to.
4. **Match the existing style**: no code comments explaining *what* code does (names should
   already say that) — only *why*, when it is genuinely non-obvious (a hidden constraint, a
   workaround for a specific bug, something that would surprise a reader). The codebase leans
   heavily on this already; read a neighboring file before adding a block comment.

## Proposing a feature

Open an issue (there is a template for it). Explain the use case, not just the mechanism — a lot
of this project's own design decisions came from a concrete real case (a specific game, a specific
GPU, a specific failure) rather than a hypothetical one, and that is the kind of detail that
actually moves a design discussion forward. A well-described feature request is useful groundwork
even before anyone builds it: several phases in `docs/ROADMAP.md` started exactly as an
issue-shaped idea.

## Reporting a bug

Open an issue (there is a template for it). The single most useful thing you can include: your
**host's GPU vendor and driver**, the **redroid image id** (`android-15-official` or whichever),
and which **modules** the instance has enabled — this project's own `docs/KNOWN-COMBINATIONS.md`
exists because behavior genuinely varies across that combination, and "it doesn't work" without
it usually means a few back-and-forth messages before the report is actionable.

If it is a crash or hang on the Android side specifically, check whether the Doctor tab already
flags something relevant first — a surprising number of real issues are a missing host
prerequisite (kernel `binder`, `mac80211_hwsim`, a GPU driver) that Doctor already detects with
the exact fix command.

## Adding a module

Third-party/non-free content (GApps, Magisk, anything like them) is **never packaged** inside this
repo or its images — see `docs/REQUIREMENTS.md` section 6. A module that integrates one of those
downloads it from its real official source at the moment a user actually requests it, under an
explicit consent contract (`backend/src/modules/manifests/*.json` + the module's own
`integrate.js`) — never silently. Read `docs/MODULE-AUTHORING.md` before writing one; it covers
the full manifest schema and the 7-stage lifecycle hook contract with real examples from the
modules already shipped.

## License

By contributing, you agree your contribution is licensed under this project's own license, Apache
License 2.0 (`LICENSE`).

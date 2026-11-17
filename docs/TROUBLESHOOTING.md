# Troubleshooting — problems people actually hit

**Languages:** English | [Español](TROUBLESHOOTING.es.md)

This page only covers problems someone actually ran into while using redroid-forge — not a
speculative list of everything that could theoretically go wrong. If you hit something that isn't
here, open an issue (see `CONTRIBUTING.md`); once it's understood, it gets added here so the next
person doesn't have to debug it from scratch.

See also [`docs/SCRCPY-TIPS.md`](SCRCPY-TIPS.md) for problems specific to connecting with the
real `scrcpy` client from a terminal (audio, video codec, bit rate) — this page is about the app
itself (instances, the built-in web viewer, resources).

| Symptom | Why | Fix |
|---|---|---|
| An instance reports way more RAM than its cap (e.g. `dumpsys meminfo` or `/proc/meminfo` inside the instance shows the host's full RAM, not the memory limit it was given) | Android only sees the real cgroup limit through a workaround (see `meminfoFix.js`'s own comment): a fake `/proc/meminfo` gets bound in by Android's own init at boot, triggered by a `.rc` file. Found for real (17/11/2026): if that `.rc`'s permissions on disk ever drift to group/other-writable, Android's init silently refuses to process it ("insecure file") and the bind never happens — the instance keeps reporting the host's full RAM even though the cgroup limit is genuinely enforced underneath. | Fixed defensively since the `1.0.0`-track build after 17/11/2026 (the copy is always forced back to the right permission, regardless of the source file on disk). An instance **created or recreated before that fix** can still be stuck on a broken copy — a plain restart does **not** re-apply it (the `.rc` is only (re)installed on create/recreate, see the comment above `installRcTrigger` in `meminfoFix.js`); recreating the instance does. |
| In the "expandida" (full-screen) viewer, typing on the physical keyboard does nothing — only tapping Android's own on-screen keyboard works | By design, not a bug: the hidden text field that captures physical typing only gets focus when you click the **⌨** button first (hover/focus it for a reminder). Even then, only plain committed text is forwarded — Backspace, Enter, Tab and the arrow keys are never sent (no IME/composition handling, see the "expandida" design decisions in `ROADMAP.md` Phase 11). | Click **⌨** before typing. For Backspace/Enter/arrows, use Android's own on-screen keyboard (visible in the video, tap it directly) or the physical keyboard shortcuts scrcpy itself doesn't need here — there is no key-event passthrough for those yet. |
| Using a third-party scrcpy Android app (e.g. `ScrcpyForAndroid`/miuzarte) from a phone or tablet to view a redroid-forge instance: black screen on connect, or the app closes unexpectedly on disconnect | Known decoder bugs inside that specific third-party app when it talks to a redroid instance (traced into its own source — see the project's internal notes); not something redroid-forge controls or can fix from this side. | Use the built-in **"expandida"** web viewer from the tablet's own browser instead (same device, no extra app, no decoder bugs specific to that APK). |

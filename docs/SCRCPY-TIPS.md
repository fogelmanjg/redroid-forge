# scrcpy tips — first-run gotchas and the shortcuts worth knowing

**Languages:** English | [Español](SCRCPY-TIPS.es.md)

scrcpy's own docs are the real reference — this page only points at the handful of things that
actually trip people up the first time, against a redroid instance specifically, plus the
shortcuts you'll actually use. Full reference:
[shortcuts.md](https://github.com/Genymobile/scrcpy/blob/master/doc/shortcuts.md),
[audio.md](https://github.com/Genymobile/scrcpy/blob/master/doc/audio.md),
[video.md](https://github.com/Genymobile/scrcpy/blob/master/doc/video.md).

## First-run gotchas

| Symptom | Why | Fix |
|---|---|---|
| No audio, or scrcpy prints `Failed to initialize audio/opus` | scrcpy's default audio codec is **Opus**, and redroid has no Opus encoder | Add `--audio-codec=aac` (already the default in `scripts/connect.sh`/`.ps1`) |
| Audio works then silently stops, video keeps going | Audio capture failed after starting; scrcpy doesn't treat that as fatal by default | Add `--require-audio` if you'd rather it fail loudly than mirror silently |
| No audio at all, every codec | Audio capture needs Android 11+; it's unsupported (and disabled) on older images | None — use `--no-audio` and don't chase it |
| Choppy video, decoder errors, or scrcpy falls back to software on its own | Hardware decode (`--hwdec=auto`, the default) failed for this GPU/driver combo | Try `--hwdec=disabled` (plain software decode) |
| Picture looks blocky, or the connection can't keep up | Default bit rate is 8 Mbps — too high for a slow/shared link | `--video-bit-rate=4M` or `2M` (the connector scripts offer this as a menu choice) |
| High latency, input feels delayed | H.265 costs more latency than H.264 for marginal quality gain here | Stick to the default `--video-codec=h264` |

**Verified on real redroid instances** (via `scrcpy --list-encoders`, checked against both an
Android 11 and an Android 15 image): the only audio encoders present are **AAC** and **FLAC** —
there is no Opus or Vorbis encoder at all, on either version. If `--audio-codec=aac` isn't enough
for some reason, `--audio-codec=raw` (uncompressed PCM) is a fallback that needs no device encoder
at all, at the cost of bandwidth. Video encoders present: `h264`, `vp8`, `vp9` (no h265/av1).

## Shortcuts worth knowing (MOD = left Alt **or** left Super, by default)

| Shortcut | Action |
|---|---|
| `MOD+F` | Toggle fullscreen |
| `MOD+H` or middle-click | HOME |
| `MOD+B`, `MOD+Backspace`, or right-click | BACK (right-click also wakes the screen if it's off) |
| `MOD+S` | Recent apps (app switch) |
| `MOD+Up` / `MOD+Down` | Volume up / down |
| `MOD+O` / `MOD+Shift+O` | Turn the device screen off / on (mirroring keeps working either way — handy to save power without disconnecting) |
| `MOD+R` | Rotate the device |
| `MOD+C` / `MOD+V` | Copy / paste the clipboard between computer and device |
| `MOD+G` | Resize window to 1:1 (pixel-perfect) |
| Drag a file onto the window | Installs it if it's an APK, pushes it to the device otherwise |

There's no "shake the device" shortcut in scrcpy itself — if that's what you were picturing, it's
probably either an in-app gesture (Android's own "shake to undo") that scrcpy just forwards as
regular motion, or a mix-up with something else; let us know what you actually meant and we'll
document the real thing. The closest built-in equivalents are `MOD+Shift+Left`/`Right` (flip
horizontally) and `MOD+Shift+Up`/`Down` (flip vertically) — those change scrcpy's own display, not
the device.

The full list (gesture simulation for pinch-to-zoom/tilt, camera mode, HID keyboard/gamepad, etc.)
is in [shortcuts.md](https://github.com/Genymobile/scrcpy/blob/master/doc/shortcuts.md).

# Scenario runner

Measures what a load costs and what the instances deliver, on a real host: how many instances at once, with or without
hardware acceleration, doing what. It exists to answer "what are the limits of this machine?" with numbers that anyone
can repeat, and to feed the `chequeos` of the [known-combinations database](KNOWN-COMBINATIONS.md) with evidence
instead of impressions.

```
node backend/scripts/scenarios/run.js <scenario | file.json> --host <ssh-target> [--accept-contracts] [--keep]
```

It runs on ONE machine (where you invoke it) and drives the **host under test** over ssh. Nothing stays on the host:
everything a run creates carries the run id (`forge-scn-<id>`, `~/rf-scn-<id>`, `redroid-scn<id>-<name>`) and is removed
at the end, even if the run fails. It never removes anything it did not create itself.

## What a run does

1. Syncs this checkout to the host and **builds the forge image from it**. This matters: the VA-API daemon is native
   code compiled when the image is built, so an older image would measure an older daemon.
2. Starts an **isolated forge** (own port, own adb port range, own data directory) from that image.
3. Creates the instances of the scenario, one after another with a pause (many boots at once can make an Android
   restart, which is not what is being measured), and waits for each to boot.
4. After a warm-up, starts a **sampler** on the host (one sample per second) and all the workloads at the same time.
5. Collects the sampler, the daemon's own report and each workload's result, **evaluates the criteria**, writes
   `results.json`, `samples.jsonl` and `report.md` in `scenario-results/<run>-<scenario>/`, and cleans up.

Exit code: `0` pass (or not verified), `2` fail, `1` the runner itself failed.

## Scenarios

A scenario is a JSON file in `backend/scripts/scenarios/scenarios/` (see `lib/scenario.js` for the schema):

| scenario | what it measures |
|---|---|
| `idle` | the baseline: what an instance costs by existing |
| `encode-solo` | `screenrecord` over a moving screen at 8 Mbps: does the encoder deliver the bitrate, at the frame rate of the screen, with the video encode engine really working? |
| `decode-solo-hw` | H.264 High 1080p decoded flat out by the hardware decoder |
| `decode-solo-sw` | the same clip with the platform's software decoder: what the hardware is worth |

An instance lists its `modules` (`hwenc`, `gapps`), its screen (`width`, `height`, `dpi`, `fps`) and its `workloads`
(`idle`, `encode`, `decode`). Several instances and several workloads per instance run **at the same time**, which is how
combined loads are built. `criteria` says what counts as a pass.

## What is measured

On the host, every second: CPU, memory, load average; and for an **AMD GPU** (sysfs, plus debugfs when the runner can
read it): busy %, VRAM, temperature, power, clocks, and whether the video engines are powered up (**UVD = decode,
VCE = encode**), which proves that the hardware did the work and not the CPU. Per container: CPU (in cores) and memory.
And the **kernel log**, for the events that already hurt on the Polaris: `ring vce0 timeout`, GPU resets, VM faults,
init aborts of an Android. Fields that a host does not offer are reported as missing, never as zero. On a non-AMD
host only the generic part is available for now.

## Reading a result

- **PASS / FAIL / not verified.** "Not verified" is never a pass: for example, if the kernel log could not be read (the
  sampler needs root on the host), `noKernelErrors` is *not verified*, not passed.
- **The bitrate is judged with the daemon's own evidence.** A rate control promises "not more than asked, as close as the
  content allows". It can only fall short if the content does not need that many bits at its best quality (QP 14): the
  daemon reports its real bitrate and last QP every 5 s, and the check uses that. If the daemon received **no bitrate at
  all** (target 0), the instances run an Android component older than the rate control, and the check says so.
- **Warnings.** If the hwenc artifacts (built in an AOSP tree, `REDROID_HWENC_ARTIFACTS_DIR`) are older than the source
  of the component the scenario uses, the report warns that it may not measure this checkout's code.
- The decode load is `hwdec_mediacodec_test` run flat out and in a loop. It also computes a CRC of every frame, so the
  absolute fps is a *relative* figure: compare hardware against software, not against a player.

## Configuration

`~/.config/redroid-forge/scenarios.json` (or the matching `--` options):

```json
{ "host": "user@machine", "rootCmd": "sudo -n", "hwencArtifacts": "/path/on/the/host/vendor",
  "decodeTool": "/path/here/to/hwdec_mediacodec_test" }
```

`rootCmd` is how to become root on the host (debugfs and `/dev/kmsg` need it, and so does removing the root-owned data of
the isolated forge); `""` if the account already is root. Without root the run still works, with less to say.

`--accept-contracts` accepts, through the API and only for the isolated forge of this run, the contract of the modules
the scenario uses. Use it only if you have read them.

## Limits of this first version

- The **3D load** (glmark2, from F-Droid, GPLv3, has an x86_64 build) is the next phase; so are the combinations and the
  scaling to N instances.
- Games from the Play Store are mostly ARM64-only, and the official Redroid image **declares ARM64 support but ships no
  translation library** (`libndk_translation`), so they crash on start. They need a translation module that does not exist
  yet; the AOSP build produces the files.
- Only AMD GPUs report their video engines and power. Intel and NVIDIA runs give CPU, memory, per-instance and kernel
  data only.

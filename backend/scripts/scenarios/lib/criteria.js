'use strict';

// What counts as "the scenario passed". Pure: it receives what was measured and returns a list of checks,
// each with its verdict and the reason, so a failing run says exactly what failed and by how much.
//
//   criteria (all optional; what is not declared is not checked):
//     noRestarts        no instance restarted by itself during the run
//     noKernelErrors    no GPU timeout/reset, VM fault, init abort... in the kernel log (only if the sampler
//                       could read it; otherwise the check is reported as "unknown", never as a pass)
//     encode: { bitrateTolerance: 0.35, minFpsRatio: 0.7 }
//         the encoder delivers the bitrate asked for (+/- tolerance) and at least minFpsRatio of the frame
//         rate of the screen
//     decode: { minFps: 24 }
//         the decoder sustains at least that many frames per second, flat out
//     videoEngines: ['uvd', 'vce']
//         those engines of the GPU were powered up during the run (proves that the hardware was used)

function check(id, ok, detail) {
  return { id, verdict: ok === null ? 'unknown' : (ok ? 'pass' : 'fail'), detail };
}

function evaluate({
  criteria = {}, instances = [], workloads = [], sampler = null, daemon = null,
}) {
  const out = [];

  if (criteria.noRestarts) {
    const bad = instances.filter((i) => i.restartsDuring > 0 || (i.status && i.status !== 'running'));
    out.push(check('noRestarts', bad.length === 0,
      bad.length === 0 ? `${instances.length} instance(s) ran without restarting`
        : bad.map((i) => `${i.name}: ${i.restartsDuring} restart(s), status ${i.status}`).join('; ')));
  }

  if (criteria.noKernelErrors) {
    if (!sampler || !sampler.capabilities || !sampler.capabilities.kmsg) {
      out.push(check('noKernelErrors', null, 'the kernel log could not be read (the sampler needs root): not verified'));
    } else {
      const ev = sampler.kernel_events || [];
      out.push(check('noKernelErrors', ev.length === 0, ev.length === 0 ? 'no errors in the kernel log' : `${ev.length} event(s): ${ev[0].kernel}`));
    }
  }

  for (const w of workloads) {
    const who = `${w.instance}/${w.type}`;
    if (!w.ok) {
      out.push(check(`${who}.ran`, false, w.error || 'the workload failed'));
      continue;
    }
    if (w.type === 'encode' && criteria.encode) {
      // A rate controller promises "not more than asked, and as close as the content allows". It can only
      // fall short of the target if the content does not need that many bits at its best quality (the QP
      // floor): the daemon's own report says whether that is the case.
      const tol = criteria.encode.bitrateTolerance ?? 0.35;
      const ratio = w.achievedMbps / w.targetMbps;
      const pct = `${Math.round(ratio * 100)} %`;
      const said = `asked ${w.targetMbps} Mbps, delivered ${w.achievedMbps} Mbps (${pct})`;
      if (daemon && daemon.encode && daemon.encode.requestedMbps === 0) {
        out.push(check(`${who}.bitrate`, false,
          `${said}: the daemon received NO bitrate (target 0, fixed QP ${daemon.encode.lastQp}). The Android component of the instance is older than `
          + 'the rate control (PR #19): rebuild the hwenc artifacts before measuring the bitrate'));
      } else if (ratio > 1 + tol) {
        out.push(check(`${who}.bitrate`, false, `${said}: it EXCEEDS the target by more than ${Math.round(tol * 100)} %`));
      } else if (ratio >= 1 - tol) {
        out.push(check(`${who}.bitrate`, true, `${said}, within +/-${Math.round(tol * 100)} %`));
      } else if (daemon && daemon.encode && daemon.encode.atFloorRatio >= 0.5) {
        out.push(check(`${who}.bitrate`, true,
          `${said}: the encoder was at its quality floor (QP ${daemon.encode.lastQp}) in ${Math.round(daemon.encode.atFloorRatio * 100)} % of the windows, `
          + 'so the content does not need more bits; use a more complex content (a video, 3D) to make it reach the target'));
      } else if (daemon && daemon.encode) {
        out.push(check(`${who}.bitrate`, false, `${said}, and it was NOT at its quality floor (last QP ${daemon.encode.lastQp}): the rate control did not steer to the target`));
      } else {
        out.push(check(`${who}.bitrate`, null, `${said}: below the target and the daemon reported nothing to tell if it was the content or the rate control`));
      }
      if (criteria.encode.minFps !== undefined) {
        out.push(check(`${who}.fps`, w.fps >= criteria.encode.minFps, `${w.fps} fps (minimum ${criteria.encode.minFps})`));
      }
      out.push(check(`${who}.valid`, w.decodesCleanly, w.decodesCleanly ? 'the recording decodes without errors' : 'the recording has decoding errors'));
    }
    if (w.type === 'decode' && criteria.decode && criteria.decode.minFps !== undefined) {
      out.push(check(`${who}.fps`, w.fps !== null && w.fps >= criteria.decode.minFps,
        `${w.fps} fps with the ${w.decoder === 'hw' ? 'hardware' : 'software'} decoder (minimum ${criteria.decode.minFps})`));
    }
  }

  if (criteria.videoEngines) {
    for (const eng of criteria.videoEngines) {
      const r = sampler ? sampler[`${eng}_active_ratio`] : null;
      if (r === null || r === undefined) out.push(check(`${eng}Active`, null, `${eng.toUpperCase()} state not readable on this host`));
      else out.push(check(`${eng}Active`, r > 0, `${eng.toUpperCase()} was powered up in ${Math.round(r * 100)} % of the samples`));
    }
  }

  return out;
}

// The scenario passes only if nothing failed. "unknown" and "warn" do not fail it, and are never counted as a pass
// by themselves: a run whose only checks are unknown/warn is "unknown".
function verdict(checks) {
  if (checks.some((c) => c.verdict === 'fail')) return 'fail';
  if (checks.length === 0 || checks.every((c) => c.verdict === 'unknown' || c.verdict === 'warn')) return 'unknown';
  return 'pass';
}

module.exports = { evaluate, verdict };

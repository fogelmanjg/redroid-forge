'use strict';

// What the VA-API daemon of redroid-forge says about itself while a scenario runs. The runner starts the
// isolated forge with REDROID_FORGE_ENCODE_STATS=1, and the daemon prints, every 5 s, the REAL bitrate that
// the encoder produced against the target and the QP it ended up at:
//
//   encode-stats: 2.86 Mbps over 5.0 s (150 frames, target 8.00 Mbps, last qp 14)
//
// That last piece is what tells a rate controller that "did not reach the target" because it could not
// (it is at its quality floor: the content does not need that many bits) from one that failed to steer.
// Pure: it only parses text.

const ENCODE_RE = /encode-stats:\s*([\d.]+) Mbps over ([\d.]+) s \((\d+) frames, target ([\d.]+) Mbps, last qp (\d+)\)/;

// The lowest QP the rate control of the encoder uses (RC_QP_MIN in backend/native/vaapi-daemon/ratectl.h):
// from there down it cannot spend more bits however much is asked.
const QP_FLOOR = 14;

function parseEncodeStats(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = ENCODE_RE.exec(line);
    if (m) out.push({ mbps: Number(m[1]), seconds: Number(m[2]), frames: Number(m[3]), targetMbps: Number(m[4]), qp: Number(m[5]) });
  }
  return out;
}

// -> { windows, meanMbps, lastQp, atFloorRatio } or null if there is nothing to say
function summarize(stats) {
  if (!stats.length) return null;
  const mean = stats.reduce((a, s) => a + s.mbps, 0) / stats.length;
  return {
    windows: stats.length,
    meanMbps: Math.round(mean * 100) / 100,
    lastQp: stats[stats.length - 1].qp,
    // The bitrate that the Android component asked the daemon for. 0 means it asked for none: an older component
    // (before the rate control) that does not send it, and the daemon then uses its historical fixed QP.
    requestedMbps: Math.max(...stats.map((x) => x.targetMbps)),
    atFloorRatio: Math.round((stats.filter((s) => s.qp <= QP_FLOOR + 1).length / stats.length) * 100) / 100,
  };
}

module.exports = { parseEncodeStats, summarize, QP_FLOOR };

'use strict';

// The report of a run, as Markdown. Pure: it only formats what the runner measured. The same data goes to
// results.json, which is the machine-readable version (and what feeds the "chequeos" of the
// known-combinations database).

const { QP_FLOOR } = require('./daemonLog');

const f = (n, d = 1) => (n === null || n === undefined || Number.isNaN(n) ? '–' : String(Math.round(n * 10 ** d) / 10 ** d));
const stat = (s, key = 'mean', d = 1) => (s ? f(s[key], d) : '–');

const MARK = { pass: 'PASS', fail: 'FAIL', unknown: 'not verified', warn: 'WARNING' };

function workloadRow(w) {
  if (!w.ok) return `| ${w.instance} | ${w.type} | **failed** | ${w.error || ''} |`;
  if (w.type === 'encode') {
    return `| ${w.instance} | encode | ${w.size} ${w.codec} | asked ${w.targetMbps} Mbps, delivered **${w.achievedMbps} Mbps**, ${w.fps} fps (${w.frames} frames in ${w.seconds} s) |`;
  }
  if (w.type === 'decode') {
    return `| ${w.instance} | decode | ${w.decoder === 'hw' ? 'hardware' : 'software'} ${w.codec} ${w.size || ''} | **${w.fps} fps** flat out (min ${f(w.fpsMin)}, max ${f(w.fpsMax)}, ${w.runs} run(s)), clip ${w.clip} |`;
  }
  return `| ${w.instance} | ${w.type} | | ${w.note || ''} |`;
}

function render(r) {
  const s = r.sampler || {};
  const g = s.gpu || {};
  const lines = [];
  const warnings = r.checks.filter((c) => c.verdict === 'warn').length;
  lines.push(`# Scenario \`${r.scenario.id}\` — ${MARK[r.verdict] || r.verdict}${warnings ? ` (${warnings} warning${warnings > 1 ? 's' : ''})` : ''}`);
  lines.push('');
  if (r.scenario.description) lines.push(r.scenario.description, '');
  lines.push(`- **Host:** ${r.host.name} — ${r.host.gpu || 'GPU unknown'}, kernel ${r.host.kernel || '?'}`);
  lines.push(`- **Run:** ${r.runId}, ${r.startedAt}, redroid-forge ${r.forgeVersion || '?'}${r.commit ? ` (${r.commit})` : ''}`);
  lines.push(`- **Duration:** ${r.scenario.durationS} s of load after ${r.scenario.warmupS ?? 0} s of warm-up, over ${r.instances.length} instance(s) (${r.sampler ? s.samples : 0} samples)`);
  lines.push('');

  lines.push('## Instances', '', '| name | modules | screen | boot | restarts |', '|---|---|---|---|---|');
  for (const i of r.instances) {
    const d = i.display || {};
    lines.push(`| ${i.name} | ${(i.modules || []).join(', ') || '(none)'} | ${d.width}×${d.height} @ ${d.fps} fps | ${i.bootS ?? '–'} s | ${i.restartsDuring ?? 0} |`);
  }

  lines.push('', '## Workloads', '', '| instance | load | what | result |', '|---|---|---|---|');
  for (const w of r.workloads) lines.push(workloadRow(w));

  lines.push('', '## Host while it ran', '', '| metric | mean | p95 | max |', '|---|---|---|---|');
  const row = (label, st, d = 1) => lines.push(`| ${label} | ${stat(st, 'mean', d)} | ${stat(st, 'p95', d)} | ${stat(st, 'max', d)} |`);
  row('CPU % (all cores)', s.cpu_pct);
  row('memory used (MB)', s.mem_used_mb, 0);
  row('load average (1 min)', s.load1);
  row('GPU busy %', g.busy);
  row('VRAM (MB)', g.vram_mb, 0);
  row('GPU temperature (°C)', g.temp_c);
  row('GPU power (W)', g.power_w);
  row('shader clock (MHz)', g.sclk_mhz, 0);
  lines.push('', `Video engines powered up: decode (UVD) in ${s.uvd_active_ratio === null || s.uvd_active_ratio === undefined ? '–' : `${Math.round(s.uvd_active_ratio * 100)} %`} of the samples, encode (VCE) in ${s.vce_active_ratio === null || s.vce_active_ratio === undefined ? '–' : `${Math.round(s.vce_active_ratio * 100)} %`}.`);

  if (r.daemon && r.daemon.encode) {
    const e = r.daemon.encode;
    lines.push('', `Encoder (daemon's own report): ${e.meanMbps} Mbps on average over ${e.windows} window(s) of 5 s, last QP ${e.lastQp}, at the quality floor (QP ${QP_FLOOR}) in ${Math.round(e.atFloorRatio * 100)} % of them.`);
  }

  const conts = Object.entries(s.containers || {});
  if (conts.length) {
    lines.push('', '### Per instance', '', '| container | CPU (cores) mean / max | memory (MB) mean |', '|---|---|---|');
    for (const [name, c] of conts) lines.push(`| ${name} | ${stat(c.cpu_cores, 'mean', 2)} / ${stat(c.cpu_cores, 'max', 2)} | ${stat(c.mem_mb, 'mean', 0)} |`);
  }

  if ((s.kernel_events || []).length) {
    lines.push('', '### Kernel events', '');
    for (const e of s.kernel_events.slice(0, 10)) lines.push(`- t=${e.t} s: \`${e.kernel}\``);
  }

  lines.push('', '## Checks', '');
  if (!r.checks.length) lines.push('(the scenario declares no criteria)');
  for (const c of r.checks) lines.push(`- **${MARK[c.verdict]}** \`${c.id}\` — ${c.detail}`);
  lines.push('');
  return lines.join('\n');
}

module.exports = { render };

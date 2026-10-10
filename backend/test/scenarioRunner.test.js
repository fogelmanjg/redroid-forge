'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const dir = path.join(__dirname, '..', 'scripts', 'scenarios');
const { validate } = require(path.join(dir, 'lib', 'scenario'));
const { evaluate, verdict } = require(path.join(dir, 'lib', 'criteria'));
const { parseEncodeStats, summarize, QP_FLOOR } = require(path.join(dir, 'lib', 'daemonLog'));
const { compare } = require(path.join(dir, 'lib', 'artifacts'));
const { render } = require(path.join(dir, 'lib', 'report'));
const { q } = require(path.join(dir, 'lib', 'host'));

const base = () => ({
  id: 'x', durationS: 30, instances: [{ name: 'a', modules: ['hwenc'], workloads: [{ type: 'idle' }] }],
});

// ---- scenario validation ----

test('every scenario file that ships is valid', () => {
  const files = fs.readdirSync(path.join(dir, 'scenarios')).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 4);
  for (const f of files) assert.doesNotThrow(() => validate(JSON.parse(fs.readFileSync(path.join(dir, 'scenarios', f), 'utf-8'))), f);
});

test('validate: fills the defaults and does not mutate the input', () => {
  const raw = base();
  const sc = validate(raw);
  assert.strictEqual(sc.warmupS, 5);
  assert.strictEqual(sc.staggerS, 4);
  assert.deepStrictEqual(sc.criteria, {});
  assert.strictEqual(raw.warmupS, undefined);
});

test('validate: reports EVERY problem at once', () => {
  const bad = { id: 'Bad ID', durationS: 1, instances: [{ name: 'A!', modules: ['magisk'], workloads: [{ type: 'nope' }] }] };
  assert.throws(() => validate(bad), (e) => /"id"/.test(e.message) && /durationS/.test(e.message) && /name/.test(e.message)
    && /modules/.test(e.message) && /type must be one of/.test(e.message));
});

test('validate: the hardware decoder needs the hwenc module; names are unique; 1 to 12 instances', () => {
  const noHw = base();
  noHw.instances[0].modules = [];
  noHw.instances[0].workloads = [{ type: 'decode', decoder: 'hw' }];
  assert.throws(() => validate(noHw), /only exists in an instance with the "hwenc" module/);
  noHw.instances[0].workloads = [{ type: 'decode', decoder: 'sw' }];
  assert.doesNotThrow(() => validate(noHw));
  const dup = base();
  dup.instances.push({ name: 'a' });
  assert.throws(() => validate(dup), /repeated/);
  const none = base();
  none.instances = [];
  assert.throws(() => validate(none), /1 to 12/);
  const many = base();
  many.instances = Array.from({ length: 13 }, (_, i) => ({ name: `i${i}` }));
  assert.throws(() => validate(many), /1 to 12/);
});

// ---- the daemon's report ----

test('parseEncodeStats reads the lines of the daemon, with or without the log prefix', () => {
  const t = '[hwAccel] encode-stats: 2.97 Mbps over 5.0 s (153 frames, target 0.00 Mbps, last qp 26)\nnoise\n'
    + 'encode-stats: 7.50 Mbps over 5.0 s (150 frames, target 8.00 Mbps, last qp 17)';
  assert.deepStrictEqual(parseEncodeStats(t), [
    { mbps: 2.97, seconds: 5, frames: 153, targetMbps: 0, qp: 26 },
    { mbps: 7.5, seconds: 5, frames: 150, targetMbps: 8, qp: 17 },
  ]);
  assert.deepStrictEqual(parseEncodeStats(''), []);
  assert.strictEqual(summarize([]), null);
});

test('summarize: tells whether the component asked for a bitrate and how much of the time the encoder was at its floor', () => {
  const s = summarize(parseEncodeStats(
    `encode-stats: 3.00 Mbps over 5.0 s (150 frames, target 8.00 Mbps, last qp ${QP_FLOOR})\n`
    + `encode-stats: 3.00 Mbps over 5.0 s (150 frames, target 8.00 Mbps, last qp ${QP_FLOOR + 1})\n`
    + 'encode-stats: 5.00 Mbps over 5.0 s (150 frames, target 8.00 Mbps, last qp 22)',
  ));
  assert.strictEqual(s.requestedMbps, 8);
  assert.strictEqual(s.atFloorRatio, 0.67);
  assert.strictEqual(s.lastQp, 22);
});

// ---- criteria ----

const enc = (over = {}) => ({ instance: 'a', type: 'encode', ok: true, targetMbps: 8, achievedMbps: 7.5, fps: 30, decodesCleanly: true, ...over });
const ev = (workload, daemon, criteria = { encode: { bitrateTolerance: 0.35 } }) => evaluate({ criteria, workloads: [workload], daemon });
const find = (checks, id) => checks.find((c) => c.id === id);

test('encode: within tolerance passes; exceeding the target fails', () => {
  assert.strictEqual(find(ev(enc()), 'a/encode.bitrate').verdict, 'pass');
  assert.strictEqual(find(ev(enc({ achievedMbps: 12 })), 'a/encode.bitrate').verdict, 'fail');
});

test('encode: below the target it is judged with the daemon evidence -- floor passes, no floor fails, no evidence is unknown', () => {
  const low = enc({ achievedMbps: 2.9 });
  const atFloor = { encode: { requestedMbps: 8, atFloorRatio: 1, lastQp: QP_FLOOR } };
  const steering = { encode: { requestedMbps: 8, atFloorRatio: 0, lastQp: 26 } };
  assert.strictEqual(find(ev(low, atFloor), 'a/encode.bitrate').verdict, 'pass');
  assert.match(find(ev(low, atFloor), 'a/encode.bitrate').detail, /quality floor/);
  assert.strictEqual(find(ev(low, steering), 'a/encode.bitrate').verdict, 'fail');
  assert.strictEqual(find(ev(low, null), 'a/encode.bitrate').verdict, 'unknown');
});

test('encode: if the daemon received no bitrate (an older component) it says that, not "content too simple"', () => {
  const none = { encode: { requestedMbps: 0, atFloorRatio: 0, lastQp: 26 } };
  const c = find(ev(enc({ achievedMbps: 2.9 }), none), 'a/encode.bitrate');
  assert.strictEqual(c.verdict, 'fail');
  assert.match(c.detail, /NO bitrate.*older than the rate control/s);
});

test('a workload that failed is a failed check, and "unknown" never counts as a pass', () => {
  const r = evaluate({ criteria: {}, workloads: [{ instance: 'a', type: 'decode', ok: false, error: 'boom' }] });
  assert.strictEqual(find(r, 'a/decode.ran').verdict, 'fail');
  assert.strictEqual(verdict(r), 'fail');
  assert.strictEqual(verdict([{ verdict: 'unknown' }]), 'unknown');
  assert.strictEqual(verdict([]), 'unknown');
  assert.strictEqual(verdict([{ verdict: 'pass' }, { verdict: 'unknown' }]), 'pass');
  assert.strictEqual(verdict([{ verdict: 'pass' }, { verdict: 'warn' }]), 'pass', 'a warning does not fail the run');
  assert.strictEqual(verdict([{ verdict: 'warn' }]), 'unknown', 'a warning alone proves nothing');
  assert.strictEqual(verdict([{ verdict: 'fail' }, { verdict: 'warn' }]), 'fail');
});

test('noRestarts, noKernelErrors (unknown when the kernel log cannot be read) and videoEngines', () => {
  const crit = { noRestarts: true, noKernelErrors: true, videoEngines: ['uvd', 'vce'] };
  const r = evaluate({
    criteria: crit,
    instances: [{ name: 'a', restartsDuring: 1, status: 'running' }],
    sampler: { capabilities: { kmsg: false }, uvd_active_ratio: 0.8, vce_active_ratio: null },
  });
  assert.strictEqual(find(r, 'noRestarts').verdict, 'fail');
  assert.strictEqual(find(r, 'noKernelErrors').verdict, 'unknown');
  assert.strictEqual(find(r, 'uvdActive').verdict, 'pass');
  assert.strictEqual(find(r, 'vceActive').verdict, 'unknown');
  const withErr = evaluate({ criteria: { noKernelErrors: true }, sampler: { capabilities: { kmsg: true }, kernel_events: [{ t: 3, kernel: 'ring vce0 timeout' }] } });
  assert.strictEqual(find(withErr, 'noKernelErrors').verdict, 'fail');
  assert.match(find(withErr, 'noKernelErrors').detail, /ring vce0 timeout/);
});

test('decode: the frames per second against the minimum', () => {
  const w = { instance: 'a', type: 'decode', ok: true, decoder: 'hw', fps: 150 };
  assert.strictEqual(find(evaluate({ criteria: { decode: { minFps: 60 } }, workloads: [w] }), 'a/decode.fps').verdict, 'pass');
  assert.strictEqual(find(evaluate({ criteria: { decode: { minFps: 200 } }, workloads: [w] }), 'a/decode.fps').verdict, 'fail');
});

// ---- stale artifacts ----

test('artifacts: built before the last change to the component is a WARNING (not a failure), after is a pass, unreadable is unknown', () => {
  assert.strictEqual(compare({ builtAt: 100, sourceAt: 200, sourceCommit: 'abc' }).verdict, 'warn');
  assert.match(compare({ builtAt: 100, sourceAt: 200, sourceCommit: 'abc' }).detail, /BEFORE the last change.*abc/s);
  assert.strictEqual(compare({ builtAt: 300, sourceAt: 200 }).verdict, 'pass');
  assert.strictEqual(compare({ builtAt: null, sourceAt: 200 }).verdict, 'unknown');
  assert.strictEqual(compare({ builtAt: 300, sourceAt: null }).verdict, 'unknown');
});

// ---- the report ----

test('render: a report that shows the verdict, the loads, the host and each check', () => {
  const md = render({
    runId: 'r1', startedAt: '2026-10-10T00:00:00Z', commit: 'abc1234', forgeVersion: '0.1.0',
    scenario: { id: 'encode-solo', description: 'desc', durationS: 30, warmupS: 5 },
    host: { name: 'h', gpu: 'AMD X', kernel: '6.12' },
    instances: [{ name: 'a', modules: ['hwenc'], display: { width: 1280, height: 720, fps: 30 }, bootS: 10, restartsDuring: 0 }],
    workloads: [enc({ size: '1280x720', codec: 'h264', frames: 900, seconds: 30 }), { instance: 'a', type: 'decode', ok: false, error: 'no frames' }],
    sampler: { samples: 31, cpu_pct: { mean: 9.1, p95: 13, max: 28 }, gpu: { busy: { mean: 14, p95: 81, max: 86 } }, uvd_active_ratio: 0, vce_active_ratio: 0.76, containers: {}, kernel_events: [] },
    daemon: { encode: { meanMbps: 2.9, windows: 6, lastQp: 26, atFloorRatio: 0, requestedMbps: 2.49 } },
    checks: [{ id: 'noRestarts', verdict: 'pass', detail: 'fine' }, { id: 'x', verdict: 'fail', detail: 'bad' }, { id: 'w', verdict: 'warn', detail: 'careful' }],
    verdict: 'fail',
  });
  assert.match(md, /# Scenario `encode-solo` — FAIL \(1 warning\)/);
  assert.match(md, /\*\*WARNING\*\* `w` — careful/);
  assert.match(md, /delivered \*\*7\.5 Mbps\*\*/);
  assert.match(md, /\*\*failed\*\* \| no frames/);
  assert.match(md, /encode \(VCE\) in 76 %/);
  assert.match(md, /last QP 26/);
  assert.match(md, /target of 2\.49 Mbps as it reached the daemon/);
  assert.match(md, /\*\*PASS\*\* `noRestarts`/);
  assert.match(md, /\*\*FAIL\*\* `x` — bad/);
});

// ---- helpers ----

test('q quotes for the shell, including a quote inside', () => {
  assert.strictEqual(q("it's"), `'it'\\''s'`);
  assert.strictEqual(execFileSync('sh', ['-c', `printf %s ${q("a b'c\"d$e")}`], { encoding: 'utf-8' }), "a b'c\"d$e");
});

test('the sampler starts, samples, and writes its summary (python3 standard library only)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sampler-'));
  try {
    execFileSync('python3', [path.join(dir, 'lib', 'sampler.py'), '--out', path.join(tmp, 's.jsonl'), '--summary', path.join(tmp, 's.json'), '--interval', '0.5', '--duration', '1.5']);
    const sum = JSON.parse(fs.readFileSync(path.join(tmp, 's.json'), 'utf-8'));
    assert.ok(sum.samples >= 2);
    assert.ok(sum.cpu_pct && typeof sum.cpu_pct.mean === 'number');
    assert.ok('capabilities' in sum && 'kernel_events' in sum && 'uvd_active_ratio' in sum);
    const lines = fs.readFileSync(path.join(tmp, 's.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(lines.every((l) => 't' in l));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('hwdec_mediacodec_test: the result line of the older (Spanish) and the newer (English) binaries are both read', () => {
  const { parseDecodeResult } = require(path.join(dir, 'lib', 'toolOutput'));
  assert.deepStrictEqual(parseDecodeResult('RESULTADO: OMX.google.h264.decoder video/avc -> 300 frames en 3.19 s (94.2 fps)'),
    { decoder: 'OMX.google.h264.decoder', mime: 'video/avc', frames: 300, seconds: 3.19, fps: 94.2 });
  assert.strictEqual(parseDecodeResult('RESULT: c2.hardware.decoder.h264 video/avc -> 300 frames in 1.9 s (158.1 fps)').fps, 158.1);
  assert.strictEqual(parseDecodeResult('RESULT: start failed: the decoder could not start'), null);
  assert.strictEqual(parseDecodeResult(undefined), null);
});

test('artifacts: a scenario that only decodes is not judged against the encoder source, and vice versa', () => {
  const { sourcesFor } = require(path.join(dir, 'lib', 'artifacts'));
  assert.ok(sourcesFor(['decode']).some((p) => /VaapiDec/.test(p)));
  assert.ok(!sourcesFor(['decode']).some((p) => /VaapiEnc/.test(p)));
  assert.ok(sourcesFor(['encode']).some((p) => /VaapiEnc/.test(p)));
  assert.ok(!sourcesFor(['encode']).some((p) => /VaapiDec/.test(p)));
  assert.ok(sourcesFor(['idle']).every((p) => /service/.test(p)), 'an idle scenario depends only on the common service');
});

test('IsolatedForge: the method that reads the daemon log is not hidden by the logging callback stored in the instance', () => {
  // Regression: the constructor stores the runner's logger in `this.log`; a METHOD with that name was shadowed
  // by it, returned undefined, and made the daemon's report look empty without any error.
  const { IsolatedForge } = require(path.join(dir, 'lib', 'forge'));
  const f = new IsolatedForge({ ssh: 'x' }, { runId: 't', log: () => {} });
  assert.strictEqual(typeof f.daemonLog, 'function', 'daemonLog is a method of the prototype');
  assert.ok(Object.getOwnPropertyNames(Object.getPrototypeOf(f)).includes('daemonLog'));
  for (const method of Object.getOwnPropertyNames(IsolatedForge.prototype).filter((m) => m !== 'constructor')) {
    assert.ok(!Object.prototype.hasOwnProperty.call(f, method), `the instance property "${method}" would hide the method of the same name`);
  }
});

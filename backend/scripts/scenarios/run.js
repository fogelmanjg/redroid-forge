#!/usr/bin/env node
'use strict';

// Scenario runner: puts a known load on instances of a host and measures what it costs and what the
// instances deliver (docs/SCENARIOS.md). It runs on ONE machine (where you invoke it) and drives the host
// under test over ssh; nothing is installed on the host except what a run creates and removes again.
//
//   node backend/scripts/scenarios/run.js <scenario.json | name> --host <ssh-target>
//        [--root-cmd "sudo -n"] [--hwenc-artifacts <dir on the host>] [--decode-tool <local path>]
//        [--accept-contracts] [--out <dir>] [--keep] [--dry-run]
//
// The options can also be given in ~/.config/redroid-forge/scenarios.json:
//   { "host": "...", "rootCmd": "...", "hwencArtifacts": "...", "decodeTool": "..." }
//
// --accept-contracts: the modules the scenario uses (hwenc, gapps) have a contract that is normally accepted
//   by a person in the UI; this accepts it through the API, for the isolated forge of this run. Use it only if
//   you have read it.
// --keep: do not remove the forge, the instances and the directory of the run at the end (to look around).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Host, q } = require('./lib/host');
const { IsolatedForge, REPO_ROOT } = require('./lib/forge');
const { Instance } = require('./lib/instance');
const { Assets } = require('./lib/assets');
const { WORKLOADS } = require('./lib/workloads');
const { validate } = require('./lib/scenario');
const { evaluate, verdict } = require('./lib/criteria');
const { render } = require('./lib/report');
const { parseEncodeStats, summarize } = require('./lib/daemonLog');
const { artifactsCheck } = require('./lib/artifacts');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.error(`[scenario ${new Date().toTimeString().slice(0, 8)}] ${m}`);

function parseArgs(argv) {
  const opts = { flags: new Set() };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (['--accept-contracts', '--keep', '--dry-run'].includes(a)) opts.flags.add(a.slice(2));
    else if (a.startsWith('--')) opts[a.slice(2)] = argv[++i];
    else rest.push(a);
  }
  opts.scenario = rest[0];
  return opts;
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config', 'redroid-forge', 'scenarios.json'), 'utf-8')); } catch { return {}; }
}

function loadScenario(arg) {
  if (!arg) throw new Error('usage: run.js <scenario.json | name> --host <ssh-target>');
  const file = fs.existsSync(arg) ? arg : path.join(__dirname, 'scenarios', arg.endsWith('.json') ? arg : `${arg}.json`);
  if (!fs.existsSync(file)) throw new Error(`scenario not found: ${arg}`);
  return validate(JSON.parse(fs.readFileSync(file, 'utf-8')));
}

async function hostInfo(host, forge) {
  const gpu = (await host.run(`lspci -nn | grep -iE 'VGA|3D controller|Display controller' | head -1 | sed 's/^[^ ]* //'`)).stdout.trim();
  const kernel = (await host.run('uname -r')).stdout.trim();
  const m = await forge.api('GET', '/modules/hwenc');
  return { name: host.ssh, gpu, kernel, gpuVendor: m.json ? m.json.hostGpuVendor : null };
}

// The folder with the ARM translation files (see docs/SCENARIOS.md): `armDir` of the config, or the one the module itself uses.
function armDirOf(cfg) {
  const dir = cfg.armDir || process.env.REDROID_FORGE_ARM_DIR || path.join(REPO_ROOT, 'backend', 'data', 'arm-translation');
  if (!fs.existsSync(path.join(dir, 'package.json'))) {
    throw new Error(`the scenario uses the "arm-translation" module but ${dir} has no files: extract them with backend/scripts/sdk-extract.js, or point to them with armDir`);
  }
  return dir;
}

function usesModule(scenario, id) {
  return scenario.instances.some((i) => i.modules.includes(id));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cfg = { ...loadConfig() };
  for (const k of ['host', 'rootCmd', 'hwencArtifacts', 'decodeTool', 'armDir']) {
    const cli = { rootCmd: 'root-cmd', hwencArtifacts: 'hwenc-artifacts', decodeTool: 'decode-tool', armDir: 'arm-dir' }[k] || k;
    if (opts[cli] !== undefined) cfg[k] = opts[cli];
  }
  const scenario = loadScenario(opts.scenario);
  if (opts.flags.has('dry-run')) {
    console.log(`scenario "${scenario.id}" is valid: ${scenario.instances.length} instance(s), ${scenario.durationS} s of load`);
    return 0;
  }
  if (!cfg.host) throw new Error('--host <ssh-target> is required (or "host" in ~/.config/redroid-forge/scenarios.json)');

  const host = new Host({ ssh: cfg.host, rootCmd: cfg.rootCmd === undefined ? 'sudo -n' : cfg.rootCmd, log });
  const forge = new IsolatedForge(host, { hwencArtifacts: cfg.hwencArtifacts, armDir: usesModule(scenario, 'arm-translation') ? armDirOf(cfg) : null, log });
  const assets = new Assets(host, { decodeTool: cfg.decodeTool, log });
  const startedAt = new Date().toISOString();
  const outDir = path.resolve(opts.out || path.join(REPO_ROOT, 'scenario-results', `${forge.runId}-${scenario.id}`));
  fs.mkdirSync(outDir, { recursive: true });

  let interrupted = false;
  const onSignal = () => { interrupted = true; log('interrupted: cleaning up'); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  let exitCode = 1;
  try {
    await assets.init();
    await forge.start();
    const info = await hostInfo(host, forge);

    // Contracts of the modules this scenario uses.
    const modules = [...new Set(scenario.instances.flatMap((i) => i.modules))];
    for (const m of modules) {
      const st = await forge.api('GET', `/modules/${m}`);
      if (st.json && st.json.hostCompatible === false) throw new Error(`the module ${m} cannot run on this host: ${st.json.hostIncompatibilityReason}`);
      if (st.json && !st.json.accepted) {
        if (!opts.flags.has('accept-contracts')) throw new Error(`the contract of "${m}" is not accepted: read it in the UI, or pass --accept-contracts to accept it for this run`);
        await forge.acceptContract(m);
      }
    }

    // Instances: created one after another with a pause, booting while the next one is created.
    const tag = `scn${forge.runId.slice(-4)}`;
    const instances = [];
    const boots = [];
    for (const spec of scenario.instances) {
      if (interrupted) throw new Error('interrupted');
      const rec = await forge.createInstance({
        name: `${tag}-${spec.name}`, imageId: 'android-15-official', modules: spec.modules,
        width: spec.width, height: spec.height, dpi: spec.dpi, fps: spec.fps,
      });
      const inst = new Instance(host, rec);
      inst.spec = spec;
      instances.push(inst);
      log(`created ${inst.name} (slot ${rec.binderSlot}, adb ${rec.adbPort})`);
      boots.push(inst.waitBoot().then((s) => { inst.bootS = s; }));
      if (scenario.staggerS) await sleep(scenario.staggerS * 1000);
    }
    await Promise.all(boots);
    for (const inst of instances) inst.restartsAtStart = (await inst.restartCount()).restarts;
    log(`all ${instances.length} instance(s) booted; warm-up ${scenario.warmupS} s`);
    await sleep(scenario.warmupS * 1000);

    // Sampler on the host, then the loads, all at the same time.
    const work = `${forge.home}/${forge.dir}/scn`;
    await host.run(`mkdir -p ${q(work)}`, { check: true });
    await host.putFile(path.join(__dirname, 'lib', 'sampler.py'), `${work}/sampler.py`);
    const names = instances.map((i) => i.container).join(',');
    await host.root(`cd ${q(work)}; setsid nohup python3 sampler.py --out samples.jsonl --summary summary.json --containers ${q(names)} >sampler.log 2>&1 < /dev/null & echo $! > ${q(work)}/sampler.pid`);
    await sleep(1500);

    log(`measuring for ${scenario.durationS} s`);
    const results = await Promise.all(instances.flatMap((inst) => inst.spec.workloads.map(async (spec) => {
      try {
        const r = await WORKLOADS[spec.type]({
          host, inst, spec, assets, durationS: scenario.durationS, work, log,
        });
        return { instance: inst.spec.name, ...r };
      } catch (e) {
        return { instance: inst.spec.name, type: spec.type, ok: false, error: e.message };
      }
    })));
    // A scenario with no workloads still measures the idle cost for its duration.
    if (!results.length) await sleep(scenario.durationS * 1000);

    await host.root(`kill -TERM $(cat ${q(work)}/sampler.pid)`);
    for (let i = 0; i < 20; i++) {
      if ((await host.run(`test -s ${q(work)}/summary.json && echo yes`)).stdout.trim() === 'yes') break;
      await sleep(1000);
    }
    let sampler = null;
    try {
      await host.getFile(`${work}/summary.json`, path.join(outDir, 'sampler-summary.json'));
      await host.getFile(`${work}/samples.jsonl`, path.join(outDir, 'samples.jsonl'));
      sampler = JSON.parse(fs.readFileSync(path.join(outDir, 'sampler-summary.json'), 'utf-8'));
    } catch (e) { log(`the sampler data could not be collected: ${e.message}`); }

    const instReport = [];
    for (const inst of instances) {
      const now = await inst.restartCount();
      instReport.push({
        name: inst.spec.name, modules: inst.spec.modules, display: inst.record.display, bootS: inst.bootS,
        restartsDuring: now.restarts - inst.restartsAtStart, status: now.status,
      });
    }
    const encodeStats = parseEncodeStats(await forge.daemonLog());
    const daemon = { encode: summarize(encodeStats), encodeWindows: encodeStats };
    const checks = evaluate({ criteria: scenario.criteria, instances: instReport, workloads: results, sampler, daemon });
    if (modules.includes('hwenc') && cfg.hwencArtifacts) {
      const kinds = [...new Set(scenario.instances.flatMap((i) => i.workloads.map((w) => w.type)))];
      const art = await artifactsCheck(host, cfg.hwencArtifacts, REPO_ROOT, kinds);
      if (art) checks.push(art);
    }
    let commit = null;
    try { commit = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf-8' }).trim(); } catch { /* not a git checkout */ }
    const report = {
      runId: forge.runId, startedAt, scenario, host: info, commit, forgeVersion: require('../../package.json').version,
      instances: instReport, workloads: results, sampler, daemon, checks, verdict: verdict(checks),
    };
    fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(outDir, 'report.md'), render(report));
    console.log(render(report));
    log(`results in ${outDir}`);
    exitCode = report.verdict === 'fail' ? 2 : 0;
  } finally {
    if (opts.flags.has('keep')) log(`--keep: ${forge.name} and ~/${forge.dir} stay on ${host.ssh}; remove them by hand when done`);
    else await forge.cleanup().catch((e) => log(`cleanup problem: ${e.message}`));
  }
  return exitCode;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (e) => { console.error(`ERROR: ${e.message}`); process.exit(1); });
}

module.exports = { parseArgs, loadScenario };

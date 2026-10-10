'use strict';

// An isolated redroid-forge on the machine under test, created for ONE run of the runner and removed at
// its end. It runs the code of THIS checkout (it is synced to the host), with its own data directory, its
// own port and its own range of adb ports, so it neither disturbs nor depends on whatever else runs there
// -- including the forge that may already be installed, or another session testing at the same time.
//
// Every name carries the run id (forge-scn-<id>, ~/rf-scn-<id>) and the run NEVER removes anything it did
// not create itself: if a name already exists, it stops.

const path = require('path');
const { q } = require('./host');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

function newRunId() {
  const t = new Date().toISOString().replace(/[-:T]/g, '').slice(2, 12); // yymmddhhmm
  return `${t}-${Math.random().toString(36).slice(2, 6)}`;
}

class IsolatedForge {
  constructor(host, {
    runId = newRunId(), image = null, hwencArtifacts, log = () => {},
  } = {}) {
    this.host = host;
    this.runId = runId;
    // `image`: use an image that already exists. By default the image is BUILT from this checkout: the VA-API
    // daemon is native code compiled when the image is built, so an older image would measure an older daemon.
    this.image = image;
    this.builtImage = null;
    this.hwencArtifacts = hwencArtifacts;
    this.log = log;
    this.name = `forge-scn-${runId}`;
    this.dir = `rf-scn-${runId}`;       // relative to the home of the host's user
    this.port = null;
    this.adbRange = null;
    this.created = false;
    this.home = null;
  }

  async start() {
    const { host } = this;
    // The name must be free: this run only ever touches what it created.
    const clash = await host.run(`docker ps -a --format '{{.Names}}' | grep -x ${q(this.name)}`);
    if (clash.stdout.trim()) throw new Error(`the container ${this.name} already exists: refusing to touch it`);

    // A free port and a free range of adb ports (the host may be running other things).
    const used = (await host.run(`ss -ltn | awk 'NR>1{n=split($4,a,":"); print a[n]}' | sort -un`)).stdout.split('\n').map(Number);
    const free = (p) => !used.includes(p);
    let base = 8100 + Math.floor(Math.random() * 50);
    while (!free(base)) base += 1;
    let adbStart = 5600 + Math.floor(Math.random() * 20) * 20;
    while (Array.from({ length: 20 }, (_, i) => adbStart + i).some((p) => !free(p))) adbStart += 20;
    this.port = base;
    this.adbRange = [adbStart, adbStart + 19];

    this.log(`syncing the checkout to ~/${this.dir} on ${host.ssh}`);
    await host.run(`mkdir -p ~/${this.dir}/backend/data`, { check: true });
    await host.rsyncTo(REPO_ROOT, `${this.dir}`, ['node_modules', '.git', 'backend/data', 'scenario-results']);

    if (!this.image) {
      this.builtImage = `redroid-forge-scn:${this.runId}`;
      this.log(`building the image of this checkout on ${host.ssh} (the first time it can take several minutes; later ones reuse the cached layers)`);
      const t0 = Date.now();
      await host.run(`cd ~/${this.dir} && docker build -q --build-arg HWDEC=1 -t ${q(this.builtImage)} .`, { check: true, timeoutMs: 40 * 60 * 1000 });
      this.image = this.builtImage;
      this.log(`image built in ${Math.round((Date.now() - t0) / 1000)} s`);
    }

    const art = this.hwencArtifacts;
    const hwencArgs = art ? `-e REDROID_HWENC_ARTIFACTS_DIR=${q(art)} -v ${q(art)}:${q(art)}:ro` : '';
    const home = (await host.run('echo $HOME', { check: true })).stdout.trim();
    this.home = home;
    // Only the data directory is mounted: the code (and the daemon) are the ones inside the image.
    const mounts = `-v ${home}/${this.dir}/backend/data:/app/backend/data`;
    const cmd = `docker run -d --name ${this.name} --privileged --pid=host --network=host `
      + `-e PORT=${this.port} -e ADB_PORT_START=${this.adbRange[0]} -e ADB_PORT_END=${this.adbRange[1]} `
      + `-e REDROID_FORGE_HWDEC_DOWNLOAD=derive-sse -e REDROID_FORGE_ENCODE_STATS=1 ${hwencArgs} `
      + `-v /dev/binderfs:/dev/binderfs -v /lib/modules:/lib/modules -v /var/run/docker.sock:/var/run/docker.sock `
      + `-v /dev/vaapi-helper:/dev/vaapi-helper ${mounts} ${this.image}`;
    await host.run(cmd, { check: true });
    this.created = true;

    for (let i = 0; i < 40; i++) {
      const r = await host.api(this.port, 'GET', '/images');
      if (r.status === 200) { this.log(`forge up on ${host.ssh}:${this.port} (adb ${this.adbRange.join('-')})`); return; }
      await new Promise((res) => setTimeout(res, 500));
    }
    throw new Error(`${this.name} did not answer on :${this.port}`);
  }

  api(method, p, body) { return this.host.api(this.port, method, p, body); }

  // Accepts the contract of a module through the API (what the UI does when the user ticks the box).
  // Only for test runs: the person running the scenario takes that decision with --accept-contracts.
  async acceptContract(moduleId) {
    const m = await this.api('GET', `/modules/${moduleId}`);
    if (m.status !== 200) throw new Error(`module ${moduleId}: HTTP ${m.status}`);
    if (m.json.accepted) return;
    const r = await this.api('POST', `/modules/${moduleId}/accept`, { version: m.json.version, instanceName: `scenario-${this.runId}` });
    if (r.status !== 201) throw new Error(`could not accept the contract of ${moduleId}: HTTP ${r.status}`);
  }

  // What the forge (and the VA-API daemon it supervises) printed so far.
  async log() {
    const r = await this.host.run(`docker logs ${q(this.name)} 2>&1 | tail -n 4000`);
    return r.stdout;
  }

  async createInstance(spec) {
    const r = await this.api('POST', '/instances', spec);
    if (r.status !== 201) throw new Error(`creating ${spec.name}: HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
    return r.json;
  }

  async instances() {
    const r = await this.api('GET', '/instances');
    return r.json || [];
  }

  // Removes what this run created, in order: its instances (through the API, so the registry stays
  // consistent), its forge, its directory. Safe to call twice.
  async cleanup() {
    if (!this.created) return;
    for (const inst of await this.instances().catch(() => [])) {
      await this.api('DELETE', `/instances/${inst.id}`).catch(() => {});
    }
    await this.host.run(`docker rm -f ${q(this.name)}`);
    // The data directory is root-owned: the forge ran as root in its container.
    await this.host.root(`rm -rf ${q(`${this.home}/${this.dir}`)}`);
    // The image this run built (its layers stay in the build cache, which is what makes the next run fast).
    if (this.builtImage) await this.host.run(`docker rmi ${q(this.builtImage)}`);
    this.created = false;
    this.log(`cleaned up ${this.name} and ~/${this.dir}`);
  }
}

module.exports = { IsolatedForge, newRunId, REPO_ROOT };

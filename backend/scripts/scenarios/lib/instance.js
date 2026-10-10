'use strict';

const { q } = require('./host');

// One running instance of the run, seen from the runner: its container on the host, with the few things
// the workloads need (run a command inside, copy files in and out, know if it restarted).
class Instance {
  constructor(host, record) {
    this.host = host;
    this.record = record;                       // what the forge API returned when creating it
    this.name = record.name;
    this.container = `redroid-${record.name}`;  // how forge names the container
    this.restartsAtStart = null;
  }

  async exec(cmd, opts) {
    return this.host.run(`docker exec ${this.container} sh -c ${q(cmd)}`, opts);
  }

  async waitBoot(timeoutS = 150) {
    const t0 = Date.now();
    while ((Date.now() - t0) / 1000 < timeoutS) {
      const r = await this.exec('getprop sys.boot_completed');
      if (r.stdout.trim() === '1') return Math.round((Date.now() - t0) / 1000);
      await new Promise((res) => setTimeout(res, 2000));
    }
    throw new Error(`${this.name} did not finish booting in ${timeoutS} s`);
  }

  async restartCount() {
    const r = await this.host.run(`docker inspect -f '{{.RestartCount}} {{.State.Status}}' ${this.container}`);
    const [n, status] = r.stdout.trim().split(' ');
    return { restarts: Number(n), status };
  }

  async copyIn(hostPath, instancePath) {
    await this.host.run(`docker cp ${q(hostPath)} ${this.container}:${q(instancePath)}`, { check: true });
  }

  async copyOut(instancePath, hostPath) {
    await this.host.run(`docker cp ${this.container}:${q(instancePath)} ${q(hostPath)}`, { check: true });
  }

  // Something with movement on the screen, so that an encoder has something to encode (a still screen
  // makes any encoder look good): the Settings list scrolled up and down, forever, until stopMotion().
  async startMotion() {
    await this.exec('am start -a android.settings.SETTINGS >/dev/null 2>&1');
    await new Promise((res) => setTimeout(res, 3000));
    const w = this.record.display ? this.record.display.width : 720;
    const h = this.record.display ? this.record.display.height : 1280;
    const x = Math.round(w / 2);
    const [y1, y2] = [Math.round(h * 0.75), Math.round(h * 0.25)];
    const loop = `while true; do input swipe ${x} ${y1} ${x} ${y2} 350; input swipe ${x} ${y2} ${x} ${y1} 350; done`;
    // The loop gets a marker in its own file so it can be stopped without pgrep/pkill -f, which would match
    // this very shell (the container shares the host's pid space in some setups).
    await this.exec(`sh -c '${loop}' >/dev/null 2>&1 & echo $! > /data/local/tmp/motion.pid`);
  }

  async stopMotion() {
    await this.exec('kill $(cat /data/local/tmp/motion.pid) 2>/dev/null; rm -f /data/local/tmp/motion.pid');
  }
}

module.exports = { Instance };

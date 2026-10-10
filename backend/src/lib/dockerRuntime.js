const Docker = require('dockerode');

// A pure adapter over dockerode — it ports container-runtime.service.ts from
// plenum-redroid, without the rest of its dependencies.
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

async function listLocalImageTags() {
  const images = await docker.listImages();
  const tags = new Set();
  for (const img of images) {
    for (const t of img.RepoTags || []) tags.add(t);
  }
  return tags;
}

// Redroid needs direct access to /dev/binder* (mounted via binds) and, for
// gpuMode=host, to the rest of the host's GPU devices — plenum-redroid solves
// this with Privileged:true instead of listing /dev/dri by hand (see
// instance-orchestrator.service.ts:170), and the same criterion is kept here.
async function create({ name, image, cmd, binds, adbPort, memoryMb }) {
  const container = await docker.createContainer({
    name,
    Image: image,
    Cmd: cmd,
    HostConfig: {
      Privileged: true,
      Binds: binds,
      PortBindings: { '5555/tcp': [{ HostIp: '0.0.0.0', HostPort: String(adbPort) }] },
      RestartPolicy: { Name: 'unless-stopped' },
      ...(memoryMb ? { Memory: memoryMb * 1024 * 1024 } : {}),
    },
    ExposedPorts: { '5555/tcp': {} },
  });
  return container.id;
}

async function start(containerId) {
  try {
    await docker.getContainer(containerId).start();
  } catch (e) {
    if (e.statusCode !== 304) throw e; // 304 = it was already running
  }
}

async function stop(containerId) {
  await docker.getContainer(containerId).stop().catch((e) => {
    if (e.statusCode !== 304) throw e;
  });
}

async function restart(containerId) {
  await docker.getContainer(containerId).restart();
}

async function remove(containerId, { force = false } = {}) {
  const c = docker.getContainer(containerId);
  if (force) await c.stop().catch(() => {});
  await c.remove({ force, v: true });
}

// `docker rm -v` only deletes anonymous volumes — the named ones (like those this
// manager uses, one per instance) have to be deleted separately.
async function removeVolume(name) {
  await docker.getVolume(name).remove().catch((e) => {
    if (e.statusCode !== 404) throw e;
  });
}

async function inspect(containerId) {
  return docker.getContainer(containerId).inspect();
}

async function getPid(containerId) {
  const info = await inspect(containerId);
  return String(info.State.Pid);
}

async function getBridgeIp(containerId) {
  const info = await inspect(containerId);
  return info.NetworkSettings?.Networks?.bridge?.IPAddress;
}

// Equivalent to `docker exec <containerId> <cmd>` but through dockerode instead
// of shelling out to the docker CLI. It rejects if the command ends with an exit
// code != 0, just like the CLI.
async function exec(containerId, cmd, timeoutMs = 15000) {
  const e = await docker.getContainer(containerId).exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await e.start({ hijack: true, stdin: false });
  const out = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`exec timeout after ${timeoutMs}ms`)), timeoutMs);
    stream.on('data', (chunk) => { buf += chunk.toString('utf-8'); });
    stream.on('end', () => { clearTimeout(timer); resolve(buf); });
    stream.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
  const { ExitCode } = await e.inspect();
  if (ExitCode !== 0) {
    throw Object.assign(new Error(`exec "${cmd.join(' ')}" exited with code ${ExitCode}: ${out}`), { exitCode: ExitCode, output: out });
  }
  return out;
}

async function ensureImage(image) {
  const found = await docker.listImages({ filters: { reference: [image] } });
  if (found.length > 0) return;
  await new Promise((resolve, reject) => {
    docker.pull(image, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (err2) => (err2 ? reject(err2) : resolve()));
    });
  });
}

// Reads ALL the output of a container that already finished, as text. It is read as a
// stream (follow: true) on purpose: the non-streaming `container.logs()` goes through
// docker-modem, which JSON-parses the body when it looks like JSON, so an output such as
// 3607632867885909819 came back as the NUMBER 3607632867885909500 (precision lost) and
// {"a":1} as the object "[object Object]". A stream is never parsed.
async function readLogs(container) {
  const stream = await container.logs({ stdout: true, stderr: true, follow: true });
  const chunks = [];
  await new Promise((resolve, reject) => {
    stream.on('data', (d) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d))));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return Buffer.concat(chunks).toString('utf-8');
}

// Runs a single-use container until it finishes and returns its stdout --
// equivalent to `docker run --rm ...` but through dockerode. Tty:true avoids the
// multiplexed binary framing that container.logs() brings for separate
// stdout/stderr, which does not need to be distinguished here.
async function runEphemeral(image, cmd, binds, timeoutMs = 30000) {
  await ensureImage(image);
  const container = await docker.createContainer({
    Image: image,
    Cmd: cmd,
    Tty: true,
    HostConfig: { Binds: binds, AutoRemove: false },
  });
  try {
    await container.start();
    await Promise.race([
      container.wait(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('runEphemeral timeout')), timeoutMs)),
    ]);
    return await readLogs(container);
  } finally {
    await container.remove({ force: true }).catch(() => {});
  }
}

module.exports = {
  docker, listLocalImageTags, create, start, stop, restart, remove, removeVolume,
  inspect, getPid, getBridgeIp, exec, runEphemeral, readLogs,
};

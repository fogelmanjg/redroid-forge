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
async function create({
  name, image, cmd, binds, adbPort, memoryMb, cpusetCpus,
}) {
  const container = await docker.createContainer({
    name,
    Image: image,
    Cmd: cmd,
    HostConfig: {
      Privileged: true,
      Binds: binds,
      PortBindings: { '5555/tcp': [{ HostIp: '0.0.0.0', HostPort: String(adbPort) }] },
      RestartPolicy: { Name: 'unless-stopped' },
      // MemorySwap == Memory (not left to Docker's own default, and not -1/unlimited): a cap
      // with unlimited swap behind it is not really a hard cap -- Android can keep growing
      // past it by swapping instead of ever triggering the cgroup OOM kill, which defeats the
      // point (see updateResources' comment for the Update API's own version of this).
      ...(memoryMb ? { Memory: memoryMb * 1024 * 1024, MemorySwap: memoryMb * 1024 * 1024 } : {}),
      ...(cpusetCpus ? { CpusetCpus: cpusetCpus } : {}),
    },
    ExposedPorts: { '5555/tcp': {} },
  });
  return container.id;
}

// Live update of an already-running (or stopped) container's resource limits -- unlike width/
// height/dpi/fps (RECREATE_FIELDS-style in jg-dashboard, since those are kernel cmdline
// arguments baked in at create time), Docker's own Update API supports changing Memory/
// CpusetCpus on a container that already exists, no stop/recreate needed.
async function updateResources(containerId, { memoryMb, cpusetCpus }) {
  const update = {};
  if (memoryMb) {
    update.Memory = memoryMb * 1024 * 1024;
    // Docker's Update API rejects a new Memory limit on its own if the container's current
    // MemorySwap would end up smaller than it (found for real: a container created with no
    // limit at all gets a 409 "Memory limit should be smaller than already set memoryswap
    // limit" otherwise) -- MemorySwap == Memory means no swap beyond the hard limit, not "no
    // swap at all" (that would be MemorySwap == -1, unlimited, the opposite of what a memory
    // cap is for). Same value both places is also what create() effectively gets by default
    // from Docker when only Memory is given at creation time -- update() just does not infer
    // it the way create() does.
    update.MemorySwap = update.Memory;
  }
  if (cpusetCpus) update.CpusetCpus = cpusetCpus;
  if (Object.keys(update).length === 0) return;
  await docker.getContainer(containerId).update(update);
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

// The real host path backing a named volume (what `docker volume inspect` shows as
// Mountpoint) -- instances use a Docker-managed named volume for /data, not a bind mount
// to a path redroid-forge picks, so this is the only way to answer "where does my data
// actually live" for someone used to choosing a folder themselves. Returns null if the
// volume does not exist (e.g. the instance was never started, or got removed) instead
// of throwing.
async function inspectVolume(name) {
  try {
    return await docker.getVolume(name).inspect();
  } catch (e) {
    if (e.statusCode === 404) return null;
    throw e;
  }
}

// Identifies an image the same way the known-combinations database does: by its
// RepoDigest (`sha256:...`), never by tag (tags move; a digest does not). An image
// pulled/built without any RepoDigest (e.g. a local `docker load`) returns null --
// it can never match a base in the database, which is the correct outcome.
async function getImageDigest(imageRef) {
  const info = await docker.getImage(imageRef).inspect();
  const repoDigest = (info.RepoDigests || [])[0];
  if (!repoDigest) return null;
  const at = repoDigest.lastIndexOf('@');
  return at >= 0 ? repoDigest.slice(at + 1) : null;
}

async function getPid(containerId) {
  const info = await inspect(containerId);
  return String(info.State.Pid);
}

async function getBridgeIp(containerId) {
  const info = await inspect(containerId);
  return info.NetworkSettings?.Networks?.bridge?.IPAddress;
}

// Default exec environment: a bare `docker exec` does NOT inherit the PATH an Android
// container's own init sets up for its boot (that's internal to Android's own process
// tree) -- it gets a generic Linux PATH that doesn't include /system/bin or /system/xbin,
// so even common calls like `su`/`ip`/`getprop` fail with "executable file not found in
// $PATH" despite the binaries being right there. Found for real running this against a
// live instance (see docs/ROADMAP.md Phase 3) -- not a hypothetical.
const ANDROID_EXEC_ENV = ['PATH=/system/bin:/system/xbin:/vendor/bin:/vendor/xbin:/sbin:/bin'];

// Equivalent to `docker exec <containerId> <cmd>` but through dockerode instead
// of shelling out to the docker CLI. It rejects if the command ends with an exit
// code != 0, just like the CLI.
async function exec(containerId, cmd, timeoutMs = 15000) {
  const e = await docker.getContainer(containerId).exec({
    Cmd: cmd,
    Env: ANDROID_EXEC_ENV,
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
// The content of ONE file of a container, running or stopped (the Docker archive API: the same one `docker cp` uses).
async function readFile(containerId, filePath) {
  const stream = await docker.getContainer(containerId).getArchive({ path: filePath });
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  const file = require('./tarFile').firstFileFromTar(Buffer.concat(chunks));
  if (!file) throw new Error(`${filePath} is not a regular file of ${containerId}`);
  return file;
}

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
  inspect, inspectVolume, getImageDigest, getPid, getBridgeIp, exec, runEphemeral, readLogs, readFile, updateResources,
};

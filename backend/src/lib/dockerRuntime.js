const Docker = require('dockerode');

// Adapter puro sobre dockerode — porta container-runtime.service.ts de
// plenum-redroid, sin el resto de sus dependencias.
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

async function listLocalImageTags() {
  const images = await docker.listImages();
  const tags = new Set();
  for (const img of images) {
    for (const t of img.RepoTags || []) tags.add(t);
  }
  return tags;
}

// Redroid necesita acceso directo a /dev/binder* (montado via binds) y, para
// gpuMode=host, al resto de los dispositivos de GPU del host — plenum-redroid
// resuelve esto con Privileged:true en vez de listar /dev/dri a mano (ver
// instance-orchestrator.service.ts:170), se mantiene el mismo criterio acá.
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
    if (e.statusCode !== 304) throw e; // 304 = ya estaba corriendo
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

// `docker rm -v` solo borra volumenes anonimos — los nombrados (como los que
// usa este manager, uno por instancia) hay que borrarlos aparte.
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

// Equivalente a `docker exec <containerId> <cmd>` pero vía dockerode en vez
// de shellear al CLI de docker (no está instalado en la imagen del manager).
// Rechaza si el comando termina con exit code != 0, igual que el CLI.
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
    throw Object.assign(new Error(`exec "${cmd.join(' ')}" salio con codigo ${ExitCode}: ${out}`), { exitCode: ExitCode, output: out });
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

// Corre un contenedor de un solo uso hasta que termina y devuelve su stdout —
// equivalente a `docker run --rm ...` pero via dockerode (el CLI no esta
// instalado en la imagen del manager). Tty:true evita el framing binario
// multiplexado que trae container.logs() para stdout/stderr separados, que
// acá no hace falta distinguir.
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
    const logs = await container.logs({ stdout: true, stderr: true });
    return logs.toString('utf-8');
  } finally {
    await container.remove({ force: true }).catch(() => {});
  }
}

module.exports = {
  docker, listLocalImageTags, create, start, stop, restart, remove, removeVolume,
  inspect, getPid, getBridgeIp, exec, runEphemeral,
};

const express = require('express');
const runtime = require('../lib/dockerRuntime');
const binder = require('../lib/binder');
const hwsimWifi = require('../lib/hwsimWifi');
const androidIdentity = require('../lib/androidIdentity');
const store = require('../lib/store');
const portAllocator = require('../lib/portAllocator');
const catalog = require('../../images.json');

const router = express.Router();

// httpStatus (no "status": ese campo lo pisa Node con el exit code cuando el
// error viene de execFileSync, ver hwsimWifi.js/binder.js) para no terminar
// llamando res.status(1) con un error interno y tumbando el proceso.
function httpError(message, httpStatus) {
  return Object.assign(new Error(message), { httpStatus });
}

function findImage(imageId) {
  const img = catalog.find((i) => i.id === imageId);
  if (!img) throw httpError(`Imagen desconocida: ${imageId}`, 400);
  return img;
}

function scheduleWifiFixes(instance) {
  if (!instance.needsHwsimWifi) return;
  hwsimWifi.scheduleHwsimWifiFix(instance.id, instance.containerId);
  hwsimWifi.scheduleWifiConnectedFix(instance.id, instance.containerId);
  hwsimWifi.scheduleEth0RoutingFix(instance.id, instance.containerId);
}

async function withRuntimeStatus(instance) {
  try {
    const info = await runtime.inspect(instance.containerId);
    return { ...instance, status: info.State.Status };
  } catch {
    return { ...instance, status: 'missing' };
  }
}

router.get('/', async (req, res) => {
  const all = store.readAll();
  res.json(await Promise.all(all.map(withRuntimeStatus)));
});

router.post('/', async (req, res) => {
  try {
    const { name, imageId, width, height, dpi, fps } = req.body;
    if (!name || !imageId) throw httpError('name e imageId son requeridos', 400);
    if (store.readAll().some((i) => i.name === name)) {
      throw httpError(`Ya existe una instancia llamada "${name}"`, 409);
    }

    const img = findImage(imageId);
    const adbPort = portAllocator.nextPort();
    const slot = binder.nextFreeSlot();
    const volumeName = `redroid-forge-${name}`;
    const binds = [...binder.binderBinds(slot), `${volumeName}:/data`];

    const cmd = [
      `androidboot.redroid_width=${width || 720}`,
      `androidboot.redroid_height=${height || 1280}`,
      `androidboot.redroid_dpi=${dpi || 160}`,
      `androidboot.redroid_fps=${fps || 60}`,
      `androidboot.redroid_gpu_mode=${img.gpuMode}`,
    ];

    const containerId = await runtime.create({
      name: `redroid-${name}`,
      image: img.dockerImage,
      cmd,
      binds,
      adbPort,
    });

    const instance = {
      id: containerId,
      name,
      imageId,
      dockerImage: img.dockerImage,
      containerId,
      adbPort,
      binderSlot: slot,
      volumeName,
      needsHwsimWifi: !!img.needsHwsimWifi,
      hasGapps: !!img.hasGapps,
      androidId: null,
      androidIdRegisteredAt: null,
      createdAt: new Date().toISOString(),
    };
    store.upsert(instance);

    await runtime.start(containerId);
    scheduleWifiFixes(instance);
    if (instance.hasGapps) androidIdentity.scheduleFetch(instance.id);

    res.status(201).json(await withRuntimeStatus(instance));
  } catch (e) {
    const status = e.httpStatus >= 400 && e.httpStatus < 600 ? e.httpStatus : 500;
    res.status(status).json({ error: e.message });
  }
});

router.post('/:id/start', async (req, res) => {
  const instance = store.get(req.params.id);
  if (!instance) return res.status(404).json({ error: 'Instancia no encontrada' });
  try {
    await runtime.start(instance.containerId);
    scheduleWifiFixes(instance);
    res.json(await withRuntimeStatus(instance));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/stop', async (req, res) => {
  const instance = store.get(req.params.id);
  if (!instance) return res.status(404).json({ error: 'Instancia no encontrada' });
  try {
    await runtime.stop(instance.containerId);
    res.json(await withRuntimeStatus(instance));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/restart', async (req, res) => {
  const instance = store.get(req.params.id);
  if (!instance) return res.status(404).json({ error: 'Instancia no encontrada' });
  try {
    await runtime.restart(instance.containerId);
    scheduleWifiFixes(instance);
    res.json(await withRuntimeStatus(instance));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id/android-id', async (req, res) => {
  const instance = store.get(req.params.id);
  if (!instance) return res.status(404).json({ error: 'Instancia no encontrada' });
  try {
    const androidId = await androidIdentity.get(instance.id);
    res.json({ androidId, androidIdRegisteredAt: store.get(instance.id)?.androidIdRegisteredAt || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/android-id/registered', (req, res) => {
  const updated = androidIdentity.markRegistered(req.params.id);
  if (!updated) return res.status(404).json({ error: 'Instancia no encontrada' });
  res.json({ androidId: updated.androidId, androidIdRegisteredAt: updated.androidIdRegisteredAt });
});

router.delete('/:id', async (req, res) => {
  const instance = store.get(req.params.id);
  if (!instance) return res.status(404).json({ error: 'Instancia no encontrada' });
  try {
    await runtime.remove(instance.containerId, { force: true });
    if (instance.volumeName) await runtime.removeVolume(instance.volumeName);
    store.remove(instance.id);
    res.status(204).end();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

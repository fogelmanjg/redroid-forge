const express = require('express');
const runtime = require('../lib/dockerRuntime');
const binder = require('../lib/binder');
const hwsimWifi = require('../lib/hwsimWifi');
const androidIdentity = require('../lib/androidIdentity');
const store = require('../lib/store');
const portAllocator = require('../lib/portAllocator');
const moduleGate = require('../lib/moduleGate');
const moduleRunner = require('../lib/moduleRunner');
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

// Bloquea crear/arrancar/reiniciar si algun modulo que la imagen requiere
// (GApps, Magisk, WiFi falso -- ver lib/moduleGate.js) no tiene una
// aceptacion vigente de su manifest, o no es compatible con la imagen
// elegida (compatibleCon). Se llama antes de tocar Docker para nada: "el
// backend ejecuta el script/integra el componente" solo despues de esto.
function assertModulesReady(img) {
  const result = moduleGate.check(img);
  if (!result.ok) {
    throw Object.assign(new Error(result.error), { httpStatus: result.httpStatus, modules: result.modules });
  }
}

// Uso estricto (create): la imagen tiene que existir en el catalogo.
function resolveImageAndGate(imageId) {
  const img = findImage(imageId);
  assertModulesReady(img);
  return img;
}

// Uso para start/restart: revalida el contrato en cada arranque, pero si la
// imagen ya no esta en el catalogo (se pudo editar images.json despues de
// crear la instancia), no bloquea el arranque -- antes de este gate,
// start/restart nunca dependian del catalogo.
function revalidateModulesIfImageKnown(instance) {
  const img = catalog.find((i) => i.id === instance.imageId);
  if (!img) {
    console.warn(`[instances] "${instance.imageId}" ya no esta en el catalogo -- se omite la revalidacion de modulos para ${instance.id}`);
    return;
  }
  assertModulesReady(img);
}

// requiredModuleIds se calcula una vez al crear (a partir de la imagen que
// SI estaba en el catalogo en ese momento) y se persiste en la instancia --
// asi start/restart pueden correr las etapas 5/6 del runner generico
// (moduleRunner.js) sin depender de que la imagen siga en el catalogo mas
// adelante, mismo criterio que ya usaba el campo `hwEncCapable` guardado por
// instancia antes de esta fase.
function requiredModuleIdsFor(instance) {
  return instance.requiredModuleIds || [];
}

// e.modules (lista de manifests pendientes de aceptar, ver moduleGate.js) se
// suma al body de error para que el frontend pueda renderizar el/los modales
// de contrato sin tener que volver a pedirlos.
function sendError(res, e, fallbackStatus = 500) {
  const status = e.httpStatus >= 400 && e.httpStatus < 600 ? e.httpStatus : fallbackStatus;
  res.status(status).json({ error: e.message, ...(e.modules ? { modules: e.modules } : {}) });
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

    const img = resolveImageAndGate(imageId);
    // Que modulos requiere esta imagen (moduleGate.js) -- se persiste en la
    // instancia (ver requiredModuleIdsFor()) para que start/restart no
    // dependan de que la imagen siga en el catalogo despues.
    const requiredModuleIds = moduleGate.requiredModuleIdsForImage(img);
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

    // Etapa 3 (moduleRunner.js): cada modulo requerido que declare "etapa"/
    // "entry" en su manifest puede sumar binds/cmd propios antes de crear el
    // contenedor -- puramente aditivo sobre lo que ya arma este handler. Es
    // lo que reemplaza el `if (img.hwEncCapable) binds.push(...)` que antes
    // vivia hardcodeado aca.
    const createReq = await moduleRunner.prepareCreate(requiredModuleIds);
    binds.push(...createReq.binds);
    cmd.push(...createReq.cmd);

    const containerId = await runtime.create({
      name: `redroid-${name}`,
      image: img.dockerImage,
      cmd,
      binds,
      adbPort,
    });

    // Etapa 4: entre create() y start() -- unica ventana en la que /vendor es
    // escribible (ver docs/ARQUITECTURA.md). Si un modulo falla aca, no se
    // sigue a start(): mejor un contenedor creado a medio inyectar y visible
    // en el error que arrancar con la mitad de los modulos sin aplicarse.
    await moduleRunner.integrate(requiredModuleIds, containerId);

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
      hwEncCapable: !!img.hwEncCapable,
      requiredModuleIds,
      androidId: null,
      androidIdRegisteredAt: null,
      createdAt: new Date().toISOString(),
    };
    store.upsert(instance);

    // Etapa 5: infraestructura del host (ej. el daemon VA-API de hwAccel.js,
    // via el hook de hwenc) -- tiene que estar lista antes del start.
    await moduleRunner.ensureHostInfraReady(requiredModuleIds);
    await runtime.start(containerId);
    scheduleWifiFixes(instance);
    // Etapa 6: fixups post-boot fire-and-forget (mismo patron que
    // scheduleWifiFixes), no bloquean la respuesta.
    moduleRunner.scheduleRuntimeFixups(requiredModuleIds, containerId);
    if (instance.hasGapps) androidIdentity.scheduleFetch(instance.id);

    res.status(201).json(await withRuntimeStatus(instance));
  } catch (e) {
    sendError(res, e);
  }
});

router.post('/:id/start', async (req, res) => {
  const instance = store.get(req.params.id);
  if (!instance) return res.status(404).json({ error: 'Instancia no encontrada' });
  try {
    // Revalida el contrato en cada arranque, no solo al crear: si el
    // manifest de un modulo que esta instancia usa subio de version desde
    // que se creo, el proximo arranque queda bloqueado hasta reaceptar.
    revalidateModulesIfImageKnown(instance);
    const requiredModuleIds = requiredModuleIdsFor(instance);
    await moduleRunner.ensureHostInfraReady(requiredModuleIds);
    await runtime.start(instance.containerId);
    scheduleWifiFixes(instance);
    moduleRunner.scheduleRuntimeFixups(requiredModuleIds, instance.containerId);
    res.json(await withRuntimeStatus(instance));
  } catch (e) {
    sendError(res, e);
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
    revalidateModulesIfImageKnown(instance);
    const requiredModuleIds = requiredModuleIdsFor(instance);
    await moduleRunner.ensureHostInfraReady(requiredModuleIds);
    await runtime.restart(instance.containerId);
    scheduleWifiFixes(instance);
    moduleRunner.scheduleRuntimeFixups(requiredModuleIds, instance.containerId);
    res.json(await withRuntimeStatus(instance));
  } catch (e) {
    sendError(res, e);
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

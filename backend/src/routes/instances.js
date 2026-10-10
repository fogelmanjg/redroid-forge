const express = require('express');
const runtime = require('../lib/dockerRuntime');
const binder = require('../lib/binder');
const hwsimWifi = require('../lib/hwsimWifi');
const androidIdentity = require('../lib/androidIdentity');
const deviceProfile = require('../lib/deviceProfile');
const store = require('../lib/store');
const portAllocator = require('../lib/portAllocator');
const moduleGate = require('../lib/moduleGate');
const moduleManifests = require('../lib/moduleManifests');
const moduleAcceptance = require('../lib/moduleAcceptance');
const moduleRunner = require('../lib/moduleRunner');
const instanceParams = require('../lib/instanceParams');
const catalog = require('../../images.json');

const router = express.Router();

// httpStatus (not "status": Node overwrites that field with the exit code when the
// error comes from execFileSync, see hwsimWifi.js/binder.js) so as not to end up
// calling res.status(1) with an internal error and bringing the process down.
function httpError(message, httpStatus) {
  return Object.assign(new Error(message), { httpStatus });
}

function findImage(imageId) {
  const img = catalog.find((i) => i.id === imageId);
  if (!img) throw httpError(`Unknown image: ${imageId}`, 400);
  return img;
}

// Blocks creating/starting/restarting if some module the image requires (GApps,
// Magisk, fake WiFi -- see lib/moduleGate.js) has no current acceptance of its
// manifest, or is not compatible with the chosen image (compatibleCon). It is
// called before touching Docker at all: "the backend runs the script/integrates
// the component" only after this.
async function assertModulesReady(img, requested) {
  const result = await moduleGate.check(img, requested);
  if (!result.ok) {
    throw Object.assign(new Error(result.error), { httpStatus: result.httpStatus, modules: result.modules });
  }
}

// Strict use (create): the image has to exist in the catalog.
async function resolveImageAndGate(imageId, requested) {
  const img = findImage(imageId);
  await assertModulesReady(img, requested);
  return img;
}

// Use for start/restart: it revalidates the contract on every start, but if the
// image is no longer in the catalog (images.json may have been edited after
// creating the instance), it does not block the start -- before this gate,
// start/restart never depended on the catalog.
async function revalidateModulesIfImageKnown(instance) {
  const img = catalog.find((i) => i.id === instance.imageId);
  if (!img) {
    console.warn(`[instances] "${instance.imageId}" is no longer in the catalog -- module revalidation is skipped for ${instance.id}`);
    return;
  }
  // The optional modules chosen when it was created are revalidated too -- exactly those (an
  // instance that opted out of hwenc stays out). An instance created before the per-instance
  // options has no persisted list: it gets the image's defaults, as it did.
  const extras = instance.requiredModuleIds
    ? instance.requiredModuleIds.filter((id) => moduleGate.OPTIONAL_PER_INSTANCE.includes(id))
    : undefined;
  await assertModulesReady(img, extras);
}

// requiredModuleIds is computed once at creation (from the image that WAS in the
// catalog at that moment) and persisted on the instance -- so start/restart can
// run stages 5/6 of the generic runner (moduleRunner.js) without depending on the
// image still being in the catalog later, the same criterion the per-instance
// `hwEncCapable` field already used before this phase.
//
// Fallback for instances created BEFORE this phase (they have no persisted
// requiredModuleIds): instead of assuming "no required module" (which would
// silently skip ensureHostInfraReady/scheduleRuntimeFixups for an instance that
// does need them, e.g. hwEncCapable=true), it is recomputed from the catalog with
// the same criterion as revalidateModulesIfImageKnown -- only if the image is no
// longer in the catalog does it settle for [].
function requiredModuleIdsFor(instance) {
  if (instance.requiredModuleIds) return instance.requiredModuleIds;
  const img = catalog.find((i) => i.id === instance.imageId);
  // `requiredModuleIds(img)` with no choice = the image's defaults: what these instances got.
  return img ? moduleGate.requiredModuleIds(img) : [];
}

// e.modules (the list of manifests pending acceptance, see moduleGate.js) is added
// to the error body so that the frontend can render the contract modal(s) without
// having to request them again.
function sendError(res, e, fallbackStatus = 500) {
  const status = e.httpStatus >= 400 && e.httpStatus < 600 ? e.httpStatus : fallbackStatus;
  res.status(status).json({ error: e.message, ...(e.modules ? { modules: e.modules } : {}) });
}

// device-profile is opt-in per request, never hard-required by an image (it is not
// in moduleGate.requiredModuleIdsForImage because no image requires it) -- that is
// why it does not go through moduleGate.check (that method only looks at the
// modules the CHOSEN image requires), it is gated by querying its acceptance
// directly, just as strict: without a current acceptance of the manifest, nothing
// runs.
function assertDeviceProfileReady(img) {
  const manifest = moduleManifests.get('device-profile');
  if (!manifest) throw httpError('The manifest of module "device-profile" does not exist.', 500);

  if (img) {
    const reason = moduleManifests.incompatibilityReason(manifest, img);
    if (reason) throw httpError(`The device profile cannot be applied: ${reason}`, 409);
  }

  if (!moduleAcceptance.isAccepted('device-profile', manifest.version)) {
    throw Object.assign(
      new Error('The contract of module "device-profile" has to be read and accepted before continuing.'),
      { httpStatus: 428, modules: [manifest] },
    );
  }
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
    const { name, imageId, modules } = req.body;
    const display = instanceParams.parseDisplay(req.body);
    if (!name || !imageId) throw httpError('name and imageId are required', 400);
    // The same pattern the UI enforces: the name ends up in container and volume names.
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) {
      throw httpError('"name" must be lowercase letters, digits and hyphens (1-40 characters, not starting with a hyphen)', 400);
    }
    if (store.readAll().some((i) => i.name === name)) {
      throw httpError(`An instance named "${name}" already exists`, 409);
    }

    const img = await resolveImageAndGate(imageId, modules);
    // Which modules this image requires (moduleGate.js) -- it is persisted on the
    // instance (see requiredModuleIdsFor()) so that start/restart do not depend on
    // the image still being in the catalog afterwards.
    const requiredModuleIds = moduleGate.requiredModuleIds(img, modules);
    const adbPort = portAllocator.nextPort();
    const slot = binder.nextFreeSlot();
    const volumeName = `redroid-forge-${name}`;
    const binds = [...binder.binderBinds(slot), `${volumeName}:/data`];

    const cmd = [
      `androidboot.redroid_width=${display.width}`,
      `androidboot.redroid_height=${display.height}`,
      `androidboot.redroid_dpi=${display.dpi}`,
      `androidboot.redroid_fps=${display.fps}`,
      `androidboot.redroid_gpu_mode=${img.gpuMode}`,
    ];

    // Stage 3 (moduleRunner.js): every required module that declares "etapa"/
    // "entry" in its manifest can add its own binds/cmd before creating the
    // container -- purely additive over what this handler already builds. It is
    // what replaces the `if (img.hwEncCapable) binds.push(...)` that used to be
    // hardcoded here.
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

    // Stage 4: between create() and start() -- the only window in which /vendor is
    // writable (see docs/ARCHITECTURE.md). If a module fails here, start() is not
    // reached: better to clean up the freshly created container than to leave it
    // orphaned -- store.upsert() has not been reached yet, so without this cleanup it
    // would stay invisible to the API's DELETE (it would have to be removed by hand
    // with `docker rm`).
    try {
      // `display`: the instance's screen size, for the modules that adjust something to it (hwenc limits the
      // resolution the hardware decoders advertise).
      await moduleRunner.integrate(requiredModuleIds, containerId, {
        display: { width: display.width, height: display.height },
      });
    } catch (e) {
      await runtime.remove(containerId, { force: true }).catch(() => {});
      await runtime.removeVolume(volumeName).catch(() => {});
      throw e;
    }

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
      hasGapps: !!img.hasGapps || requiredModuleIds.includes('gapps'),
      hwEncCapable: !!img.hwEncCapable,
      requiredModuleIds,
      display,
      androidId: null,
      androidIdRegisteredAt: null,
      createdAt: new Date().toISOString(),
    };
    store.upsert(instance);

    // Stage 5: host infrastructure (e.g. hwAccel.js's VA-API daemon, via hwenc's
    // hook) -- it has to be ready before the start.
    await moduleRunner.ensureHostInfraReady(requiredModuleIds);
    await runtime.start(containerId);
    scheduleWifiFixes(instance);
    // Stage 6: fire-and-forget post-boot fixups (the same pattern as
    // scheduleWifiFixes), they do not block the response.
    moduleRunner.scheduleRuntimeFixups(requiredModuleIds, containerId);
    if (instance.hasGapps) androidIdentity.scheduleFetch(instance.id);

    res.status(201).json(await withRuntimeStatus(instance));
  } catch (e) {
    sendError(res, e);
  }
});

router.post('/:id/start', async (req, res) => {
  const instance = store.get(req.params.id);
  if (!instance) return res.status(404).json({ error: 'Instance not found' });
  try {
    // It revalidates the contract on every start, not only at creation: if the
    // manifest of a module this instance uses went up a version since it was
    // created, the next start stays blocked until it is accepted again.
    await revalidateModulesIfImageKnown(instance);
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
    await revalidateModulesIfImageKnown(instance);
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

// There is no prior convention of an "on-demand stage 6" (see ARCHITECTURE.md)
// triggered by the user against a particular instance -- this route is the first.
// Unlike scheduleWifiFixes (fire-and-forget after the start), this answers only
// when the spoof + restart have finished, so the frontend knows right away whether
// it worked.
router.post('/:id/device-profile', async (req, res) => {
  const instance = store.get(req.params.id);
  if (!instance) return res.status(404).json({ error: 'Instancia no encontrada' });
  try {
    const { profile } = req.body || {};
    if (profile !== undefined && typeof profile !== 'string') {
      throw httpError('"profile" must be a string (a profile name) or be omitted to revert to the default.', 400);
    }
    if (profile !== undefined && profile !== deviceProfile.DEFAULT_PROFILE && !deviceProfile.DEVICE_PROFILES[profile]) {
      throw httpError(`Unknown device profile: "${profile}".`, 400);
    }

    // Unlike revalidateModulesIfImageKnown (there start/restart never depended on the
    // catalog, so skipping the revalidation is benign), here the image is a real
    // prerequisite: without its androidVersion the profile's fingerprint cannot be
    // built.
    const img = catalog.find((i) => i.id === instance.imageId);
    if (!img) {
      throw httpError(
        `Image "${instance.imageId}" of this instance was not found in the catalog -- androidVersion cannot be determined to build the profile.`,
        409,
      );
    }
    assertDeviceProfileReady(img);

    const info = await runtime.inspect(instance.containerId).catch(() => null);
    if (!info || info.State.Status !== 'running') {
      throw httpError('The instance has to be running to apply a device profile.', 409);
    }

    const appliedKey = await deviceProfile.applyDeviceProfile(instance.containerId, img.androidVersion, profile);
    // The store is updated HERE, as soon as the spoof itself (the only real mutation
    // on the container) succeeded -- not after the restart below. If the restart
    // happens to fail, the container's filesystem ALREADY has the new profile
    // applied; leaving the store out of date until the restart finishes would mean
    // reporting the old profile while the real file has already changed (a real
    // code-review finding, PR #3).
    const updated = store.upsert({ ...instance, deviceProfile: appliedKey === deviceProfile.DEFAULT_PROFILE ? null : appliedKey });

    // "mount -o remount,rw /" leaves the filesystem writable on the fly, but several
    // build.prop props stay cached by Android's runtime until the next full boot --
    // without this restart, the spoof is left half-applied (see ROADMAP.md Phase 3,
    // jg-dashboard note). The same guard as /start and /restart (post Phase 5: via
    // moduleRunner, not the hardcoded ensureHwAccelIfNeeded that existed when this
    // fix was written) -- if this instance requires hwenc, the VA-API daemon has to
    // be up before restarting it (before, this route did not check it, unlike its
    // sibling routes).
    await moduleRunner.ensureHostInfraReady(requiredModuleIdsFor(updated));
    await runtime.restart(instance.containerId);
    // The restart recreates the container's netns -- without running this again, an
    // instance with fake wifi is left without radios until the next manual
    // start/restart.
    scheduleWifiFixes(updated);

    res.json(await withRuntimeStatus(updated));
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

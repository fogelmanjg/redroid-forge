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
const moduleScheduler = require('../lib/moduleScheduler');
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

// Strict use (create): the image has to exist in the catalog. `gpuModeOverride`, if given,
// replaces `img.gpuMode` BEFORE gating -- so every compatibility check that follows (hwenc's
// compatibleCon.gpuMode among them) is evaluated against what the instance will actually boot
// with, not the catalog's own default it may be overriding.
//
// gpu-mode's contract is gated on the EFFECTIVE mode being "host", never on "guest" and never
// on "does it differ from the image's default" -- guest is pure software rendering inside the
// container, nothing to disclose; host shares the host's real GPU hardware with the container
// and redroid itself has known, not-all-fixed bugs specific to that mode on some images/GPUs
// (see redroid-gralloc-fix). That holds even when host is the image's OWN declared default:
// catalog images default to guest exactly so a fresh install works out of the box on any
// machine -- an image whose own default happens to be host still has to surface the same
// disclosure, not skip it for being "just the default".
async function resolveImageAndGate(imageId, requested, gpuModeOverride) {
  const rawImg = findImage(imageId);
  const effectiveGpuMode = gpuModeOverride || rawImg.gpuMode;
  if (effectiveGpuMode === 'host') assertStandaloneModuleReady('gpu-mode', rawImg);
  const img = effectiveGpuMode === rawImg.gpuMode ? rawImg : { ...rawImg, gpuMode: effectiveGpuMode };
  await assertModulesReady(img, requested);
  return img;
}

// Use for start/restart: it revalidates the contract on every start, but if the
// image is no longer in the catalog (images.json may have been edited after
// creating the instance), it does not block the start -- before this gate,
// start/restart never depended on the catalog.
async function revalidateModulesIfImageKnown(instance) {
  const catalogImg = catalog.find((i) => i.id === instance.imageId);
  if (!catalogImg) {
    console.warn(`[instances] "${instance.imageId}" is no longer in the catalog -- module revalidation is skipped for ${instance.id}`);
    return;
  }
  // instance.gpuMode (set at creation, see resolveImageAndGate) may differ from the catalog's
  // own default if it was overridden there -- revalidation has to check every module's
  // compatibleCon.gpuMode against what this instance actually boots with, not the catalog's
  // default it chose to override.
  const img = instance.gpuMode && instance.gpuMode !== catalogImg.gpuMode
    ? { ...catalogImg, gpuMode: instance.gpuMode }
    : catalogImg;
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

// Shared by device-profile, cpu-ram and gpu-mode: each is opt-in per request, never hard-
// required by an image (none of them is in moduleGate.requiredModuleIdsForImage because no
// image requires them) -- that is why none goes through moduleGate.check (that method only
// looks at the modules the CHOSEN image requires), they are gated by querying their own
// acceptance directly, just as strict: without a current acceptance of the manifest, nothing
// runs.
function assertStandaloneModuleReady(moduleId, img) {
  const manifest = moduleManifests.get(moduleId);
  if (!manifest) throw httpError(`The manifest of module "${moduleId}" does not exist.`, 500);

  if (img) {
    const reason = moduleManifests.incompatibilityReason(manifest, img);
    if (reason) throw httpError(`"${manifest.nombre}" cannot be applied: ${reason}`, 409);
  }

  if (!moduleAcceptance.isAccepted(moduleId, manifest.version)) {
    throw Object.assign(
      new Error(`The contract of module "${moduleId}" has to be read and accepted before continuing.`),
      { httpStatus: 428, modules: [manifest] },
    );
  }
}

// Shared by the on-demand route below (instance already running -- a deliberate, visible
// action the user chose right now) and reconcileDeviceProfile (a change that was only
// stored while stopped, now due): exec the spoof into the container's filesystem, then
// restart so Android's cached build.prop values actually pick it up (see deviceProfile.js).
// `deviceProfileApplied` tracks what is really baked into the container right now, separate
// from `deviceProfile` (what the user wants) -- they can disagree while stopped, never once
// this returns.
async function applyAndRestartDeviceProfile(instance, img, profileKey) {
  assertStandaloneModuleReady('device-profile', img);
  const appliedKey = await deviceProfile.applyDeviceProfile(instance.containerId, img.androidVersion, profileKey);
  const normalized = appliedKey === deviceProfile.DEFAULT_PROFILE ? null : appliedKey;
  const updated = store.upsert({ ...instance, deviceProfile: normalized, deviceProfileApplied: normalized });
  await moduleRunner.ensureHostInfraReady(requiredModuleIdsFor(updated));
  await runtime.restart(instance.containerId);
  // The restart recreates the container's netns -- without running this again, an instance
  // with fake wifi is left without radios until the next manual start/restart.
  scheduleWifiFixes(updated);
  return updated;
}

// Changing the device profile while the instance was STOPPED only updates what is stored
// (see the route below) -- nothing to exec against yet, and nothing running to disrupt
// either. Called right after start()/restart() bring the container up, BEFORE the rest of
// their own post-boot steps, so that by the time those run the container is already in its
// final state: one settle restart here if a change was pending, not a second visible boot
// the caller would have to account for separately. A silent no-op when nothing is pending
// (the common case, checked every start/restart) and left pending again (not thrown) if the
// image is no longer in the catalog or the spoof itself fails -- same as if the user had
// never opened the on-demand route, the next start retries.
async function reconcileDeviceProfile(instance) {
  const desired = instance.deviceProfile || null;
  const applied = instance.deviceProfileApplied || null;
  if (desired === applied) return instance;
  const img = catalog.find((i) => i.id === instance.imageId);
  if (!img) return instance;
  // Right after runtime.start()/restart() returns, /system is not populated yet -- confirmed
  // for real: the very first attempt here failed with "su: no such file or directory",
  // Android's own init had not gotten far enough along. A few retries with a short wait
  // covers it, same convention as hwsimWifi.js's own boot-timing retries (ensureEth0Routing).
  // Bounded and awaited HERE, not fire-and-forget: a pending profile change makes start()/
  // restart() take a little longer (the rare case -- only right after the profile was
  // changed while stopped), but the user never sees the OLD profile come up and then gets
  // yanked by a surprise restart moments later -- same reasoning as jg-dashboard's own
  // applyDeviceProfileEarly, awaited inside doStart() before the instance is reachable.
  const MAX_ATTEMPTS = 10;
  const RETRY_DELAY_MS = 3000;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await applyAndRestartDeviceProfile(instance, img, desired);
    } catch (e) {
      console.warn(`[instances] device profile reconciliation attempt ${attempt}/${MAX_ATTEMPTS} failed for ${instance.id}: ${e.message}`);
      if (attempt < MAX_ATTEMPTS) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }
  console.warn(`[instances] device profile reconciliation gave up for ${instance.id} -- still pending, next start/restart retries`);
  return instance;
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
    const resources = instanceParams.parseResources(req.body);
    const gpuModeChoice = instanceParams.parseGpuMode(req.body);
    if (!name || !imageId) throw httpError('name and imageId are required', 400);
    // The same pattern the UI enforces: the name ends up in container and volume names.
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) {
      throw httpError('"name" must be lowercase letters, digits and hyphens (1-40 characters, not starting with a hyphen)', 400);
    }
    if (store.readAll().some((i) => i.name === name)) {
      throw httpError(`An instance named "${name}" already exists`, 409);
    }
    const img = await resolveImageAndGate(imageId, modules, gpuModeChoice.gpuMode);
    // Which modules this image requires (moduleGate.js) -- it is persisted on the
    // instance (see requiredModuleIdsFor()) so that start/restart do not depend on
    // the image still being in the catalog afterwards.
    const requiredModuleIds = moduleGate.requiredModuleIds(img, modules);
    const adbPort = portAllocator.nextPort();
    const slot = binder.nextFreeSlot({ inUse: await binder.slotsInUseOnHost(runtime.docker).catch(() => []) });
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
      ...resources,
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
      gpuMode: img.gpuMode,
      memoryMb: resources.memoryMb || null,
      cpusetCpus: resources.cpusetCpus || null,
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
    // Stage 7: periodic watchdogs (CIFI and the like) -- started here, not just
    // on /start, since a freshly created instance is also freshly running.
    moduleScheduler.start(instance.id, containerId, requiredModuleIds);
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
    const reconciled = await reconcileDeviceProfile(instance);
    scheduleWifiFixes(reconciled);
    moduleRunner.scheduleRuntimeFixups(requiredModuleIds, reconciled.containerId);
    moduleScheduler.start(reconciled.id, reconciled.containerId, requiredModuleIds);
    res.json(await withRuntimeStatus(reconciled));
  } catch (e) {
    sendError(res, e);
  }
});

router.post('/:id/stop', async (req, res) => {
  const instance = store.get(req.params.id);
  if (!instance) return res.status(404).json({ error: 'Instancia no encontrada' });
  try {
    moduleScheduler.stop(instance.id);
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
    moduleScheduler.stop(instance.id); // cleared and rescheduled below -- never double-ticking across a restart
    await runtime.restart(instance.containerId);
    const reconciled = await reconcileDeviceProfile(instance);
    scheduleWifiFixes(reconciled);
    moduleRunner.scheduleRuntimeFixups(requiredModuleIds, reconciled.containerId);
    moduleScheduler.start(reconciled.id, reconciled.containerId, requiredModuleIds);
    res.json(await withRuntimeStatus(reconciled));
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
    assertStandaloneModuleReady('device-profile', img);
    const normalized = (profile === undefined || profile === deviceProfile.DEFAULT_PROFILE) ? null : profile;

    // Stopped: nothing to exec against (no running process to reach), and nothing running to
    // disrupt either -- just record what the user wants. reconcileDeviceProfile (see above)
    // applies it on the next start/restart, before the instance is ever reachable again, so
    // the change is never silently lost. Running: apply it right now -- a deliberate, visible
    // action (it restarts the instance) the user chose while something may already be using
    // it, same distinction jg-dashboard's own edit flow makes (editing while stopped only
    // stores it there too; editing while running restarts on the spot).
    const info = await runtime.inspect(instance.containerId).catch(() => null);
    const updated = info && info.State.Status === 'running'
      ? await applyAndRestartDeviceProfile(instance, img, normalized)
      : store.upsert({ ...instance, deviceProfile: normalized });

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

// Live update of CPU/RAM limits -- unlike width/height/dpi/fps (baked into the kernel cmdline
// at create time, a real recreate), Docker's own Update API supports changing Memory/CpusetCpus
// on a container that already exists. Only the fields given are touched: {} changes nothing
// (not a way to "clear" a limit once set -- not asked for, not built).
router.post('/:id/resources', async (req, res) => {
  const instance = store.get(req.params.id);
  if (!instance) return res.status(404).json({ error: 'Instancia no encontrada' });
  try {
    const resources = instanceParams.parseResources(req.body);
    await runtime.updateResources(instance.containerId, resources);
    const updated = store.upsert({
      ...instance,
      memoryMb: resources.memoryMb !== undefined ? resources.memoryMb : instance.memoryMb,
      cpusetCpus: resources.cpusetCpus !== undefined ? resources.cpusetCpus : instance.cpusetCpus,
    });
    res.json(await withRuntimeStatus(updated));
  } catch (e) {
    sendError(res, e);
  }
});

// width/height/dpi/fps/gpuMode are baked into the container's kernel command line at create
// time (androidboot.redroid_*) -- unlike resources (Docker's own Update API) or device-profile
// (exec + restart on the existing container), none of them has a live-update path. Changing
// any of them means a real recreate: stop (tolerant if already stopped, inside remove) + remove
// the CONTAINER ONLY (never the named volume -- dockerRuntime.remove's `v:true` only ever
// touches anonymous volumes, see its own comment) + create a fresh one with the new cmdline,
// reusing the same adbPort/binderSlot/volume/resources -- then start it again if it was
// already running, so the instance ends up in the state it was already in, just booted with
// the new values. `instance.id` is kept exactly as it was (it is NOT re-set to the new
// containerId): this codebase already threads id/containerId as two separate values
// everywhere (moduleScheduler.start(id, containerId, ...), scheduleWifiFixes(instance), ...),
// they just happen to start out equal at creation -- keeping `id` stable is what lets the
// instance's URL/identity survive a recreate at all.
router.post('/:id/display', async (req, res) => {
  const instance = store.get(req.params.id);
  if (!instance) return res.status(404).json({ error: 'Instancia no encontrada' });
  try {
    const display = instanceParams.parseDisplay(req.body, instance.display);
    const gpuModeChoice = instanceParams.parseGpuMode(req.body);
    const catalogImg = catalog.find((i) => i.id === instance.imageId);
    if (!catalogImg) {
      throw httpError(`Image "${instance.imageId}" of this instance was not found in the catalog -- it cannot be recreated.`, 409);
    }
    const effectiveGpuMode = gpuModeChoice.gpuMode || instance.gpuMode || catalogImg.gpuMode;
    if (effectiveGpuMode === 'host') assertStandaloneModuleReady('gpu-mode', catalogImg);
    const img = effectiveGpuMode === catalogImg.gpuMode ? catalogImg : { ...catalogImg, gpuMode: effectiveGpuMode };

    // Every module's compatibility is re-checked against what the instance will boot with
    // next (hwenc/hwdec/redroid-gralloc-fix among them) -- same gate as creation, not skipped
    // just because the instance already exists. `req.body.modules`, if given, REPLACES the
    // optional list (same semantics as POST / at creation) -- this is what lets the codec
    // chip toggle hwenc/hwdec through this same route. Omitted (the display-only panel never
    // sends it): the optional modules already chosen stay exactly those.
    const extras = req.body.modules !== undefined
      ? req.body.modules
      : (instance.requiredModuleIds
        ? instance.requiredModuleIds.filter((id) => moduleGate.OPTIONAL_PER_INSTANCE.includes(id))
        : undefined);
    await assertModulesReady(img, extras);
    const requiredModuleIds = moduleGate.requiredModuleIds(img, extras);

    const info = instance.containerId ? await runtime.inspect(instance.containerId).catch(() => null) : null;
    const wasRunning = info?.State?.Status === 'running';

    // `containerId` can already be null here -- a PREVIOUS call to this route may have
    // removed the old container and then failed before create() finished (found for real:
    // two modules sharing the same bind, see moduleRunner.prepareCreate's dedup). Nothing to
    // remove in that case; runtime.remove() itself has no "already gone" tolerance like
    // start()/stop() do, it would throw "No such container: null".
    if (instance.containerId) {
      await runtime.remove(instance.containerId, { force: true });
      // Persisted right away, before create() is even attempted: if create() itself fails
      // below (a real possibility -- missing image, no free binder slot, ...), the stored
      // record still correctly says "no container" rather than pointing at the one just
      // deleted. The volume (the actual data) was never touched either way.
      instance.containerId = null;
      store.upsert({ ...instance });
    }

    const binds = [...binder.binderBinds(instance.binderSlot), `${instance.volumeName}:/data`];
    const cmd = [
      `androidboot.redroid_width=${display.width}`,
      `androidboot.redroid_height=${display.height}`,
      `androidboot.redroid_dpi=${display.dpi}`,
      `androidboot.redroid_fps=${display.fps}`,
      `androidboot.redroid_gpu_mode=${img.gpuMode}`,
    ];
    const createReq = await moduleRunner.prepareCreate(requiredModuleIds);
    binds.push(...createReq.binds);
    cmd.push(...createReq.cmd);

    const containerId = await runtime.create({
      name: `redroid-${instance.name}`,
      image: img.dockerImage,
      cmd,
      binds,
      adbPort: instance.adbPort,
      memoryMb: instance.memoryMb,
      cpusetCpus: instance.cpusetCpus,
    });

    try {
      await moduleRunner.integrate(requiredModuleIds, containerId, {
        display: { width: display.width, height: display.height },
      });
    } catch (e) {
      await runtime.remove(containerId, { force: true }).catch(() => {});
      throw e;
    }

    // build.prop lives in the container's OWN filesystem layer, not in the persistent /data
    // volume -- any previously-applied device profile spoof is gone with the old container.
    // deviceProfileApplied reset to null so reconcileDeviceProfile (see /start) knows to
    // re-apply the still-desired `deviceProfile` on the next boot, exactly like a change made
    // while the instance was stopped already does.
    let updated = store.upsert({
      ...instance, containerId, display, gpuMode: img.gpuMode, requiredModuleIds, deviceProfileApplied: null,
    });

    if (wasRunning) {
      await moduleRunner.ensureHostInfraReady(requiredModuleIds);
      await runtime.start(containerId);
      updated = await reconcileDeviceProfile(updated);
      scheduleWifiFixes(updated);
      moduleRunner.scheduleRuntimeFixups(requiredModuleIds, containerId);
      moduleScheduler.start(updated.id, containerId, requiredModuleIds);
    }

    res.json(await withRuntimeStatus(updated));
  } catch (e) {
    sendError(res, e);
  }
});

router.get('/:id/watchdogs', (req, res) => {
  const instance = store.get(req.params.id);
  if (!instance) return res.status(404).json({ error: 'Instancia no encontrada' });
  res.json(moduleScheduler.status(instance.id, requiredModuleIdsFor(instance)));
});

function watchdogPauseRoute(paused) {
  return (req, res) => {
    const instance = store.get(req.params.id);
    if (!instance) return res.status(404).json({ error: 'Instancia no encontrada' });
    const ids = requiredModuleIdsFor(instance);
    if (!moduleRunner.watchdogModules(ids).some((m) => m.id === req.params.moduleId)) {
      return res.status(404).json({ error: `This instance has no watchdog module "${req.params.moduleId}"` });
    }
    (paused ? moduleScheduler.pause : moduleScheduler.resume)(instance.id, req.params.moduleId);
    res.json(moduleScheduler.status(instance.id, ids).find((w) => w.moduleId === req.params.moduleId));
  };
}
router.post('/:id/watchdogs/:moduleId/pause', watchdogPauseRoute(true));
router.post('/:id/watchdogs/:moduleId/resume', watchdogPauseRoute(false));

router.delete('/:id', async (req, res) => {
  const instance = store.get(req.params.id);
  if (!instance) return res.status(404).json({ error: 'Instancia no encontrada' });
  try {
    moduleScheduler.stop(instance.id);
    await runtime.remove(instance.containerId, { force: true });
    if (instance.volumeName) await runtime.removeVolume(instance.volumeName);
    store.remove(instance.id);
    res.status(204).end();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

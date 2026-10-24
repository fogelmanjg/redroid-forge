'use strict';

// Wires knownDb.resolve() (docs/KNOWN-COMBINATIONS.md section 3) to a real instance:
// turns "this instance" into the plain { baseDigest, gappsId, magiskId, modulos,
// hostGpuVendor } input that resolve() expects, using exactly the data the instance
// was actually created with -- not the image's defaults.

const path = require('path');
const fs = require('fs');
const runtime = require('./dockerRuntime');
const knownDbStore = require('./knownDbStore');
const knownDb = require('./knownDb');
const moduleManifests = require('./moduleManifests');
const hwAccel = require('./hwAccel');

const GAPPS_DIR = process.env.REDROID_FORGE_GAPPS_DIR
  || path.join(__dirname, '..', '..', 'data', 'gapps');

// Same package.json the gapps module itself reads (src/modules/gapps/integrate.js) --
// only its declared id, no re-verification of file hashes here: this is a read-only
// status check, not an integration step.
function localGappsId(dir = GAPPS_DIR) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
    return pkg.id || null;
  } catch {
    return null;
  }
}

// redroid-forge has no Magisk module (yet) -- always null until one exists.
function localMagiskId() {
  return null;
}

function modulesWithVersions(moduleIds) {
  const out = {};
  for (const id of moduleIds) {
    const manifest = moduleManifests.get(id);
    out[id] = manifest ? manifest.version : null;
  }
  return out;
}

function buildInput(instance, { baseDigest, hostGpuVendor }) {
  return {
    baseDigest,
    gappsId: instance.hasGapps ? localGappsId() : null,
    magiskId: localMagiskId(),
    modulos: modulesWithVersions(instance.requiredModuleIds || []),
    hostGpuVendor,
  };
}

// Pure (no I/O): resolve() given an already-fetched db/baseDigest/hostGpuVendor. Split
// out of resolveForInstance so attachSupport() below can reuse one db load, one GPU
// detection (it spawns lspci) and one digest lookup per distinct image across an
// entire instance list, instead of repeating all three per instance.
function resolveOne(instance, ctx) {
  return knownDb.resolve(ctx.db, buildInput(instance, ctx));
}

// -> the same shape as knownDb.resolve(): { nivel, combinacion, motivos }, plus the
// resolved input itself (useful for the UI/debugging to show WHY). Does its own I/O --
// for a single instance looked up on its own (GET /api/instances/:id/soporte).
async function resolveForInstance(instance) {
  const { db } = knownDbStore.loadCurrent();
  const [baseDigest, hostGpuVendor] = await Promise.all([
    runtime.getImageDigest(instance.dockerImage).catch(() => null),
    hwAccel.detectGpuVendor().catch(() => null),
  ]);
  const ctx = { db, baseDigest, hostGpuVendor };
  return { ...resolveOne(instance, ctx), input: buildInput(instance, ctx) };
}

// Attaches `soporte: {nivel, combinacion, motivos}` to every instance of a list, e.g. the
// real payload of GET /api/instances (refreshed every few seconds by the frontend while
// that tab is open -- see app.js) -- one db load, one GPU vendor detection and one digest
// lookup per DISTINCT dockerImage across the whole list, not per instance.
async function attachSupport(instances) {
  const { db } = knownDbStore.loadCurrent();
  const hostGpuVendor = await hwAccel.detectGpuVendor().catch(() => null);
  const images = [...new Set(instances.map((i) => i.dockerImage))];
  const digestPairs = await Promise.all(
    images.map(async (image) => [image, await runtime.getImageDigest(image).catch(() => null)]),
  );
  const digestByImage = new Map(digestPairs);
  return instances.map((instance) => ({
    ...instance,
    soporte: resolveOne(instance, { db, hostGpuVendor, baseDigest: digestByImage.get(instance.dockerImage) }),
  }));
}

module.exports = {
  resolveForInstance, attachSupport, localGappsId, localMagiskId, modulesWithVersions,
};

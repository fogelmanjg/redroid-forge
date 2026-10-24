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

// -> the same shape as knownDb.resolve(): { nivel, combinacion, motivos }, plus the
// resolved input itself (useful for the UI/debugging to show WHY).
async function resolveForInstance(instance) {
  const { db } = knownDbStore.loadCurrent();
  const [baseDigest, hostGpuVendor] = await Promise.all([
    runtime.getImageDigest(instance.dockerImage).catch(() => null),
    hwAccel.detectGpuVendor().catch(() => null),
  ]);
  const input = {
    baseDigest,
    gappsId: instance.hasGapps ? localGappsId() : null,
    magiskId: localMagiskId(),
    modulos: modulesWithVersions(instance.requiredModuleIds || []),
    hostGpuVendor,
  };
  return { ...knownDb.resolve(db, input), input };
}

module.exports = { resolveForInstance, localGappsId, localMagiskId, modulesWithVersions };

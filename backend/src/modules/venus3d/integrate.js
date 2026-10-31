#!/usr/bin/env node
'use strict';

// venus3d module (stages 3, 4, 5 -- see manifest.json, moduleRunner.js and
// docs/ARCHITECTURE.md): real 3D acceleration on NVIDIA hosts, ported from redroid-nvidia's
// Tier 4/5. See backend/src/lib/venus3dService.js and venus3dAccel.js for the real logic --
// this file only wires the module contract to them, same shape as hwenc/nvenc's integrate.js.

const svc = require('../../lib/venus3dService');

function prepareCreate() {
  return svc.prepareCreate();
}

async function integrate(containerId) {
  await svc.installFiles(containerId);
}

async function ensureHostInfraReady() {
  await svc.ensureHostInfraReady();
}

module.exports = { prepareCreate, integrate, ensureHostInfraReady };

if (require.main === module) {
  const containerId = process.argv[2];
  if (!containerId) {
    console.error('Usage: node integrate.js <containerId>');
    process.exit(1);
  }
  integrate(containerId).catch((e) => { console.error(e); process.exit(1); });
}

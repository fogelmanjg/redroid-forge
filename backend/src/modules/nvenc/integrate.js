#!/usr/bin/env node
'use strict';

// nvenc module (stages 3, 4, 5, 6 -- see manifest.json, moduleRunner.js and
// docs/ARCHITECTURE.md): hardware H.264 ENCODE on NVIDIA hosts, ported from redroid-nvidia's
// Tier 7. See backend/src/lib/nvencService.js and nvencAccel.js for the real logic -- this
// file only wires the module contract to them, same shape as hwenc/integrate.js.
//
// Our own 100% free code (Apache-2.0, same as redroid-forge itself) -- the artifacts are read
// from a local folder (REDROID_NVENC_ARTIFACTS_DIR) for the same reason hwenc's own comment
// gives: Android/bionic binaries need the full AOSP toolchain to build, not something this
// project's normal build can do on the spot.

const svc = require('../../lib/nvencService');

function prepareCreate() {
  return svc.prepareCreate();
}

async function integrate(containerId) {
  await svc.installFiles(containerId);
  await svc.patchMediaCodecsXml(containerId);
}

async function ensureHostInfraReady() {
  await svc.ensureHostInfraReady();
}

async function ensureRuntimeReady(containerId) {
  await svc.ensureRuntimeReady(containerId);
}

module.exports = { prepareCreate, integrate, ensureHostInfraReady, ensureRuntimeReady };

if (require.main === module) {
  const containerId = process.argv[2];
  if (!containerId) {
    console.error('Usage: node integrate.js <containerId>');
    process.exit(1);
  }
  integrate(containerId).catch((e) => { console.error(e); process.exit(1); });
}

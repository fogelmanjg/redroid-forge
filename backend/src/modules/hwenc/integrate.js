#!/usr/bin/env node
'use strict';

// hwenc module (stages 3, 4, 5 and 6 -- see manifest.json, moduleRunner.js and
// docs/ARCHITECTURE.md): turns on hardware H.264 ENCODE only. Decode is the separate "hwdec"
// module (../hwdec/integrate.js) -- split on 22/10/2026 because the two have different real
// risk profiles (encode is AMD/Intel-only; decode also works on NVIDIA but has its own known
// bug there) and, on at least one AMD GPU, running both together has caused a real,
// reproducible, not-yet-understood hang. Both still share the same underlying Codec2 VA-API
// HAL service, daemon and media_codecs.xml file -- that shared machinery lives in
// backend/src/lib/codec2Service.js, this file only decides WHICH half of it applies.
//
// Unlike GApps/Magisk (section 6 of REQUIREMENTS.md), this IS our own 100% free code -- the
// "never host the binary" restriction does not apply. The reason for downloading it instead
// of building it on the spot is purely technical: they are Android/bionic binaries that need
// the complete AOSP toolchain to build, not something redroid-forge's normal build can do.
//
// [PENDING] today it reads the artifacts from a local folder (REDROID_HWENC_ARTIFACTS_DIR)
// because redroid-hwenc does not publish a release yet -- when one exists, this would have to
// download it from there instead of assuming they are already on disk.

const svc = require('../../lib/codec2Service');

function prepareCreate() {
  return svc.prepareCreate();
}

async function integrate(containerId, ctx = {}) {
  await svc.installFiles(containerId);
  await svc.patchMediaCodecsXml(containerId, ctx, { addEncoder: true, addDecoders: false });
}

async function ensureHostInfraReady() {
  await svc.ensureHostInfraReady();
}

async function ensureRuntimeReady(containerId) {
  await svc.ensureRuntimeReady(containerId);
}

module.exports = {
  prepareCreate, integrate, ensureHostInfraReady, ensureRuntimeReady,
  REQUIRED_BOOT_FLAGS: svc.REQUIRED_BOOT_FLAGS,
};

if (require.main === module) {
  const containerId = process.argv[2];
  if (!containerId) {
    console.error('Usage: node integrate.js <containerId>');
    process.exit(1);
  }
  integrate(containerId).catch((e) => { console.error(e); process.exit(1); });
}

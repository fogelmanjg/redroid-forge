'use strict';

// hwdec module (stages 3, 4, 5 and 6 -- see manifest.json, moduleRunner.js and
// docs/ARCHITECTURE.md): turns on hardware video DECODE only. Encode is the separate "hwenc"
// module (../hwenc/integrate.js) -- see that file's header for why they were split. Both
// share the same underlying Codec2 VA-API HAL service, daemon and media_codecs.xml file in
// backend/src/lib/codec2Service.js; this file only decides that it is allowed to touch the
// decoder half of it, never the encoder one.

const svc = require('../../lib/codec2Service');

function prepareCreate() {
  return svc.prepareCreate();
}

async function integrate(containerId, ctx = {}) {
  await svc.installFiles(containerId);
  await svc.patchMediaCodecsXml(containerId, ctx, { addEncoder: false, addDecoders: true });
}

async function ensureHostInfraReady() {
  await svc.ensureHostInfraReady();
}

async function ensureRuntimeReady(containerId) {
  await svc.ensureRuntimeReady(containerId);
}

module.exports = { prepareCreate, integrate, ensureHostInfraReady, ensureRuntimeReady };

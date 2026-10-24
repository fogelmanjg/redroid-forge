#!/usr/bin/env node
'use strict';

// wifi-interno module (stages 4 and 6 -- see manifest.json, moduleRunner.js).
// The kernel-side wiring (hwsim phy claiming, svc wifi enable, cmd wifi
// connect-network) stays hand-wired in routes/instances.js (ids.includes
// ('wifi-interno')) -- it predates moduleRunner and depends on per-instance
// state (instanceId) moduleRunner's generic stages do not pass through. This
// entry only adds the HAL-overlay half found missing 24/10/2026: see
// hwsimWifi.js's integrate()/ensureRuntimeReady() for why.

const hwsimWifi = require('../../lib/hwsimWifi');

async function integrate(containerId) {
  await hwsimWifi.integrate(containerId);
}

async function ensureRuntimeReady(containerId) {
  await hwsimWifi.ensureRuntimeReady(containerId);
}

module.exports = { integrate, ensureRuntimeReady };

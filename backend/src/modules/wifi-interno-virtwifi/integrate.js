#!/usr/bin/env node
'use strict';

// wifi-interno-virtwifi module (stages 4, 5 and 6 -- see manifest.json, moduleRunner.js).
// EXPERIMENTAL alternative backend for the same fake-wifi HAL as "wifi-interno"
// (mac80211_hwsim) -- see backend/src/lib/virtWifi.js for why this is its own module
// instead of a change to wifi-interno.json/hwsimWifi.js.

const virtWifi = require('../../lib/virtWifi');

async function integrate(containerId) {
  await virtWifi.integrate(containerId);
}

async function ensureHostInfraReady() {
  await virtWifi.ensureHostInfraReady();
}

async function ensureRuntimeReady(containerId) {
  await virtWifi.ensureRuntimeReady(containerId);
}

module.exports = { integrate, ensureHostInfraReady, ensureRuntimeReady };

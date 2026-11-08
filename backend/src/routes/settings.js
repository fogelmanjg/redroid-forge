const express = require('express');
const settings = require('../lib/settings');
const permissions = require('../lib/permissions');
const hwAccel = require('../lib/hwAccel');
const httpListeners = require('../lib/httpListeners');
const { IP_SHAPE_RE } = require('../lib/instanceParams');

const router = express.Router();

router.get('/', (req, res) => {
  res.json(settings.get());
});

// Admin only (docs/ROADMAP.md Phase 7) -- this changes where every instance's backups land,
// which interfaces are offered at all, and (appBindHosts) this app's OWN listen addresses -- none
// of it scoped to any one instance's ownership.
router.put('/', async (req, res) => {
  if (!permissions.canManageSettings(req.user)) return res.status(403).json({ error: 'Admin only' });
  const {
    backupDir, networkInterfaceOverrides, appBindHosts, operatorPoolMaxVcpus, operatorPoolMaxMemoryMb, encodeBackend,
  } = req.body || {};
  if (backupDir !== undefined && (typeof backupDir !== 'string' || backupDir.trim() === '')) {
    return res.status(400).json({ error: 'backupDir must be a non-empty string' });
  }
  if (networkInterfaceOverrides !== undefined) {
    if (typeof networkInterfaceOverrides !== 'object' || networkInterfaceOverrides === null || Array.isArray(networkInterfaceOverrides)) {
      return res.status(400).json({ error: 'networkInterfaceOverrides must be an object of {ifaceName: boolean}' });
    }
    for (const [name, value] of Object.entries(networkInterfaceOverrides)) {
      if (typeof value !== 'boolean') {
        return res.status(400).json({ error: `networkInterfaceOverrides["${name}"] must be a boolean` });
      }
    }
  }
  // 127.0.0.1 is implicit (server.js always binds it regardless) and never needs to be listed
  // here -- an empty array = "nothing beyond localhost, or REDROID_FORGE_BIND_HOST" (server.js).
  if (appBindHosts !== undefined) {
    if (!Array.isArray(appBindHosts)) {
      return res.status(400).json({ error: 'appBindHosts must be an array of IP addresses' });
    }
    for (const h of appBindHosts) {
      if (typeof h !== 'string' || !IP_SHAPE_RE.test(h)) {
        return res.status(400).json({ error: `appBindHosts contains an invalid address: ${JSON.stringify(h)}` });
      }
    }
  }
  // Shared ceiling across every operator at once (src/lib/quotas.js) -- null/empty = unlimited.
  for (const [key, value] of [['operatorPoolMaxVcpus', operatorPoolMaxVcpus], ['operatorPoolMaxMemoryMb', operatorPoolMaxMemoryMb]]) {
    if (value !== undefined && value !== null && value !== '' && !(Number.isInteger(value) && value > 0)) {
      return res.status(400).json({ error: `${key} must be a positive integer, or null/empty to leave it unlimited` });
    }
  }
  if (encodeBackend !== undefined && encodeBackend !== null && encodeBackend !== 'legacy' && encodeBackend !== 'ffmpeg') {
    return res.status(400).json({ error: 'encodeBackend must be "legacy", "ffmpeg", or null (automatic)' });
  }
  const patch = {};
  if (backupDir !== undefined) patch.backupDir = backupDir.trim();
  if (networkInterfaceOverrides !== undefined) patch.networkInterfaceOverrides = networkInterfaceOverrides;
  const beforeAppBindHosts = settings.get().appBindHosts;
  if (appBindHosts !== undefined) {
    const deduped = [...new Set(appBindHosts)].filter((h) => h !== '127.0.0.1');
    patch.appBindHosts = deduped.includes('0.0.0.0') ? ['0.0.0.0'] : deduped;
  }
  if (operatorPoolMaxVcpus !== undefined) patch.operatorPoolMaxVcpus = operatorPoolMaxVcpus || null;
  if (operatorPoolMaxMemoryMb !== undefined) patch.operatorPoolMaxMemoryMb = operatorPoolMaxMemoryMb || null;
  const beforeEncodeBackend = settings.get().encodeBackend;
  if (encodeBackend !== undefined) patch.encodeBackend = encodeBackend || null;
  const updated = settings.update(patch);
  // Unlike authMode (needs a full app restart, never automated -- see auth.js's own comment),
  // this one can be hot-applied: hwAccel.restartDaemonWithCurrentSettings() waits for the old
  // native daemon to actually exit before relaunching it with the new backend (see its own
  // comment on why that matters). It briefly cuts hw-accel for EVERY instance on this host (the
  // daemon is shared, not per-instance -- see settings.js's comment on encodeBackend), the same
  // kind of blip the daemon's own crash-restart supervisor already causes on its own. Never
  // fails the request: the setting is saved either way, and a manual restart still applies it if
  // this hot-restart itself has trouble.
  if (encodeBackend !== undefined && patch.encodeBackend !== beforeEncodeBackend) {
    try {
      await hwAccel.restartDaemonWithCurrentSettings();
    } catch (e) {
      console.warn(`[settings] could not relaunch the VA-API daemon with the new encode backend: ${e.message}`);
    }
  }
  // Same "hot-apply, never fail the request over it" reasoning as encodeBackend above, but for
  // this app's OWN listeners (lib/httpListeners.js) instead of the native daemon -- a changed
  // appBindHosts used to need a manual `docker compose restart` (real gotcha, 28/10/2026: "up -d"
  // alone does nothing, since this setting lives in data, not .env/the image); now the close+
  // relisten happens here instead. Compared by value, not reference: patch.appBindHosts is a new
  // deduped array every time, so `!==` would "change" on every save even with the same hosts.
  const appBindHostsChanged = appBindHosts !== undefined && JSON.stringify([...patch.appBindHosts].sort())
    !== JSON.stringify([...beforeAppBindHosts].sort());
  // Responds BEFORE restarting, unlike encodeBackend above: the admin's own request may itself be
  // arriving on the very address about to be closed, and httpListeners.closeAll() waits (with a
  // timeout) for that connection to end -- awaiting it before res.json() would deadlock the
  // request against its own response. The setting is already saved either way (settings.update()
  // ran above), so there's nothing wrong with the client getting its answer first.
  res.json(updated);
  if (appBindHostsChanged) {
    try {
      await httpListeners.restart();
    } catch (e) {
      console.warn(`[settings] could not rebind this app's own listeners with the new network settings: ${e.message}`);
    }
  }
});

module.exports = router;

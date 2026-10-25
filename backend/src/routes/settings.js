const express = require('express');
const settings = require('../lib/settings');
const permissions = require('../lib/permissions');
const { IP_SHAPE_RE } = require('../lib/instanceParams');

const router = express.Router();

router.get('/', (req, res) => {
  res.json(settings.get());
});

// Admin only (docs/ROADMAP.md Phase 7) -- this changes where every instance's backups land,
// which interfaces are offered at all, and (appBindHost) this app's OWN listen address -- none
// of it scoped to any one instance's ownership.
router.put('/', (req, res) => {
  if (!permissions.canManageSettings(req.user)) return res.status(403).json({ error: 'Admin only' });
  const { backupDir, networkInterfaceOverrides, appBindHost, operatorPoolMaxVcpus, operatorPoolMaxMemoryMb } = req.body || {};
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
  // null/empty string = "defer to REDROID_FORGE_BIND_HOST / 127.0.0.1" (server.js) -- not an
  // error, that is the explicit way back to the env-var default.
  if (appBindHost !== undefined && appBindHost !== null && appBindHost !== '' && !IP_SHAPE_RE.test(appBindHost)) {
    return res.status(400).json({ error: 'appBindHost must be an IP address, or null/empty to clear it' });
  }
  // Shared ceiling across every operator at once (src/lib/quotas.js) -- null/empty = unlimited,
  // same convention as appBindHost just above.
  for (const [key, value] of [['operatorPoolMaxVcpus', operatorPoolMaxVcpus], ['operatorPoolMaxMemoryMb', operatorPoolMaxMemoryMb]]) {
    if (value !== undefined && value !== null && value !== '' && !(Number.isInteger(value) && value > 0)) {
      return res.status(400).json({ error: `${key} must be a positive integer, or null/empty to leave it unlimited` });
    }
  }
  const patch = {};
  if (backupDir !== undefined) patch.backupDir = backupDir.trim();
  if (networkInterfaceOverrides !== undefined) patch.networkInterfaceOverrides = networkInterfaceOverrides;
  if (appBindHost !== undefined) patch.appBindHost = appBindHost || null;
  if (operatorPoolMaxVcpus !== undefined) patch.operatorPoolMaxVcpus = operatorPoolMaxVcpus || null;
  if (operatorPoolMaxMemoryMb !== undefined) patch.operatorPoolMaxMemoryMb = operatorPoolMaxMemoryMb || null;
  res.json(settings.update(patch));
});

module.exports = router;

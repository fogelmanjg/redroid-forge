const express = require('express');
const settings = require('../lib/settings');
const permissions = require('../lib/permissions');
const { IP_SHAPE_RE } = require('../lib/instanceParams');

const router = express.Router();

router.get('/', (req, res) => {
  res.json(settings.get());
});

// Admin only (docs/ROADMAP.md Phase 7) -- this changes where every instance's backups land,
// which interfaces are offered at all, and (appBindHosts) this app's OWN listen addresses -- none
// of it scoped to any one instance's ownership.
router.put('/', (req, res) => {
  if (!permissions.canManageSettings(req.user)) return res.status(403).json({ error: 'Admin only' });
  const { backupDir, networkInterfaceOverrides, appBindHosts, operatorPoolMaxVcpus, operatorPoolMaxMemoryMb } = req.body || {};
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
  const patch = {};
  if (backupDir !== undefined) patch.backupDir = backupDir.trim();
  if (networkInterfaceOverrides !== undefined) patch.networkInterfaceOverrides = networkInterfaceOverrides;
  if (appBindHosts !== undefined) {
    const deduped = [...new Set(appBindHosts)].filter((h) => h !== '127.0.0.1');
    patch.appBindHosts = deduped.includes('0.0.0.0') ? ['0.0.0.0'] : deduped;
  }
  if (operatorPoolMaxVcpus !== undefined) patch.operatorPoolMaxVcpus = operatorPoolMaxVcpus || null;
  if (operatorPoolMaxMemoryMb !== undefined) patch.operatorPoolMaxMemoryMb = operatorPoolMaxMemoryMb || null;
  res.json(settings.update(patch));
});

module.exports = router;

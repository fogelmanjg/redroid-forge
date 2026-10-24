const express = require('express');
const settings = require('../lib/settings');
const permissions = require('../lib/permissions');

const router = express.Router();

router.get('/', (req, res) => {
  res.json(settings.get());
});

// Admin only (docs/ROADMAP.md Phase 7) -- this changes where every instance's backups land,
// not scoped to any one instance's ownership.
router.put('/', (req, res) => {
  if (!permissions.canManageSettings(req.user)) return res.status(403).json({ error: 'Admin only' });
  const { backupDir, networkInterfaceOverrides } = req.body || {};
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
  const patch = {};
  if (backupDir !== undefined) patch.backupDir = backupDir.trim();
  if (networkInterfaceOverrides !== undefined) patch.networkInterfaceOverrides = networkInterfaceOverrides;
  res.json(settings.update(patch));
});

module.exports = router;

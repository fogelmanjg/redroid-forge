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
  const { backupDir } = req.body || {};
  if (backupDir !== undefined && (typeof backupDir !== 'string' || backupDir.trim() === '')) {
    return res.status(400).json({ error: 'backupDir must be a non-empty string' });
  }
  res.json(settings.update(backupDir !== undefined ? { backupDir: backupDir.trim() } : {}));
});

module.exports = router;

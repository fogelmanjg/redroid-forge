const express = require('express');
const backup = require('../lib/backup');
const settings = require('../lib/settings');
const permissions = require('../lib/permissions');

const router = express.Router();

// Not instance-scoped on purpose -- see routes/instances.js's /:id/backup and /:id/restore
// comment. Any instance can restore from any backup in the configured folder. Listing is
// visible to anyone logged in (read-only, low sensitivity -- just file names/sizes/dates);
// deleting needs "backup-restore" generically (no instance to scope ownership against, same
// as "create" -- see permissions.can()'s own handling of a missing instance).
router.get('/', (req, res) => {
  res.json(backup.listBackups(settings.get().backupDir));
});

router.delete('/:file', (req, res) => {
  if (!permissions.can(req.user, 'backup-restore')) return res.status(403).json({ error: 'Not allowed: missing "backup-restore"' });
  try {
    backup.deleteBackup(settings.get().backupDir, req.params.file);
    res.status(204).end();
  } catch (e) {
    const status = e.httpStatus >= 400 && e.httpStatus < 600 ? e.httpStatus : 500;
    res.status(status).json({ error: e.message });
  }
});

module.exports = router;

const express = require('express');
const backup = require('../lib/backup');
const settings = require('../lib/settings');
const permissions = require('../lib/permissions');
const store = require('../lib/store');

const router = express.Router();

// Not instance-scoped on purpose -- see routes/instances.js's /:id/backup and /:id/restore
// comment. Any instance can restore from any backup in the configured folder. Listing is
// visible to anyone logged in (read-only, low sensitivity -- just file names/sizes/dates);
// deleting needs "backup-restore" generically (no instance to scope ownership against, same
// as "create" -- see permissions.can()'s own handling of a missing instance).
//
// 1.0.0-beta.8: only the backups of instances the user owns (or owned when the backup was made) --
// see permissions.canAccessBackup. Before, everyone saw, restored and deleted every backup, so an
// operator could restore someone else's /data (their Google accounts, app sessions) into their own
// instance.
router.get('/', (req, res) => {
  const instances = store.readAll();
  res.json(backup.listBackups(settings.get().backupDir).filter((b) => permissions.canAccessBackup(req.user, b.meta, instances)));
});

router.delete('/:file', (req, res) => {
  if (!permissions.can(req.user, 'backup-restore')) return res.status(403).json({ error: 'Not allowed: missing "backup-restore"' });
  try {
    const dir = settings.get().backupDir;
    if (!permissions.canAccessBackup(req.user, backup.readMeta(dir, req.params.file), store.readAll())) {
      return res.status(403).json({ error: 'Not allowed: this backup belongs to an instance you do not own' });
    }
    backup.deleteBackup(dir, req.params.file);
    res.status(204).end();
  } catch (e) {
    const status = e.httpStatus >= 400 && e.httpStatus < 600 ? e.httpStatus : 500;
    res.status(status).json({ error: e.message });
  }
});

module.exports = router;

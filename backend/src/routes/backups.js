const express = require('express');
const backup = require('../lib/backup');
const settings = require('../lib/settings');

const router = express.Router();

// Not instance-scoped on purpose -- see routes/instances.js's /:id/backup and /:id/restore
// comment. Any instance can restore from any backup in the configured folder.
router.get('/', (req, res) => {
  res.json(backup.listBackups(settings.get().backupDir));
});

router.delete('/:file', (req, res) => {
  try {
    backup.deleteBackup(settings.get().backupDir, req.params.file);
    res.status(204).end();
  } catch (e) {
    const status = e.httpStatus >= 400 && e.httpStatus < 600 ? e.httpStatus : 500;
    res.status(status).json({ error: e.message });
  }
});

module.exports = router;

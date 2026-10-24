const express = require('express');
const backup = require('../lib/backup');
const settings = require('../lib/settings');

const router = express.Router();

// Not instance-scoped on purpose -- see routes/instances.js's /:id/backup and /:id/restore
// comment. Any instance can restore from any backup in the configured folder.
router.get('/', (req, res) => {
  res.json(backup.listBackups(settings.get().backupDir));
});

module.exports = router;

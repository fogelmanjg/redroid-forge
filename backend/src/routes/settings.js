const express = require('express');
const settings = require('../lib/settings');

const router = express.Router();

router.get('/', (req, res) => {
  res.json(settings.get());
});

router.put('/', (req, res) => {
  const { backupDir } = req.body || {};
  if (backupDir !== undefined && (typeof backupDir !== 'string' || backupDir.trim() === '')) {
    return res.status(400).json({ error: 'backupDir must be a non-empty string' });
  }
  res.json(settings.update(backupDir !== undefined ? { backupDir: backupDir.trim() } : {}));
});

module.exports = router;

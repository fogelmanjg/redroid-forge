const os = require('os');
const express = require('express');
const doctor = require('../lib/doctor');
const permissions = require('../lib/permissions');
const store = require('../lib/store');

const router = express.Router();

// The full list is admin only (1.0.0-beta.11): it describes the host (hardware, firewall, GPU
// stack) and every instance on it. Anyone else gets doctor.runForUser -- the checks about their
// own instances plus a yes/no "the host has a problem, ask your admin".
router.get('/', async (req, res) => {
  try {
    if (!permissions.canManageSettings(req.user)) {
      return res.json(await doctor.runForUser(permissions.visibleInstances(req.user, store.readAll())));
    }
    const checks = await doctor.runAll();
    res.json(checks);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// The one Doctor fact the rest of the UI needs for everyone: the core count for the per-core
// CPU picker on an instance's resources row.
router.get('/cores', (req, res) => {
  res.json({ cores: os.cpus().length });
});

module.exports = router;

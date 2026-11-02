const express = require('express');
const versionCheck = require('../lib/versionCheck');

const router = express.Router();

// Installed version only -- no network call, safe to show on every page load.
router.get('/', (req, res) => {
  res.json({ installed: versionCheck.getInstalledVersion() });
});

// The ONLY thing that ever calls GitHub here -- a person pressing "Chequear" right now. No
// automatic mode, no cache, no scheduler (see versionCheck.js).
router.post('/check', async (req, res) => {
  try {
    const r = await versionCheck.checkForUpdate();
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message, code: e.code || null });
  }
});

module.exports = router;

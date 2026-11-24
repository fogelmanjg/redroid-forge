const express = require('express');
const versionCheck = require('../lib/versionCheck');

const router = express.Router();

// Installed version only -- no network call, safe to show on every page load.
router.get('/', (req, res) => {
  // repoUrl (1.0.0-beta.12): the header links the version to its release notes and the project page.
  res.json({ installed: versionCheck.getInstalledVersion(), repoUrl: `https://github.com/${versionCheck.REPO}` });
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

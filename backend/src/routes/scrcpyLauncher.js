'use strict';

// "Test local scrcpy" (1.0.0-beta.5) -- see lib/scrcpyLauncherTest.js for the whole flow. Any
// logged-in user may run it: it only proves THEIR browser + launcher + network reach this host, and
// what it enables lives in their own browser (localStorage), not on the server.
//
//   POST /api/scrcpy-launcher/test        -> { code, port, expiresInMs, firewall }
//   GET  /api/scrcpy-launcher/test/:code  -> { state: pending|ok|expired|unknown, launcherVersion, scrcpyVersion, adbVersion, firewall }

const express = require('express');
const scrcpyLauncherTest = require('../lib/scrcpyLauncherTest');

const router = express.Router();

router.post('/test', async (req, res) => {
  try {
    res.json(await scrcpyLauncherTest.getShared().start());
  } catch (e) {
    res.status(e.httpStatus || 500).json({ error: e.message });
  }
});

router.get('/test/:code', (req, res) => {
  if (!/^[0-9a-f]{32}$/.test(req.params.code)) return res.status(400).json({ error: 'Bad code' });
  res.json(scrcpyLauncherTest.getShared().result(req.params.code));
});

module.exports = router;

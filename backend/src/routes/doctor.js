const express = require('express');
const doctor = require('../lib/doctor');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const checks = await doctor.runAll();
    res.json(checks);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

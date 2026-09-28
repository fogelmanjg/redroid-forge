const express = require('express');
const runtime = require('../lib/dockerRuntime');
const catalog = require('../../images.json');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const localTags = await runtime.listLocalImageTags();
    res.json(catalog.map((img) => ({ ...img, present: localTags.has(img.dockerImage) })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

const express = require('express');
const store = require('../lib/knownDbStore');

const router = express.Router();

// Solo lectura (sub-paso 2 de docs/BASE-COMBINACIONES.md). La actualizacion
// desde el repo externo es el sub-paso 3 y no existe todavia.
router.get('/', (req, res) => {
  try {
    res.json(store.summarize(store.loadCurrent()));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/combinaciones', (req, res) => {
  try {
    const { db, source } = store.loadCurrent();
    res.json({
      serial: db.serial,
      source,
      combinaciones: db.combinaciones.map((c) => ({
        ...c,
        baseInfo: db.bases.find((b) => b.id === c.base) || null,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

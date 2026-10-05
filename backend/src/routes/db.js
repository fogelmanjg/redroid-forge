const express = require('express');
const store = require('../lib/knownDbStore');
const updater = require('../lib/knownDbUpdate');

const router = express.Router();

// Lectura (sub-paso 2) + consulta/aplicacion de actualizaciones (sub-paso 3,
// docs/BASE-COMBINACIONES.md). Aplicar es SIEMPRE una accion explicita (POST).
router.get('/', (req, res) => {
  try {
    const cfg = updater.getConfig();
    res.json({
      ...store.summarize(store.loadCurrent()),
      actualizacion: {
        urlBase: cfg.baseUrl,
        chequeoAutomatico: cfg.chequeoAutomatico,
        clavesDeConfianza: updater.loadTrustedKeys().length,
        ultimoChequeo: updater.getLastCheck(),
      },
    });
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

// Consulta ahora mismo si hay una base mas nueva (no descarga ni aplica).
router.post('/check', async (req, res) => {
  const r = await updater.runCheck();
  res.status(r.ok ? 200 : 502).json(r);
});

// Descarga, verifica la firma y aplica. Solo por accion del usuario.
router.post('/update', async (req, res) => {
  try {
    const { db } = store.loadCurrent();
    const cfg = updater.getConfig();
    const r = await updater.applyUpdate({
      baseUrl: cfg.baseUrl,
      trustedKeys: updater.loadTrustedKeys(),
      current: db,
    });
    res.json(r);
  } catch (e) {
    const status = { red: 502, http: 502, tamano: 502, formato: 502, firma: 422, rechazada: 409, 'sin-claves': 412 }[e.code] || 500;
    res.status(status).json({ error: e.message, code: e.code || null });
  }
});

module.exports = router;

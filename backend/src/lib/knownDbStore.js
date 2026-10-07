const fs = require('fs');
const path = require('path');
const knownDb = require('./knownDb');

// Carga de la base de combinaciones conocidas (docs/KNOWN-COMBINATIONS.md,
// secciones 4.1 y 5). Dos fuentes: el snapshot que viaja DENTRO de la release
// (confiable por venir con el codigo) y, mas adelante (sub-paso 3), una copia
// descargada y verificada en data/db/. Se usa la de mayor `serial`. Este
// modulo solo LEE: la descarga/verificacion/actualizacion no esta todavia.

const SNAPSHOT_PATH = path.join(__dirname, '..', '..', 'db', 'snapshot.json');
const CACHE_PATH = path.join(__dirname, '..', '..', 'data', 'db', 'database.json');

function readValidated(file) {
  const db = JSON.parse(fs.readFileSync(file, 'utf-8'));
  return knownDb.validateDatabase(db);
}

// -> { db, source: 'snapshot'|'actualizada', warnings: [string] }
// Un snapshot ilegible es un error real (esta roto el propio release) y se
// propaga; una copia descargada ilegible/invalida NO tumba nada: se ignora
// con un aviso y se sigue con el snapshot.
function loadCurrent({ snapshotPath = SNAPSHOT_PATH, cachePath = CACHE_PATH } = {}) {
  const warnings = [];
  const snapshot = readValidated(snapshotPath);
  let cached = null;
  if (fs.existsSync(cachePath)) {
    try {
      cached = readValidated(cachePath);
      const accept = knownDb.checkUpdateAcceptable(cached, null, require('../../package.json').version);
      if (!accept.ok) {
        warnings.push(`se ignora la base descargada: ${accept.motivo}`);
        cached = null;
      }
    } catch (e) {
      warnings.push(`se ignora la base descargada (ilegible o invalida): ${e.message}`);
      cached = null;
    }
  }
  const db = knownDb.pickNewest(snapshot, cached);
  return { db, source: db === cached ? 'actualizada' : 'snapshot', warnings };
}

function summarize({ db, source, warnings }) {
  const oficiales = db.combinaciones.filter((c) => c.soporte === 'oficial').length;
  return {
    schemaVersion: db.schemaVersion,
    serial: db.serial,
    generatedAt: db.generatedAt,
    source,
    counts: {
      bases: db.bases.length,
      paquetes: db.paquetes.length,
      combinaciones: db.combinaciones.length,
      oficiales,
    },
    warnings,
  };
}

module.exports = { loadCurrent, summarize, SNAPSHOT_PATH, CACHE_PATH };

const fs = require('fs');
const path = require('path');
const knownDb = require('./knownDb');

// Loading of the known-combinations database (docs/KNOWN-COMBINATIONS.md,
// sections 4.1 and 5). Two sources: the snapshot that travels INSIDE the release
// (trusted because it comes with the code) and a downloaded and verified copy in
// data/db/. The one with the higher `serial` is used. This module only READS:
// downloading/verifying/updating lives in knownDbUpdate.js.

const SNAPSHOT_PATH = path.join(__dirname, '..', '..', 'db', 'snapshot.json');
const CACHE_PATH = path.join(__dirname, '..', '..', 'data', 'db', 'database.json');

function readValidated(file) {
  const db = JSON.parse(fs.readFileSync(file, 'utf-8'));
  return knownDb.validateDatabase(db);
}

// -> { db, source: 'snapshot'|'actualizada', warnings: [string] }
// An unreadable snapshot is a real error (the release itself is broken) and
// propagates; an unreadable/invalid downloaded copy does NOT bring anything
// down: it is ignored with a warning and the snapshot is used.
function loadCurrent({ snapshotPath = SNAPSHOT_PATH, cachePath = CACHE_PATH } = {}) {
  const warnings = [];
  const snapshot = readValidated(snapshotPath);
  let cached = null;
  if (fs.existsSync(cachePath)) {
    try {
      cached = readValidated(cachePath);
      const accept = knownDb.checkUpdateAcceptable(cached, null, require('../../package.json').version);
      if (!accept.ok) {
        warnings.push(`the downloaded database is ignored: ${accept.motivo}`);
        cached = null;
      }
    } catch (e) {
      warnings.push(`the downloaded database is ignored (unreadable or invalid): ${e.message}`);
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

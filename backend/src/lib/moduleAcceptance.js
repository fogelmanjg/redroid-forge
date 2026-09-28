const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DEFAULT_STORE_FILE = path.join(DATA_DIR, 'module-acceptances.json');

// Registro de "usuario/instancia acepto el manifest version N de modulo X, en
// tal fecha" (seccion 5 de docs/REQUIREMENTS.md). No hay auth todavia (Fase
// 6), asi que la aceptacion vale para toda la instalacion (un solo registro
// por modulo+version alcanza para "vigente"), pero se guarda el contexto de
// usuario/instancia disponible para auditoria y para cuando la Fase 6 sume
// usuarios reales.
let storeFile = DEFAULT_STORE_FILE;

function ensureDataDir() {
  const dir = path.dirname(storeFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readAll() {
  ensureDataDir();
  if (!fs.existsSync(storeFile)) return [];
  try {
    return JSON.parse(fs.readFileSync(storeFile, 'utf-8'));
  } catch {
    return [];
  }
}

// Escritura atomica (tmp + rename), mismo patron que lib/store.js.
function writeAll(records) {
  ensureDataDir();
  const tmp = `${storeFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2));
  fs.renameSync(tmp, storeFile);
}

function record({ moduleId, version, userId, instanceId, instanceName }) {
  const all = readAll();
  const entry = {
    id: crypto.randomUUID(),
    moduleId,
    version,
    userId: userId || 'local',
    instanceId: instanceId || null,
    instanceName: instanceName || null,
    acceptedAt: new Date().toISOString(),
  };
  all.push(entry);
  writeAll(all);
  return entry;
}

// La aceptacion mas reciente registrada para un modulo, sin importar version
// (para mostrar "aceptaste la v1, la actual es v2" en vez de solo si/no).
function latestFor(moduleId) {
  const all = readAll().filter((a) => a.moduleId === moduleId);
  if (all.length === 0) return null;
  return all.reduce((a, b) => (new Date(a.acceptedAt) >= new Date(b.acceptedAt) ? a : b));
}

// Vigente = la aceptacion mas reciente es para la version actual del
// manifest. Si el manifest subio de version (cambio el disclaimer o lo que
// toca), deja de estar vigente y hay que volver a aceptar.
function isAccepted(moduleId, currentVersion) {
  const latest = latestFor(moduleId);
  return !!latest && latest.version === currentVersion;
}

// Solo para tests: aisla el archivo de datos para no pisar
// backend/data/module-acceptances.json real ni depender de su estado previo.
function _setStoreFileForTests(file) {
  storeFile = file || DEFAULT_STORE_FILE;
}

module.exports = {
  record, latestFor, isAccepted, readAll, _setStoreFileForTests,
};

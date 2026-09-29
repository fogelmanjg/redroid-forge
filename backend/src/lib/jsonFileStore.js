const fs = require('fs');
const path = require('path');

// Primitivas compartidas por store.js (instancias) y moduleAcceptance.js
// (aceptaciones de modulo) -- mismo patron ("leer con fallback a [] si no
// existe o esta corrupto" + escritura atomica via tmp+rename) que antes
// vivia duplicado byte a byte en los dos archivos.

function ensureDirFor(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJsonArray(filePath) {
  ensureDirFor(filePath);
  if (!fs.existsSync(filePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return [];
  }
}

// Escritura atomica (tmp + rename) para no dejar el archivo corrupto si el
// proceso muere a mitad de un write.
function writeJsonArray(filePath, data) {
  ensureDirFor(filePath);
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

module.exports = { readJsonArray, writeJsonArray };

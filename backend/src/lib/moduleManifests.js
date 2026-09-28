const fs = require('fs');
const path = require('path');

const MANIFESTS_DIR = path.join(__dirname, '..', 'modules', 'manifests');

// Schema del manifest de modulo (seccion 5 de docs/REQUIREMENTS.md). Se
// valida a mano en vez de sumar una dependencia de JSON Schema — son pocos
// campos y el proyecto ya evita dependencias pesadas por decision de stack.
function validateManifest(m, sourceLabel) {
  const errors = [];
  const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

  if (!isNonEmptyString(m.id)) errors.push('falta "id"');
  if (!isNonEmptyString(m.nombre)) errors.push('falta "nombre"');
  if (!isNonEmptyString(m.descripcion)) errors.push('falta "descripcion"');
  if (typeof m.esTerceroNoLibre !== 'boolean') errors.push('"esTerceroNoLibre" debe ser boolean');

  // Seccion 6: un modulo de terceros no libre siempre declara de donde sale
  // y bajo que licencia, para el disclaimer obligatorio del contrato.
  if (m.esTerceroNoLibre) {
    if (!isNonEmptyString(m.licencia)) errors.push('los modulos de terceros no libres requieren "licencia"');
    if (!isNonEmptyString(m.origen)) errors.push('los modulos de terceros no libres requieren "origen"');
  }

  if (!Array.isArray(m.queToca) || m.queToca.length === 0) {
    errors.push('"queToca" debe ser un array no vacio');
  }

  if (!m.compatibleCon || typeof m.compatibleCon !== 'object') {
    errors.push('falta "compatibleCon"');
  } else {
    if (!Array.isArray(m.compatibleCon.androidVersion) || m.compatibleCon.androidVersion.length === 0) {
      errors.push('"compatibleCon.androidVersion" debe ser un array no vacio');
    }
    if (!Array.isArray(m.compatibleCon.gpuMode) || m.compatibleCon.gpuMode.length === 0) {
      errors.push('"compatibleCon.gpuMode" debe ser un array no vacio');
    }
  }

  if (!Number.isInteger(m.version) || m.version < 1) {
    errors.push('"version" debe ser un entero >= 1');
  }

  if (errors.length > 0) {
    throw new Error(`Manifest de modulo invalido (${sourceLabel}): ${errors.join('; ')}`);
  }
}

let cache = null;

function loadAll() {
  if (cache) return cache;
  const files = fs.readdirSync(MANIFESTS_DIR).filter((f) => f.endsWith('.json'));
  const byId = new Map();
  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(MANIFESTS_DIR, file), 'utf-8'));
    validateManifest(raw, file);
    if (byId.has(raw.id)) {
      throw new Error(`Manifest de modulo duplicado: id "${raw.id}" repetido en ${file}`);
    }
    byId.set(raw.id, raw);
  }
  cache = byId;
  return byId;
}

function list() {
  return Array.from(loadAll().values());
}

function get(id) {
  return loadAll().get(id) || null;
}

// `compatibleCon` decide si un modulo se puede ofrecer/activar para una
// imagen dada. Reusa los mismos campos `androidVersion`/`gpuMode` que el
// catalogo (backend/images.json) ya suma desde la Fase 1 para el tier de
// soporte, en vez de introducir metadata de compatibilidad nueva.
function isCompatible(manifest, image) {
  if (!manifest || !image) return false;
  return (
    manifest.compatibleCon.androidVersion.includes(image.androidVersion)
    && manifest.compatibleCon.gpuMode.includes(image.gpuMode)
  );
}

// Explica por que no es compatible (o null si lo es), para no romper en
// silencio — mismo criterio de transparencia que el resto del proyecto.
function incompatibilityReason(manifest, image) {
  if (!manifest.compatibleCon.androidVersion.includes(image.androidVersion)) {
    return `"${manifest.nombre}" no esta declarado compatible con Android ${image.androidVersion}`
      + ` (compatible con: ${manifest.compatibleCon.androidVersion.join(', ')}).`;
  }
  if (!manifest.compatibleCon.gpuMode.includes(image.gpuMode)) {
    return `"${manifest.nombre}" no esta declarado compatible con gpuMode="${image.gpuMode}"`
      + ` (compatible con: ${manifest.compatibleCon.gpuMode.join(', ')}).`;
  }
  return null;
}

// Solo para tests: los manifests son archivos estaticos del repo, no datos
// de usuario, asi que en produccion la cache nunca necesita invalidarse.
function _resetCache() { cache = null; }

module.exports = {
  MANIFESTS_DIR, list, get, isCompatible, incompatibilityReason, validateManifest, _resetCache,
};

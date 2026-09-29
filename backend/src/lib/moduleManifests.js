const fs = require('fs');
const path = require('path');

let MODULES_DIR = path.join(__dirname, '..', 'modules');
let MANIFESTS_DIR = path.join(MODULES_DIR, 'manifests');

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
// id -> carpeta absoluta que contiene el manifest.json de ese modulo. Los
// modulos con logica de ejecucion (ver moduleRunner.js) necesitan esto para
// resolver su "entry" (ej. "./integrate.js") relativo a SU PROPIA carpeta,
// no a este archivo. No se expone junto al manifest (list()/get()) para no
// filtrar paths absolutos del disco a quien consuma esos objetos (ej. el
// frontend, via el 428 de moduleGate.js) -- se pide aparte con moduleDir().
let dirCache = null;

function loadOne(manifestPath, sourceLabel, byId, dirById) {
  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  validateManifest(raw, sourceLabel);
  if (byId.has(raw.id)) {
    throw new Error(`Manifest de modulo duplicado: id "${raw.id}" repetido en ${sourceLabel}`);
  }
  byId.set(raw.id, raw);
  dirById.set(raw.id, path.dirname(manifestPath));
}

// Dos fuentes de manifest, a proposito no unificadas en una sola carpeta:
//
// 1. Archivos planos en MANIFESTS_DIR (gapps.json, magisk.json, etc.) -- los
//    modulos "puramente contrato" de la Fase 4, sin logica de ejecucion
//    propia. Se mantienen donde estan (en vez de moverlos a una carpeta por
//    modulo) para no generar conflictos de merge con otro trabajo que pueda
//    estar tocando esos mismos archivos en paralelo.
// 2. `<MODULES_DIR>/<id>/manifest.json` -- modulos con logica real (ver
//    backend/src/modules/hwenc/), que ya viven en su propia carpeta junto a
//    su "entry" y demas archivos. Mismo schema, se valida igual.
//
// La unicidad de "id" se valida contra las dos fuentes juntas (un mismo id
// no puede repetirse ni dentro de una fuente ni entre ambas).
function loadAll() {
  if (cache) return cache;
  const byId = new Map();
  const dirById = new Map();

  const flatFiles = fs.readdirSync(MANIFESTS_DIR).filter((f) => f.endsWith('.json'));
  for (const file of flatFiles) {
    loadOne(path.join(MANIFESTS_DIR, file), file, byId, dirById);
  }

  const manifestsDirName = path.basename(MANIFESTS_DIR);
  const moduleDirs = fs.readdirSync(MODULES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== manifestsDirName);
  for (const dir of moduleDirs) {
    const manifestPath = path.join(MODULES_DIR, dir.name, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue; // no toda carpeta bajo modules/ es un modulo (ej. modules/manifests/ ya excluida arriba)
    loadOne(manifestPath, path.join(dir.name, 'manifest.json'), byId, dirById);
  }

  cache = byId;
  dirCache = dirById;
  return byId;
}

function list() {
  return Array.from(loadAll().values());
}

function get(id) {
  return loadAll().get(id) || null;
}

// Carpeta absoluta que contiene el manifest.json (y, si lo tiene, el "entry")
// del modulo -- null si el modulo no existe.
function moduleDir(id) {
  loadAll();
  return dirCache.get(id) || null;
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
function _resetCache() { cache = null; dirCache = null; }

// Solo para tests: apunta el descubrimiento a un `modules/` de prueba (con su
// propio `manifests/` adentro), para poder probar modulos con `entry` real
// (que hacen `require()` de un archivo) sin fixtures que toquen Docker/
// child_process. Pasar null restaura la carpeta real del repo.
function _setModulesRootForTests(dir) {
  MODULES_DIR = dir || path.join(__dirname, '..', 'modules');
  MANIFESTS_DIR = path.join(MODULES_DIR, 'manifests');
  _resetCache();
}

module.exports = {
  // OJO: no se exporta MANIFESTS_DIR -- pasa a ser mutable con
  // _setModulesRootForTests, y un valor tomado al cargar el modulo quedaria
  // desactualizado despues de un cambio de raiz. Nada fuera de este archivo
  // lo consumia, asi que se da de baja en vez de exponerlo como getter.
  list,
  get,
  moduleDir,
  isCompatible,
  incompatibilityReason,
  validateManifest,
  _resetCache,
  _setModulesRootForTests,
};

const fs = require('fs');
const path = require('path');

let MODULES_DIR = path.join(__dirname, '..', 'modules');
let MANIFESTS_DIR = path.join(MODULES_DIR, 'manifests');

// Schema of the module manifest (section 5 of docs/REQUIREMENTS.md). It is
// validated by hand instead of adding a JSON Schema dependency — there are few
// fields and the project already avoids heavy dependencies by stack decision.
function validateManifest(m, sourceLabel) {
  const errors = [];
  const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

  if (!isNonEmptyString(m.id)) errors.push('missing "id"');
  if (!isNonEmptyString(m.nombre)) errors.push('missing "nombre"');
  if (!isNonEmptyString(m.descripcion)) errors.push('missing "descripcion"');
  if (typeof m.esTerceroNoLibre !== 'boolean') errors.push('"esTerceroNoLibre" must be a boolean');

  // Section 6: a non-free third-party module always declares where it comes
  // from and under which license, for the contract's mandatory disclaimer.
  if (m.esTerceroNoLibre) {
    if (!isNonEmptyString(m.licencia)) errors.push('non-free third-party modules require "licencia"');
    if (!isNonEmptyString(m.origen)) errors.push('non-free third-party modules require "origen"');
  }

  if (!Array.isArray(m.queToca) || m.queToca.length === 0) {
    errors.push('"queToca" must be a non-empty array');
  }

  if (!m.compatibleCon || typeof m.compatibleCon !== 'object') {
    errors.push('missing "compatibleCon"');
  } else {
    if (!Array.isArray(m.compatibleCon.androidVersion) || m.compatibleCon.androidVersion.length === 0) {
      errors.push('"compatibleCon.androidVersion" must be a non-empty array');
    }
    if (!Array.isArray(m.compatibleCon.gpuMode) || m.compatibleCon.gpuMode.length === 0) {
      errors.push('"compatibleCon.gpuMode" must be a non-empty array');
    }
  }

  if (!Number.isInteger(m.version) || m.version < 1) {
    errors.push('"version" must be an integer >= 1');
  }

  if (errors.length > 0) {
    throw new Error(`Invalid module manifest (${sourceLabel}): ${errors.join('; ')}`);
  }
}

let cache = null;
// id -> absolute folder that contains that module's manifest.json. Modules with
// execution logic (see moduleRunner.js) need this to resolve their "entry"
// (e.g. "./integrate.js") relative to THEIR OWN folder, not to this file. It is
// not exposed together with the manifest (list()/get()) so as not to leak
// absolute disk paths to whoever consumes those objects (e.g. the frontend,
// via moduleGate.js's 428) -- it is requested separately with moduleDir().
let dirCache = null;

function loadOne(manifestPath, sourceLabel, byId, dirById) {
  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  validateManifest(raw, sourceLabel);
  if (byId.has(raw.id)) {
    throw new Error(`Duplicate module manifest: id "${raw.id}" repeated in ${sourceLabel}`);
  }
  byId.set(raw.id, raw);
  dirById.set(raw.id, path.dirname(manifestPath));
}

// Two manifest sources, deliberately not unified in a single folder:
//
// 1. Flat files in MANIFESTS_DIR (gapps.json, magisk.json, etc.) -- the "pure
//    contract" modules of Phase 4, with no execution logic of their own. They
//    stay where they are (instead of being moved to a per-module folder) so as
//    not to create merge conflicts with other work that may be touching those
//    same files in parallel.
// 2. `<MODULES_DIR>/<id>/manifest.json` -- modules with real logic (see
//    backend/src/modules/hwenc/), which already live in their own folder next to
//    their "entry" and other files. The same schema, validated the same way.
//
// "id" uniqueness is validated against both sources together (the same id
// cannot repeat within one source or across both).
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
    if (!fs.existsSync(manifestPath)) continue; // not every folder under modules/ is a module (e.g. modules/manifests/ is already excluded above)
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

// Absolute folder that contains the module's manifest.json (and, if it has one,
// its "entry") -- null if the module does not exist.
function moduleDir(id) {
  loadAll();
  return dirCache.get(id) || null;
}

// `compatibleCon` decides whether a module can be offered/enabled for a given
// image. It reuses the same `androidVersion`/`gpuMode` fields the catalog
// (backend/images.json) has had since Phase 1 for the support tier, instead of
// introducing new compatibility metadata.
function isCompatible(manifest, image) {
  if (!manifest || !image) return false;
  return (
    manifest.compatibleCon.androidVersion.includes(image.androidVersion)
    && manifest.compatibleCon.gpuMode.includes(image.gpuMode)
  );
}

// Explains why it is not compatible (or null if it is), so as not to break
// silently — the same transparency criterion as the rest of the project.
function incompatibilityReason(manifest, image) {
  if (!manifest.compatibleCon.androidVersion.includes(image.androidVersion)) {
    return `"${manifest.nombre}" is not declared compatible with Android ${image.androidVersion}`
      + ` (compatible with: ${manifest.compatibleCon.androidVersion.join(', ')}).`;
  }
  if (!manifest.compatibleCon.gpuMode.includes(image.gpuMode)) {
    return `"${manifest.nombre}" is not declared compatible with gpuMode="${image.gpuMode}"`
      + ` (compatible with: ${manifest.compatibleCon.gpuMode.join(', ')}).`;
  }
  return null;
}

// Only for tests: the manifests are static files of the repo, not user data, so
// in production the cache never needs to be invalidated.
function _resetCache() { cache = null; dirCache = null; }

// Only for tests: points the discovery at a test `modules/` (with its own
// `manifests/` inside), so modules with a real `entry` (which `require()` a
// file) can be tested without fixtures that touch Docker/child_process.
// Passing null restores the repo's real folder.
function _setModulesRootForTests(dir) {
  MODULES_DIR = dir || path.join(__dirname, '..', 'modules');
  MANIFESTS_DIR = path.join(MODULES_DIR, 'manifests');
  _resetCache();
}

module.exports = {
  // NOTE: MANIFESTS_DIR is not exported -- it becomes mutable with
  // _setModulesRootForTests, and a value taken when the module loads would be
  // stale after a root change. Nothing outside this file consumed it, so it is
  // dropped instead of being exposed as a getter.
  list,
  get,
  moduleDir,
  isCompatible,
  incompatibilityReason,
  validateManifest,
  _resetCache,
  _setModulesRootForTests,
};

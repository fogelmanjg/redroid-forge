const crypto = require('crypto');
const fileBundle = require('./fileBundle');

// Pure core of the known-combinations database (design in
// docs/KNOWN-COMBINATIONS.md). No disk or network I/O: it receives documents
// already read, so it can be tested without Docker. Loading/updating/caching
// are in other modules (see section 7 of the doc).

const SUPPORTED_SCHEMA = 1;
const SHA256_RE = /^[0-9a-f]{64}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

const isStr = (v) => typeof v === 'string' && v.trim().length > 0;

// Hand-written validation (the same criterion as moduleManifests.js: few fields,
// no JSON Schema dependency). It collects ALL the errors before failing.
function validateDatabase(db) {
  const errors = [];
  if (!db || typeof db !== 'object') throw new Error('Invalid database: not an object');
  if (db.schemaVersion !== SUPPORTED_SCHEMA) {
    errors.push(`schemaVersion ${db.schemaVersion} not supported (expected ${SUPPORTED_SCHEMA})`);
  }
  if (!Number.isInteger(db.serial) || db.serial < 1) errors.push('"serial" must be an integer >= 1');
  if (!isStr(db.generatedAt)) errors.push('missing "generatedAt"');
  if (!isStr(db.minForgeVersion)) errors.push('missing "minForgeVersion"');
  for (const k of ['bases', 'paquetes', 'combinaciones']) {
    if (!Array.isArray(db[k])) errors.push(`"${k}" must be an array`);
  }
  if (errors.length) throw new Error(`Invalid database: ${errors.join('; ')}`);

  const ids = (arr, label) => {
    const seen = new Set();
    for (const e of arr) {
      if (!isStr(e.id)) errors.push(`${label}: entry without "id"`);
      else if (seen.has(e.id)) errors.push(`${label}: duplicate id "${e.id}"`);
      else seen.add(e.id);
    }
    return seen;
  };
  const baseIds = ids(db.bases, 'bases');
  const pkgIds = ids(db.paquetes, 'paquetes');
  ids(db.combinaciones, 'combinaciones');

  for (const b of db.bases) {
    if (!DIGEST_RE.test(b.digest || '')) errors.push(`base "${b.id}": "digest" must be sha256:<64 hex>`);
    if (!Number.isInteger(b.androidVersion)) errors.push(`base "${b.id}": "androidVersion" must be an integer`);
    if (!['vigente', 'reemplazada', 'retirada'].includes(b.estado)) {
      errors.push(`base "${b.id}": invalid "estado"`);
    }
  }
  for (const p of db.paquetes) {
    if (!['gapps', 'magisk'].includes(p.tipo)) errors.push(`package "${p.id}": invalid "tipo"`);
    if (!SHA256_RE.test(p.sha256 || '')) errors.push(`package "${p.id}": "sha256" is mandatory (64 hex)`);
    if (!isStr(p.origen)) errors.push(`package "${p.id}": missing "origen"`);
    // A package defined by FILES (GApps from the Android SDK image): "sha256" is the digest of
    // the whole set (fileBundle.bundleDigest), so it cannot disagree with the listed files.
    if (p.archivos !== undefined) {
      const problems = fileBundle.validateFiles(p.archivos);
      for (const pr of problems) errors.push(`package "${p.id}": archivos: ${pr}`);
      if (problems.length === 0 && fileBundle.bundleDigest(p.archivos) !== p.sha256) {
        errors.push(`package "${p.id}": "sha256" is not the digest of its "archivos"`);
      }
    }
  }
  const pkgType = new Map(db.paquetes.map((p) => [p.id, p.tipo]));
  for (const c of db.combinaciones) {
    if (!baseIds.has(c.base)) errors.push(`combination "${c.id}": base "${c.base}" does not exist`);
    for (const [campo, tipo] of [['gapps', 'gapps'], ['magisk', 'magisk']]) {
      if (c[campo] == null) continue;
      if (!pkgIds.has(c[campo])) errors.push(`combination "${c.id}": ${campo} package "${c[campo]}" does not exist`);
      else if (pkgType.get(c[campo]) !== tipo) errors.push(`combination "${c.id}": "${c[campo]}" is not of type ${tipo}`);
    }
    if (!c.modulos || typeof c.modulos !== 'object') errors.push(`combination "${c.id}": missing "modulos"`);
    if (!['oficial', 'comunidad'].includes(c.soporte)) errors.push(`combination "${c.id}": invalid "soporte"`);
    const vals = Array.isArray(c.validaciones) ? c.validaciones : [];
    if (c.soporte === 'oficial' && !vals.some((v) => v.resultado === 'ok')) {
      errors.push(`combination "${c.id}": "oficial" requires at least one validation with result "ok"`);
    }
    for (const v of vals) {
      if (!v.hardware || !isStr(v.hardware.vendor)) errors.push(`combination "${c.id}": validation without hardware.vendor`);
      if (!['ok', 'parcial', 'falla'].includes(v.resultado)) errors.push(`combination "${c.id}": invalid validation result`);
      // Reproducible checks (docs/KNOWN-COMBINATIONS.md 1.1): optional for
      // now, but if present they must have a valid id and result.
      if (v.chequeos !== undefined) {
        if (!Array.isArray(v.chequeos)) errors.push(`combination "${c.id}": "chequeos" must be an array`);
        else {
          for (const ch of v.chequeos) {
            if (!isStr(ch.id)) errors.push(`combination "${c.id}": check without "id"`);
            if (!['ok', 'falla', 'omitido'].includes(ch.resultado)) errors.push(`combination "${c.id}": check "${ch.id}" with an invalid result`);
          }
        }
      }
    }
  }
  if (errors.length) throw new Error(`Base invalida: ${errors.join('; ')}`);
  return db;
}

// Compares "a.b.c" versions (numeric only).
function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// Chooses among several candidate databases (the release's snapshot, the
// downloaded cache) the one with the highest serial. A tie -> the first (the snapshot).
function pickNewest(...dbs) {
  return dbs.filter(Boolean).reduce((best, d) => (best && best.serial >= d.serial ? best : d), null);
}

// Extra checks that only apply to a DOWNLOADED database (not to the snapshot that
// comes inside the release): that redroid-forge understands it and that it is not
// a rollback. Returns { ok, motivo }.
function checkUpdateAcceptable(candidate, current, forgeVersion) {
  try {
    validateDatabase(candidate);
  } catch (e) {
    return { ok: false, motivo: e.message };
  }
  if (compareVersions(candidate.minForgeVersion, forgeVersion) > 0) {
    return { ok: false, motivo: `the database requires redroid-forge >= ${candidate.minForgeVersion} (installed: ${forgeVersion})` };
  }
  if (current && candidate.serial <= current.serial) {
    return { ok: false, motivo: `serial ${candidate.serial} is not greater than the current one (${current.serial})` };
  }
  return { ok: true };
}

// ed25519 signature over the EXACT BYTES of the downloaded database.json (not
// over the re-serialized JSON). `publicKeysPem`: a list, so keys can be rotated.
function verifySignature(dataBuf, signatureBase64, publicKeysPem) {
  let sig;
  try {
    sig = Buffer.from(signatureBase64, 'base64');
  } catch {
    return false;
  }
  return publicKeysPem.some((pem) => {
    try {
      return crypto.verify(null, dataBuf, crypto.createPublicKey(pem), sig);
    } catch {
      return false;
    }
  });
}

const sameModules = (a, b) => {
  const ka = Object.keys(a || {});
  const kb = Object.keys(b || {});
  return ka.length === kb.length && ka.every((k) => b[k] === a[k]);
};

// Support verdict for an instance (section 3 of the doc). Pure.
// input: { baseDigest, gappsId, magiskId, modulos: {id: version}, hostGpuVendor }
function resolve(db, input) {
  const { baseDigest, gappsId = null, magiskId = null, modulos = {}, hostGpuVendor = null } = input;
  const motivos = [];
  const base = db.bases.find((b) => b.digest === baseDigest);
  if (!base || base.estado === 'retirada') {
    motivos.push(base ? `the base image was withdrawn from the database (${base.id})` : 'base image not recognized (unknown digest or image without a RepoDigest)');
  }
  for (const [id, tipo] of [[gappsId, 'GApps'], [magiskId, 'Magisk']]) {
    if (id && !db.paquetes.some((p) => p.id === id)) motivos.push(`${tipo} package not recognized: ${id}`);
  }
  if (motivos.length) return { nivel: 'sin-soporte', combinacion: null, motivos };

  const combo = db.combinaciones.find((c) => c.base === base.id
    && (c.gapps || null) === gappsId && (c.magisk || null) === magiskId
    && sameModules(c.modulos, modulos));

  if (!combo) {
    return {
      nivel: 'comunidad',
      combinacion: null,
      motivos: ['every piece is known, but this combination was not validated together'],
    };
  }

  const oks = (combo.validaciones || []).filter((v) => v.resultado === 'ok');
  if (combo.soporte !== 'oficial' || oks.length === 0) {
    return { nivel: 'comunidad', combinacion: combo.id, motivos: ['known combination without a complete validation'] };
  }
  if (hostGpuVendor && !oks.some((v) => v.hardware.vendor === hostGpuVendor)) {
    const vendors = [...new Set(oks.map((v) => v.hardware.vendor))].join(', ');
    return {
      nivel: 'comunidad',
      combinacion: combo.id,
      motivos: [`combination validated on ${vendors}, but this host is ${hostGpuVendor}`],
    };
  }
  if (base.estado === 'reemplazada') {
    return { nivel: 'comunidad', combinacion: combo.id, motivos: ['there is a newer validated base image'] };
  }
  return { nivel: 'oficial', combinacion: combo.id, motivos: [] };
}

module.exports = {
  SUPPORTED_SCHEMA, validateDatabase, compareVersions, pickNewest,
  checkUpdateAcceptable, verifySignature, resolve,
};

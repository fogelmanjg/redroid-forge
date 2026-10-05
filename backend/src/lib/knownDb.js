const crypto = require('crypto');

// Nucleo puro de la base de datos de combinaciones conocidas (diseno en
// docs/BASE-COMBINACIONES.md). Sin I/O de disco ni red: recibe documentos ya
// leidos, asi se testea sin Docker. Carga/actualizacion/cache van en pasos
// posteriores (ver seccion 7 del doc).

const SUPPORTED_SCHEMA = 1;
const SHA256_RE = /^[0-9a-f]{64}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

const isStr = (v) => typeof v === 'string' && v.trim().length > 0;

// Validacion a mano (mismo criterio que moduleManifests.js: pocos campos, sin
// dependencia de JSON Schema). Junta TODOS los errores antes de fallar.
function validateDatabase(db) {
  const errors = [];
  if (!db || typeof db !== 'object') throw new Error('Base invalida: no es un objeto');
  if (db.schemaVersion !== SUPPORTED_SCHEMA) {
    errors.push(`schemaVersion ${db.schemaVersion} no soportado (se espera ${SUPPORTED_SCHEMA})`);
  }
  if (!Number.isInteger(db.serial) || db.serial < 1) errors.push('"serial" debe ser entero >= 1');
  if (!isStr(db.generatedAt)) errors.push('falta "generatedAt"');
  if (!isStr(db.minForgeVersion)) errors.push('falta "minForgeVersion"');
  for (const k of ['bases', 'paquetes', 'combinaciones']) {
    if (!Array.isArray(db[k])) errors.push(`"${k}" debe ser un array`);
  }
  if (errors.length) throw new Error(`Base invalida: ${errors.join('; ')}`);

  const ids = (arr, label) => {
    const seen = new Set();
    for (const e of arr) {
      if (!isStr(e.id)) errors.push(`${label}: entrada sin "id"`);
      else if (seen.has(e.id)) errors.push(`${label}: id duplicado "${e.id}"`);
      else seen.add(e.id);
    }
    return seen;
  };
  const baseIds = ids(db.bases, 'bases');
  const pkgIds = ids(db.paquetes, 'paquetes');
  ids(db.combinaciones, 'combinaciones');

  for (const b of db.bases) {
    if (!DIGEST_RE.test(b.digest || '')) errors.push(`base "${b.id}": "digest" debe ser sha256:<64 hex>`);
    if (!Number.isInteger(b.androidVersion)) errors.push(`base "${b.id}": "androidVersion" debe ser entero`);
    if (!['vigente', 'reemplazada', 'retirada'].includes(b.estado)) {
      errors.push(`base "${b.id}": "estado" invalido`);
    }
  }
  for (const p of db.paquetes) {
    if (!['gapps', 'magisk'].includes(p.tipo)) errors.push(`paquete "${p.id}": "tipo" invalido`);
    if (!SHA256_RE.test(p.sha256 || '')) errors.push(`paquete "${p.id}": "sha256" obligatorio (64 hex)`);
    if (!isStr(p.origen)) errors.push(`paquete "${p.id}": falta "origen"`);
  }
  const pkgType = new Map(db.paquetes.map((p) => [p.id, p.tipo]));
  for (const c of db.combinaciones) {
    if (!baseIds.has(c.base)) errors.push(`combinacion "${c.id}": base "${c.base}" no existe`);
    for (const [campo, tipo] of [['gapps', 'gapps'], ['magisk', 'magisk']]) {
      if (c[campo] == null) continue;
      if (!pkgIds.has(c[campo])) errors.push(`combinacion "${c.id}": paquete ${campo} "${c[campo]}" no existe`);
      else if (pkgType.get(c[campo]) !== tipo) errors.push(`combinacion "${c.id}": "${c[campo]}" no es de tipo ${tipo}`);
    }
    if (!c.modulos || typeof c.modulos !== 'object') errors.push(`combinacion "${c.id}": falta "modulos"`);
    if (!['oficial', 'comunidad'].includes(c.soporte)) errors.push(`combinacion "${c.id}": "soporte" invalido`);
    const vals = Array.isArray(c.validaciones) ? c.validaciones : [];
    if (c.soporte === 'oficial' && !vals.some((v) => v.resultado === 'ok')) {
      errors.push(`combinacion "${c.id}": "oficial" exige al menos una validacion con resultado "ok"`);
    }
    for (const v of vals) {
      if (!v.hardware || !isStr(v.hardware.vendor)) errors.push(`combinacion "${c.id}": validacion sin hardware.vendor`);
      if (!['ok', 'parcial', 'falla'].includes(v.resultado)) errors.push(`combinacion "${c.id}": resultado de validacion invalido`);
      // Chequeos reproducibles (docs/BASE-COMBINACIONES.md 1.1): opcionales
      // por ahora, pero si estan deben tener id y resultado validos.
      if (v.chequeos !== undefined) {
        if (!Array.isArray(v.chequeos)) errors.push(`combinacion "${c.id}": "chequeos" debe ser un array`);
        else {
          for (const ch of v.chequeos) {
            if (!isStr(ch.id)) errors.push(`combinacion "${c.id}": chequeo sin "id"`);
            if (!['ok', 'falla', 'omitido'].includes(ch.resultado)) errors.push(`combinacion "${c.id}": chequeo "${ch.id}" con resultado invalido`);
          }
        }
      }
    }
  }
  if (errors.length) throw new Error(`Base invalida: ${errors.join('; ')}`);
  return db;
}

// Compara versiones "a.b.c" (solo numericas).
function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// Elige entre varias bases candidatas (snapshot de la release, cache
// descargado) la de mayor serial. Empate -> la primera (el snapshot).
function pickNewest(...dbs) {
  return dbs.filter(Boolean).reduce((best, d) => (best && best.serial >= d.serial ? best : d), null);
}

// Chequeos extra que solo aplican a una base DESCARGADA (no al snapshot que
// viene dentro de la release): que redroid-forge la entienda y que no sea un
// rollback. Devuelve { ok, motivo }.
function checkUpdateAcceptable(candidate, current, forgeVersion) {
  try {
    validateDatabase(candidate);
  } catch (e) {
    return { ok: false, motivo: e.message };
  }
  if (compareVersions(candidate.minForgeVersion, forgeVersion) > 0) {
    return { ok: false, motivo: `la base exige redroid-forge >= ${candidate.minForgeVersion} (instalado: ${forgeVersion})` };
  }
  if (current && candidate.serial <= current.serial) {
    return { ok: false, motivo: `serial ${candidate.serial} no es mayor que el actual (${current.serial})` };
  }
  return { ok: true };
}

// Firma ed25519 sobre los BYTES EXACTOS del database.json descargado (no
// sobre el JSON re-serializado). `publicKeysPem`: lista, para poder rotar.
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

// Veredicto de soporte para una instancia (seccion 3 del doc). Puro.
// input: { baseDigest, gappsId, magiskId, modulos: {id: version}, hostGpuVendor }
function resolve(db, input) {
  const { baseDigest, gappsId = null, magiskId = null, modulos = {}, hostGpuVendor = null } = input;
  const motivos = [];
  const base = db.bases.find((b) => b.digest === baseDigest);
  if (!base || base.estado === 'retirada') {
    motivos.push(base ? `la imagen base fue retirada de la base de datos (${base.id})` : 'imagen base no reconocida (digest desconocido o imagen sin RepoDigest)');
  }
  for (const [id, tipo] of [[gappsId, 'GApps'], [magiskId, 'Magisk']]) {
    if (id && !db.paquetes.some((p) => p.id === id)) motivos.push(`paquete ${tipo} no reconocido: ${id}`);
  }
  if (motivos.length) return { nivel: 'sin-soporte', combinacion: null, motivos };

  const combo = db.combinaciones.find((c) => c.base === base.id
    && (c.gapps || null) === gappsId && (c.magisk || null) === magiskId
    && sameModules(c.modulos, modulos));

  if (!combo) {
    return {
      nivel: 'comunidad',
      combinacion: null,
      motivos: ['cada pieza es conocida, pero esta combinacion no se valido junta'],
    };
  }

  const oks = (combo.validaciones || []).filter((v) => v.resultado === 'ok');
  if (combo.soporte !== 'oficial' || oks.length === 0) {
    return { nivel: 'comunidad', combinacion: combo.id, motivos: ['combinacion conocida sin validacion completa'] };
  }
  if (hostGpuVendor && !oks.some((v) => v.hardware.vendor === hostGpuVendor)) {
    const vendors = [...new Set(oks.map((v) => v.hardware.vendor))].join(', ');
    return {
      nivel: 'comunidad',
      combinacion: combo.id,
      motivos: [`combinacion validada en ${vendors}, pero este host es ${hostGpuVendor}`],
    };
  }
  if (base.estado === 'reemplazada') {
    return { nivel: 'comunidad', combinacion: combo.id, motivos: ['hay una imagen base mas nueva validada'] };
  }
  return { nivel: 'oficial', combinacion: combo.id, motivos: [] };
}

module.exports = {
  SUPPORTED_SCHEMA, validateDatabase, compareVersions, pickNewest,
  checkUpdateAcceptable, verifySignature, resolve,
};

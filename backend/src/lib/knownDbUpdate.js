const fs = require('fs');
const path = require('path');
const knownDb = require('./knownDb');
const knownDbStore = require('./knownDbStore');
const pkg = require('../../package.json');

// Descarga y aplicacion de la base de combinaciones desde el repo externo
// (docs/BASE-COMBINACIONES.md, secciones 4.2 y 4.3). Sub-paso 3 del plan.
//
// Orden de seguridad: primero se verifica la FIRMA sobre los bytes exactos
// descargados; recien despues se parsea el JSON. Nada se escribe en disco
// hasta que la base paso firma + validacion + chequeo de serial/minForge, y la
// escritura es atomica con la anterior conservada como database.prev.json.

const TRUSTED_KEYS_PATH = path.join(__dirname, '..', '..', 'db', 'trusted-keys.json');
const DEFAULT_URL = 'https://github.com/fogelmanjg/redroid-forge-db/releases/latest/download';
const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 15000;
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

class UpdateError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

// Un fork o un espejo propio puede firmar con otras claves: se apunta a su
// lista con REDROID_FORGE_DB_TRUSTED_KEYS_FILE (la define quien opera la app,
// igual que REDROID_FORGE_DB_URL; no viaja dentro de la base descargada).
function loadTrustedKeys(file = process.env.REDROID_FORGE_DB_TRUSTED_KEYS_FILE || TRUSTED_KEYS_PATH) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return (j.keys || []).map((k) => k.pem).filter(Boolean);
  } catch {
    return [];
  }
}

function getConfig(env = process.env) {
  return {
    baseUrl: (env.REDROID_FORGE_DB_URL || DEFAULT_URL).replace(/\/+$/, ''),
    // El chequeo diario/al abrir se puede desactivar (decidido 05/10/2026).
    chequeoAutomatico: env.REDROID_FORGE_DB_CHECK !== '0',
  };
}

async function fetchBuffer(url, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow' });
  } catch (e) {
    throw new UpdateError(`no se pudo conectar a ${url}: ${e.message}`, 'red');
  }
  if (!res.ok) throw new UpdateError(`HTTP ${res.status} al pedir ${url}`, 'http');
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > MAX_BYTES) throw new UpdateError(`${url} excede ${MAX_BYTES} bytes`, 'tamano');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new UpdateError(`${url} excede ${MAX_BYTES} bytes`, 'tamano');
  return buf;
}

// Consulta liviana (latest.json: solo serial/fecha). No descarga ni aplica.
async function checkForUpdate({ baseUrl, current, fetchImpl = fetch }) {
  const buf = await fetchBuffer(`${baseUrl}/latest.json`, fetchImpl);
  let meta;
  try {
    meta = JSON.parse(buf.toString('utf-8'));
  } catch {
    throw new UpdateError('latest.json ilegible', 'formato');
  }
  if (!Number.isInteger(meta.serial)) throw new UpdateError('latest.json sin "serial"', 'formato');
  return { disponible: meta.serial > current.serial, serialRemoto: meta.serial, generatedAt: meta.generatedAt || null };
}

function writeAtomic(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
}

async function applyUpdate({
  baseUrl, trustedKeys, current, forgeVersion = pkg.version,
  cachePath = knownDbStore.CACHE_PATH, fetchImpl = fetch,
}) {
  if (!trustedKeys.length) {
    throw new UpdateError('no hay claves de confianza configuradas (build de desarrollo): no se aplica ninguna base descargada', 'sin-claves');
  }
  const [dataBuf, sigBuf] = await Promise.all([
    fetchBuffer(`${baseUrl}/database.json`, fetchImpl),
    fetchBuffer(`${baseUrl}/database.json.sig`, fetchImpl),
  ]);
  // 1. Firma ANTES de parsear nada.
  if (!knownDb.verifySignature(dataBuf, sigBuf.toString('utf-8').trim(), trustedKeys)) {
    throw new UpdateError('la firma de la base descargada NO es valida: se descarta', 'firma');
  }
  // 2. Forma, serial (anti-rollback) y compatibilidad con esta version.
  let candidate;
  try {
    candidate = JSON.parse(dataBuf.toString('utf-8'));
  } catch {
    throw new UpdateError('la base descargada no es JSON valido', 'formato');
  }
  // Misma base que ya tenemos (con firma valida): no es un error, ya esta al dia.
  if (Number.isInteger(candidate.serial) && candidate.serial === current.serial) {
    return { aplicada: false, serial: current.serial, motivo: 'ya tenes la ultima base publicada' };
  }
  const verdict = knownDb.checkUpdateAcceptable(candidate, current, forgeVersion);
  if (!verdict.ok) throw new UpdateError(`base rechazada: ${verdict.motivo}`, 'rechazada');
  // 3. Recien ahora se toca el disco: la anterior queda como .prev.
  if (fs.existsSync(cachePath)) {
    fs.copyFileSync(cachePath, path.join(path.dirname(cachePath), 'database.prev.json'));
  }
  writeAtomic(cachePath, dataBuf);
  return { aplicada: true, serial: candidate.serial, serialAnterior: current.serial };
}

// ---- estado del chequeo automatico (en memoria) ----
let lastCheck = null;

async function runCheck({ fetchImpl = fetch, config = getConfig(), trustedKeys = loadTrustedKeys() } = {}) {
  const at = new Date().toISOString();
  if (!trustedKeys.length) {
    lastCheck = { at, ok: false, motivo: 'sin claves de confianza (build de desarrollo): no se consulta' };
    return lastCheck;
  }
  try {
    const { db } = knownDbStore.loadCurrent();
    const r = await checkForUpdate({ baseUrl: config.baseUrl, current: db, fetchImpl });
    lastCheck = { at, ok: true, ...r };
  } catch (e) {
    lastCheck = { at, ok: false, motivo: e.message };
  }
  return lastCheck;
}

function getLastCheck() {
  return lastCheck;
}

// Al abrir la app y una vez al dia. Solo consulta; aplicar es siempre manual.
function startScheduler({ config = getConfig(), trustedKeys = loadTrustedKeys(), fetchImpl = fetch } = {}) {
  if (!config.chequeoAutomatico) return null;
  if (!trustedKeys.length) return null; // sin claves no hay nada que consultar
  const run = () => runCheck({ fetchImpl, config, trustedKeys }).catch(() => {});
  const first = setTimeout(run, 5000);
  const every = setInterval(run, CHECK_EVERY_MS);
  first.unref();
  every.unref();
  return { first, every };
}

module.exports = {
  UpdateError, loadTrustedKeys, getConfig, checkForUpdate, applyUpdate,
  runCheck, getLastCheck, startScheduler, TRUSTED_KEYS_PATH, DEFAULT_URL,
};

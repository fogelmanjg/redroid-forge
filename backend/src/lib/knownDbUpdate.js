const fs = require('fs');
const path = require('path');
const knownDb = require('./knownDb');
const knownDbStore = require('./knownDbStore');
const pkg = require('../../package.json');

// Download and application of the combinations database from the external repo
// (docs/KNOWN-COMBINATIONS.md, sections 4.2 and 4.3). Sub-step 3 of the plan.
//
// Security order: first the SIGNATURE is verified over the exact downloaded
// bytes; only then is the JSON parsed. Nothing is written to disk until the
// database has passed signature + validation + serial/minForge check, and the
// write is atomic with the previous one kept as database.prev.json.

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

// A fork or an own mirror may sign with other keys: point to its list with
// REDROID_FORGE_DB_TRUSTED_KEYS_FILE (defined by whoever operates the app, like
// REDROID_FORGE_DB_URL; it does not travel inside the downloaded database).
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
    // The daily/on-open check can be turned off (decided 05/10/2026).
    chequeoAutomatico: env.REDROID_FORGE_DB_CHECK !== '0',
  };
}

async function fetchBuffer(url, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow' });
  } catch (e) {
    throw new UpdateError(`could not connect to ${url}: ${e.message}`, 'red');
  }
  if (!res.ok) throw new UpdateError(`HTTP ${res.status} requesting ${url}`, 'http');
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > MAX_BYTES) throw new UpdateError(`${url} exceeds ${MAX_BYTES} bytes`, 'tamano');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new UpdateError(`${url} exceeds ${MAX_BYTES} bytes`, 'tamano');
  return buf;
}

// Light query (latest.json: only serial/date). It neither downloads nor applies.
async function checkForUpdate({ baseUrl, current, fetchImpl = fetch }) {
  const buf = await fetchBuffer(`${baseUrl}/latest.json`, fetchImpl);
  let meta;
  try {
    meta = JSON.parse(buf.toString('utf-8'));
  } catch {
    throw new UpdateError('latest.json unreadable', 'formato');
  }
  if (!Number.isInteger(meta.serial)) throw new UpdateError('latest.json without "serial"', 'formato');
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
    throw new UpdateError('no trusted keys configured (development build): no downloaded database is applied', 'sin-claves');
  }
  const [dataBuf, sigBuf] = await Promise.all([
    fetchBuffer(`${baseUrl}/database.json`, fetchImpl),
    fetchBuffer(`${baseUrl}/database.json.sig`, fetchImpl),
  ]);
  // 1. Signature BEFORE parsing anything.
  if (!knownDb.verifySignature(dataBuf, sigBuf.toString('utf-8').trim(), trustedKeys)) {
    throw new UpdateError('the signature of the downloaded database is NOT valid: it is discarded', 'firma');
  }
  // 2. Shape, serial (anti-rollback) and compatibility with this version.
  let candidate;
  try {
    candidate = JSON.parse(dataBuf.toString('utf-8'));
  } catch {
    throw new UpdateError('the downloaded database is not valid JSON', 'formato');
  }
  // The same database we already have (with a valid signature): not an error, it is already up to date.
  if (Number.isInteger(candidate.serial) && candidate.serial === current.serial) {
    return { aplicada: false, serial: current.serial, motivo: 'you already have the latest published database' };
  }
  const verdict = knownDb.checkUpdateAcceptable(candidate, current, forgeVersion);
  if (!verdict.ok) throw new UpdateError(`database rejected: ${verdict.motivo}`, 'rechazada');
  // 3. Only now is the disk touched: the previous one stays as .prev.
  if (fs.existsSync(cachePath)) {
    fs.copyFileSync(cachePath, path.join(path.dirname(cachePath), 'database.prev.json'));
  }
  writeAtomic(cachePath, dataBuf);
  return { aplicada: true, serial: candidate.serial, serialAnterior: current.serial };
}

// ---- state of the automatic check (in memory) ----
let lastCheck = null;

async function runCheck({ fetchImpl = fetch, config = getConfig(), trustedKeys = loadTrustedKeys() } = {}) {
  const at = new Date().toISOString();
  if (!trustedKeys.length) {
    lastCheck = { at, ok: false, motivo: 'no trusted keys (development build): no query is made' };
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

// On opening the app and once a day. It only queries; applying is always manual.
function startScheduler({ config = getConfig(), trustedKeys = loadTrustedKeys(), fetchImpl = fetch } = {}) {
  if (!config.chequeoAutomatico) return null;
  if (!trustedKeys.length) return null; // without keys there is nothing to query
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

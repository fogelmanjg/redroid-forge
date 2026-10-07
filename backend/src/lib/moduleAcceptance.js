const path = require('path');
const crypto = require('crypto');
const { readJsonArray, writeJsonArray } = require('./jsonFileStore');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DEFAULT_STORE_FILE = path.join(DATA_DIR, 'module-acceptances.json');

// Record of "user/instance accepted manifest version N of module X, on such
// a date" (section 5 of docs/REQUIREMENTS.md). There is no auth yet (Phase
// 6), so the acceptance holds for the whole installation (a single record
// per module+version is enough for "current"), but the available user/instance
// context is stored for auditing and for when Phase 6 adds real users.
let storeFile = DEFAULT_STORE_FILE;

function readAll() {
  return readJsonArray(storeFile);
}

function writeAll(records) {
  writeJsonArray(storeFile, records);
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

// The most recent acceptance recorded for a module, regardless of version
// (to show "you accepted v1, the current one is v2" instead of just yes/no).
function latestFor(moduleId) {
  const all = readAll().filter((a) => a.moduleId === moduleId);
  if (all.length === 0) return null;
  return all.reduce((a, b) => (new Date(a.acceptedAt) >= new Date(b.acceptedAt) ? a : b));
}

// Current = the most recent acceptance is for the manifest's current version.
// If the manifest went up a version (the disclaimer or what it touches
// changed), it stops being current and has to be accepted again.
function isAccepted(moduleId, currentVersion) {
  const latest = latestFor(moduleId);
  return !!latest && latest.version === currentVersion;
}

// Only for tests: isolates the data file so as not to overwrite the real
// backend/data/module-acceptances.json nor depend on its previous state.
function _setStoreFileForTests(file) {
  storeFile = file || DEFAULT_STORE_FILE;
}

module.exports = {
  record, latestFor, isAccepted, readAll, _setStoreFileForTests,
};

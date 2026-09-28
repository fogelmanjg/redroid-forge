const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'instances.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readAll() {
  ensureDataDir();
  if (!fs.existsSync(STORE_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

// Escritura atómica (tmp + rename) para no dejar el archivo corrupto si el
// proceso muere a mitad de un write.
function writeAll(instances) {
  ensureDataDir();
  const tmp = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(instances, null, 2));
  fs.renameSync(tmp, STORE_FILE);
}

function upsert(instance) {
  const all = readAll();
  const idx = all.findIndex((i) => i.id === instance.id);
  if (idx >= 0) all[idx] = instance;
  else all.push(instance);
  writeAll(all);
  return instance;
}

function remove(id) {
  writeAll(readAll().filter((i) => i.id !== id));
}

function get(id) {
  return readAll().find((i) => i.id === id);
}

module.exports = { readAll, writeAll, upsert, remove, get };

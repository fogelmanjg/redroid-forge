const path = require('path');
const { readJsonArray, writeJsonArray } = require('./jsonFileStore');

const STORE_FILE = path.join(__dirname, '..', '..', 'data', 'instances.json');

function readAll() {
  return readJsonArray(STORE_FILE);
}

function writeAll(instances) {
  writeJsonArray(STORE_FILE, instances);
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

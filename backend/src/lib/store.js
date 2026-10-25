const path = require('path');
const { readJsonArray, writeJsonArray } = require('./jsonFileStore');

const STORE_FILE = path.join(__dirname, '..', '..', 'data', 'instances.json');

// Self-healing migration (docs/ROADMAP.md Phase 7, 25/10/2026): `ownerId` used to be a single
// id, now it is a list (an instance can be shared by several people at once -- "la cuenta tv de
// pvz2, romina y yo" was the motivating example). `createdId` is new entirely (who the quota,
// src/lib/quotas.js, counts against) and never existed before. Rather than a one-shot migration
// script, every read just normalizes whatever shape is on disk and writes it back if it had to
// change -- same posture as settings.js's DEFAULTS merge, never a required manual step.
function normalize(instance) {
  let changed = false;
  if (!Array.isArray(instance.ownerId)) {
    instance.ownerId = instance.ownerId ? [instance.ownerId] : [];
    changed = true;
  }
  if (instance.createdId === undefined) {
    instance.createdId = instance.ownerId[0] || null;
    changed = true;
  }
  return changed;
}

function readAll(file = STORE_FILE) {
  const all = readJsonArray(file);
  let changed = false;
  for (const instance of all) {
    if (normalize(instance)) changed = true;
  }
  if (changed) writeJsonArray(file, all);
  return all;
}

function writeAll(instances, file = STORE_FILE) {
  writeJsonArray(file, instances);
}

function upsert(instance, file = STORE_FILE) {
  const all = readAll(file);
  const idx = all.findIndex((i) => i.id === instance.id);
  if (idx >= 0) all[idx] = instance;
  else all.push(instance);
  writeAll(all, file);
  return instance;
}

function remove(id, file = STORE_FILE) {
  writeAll(readAll(file).filter((i) => i.id !== id), file);
}

function get(id, file = STORE_FILE) {
  return readAll(file).find((i) => i.id === id);
}

module.exports = { readAll, writeAll, upsert, remove, get };

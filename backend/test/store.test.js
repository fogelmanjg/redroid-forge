// Coverage of src/lib/store.js's self-healing `ownerId`/`createdId` migration (docs/ROADMAP.md
// Phase 7, 25/10/2026) -- every other behavior (upsert/remove/get) predates this and is only
// exercised indirectly elsewhere, this file is specifically about the migration.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
  return path.join(dir, 'instances.json');
}

const store = require('../src/lib/store');

test('readAll: a legacy bare-string ownerId becomes a one-element array, and gains a createdId', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify([{ id: 'i1', ownerId: 'alice' }]));
  const [instance] = store.readAll(file);
  assert.deepEqual(instance.ownerId, ['alice']);
  assert.equal(instance.createdId, 'alice');
});

test('readAll: a pre-Phase-7 instance with no ownerId at all gets an empty list and a null createdId', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify([{ id: 'i1' }]));
  const [instance] = store.readAll(file);
  assert.deepEqual(instance.ownerId, []);
  assert.equal(instance.createdId, null);
});

test('readAll: already-migrated shape (array ownerId + explicit createdId) is left untouched', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify([{ id: 'i1', ownerId: ['alice', 'bob'], createdId: 'bob' }]));
  const [instance] = store.readAll(file);
  assert.deepEqual(instance.ownerId, ['alice', 'bob']);
  assert.equal(instance.createdId, 'bob');
});

test('readAll: the migration is persisted back to disk, not just applied in memory', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify([{ id: 'i1', ownerId: 'alice' }]));
  store.readAll(file); // first read heals it on disk
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.deepEqual(onDisk[0].ownerId, ['alice']);
  assert.equal(onDisk[0].createdId, 'alice');
});

test('get/upsert: go through the same migration as readAll', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify([{ id: 'i1', ownerId: 'alice' }]));
  assert.deepEqual(store.get('i1', file).ownerId, ['alice']);
  const updated = store.upsert({ id: 'i1', ownerId: ['alice', 'bob'], createdId: 'alice', name: 'x' }, file);
  assert.deepEqual(updated.ownerId, ['alice', 'bob']);
  assert.deepEqual(store.get('i1', file).ownerId, ['alice', 'bob']);
});

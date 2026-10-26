'use strict';

// Resource quotas for the "operator" role (docs/ROADMAP.md Phase 7, 25/10/2026) -- two
// independent, both-optional ceilings: a PER-OPERATOR cap (this store, keyed by user id) and a
// shared POOL cap across every operator at once (settings.js's own global settings object,
// since it is a single value, not one per user). Either, both, or neither can be configured;
// whichever is hit first blocks the request -- the user's own framing: "un pool de 10vcpu y
// 32GB para todos los operadores, y 4vcpu/16GB por operador individual, el que se alcanza antes
// se aplica".
//
// What counts against a quota is NEVER a running counter (an instance deleted outside the normal
// flow, or recreated, would have to remember to decrement it) -- it is always the live sum of
// `cpusetCpus`/`memoryMb` across every OTHER instance whose `createdId` matches, read fresh from
// the store on every check. `createdId`, not `ownerId`: who can SEE/USE an instance (`ownerId`,
// now a list) and who it COUNTS AGAINST (`createdId`) are deliberately different questions -- see
// permissions.js's own `transfer-ownership` comment and docs/ROADMAP.md Phase 7.
//
// Quotas apply to operators only: admin bypasses them entirely (same bypass admin already gets
// everywhere else), and viewer can never create/configure an instance in the first place, so it
// never reaches this check. An instance whose `createdId` is reassigned to an admin (via PUT
// /:id/created-by) is thereby also exempted from then on -- a deliberate "rescue" escape hatch,
// not a loophole: only an admin can attribute createdId to someone other than themselves, see
// routes/instances.js.

const path = require('path');
const { readJsonArray, writeJsonArray } = require('./jsonFileStore');
const { countCpus } = require('./instanceParams');
const auth = require('./auth');
const userStore = require('./userStore');
const roleAssignments = require('./roleAssignments');

const STORE_FILE = path.join(__dirname, '..', '..', 'data', 'quotas.json');

function httpError(message, httpStatus) {
  return Object.assign(new Error(message), { httpStatus });
}

function listQuotas(file = STORE_FILE) {
  return readJsonArray(file);
}

function getQuota(userId, file = STORE_FILE) {
  return readJsonArray(file).find((q) => q.userId === userId) || null;
}

// `maxVcpus`/`maxMemoryMb`: a positive integer, or null/undefined to leave that dimension
// unlimited. Ending up with both unlimited removes the row entirely (same as never having
// configured one) rather than leaving an empty husk behind in the file.
function setQuota(userId, { maxVcpus, maxMemoryMb }, file = STORE_FILE) {
  for (const [k, v] of [['maxVcpus', maxVcpus], ['maxMemoryMb', maxMemoryMb]]) {
    if (v !== null && v !== undefined && !(Number.isInteger(v) && v > 0)) {
      throw httpError(`"${k}" must be a positive integer, or null to leave it unlimited`, 400);
    }
  }
  const all = readJsonArray(file);
  const existing = all.find((q) => q.userId === userId);
  const next = { maxVcpus: maxVcpus ?? null, maxMemoryMb: maxMemoryMb ?? null };
  if (!next.maxVcpus && !next.maxMemoryMb) {
    writeJsonArray(file, all.filter((q) => q.userId !== userId));
    return null;
  }
  if (existing) {
    Object.assign(existing, next, { updatedAt: new Date().toISOString() });
  } else {
    all.push({ userId, ...next, updatedAt: new Date().toISOString() });
  }
  writeJsonArray(file, all);
  return getQuota(userId, file);
}

function deleteQuota(userId, file = STORE_FILE) {
  writeJsonArray(file, readJsonArray(file).filter((q) => q.userId !== userId));
}

// Every user id currently holding the "operator" role, regardless of which auth backend is
// active -- the one thing both the per-operator check and the pool check need ("is this
// instance's createdId actually an operator right now", and "which instances count toward the
// shared pool at all"). Returned as a Set for the caller to pass into assertWithinQuota, rather
// than computed inside it, so that function stays a plain, easily-tested pure check.
function operatorIds({ usersFile, roleAssignmentsFile } = {}) {
  const ids = new Set();
  if (auth.LOCAL_ENABLED) {
    for (const u of userStore.listUsers(usersFile)) if (u.role === 'operator') ids.add(u.id);
  }
  if (auth.OIDC_ENABLED) {
    for (const a of roleAssignments.listAssignments(roleAssignmentsFile)) if (a.role === 'operator') ids.add(a.externalId);
  }
  return ids;
}

function sumOver(instances, matches) {
  let vcpus = 0;
  let memoryMb = 0;
  for (const i of instances) {
    if (!matches(i)) continue;
    vcpus += countCpus(i.cpusetCpus);
    memoryMb += i.memoryMb || 0;
  }
  return { vcpus, memoryMb };
}

// Throws (403) if, after this change, either configured ceiling would be exceeded. Never throws
// for an admin actor, or when `createdId` is not (or no longer) in `operatorIdSet` -- see the
// module comment above for why both are deliberate, not gaps.
// `instances`: the full current list (caller passes `store.readAll()` -- kept as a parameter
// rather than read in here, so a route that already needed it for other reasons does not pay
// for a second read). `excludeInstanceId`: the instance being resized, so its OWN current usage
// is not double-counted against the new totals being proposed for it (omit/null when creating a
// brand new one, which cannot already be in `instances`). `thisVcpus`/`thisMemoryMb`: the NEW
// total this one instance would end up with after the change, not a delta. `operatorIdSet`: from
// `operatorIds()` above. `pool`: `{operatorPoolMaxVcpus, operatorPoolMaxMemoryMb}`, i.e.
// `settings.get()` -- passed in rather than read here for the same testability reason.
function assertWithinQuota({
  actorRole, createdId, instances, excludeInstanceId, thisVcpus, thisMemoryMb, operatorIdSet, pool, quotasFile = STORE_FILE,
}) {
  if (actorRole === 'admin') return;
  if (!operatorIdSet || !operatorIdSet.has(createdId)) return;
  const others = excludeInstanceId ? instances.filter((i) => i.id !== excludeInstanceId) : instances;

  const own = getQuota(createdId, quotasFile);
  if (own && (own.maxVcpus || own.maxMemoryMb)) {
    const mine = sumOver(others, (i) => i.createdId === createdId);
    if (own.maxVcpus && mine.vcpus + thisVcpus > own.maxVcpus) {
      throw httpError(`This would use ${mine.vcpus + thisVcpus} vCPUs, over your own quota of ${own.maxVcpus}`, 403);
    }
    if (own.maxMemoryMb && mine.memoryMb + thisMemoryMb > own.maxMemoryMb) {
      throw httpError(`This would use ${mine.memoryMb + thisMemoryMb}MB of RAM, over your own quota of ${own.maxMemoryMb}MB`, 403);
    }
  }

  if (pool && (pool.operatorPoolMaxVcpus || pool.operatorPoolMaxMemoryMb)) {
    const pooled = sumOver(others, (i) => operatorIdSet.has(i.createdId));
    if (pool.operatorPoolMaxVcpus && pooled.vcpus + thisVcpus > pool.operatorPoolMaxVcpus) {
      throw httpError(`This would use ${pooled.vcpus + thisVcpus} vCPUs across all operators, over the shared pool quota of ${pool.operatorPoolMaxVcpus}`, 403);
    }
    if (pool.operatorPoolMaxMemoryMb && pooled.memoryMb + thisMemoryMb > pool.operatorPoolMaxMemoryMb) {
      throw httpError(`This would use ${pooled.memoryMb + thisMemoryMb}MB of RAM across all operators, over the shared pool quota of ${pool.operatorPoolMaxMemoryMb}MB`, 403);
    }
  }
}

module.exports = {
  STORE_FILE, listQuotas, getQuota, setQuota, deleteQuota, operatorIds, assertWithinQuota,
};

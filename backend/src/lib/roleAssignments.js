'use strict';

// Role assignment for OIDC identities (docs/ROADMAP.md Phase 7, redesigned 25/10/2026) --
// deliberately separate from userStore.js's local accounts. The point: an OIDC login only ever
// proves IDENTITY (who this is, per the IdP) -- oidc.js no longer reads any role claim at all,
// on purpose. Saying what an identity is allowed to do is this project's own job, kept here, not
// the IdP's. userStore.js's local accounts don't need this split: an admin already picks a role
// at the moment they create one, there is no "local identity with no role yet" case to cover.
// OIDC is different -- the IdP can hand this project a brand new `sub` it has never seen, with
// no role opinion needed or wanted from it.
//
// This IS the "permissions backend" from that design discussion, built as a local table for
// now because nothing else exists yet to delegate to. When a real separate permissions service
// exists (e.g. as part of the Plenum federation, see docs/ROADMAP.md Phase 8's "reusing Plenum's
// roles"), only resolveRole()'s body needs to change to call it instead -- oidc.js, auth.js and
// the routes stay exactly as they are, they only ever see a role name or null.

const path = require('path');
const { readJsonArray, writeJsonArray } = require('./jsonFileStore');
const { isValidRole } = require('./permissions');

const STORE_FILE = path.join(__dirname, '..', '..', 'data', 'role-assignments.json');

// Same bootstrap problem local mode has (userStore.ensureBootstrapAdmin) and the same shape of
// answer: SOME identity has to start out as admin, or nobody could ever use the admin-only
// routes below to approve anyone, including themselves. Unlike local mode's "only matters if
// the store is empty" (an admin picks the username/password themselves, so ordering is already
// under their control), OIDC login order is NOT under the admin's control -- anyone who can
// reach the IdP can be the first to click login. Matching by a specific configured external id
// instead is precise regardless of order, and is re-checked on every login (not just once at
// creation) so the flow "log in once to discover your own id in this file, set the env var, log
// in again" works without a restart in between -- see docs/ROADMAP.md Phase 7. The expected
// value is the FULL composite external id (`${providerId}:${sub}`, see oidc.js's own comment on
// why it is composite, not a bare `sub`), exactly as it appears in this file after that first
// login.
const BOOTSTRAP_ADMIN_EXTERNAL_ID = process.env.REDROID_FORGE_OIDC_BOOTSTRAP_ADMIN_ID || '';

function listAssignments(file = STORE_FILE) {
  return readJsonArray(file);
}

function findByExternalId(externalId, file = STORE_FILE) {
  return readJsonArray(file).find((a) => a.externalId === externalId);
}

// Called on every OIDC login, successful or not -- records/refreshes the identity's last-seen
// display name (and which configured provider vouched for it -- purely informational, shown in
// the admin panel so "which of my configured sources is this" is not a guessing game once there
// is more than one) so an admin can recognize who is asking for access, without granting
// anything by itself. `role` stays whatever it already was (null the first time this externalId
// is ever seen) unless the bootstrap-admin env var matches, in which case this identity is
// always admin for as long as that var stays set.
function upsertSeen({ externalId, username, providerId, providerLabel }, file = STORE_FILE) {
  const all = readJsonArray(file);
  const existing = all.find((a) => a.externalId === externalId);
  const now = new Date().toISOString();
  const isBootstrapAdmin = !!BOOTSTRAP_ADMIN_EXTERNAL_ID && externalId === BOOTSTRAP_ADMIN_EXTERNAL_ID;
  if (existing) {
    existing.username = username;
    existing.providerId = providerId;
    existing.providerLabel = providerLabel;
    existing.lastSeenAt = now;
    if (isBootstrapAdmin) existing.role = 'admin';
  } else {
    all.push({
      externalId, username, providerId, providerLabel, role: isBootstrapAdmin ? 'admin' : null, createdAt: now, lastSeenAt: now,
    });
  }
  writeJsonArray(file, all);
  return findByExternalId(externalId, file);
}

function httpError(message, httpStatus) {
  return Object.assign(new Error(message), { httpStatus });
}

// Admin-facing: grants/changes a role, or null to revoke back to "pending" without deleting the
// record -- an admin may want to see this identity again on its next login without it
// re-appearing as a brand new, unrecognized one.
function setRole(externalId, role, file = STORE_FILE) {
  if (role !== null && !isValidRole(role)) {
    throw httpError('"role" must be one of: admin, operator, viewer, or null to revoke', 400);
  }
  const all = readJsonArray(file);
  const existing = all.find((a) => a.externalId === externalId);
  if (!existing) throw httpError('No such identity -- it has never logged in', 404);
  existing.role = role;
  existing.updatedAt = new Date().toISOString();
  writeJsonArray(file, all);
  return existing;
}

function deleteAssignment(externalId, file = STORE_FILE) {
  const all = readJsonArray(file);
  writeJsonArray(file, all.filter((a) => a.externalId !== externalId));
}

// -> 'admin' | 'operator' | 'viewer' | null (null = no access yet, pending admin approval).
// Pure lookup, no side effect -- upsertSeen is the only thing that creates/refreshes a row, kept
// as a separate call so that merely checking a role never has the side effect of creating one.
function resolveRole(externalId, file = STORE_FILE) {
  const existing = findByExternalId(externalId, file);
  return existing ? existing.role : null;
}

module.exports = {
  STORE_FILE, listAssignments, findByExternalId, upsertSeen, setRole, deleteAssignment, resolveRole,
};

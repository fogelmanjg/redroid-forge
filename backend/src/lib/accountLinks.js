'use strict';

// Explicit account linking (docs/ROADMAP.md Phase 7, 26/10/2026) -- lets ONE person log in
// through several doors (a local password AND a Google/Keycloak/whatever OIDC identity) without
// ever trusting a claimed field (email, username) as proof of sameness. See the design
// discussion: an OIDC provider only proves "whoever is at this browser controls this external
// account right now" -- it says nothing about whether that is the same person as any existing
// local account, no matter what email it claims. The only safe proof of sameness is the person
// being logged in as BOTH sides at once: this module only ever records a link that was created
// while the person was already authenticated as the local account (see routes/auth.js's
// /me/links/:providerId/start, which requires requireAuth + a local session before it will even
// start the OIDC redirect) -- never from matching a field after the fact.
//
// The local account is always the "anchor": every link points FROM an externalId TO a
// localUserId, never the other way, and never OIDC-to-OIDC. Once linked, logging in through that
// externalId (routes/auth.js's /oidc/:providerId/callback) skips roleAssignments.js entirely and
// mints a session AS the local user -- same id, so quotas/ownership/capabilities all key off one
// stable identity regardless of which door was used.

const path = require('path');
const { readJsonArray, writeJsonArray } = require('./jsonFileStore');

const STORE_FILE = path.join(__dirname, '..', '..', 'data', 'account-links.json');

function httpError(message, httpStatus) {
  return Object.assign(new Error(message), { httpStatus });
}

function listLinks(file = STORE_FILE) {
  return readJsonArray(file);
}

function findByExternalId(externalId, file = STORE_FILE) {
  return readJsonArray(file).find((l) => l.externalId === externalId);
}

function findByLocalUserId(localUserId, file = STORE_FILE) {
  return readJsonArray(file).filter((l) => l.localUserId === localUserId);
}

// Throws 409 if `externalId` is already linked to a DIFFERENT local user (never silently
// re-points an existing link to someone else -- that would be exactly the kind of silent
// identity switch this module exists to prevent). Re-linking the SAME pair just refreshes
// username/providerLabel/lastLinkedAt, same "upsert" shape as roleAssignments.upsertSeen.
function link({ externalId, localUserId, username, providerId, providerLabel }, file = STORE_FILE) {
  const all = readJsonArray(file);
  const existing = all.find((l) => l.externalId === externalId);
  const now = new Date().toISOString();
  if (existing) {
    if (existing.localUserId !== localUserId) {
      throw httpError(
        `"${externalId}" is already linked to a different local account -- unlink it there first.`,
        409,
      );
    }
    existing.username = username;
    existing.providerId = providerId;
    existing.providerLabel = providerLabel;
    existing.lastLinkedAt = now;
  } else {
    all.push({
      externalId, localUserId, username, providerId, providerLabel, linkedAt: now, lastLinkedAt: now,
    });
  }
  writeJsonArray(file, all);
  return findByExternalId(externalId, file);
}

function unlink(externalId, file = STORE_FILE) {
  const all = readJsonArray(file);
  writeJsonArray(file, all.filter((l) => l.externalId !== externalId));
}

module.exports = {
  STORE_FILE, listLinks, findByExternalId, findByLocalUserId, link, unlink,
};

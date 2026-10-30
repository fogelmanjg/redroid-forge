'use strict';

// Generic OIDC client (docs/ROADMAP.md Phase 7) -- deliberately NOT a Keycloak-specific
// integration. Any IdP that speaks standard OIDC discovery works the same way (Keycloak,
// Authentik, Auth0, Zitadel, ...).
//
// Multi-provider (redesigned 25/10/2026, see docs/ROADMAP.md Phase 7): a login can come from ANY
// number of configured trust sources at once -- the user's own framing was "ask Keycloak, ask
// Google, ask Plenum, ask Rio Negro's federation, whichever one actually vouches for this person
// right now". `REDROID_FORGE_OIDC_PROVIDERS` is a JSON array, one entry per source; the login
// screen lists all of them (GET /api/auth/oidc/providers), the person picks one, and ONLY that
// one is ever asked to prove anything -- OIDC has no "ask provider X if person Y is real" query
// outside of an actual login by that person; a provider only ever vouches for whoever is sitting
// in front of it right now, during its own flow.
//
// Still IDENTITY ONLY (see the 25/10/2026 single-provider redesign this built on): no provider's
// role/group claims are ever read. All any provider hands back is a stable external id and a
// display name -- roleAssignments.js is where that id gets turned into an actual permission,
// completely independent of which provider vouched for it.
//
// Because the SAME `sub` value is only unique WITHIN one issuer's own namespace (two different
// providers can hand out the same `sub` to two different real people), every identity's external
// id is `${providerId}:${sub}`, never the bare `sub` -- see handleCallback.
//
// openid-client is pinned to the last v5.x release (5.7.1), not the current major: v6 rewrote
// the package as ESM-only, and this backend is plain CommonJS with no build step by design (see
// docs/ROADMAP.md's own stack notes) -- rewriting the whole backend as ESM just for this one
// dependency was not worth it. v5 handles discovery/PKCE/JWKS/token validation correctly, which
// is the actual point of using a real library here instead of hand-rolling OIDC crypto.

const { Issuer, generators } = require('openid-client');
const settings = require('./settings');

const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

// REDROID_FORGE_OIDC_REDIRECT_BASE_URL + "/api/auth/oidc/<id>/callback" is every provider's
// redirect URI -- deriving it instead of asking for a full URL per provider is the whole reason
// adding a provider is "one JSON object with 4 fields", not "register a callback URL by hand
// with every IdP's console AND also tell this app about it separately, twice, trying to keep
// them in sync".
function redirectBaseUrl() {
  return (process.env.REDROID_FORGE_OIDC_REDIRECT_BASE_URL || '').replace(/\/+$/, '');
}

// Raw (unvalidated) provider entries, before redirectBaseUrl/shape checks below -- settings.json's
// `oidcProviders` (Identities panel CRUD, 30/10/2026) wins once it has ever been written
// (even to [], an explicit "none configured"); REDROID_FORGE_OIDC_PROVIDERS is only the
// bootstrap default for before that UI has ever been touched, same precedence as authMode in
// auth.js. This is also where addProvider/updateProvider/removeProvider read from before writing
// back, so the shape on disk is always the plain entry {id, label, issuerUrl, clientId,
// clientSecret}, never the derived `redirectUri` listProviders() below adds.
function rawProviderList() {
  const configured = settings.get().oidcProviders;
  if (Array.isArray(configured)) return configured;
  const raw = process.env.REDROID_FORGE_OIDC_PROVIDERS || '';
  if (!raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.warn('redroid-forge: REDROID_FORGE_OIDC_PROVIDERS must be a JSON array -- no OIDC providers available.');
      return [];
    }
    return parsed;
  } catch (e) {
    console.warn(`redroid-forge: REDROID_FORGE_OIDC_PROVIDERS is not valid JSON (${e.message}) -- no OIDC providers available.`);
    return [];
  }
}

// -> every syntactically valid provider from rawProviderList(), silently dropping anything
// malformed (same forgiving posture as jsonFileStore's readJsonArray) rather than crashing the
// whole app over one bad entry -- logged, not silent, so a typo is still visible at startup.
// Re-parsed/re-read on every call (cheap; this is not on any hot path) rather than cached, so a
// restart is the only thing needed to pick up a config change, same as every other env var here.
function listProviders() {
  const parsed = rawProviderList();
  const base = redirectBaseUrl();
  const seen = new Set();
  const providers = [];
  for (const entry of parsed) {
    const { id, label, issuerUrl, clientId, clientSecret } = entry || {};
    if (typeof id !== 'string' || !PROVIDER_ID_RE.test(id)) {
      console.warn(`redroid-forge: skipping an OIDC provider with an invalid "id" (${JSON.stringify(id)}) -- must be lowercase letters/digits/"-", 1-32 chars.`);
      continue;
    }
    if (seen.has(id)) {
      console.warn(`redroid-forge: skipping a duplicate OIDC provider id "${id}".`);
      continue;
    }
    if (typeof label !== 'string' || !label || typeof issuerUrl !== 'string' || !issuerUrl || typeof clientId !== 'string' || !clientId) {
      console.warn(`redroid-forge: skipping OIDC provider "${id}" -- "label", "issuerUrl" and "clientId" are all required.`);
      continue;
    }
    if (!base) {
      console.warn(`redroid-forge: skipping OIDC provider "${id}" -- REDROID_FORGE_OIDC_REDIRECT_BASE_URL is not set.`);
      continue;
    }
    seen.add(id);
    providers.push({
      id,
      label,
      issuerUrl,
      clientId,
      clientSecret: typeof clientSecret === 'string' && clientSecret ? clientSecret : '',
      redirectUri: `${base}/api/auth/oidc/${id}/callback`,
    });
  }
  return providers;
}

function getProvider(id) {
  return listProviders().find((p) => p.id === id);
}

function isEnabled() {
  return listProviders().length > 0;
}

// One cached openid-client per provider id -- discovery is a real network round trip, not
// something to repeat on every login attempt. Keyed by id, not by config contents: a changed
// env var only takes effect after a restart anyway (see listProviders' own comment), so there is
// no "stale cache" case to defend against here beyond what a restart already clears.
const cachedClients = new Map();
async function getClient(providerId) {
  if (cachedClients.has(providerId)) return cachedClients.get(providerId);
  const p = getProvider(providerId);
  if (!p) throw Object.assign(new Error(`Unknown OIDC provider "${providerId}"`), { httpStatus: 404 });
  const issuer = await Issuer.discover(p.issuerUrl);
  const client = new issuer.Client({
    client_id: p.clientId,
    ...(p.clientSecret ? { client_secret: p.clientSecret } : { token_endpoint_auth_method: 'none' }),
    redirect_uris: [p.redirectUri],
    response_types: ['code'],
  });
  cachedClients.set(providerId, client);
  return client;
}

// In-memory only (not persisted, not a new session-cookie concern) -- a login flow lives for
// at most a couple of minutes end to end, and if the process restarts mid-flow the user just
// retries the login link. Swept lazily on each read. Keyed by `state` regardless of provider
// (state values come from a CSPRNG, collisions across providers are not a real concern) --
// `providerId` is still stored on the entry as a defense-in-depth cross-check in handleCallback,
// so a callback hitting the wrong provider's route can never succeed even in theory.
const pending = new Map();
const PENDING_TTL_MS = 5 * 60 * 1000;

// `linkLocalUserId` (26/10/2026, account linking -- see accountLinks.js): set only when this
// login was started from "link another login method" while already authenticated as a local
// account, never from a fresh login-screen click. Carried through `pending` so
// `handleCallback` can hand it back to the route -- the route is what actually decides whether
// to create a link or run the normal role-lookup flow, this module just remembers which kind of
// flow is in progress for this `state`.
function startLogin(providerId, { linkLocalUserId } = {}) {
  const state = generators.state();
  const entry = {
    state, providerId, codeVerifier: generators.codeVerifier(), nonce: generators.nonce(), createdAt: Date.now(),
    linkLocalUserId: linkLocalUserId || null,
  };
  pending.set(state, entry);
  for (const [key, value] of pending) if (Date.now() - value.createdAt > PENDING_TTL_MS) pending.delete(key);
  return entry;
}

// -> the URL to redirect the browser to, for whichever provider the person picked on the login
// screen. The `state` embedded in it is also the lookup key `handleCallback` uses to find the
// matching PKCE verifier/nonce -- see its own comment for why that lookup is the actual CSRF
// defense, with no separate cookie needed for it.
async function getAuthorizationUrl(providerId, opts) {
  const p = getProvider(providerId);
  if (!p) throw Object.assign(new Error(`Unknown OIDC provider "${providerId}"`), { httpStatus: 404 });
  const client = await getClient(providerId);
  const { state, codeVerifier, nonce } = startLogin(providerId, opts);
  const code_challenge = generators.codeChallenge(codeVerifier);
  return client.authorizationUrl({
    scope: 'openid profile',
    state,
    nonce,
    ...(p.clientSecret ? {} : { code_challenge, code_challenge_method: 'S256' }),
  });
}

// `providerId`: from the callback route's own URL (".../oidc/:providerId/callback"), checked
// against what `startLogin` recorded for this `state` -- a callback cannot be replayed against a
// different provider's route than the one the login actually started from. `params`:
// client.callbackParams()-shaped object (query/body from the IdP's redirect) -- its own `state`
// field is the lookup key into `pending`. Finding (and single-use consuming) an entry there IS
// the CSRF defense: the state value is unguessable and was only ever disclosed to the real
// browser via the real IdP redirect, so a forged callback has nothing to look up. openid-client's
// own `client.callback()` independently re-validates state/nonce/PKCE against what it stored in
// `checks` below -- this is defense in depth, not a redundant reimplementation of what it already
// does.
// -> {id, username, providerId, providerLabel, linkLocalUserId} on success -- identity only,
// deliberately no role (see the module comment above; the caller is responsible for turning
// `id` into a role via roleAssignments.js, or into a link via accountLinks.js when
// `linkLocalUserId` is set). `id` is `${providerId}:${sub}`, never the bare `sub` (see the module
// comment on why). Throws on anything invalid (bad/expired/replayed state, provider mismatch, bad
// code, token validation failure) -- the route turns that into a redirect back to a login error,
// not a 500.
async function handleCallback(providerId, params) {
  const p = getProvider(providerId);
  if (!p) throw Object.assign(new Error(`Unknown OIDC provider "${providerId}"`), { httpStatus: 404 });
  const entry = pending.get(params.state);
  pending.delete(params.state);
  if (!entry || entry.providerId !== providerId) {
    throw Object.assign(new Error('OIDC login state mismatch, expired, or wrong provider -- please try logging in again.'), { httpStatus: 400 });
  }
  const client = await getClient(providerId);
  const tokenSet = await client.callback(p.redirectUri, params, {
    state: entry.state,
    nonce: entry.nonce,
    ...(p.clientSecret ? {} : { code_verifier: entry.codeVerifier }),
  });
  const claims = tokenSet.claims();
  return {
    id: `${providerId}:${claims.sub}`,
    username: claims.preferred_username || claims.email || claims.sub,
    providerId,
    providerLabel: p.label,
    linkLocalUserId: entry.linkLocalUserId || null,
  };
}

// Admin CRUD for the Identities panel (30/10/2026) -- writes the plain entry shape into
// settings.json's `oidcProviders` (see rawProviderList's comment on precedence over the env
// var). Deliberately thinner than listProviders()'s validation: this only rejects what would
// make an entry UNRECOGNIZABLE (bad id, missing required field), the same way a hand-edited
// REDROID_FORGE_OIDC_PROVIDERS entry can sit there "saved but not usable yet" (e.g. before
// REDROID_FORGE_OIDC_REDIRECT_BASE_URL is set) without the write itself being rejected.
function validateProviderShape(entry) {
  const { id, label, issuerUrl, clientId, clientSecret } = entry || {};
  if (typeof id !== 'string' || !PROVIDER_ID_RE.test(id)) {
    throw Object.assign(new Error('"id" must be lowercase letters/digits/"-", 1-32 chars.'), { httpStatus: 400 });
  }
  if (typeof label !== 'string' || !label.trim()) {
    throw Object.assign(new Error('"label" is required.'), { httpStatus: 400 });
  }
  if (typeof issuerUrl !== 'string' || !issuerUrl.trim()) {
    throw Object.assign(new Error('"issuerUrl" is required.'), { httpStatus: 400 });
  }
  if (typeof clientId !== 'string' || !clientId.trim()) {
    throw Object.assign(new Error('"clientId" is required.'), { httpStatus: 400 });
  }
  return {
    id,
    label: label.trim(),
    issuerUrl: issuerUrl.trim(),
    clientId: clientId.trim(),
    ...(typeof clientSecret === 'string' && clientSecret ? { clientSecret } : {}),
  };
}

function addProvider(entry) {
  const clean = validateProviderShape(entry);
  const list = rawProviderList();
  if (list.some((p) => p.id === clean.id)) {
    throw Object.assign(new Error(`A provider with id "${clean.id}" already exists.`), { httpStatus: 400 });
  }
  settings.update({ oidcProviders: [...list, clean] });
  return clean;
}

// `patch` fields left out keep their previous value -- including clientSecret, so editing just
// the label does not force re-pasting a secret that was never shown back to the UI in the first
// place (see routes/auth.js's GET /oidc-providers, which only ever returns hasClientSecret).
// Pass clientSecret: '' explicitly to clear it (e.g. switching a confidential client to public).
function updateProvider(id, patch) {
  const list = rawProviderList();
  const idx = list.findIndex((p) => p.id === id);
  if (idx === -1) throw Object.assign(new Error(`No OIDC provider with id "${id}".`), { httpStatus: 404 });
  const clean = validateProviderShape({ ...list[idx], ...patch, id });
  const next = [...list];
  next[idx] = clean;
  settings.update({ oidcProviders: next });
  return clean;
}

function removeProvider(id) {
  const list = rawProviderList();
  if (!list.some((p) => p.id === id)) {
    throw Object.assign(new Error(`No OIDC provider with id "${id}".`), { httpStatus: 404 });
  }
  settings.update({ oidcProviders: list.filter((p) => p.id !== id) });
}

module.exports = {
  listProviders, getProvider, isEnabled, getAuthorizationUrl, handleCallback,
  addProvider, updateProvider, removeProvider, rawProviderList,
};

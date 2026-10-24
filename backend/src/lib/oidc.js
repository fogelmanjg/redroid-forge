'use strict';

// Generic OIDC client (docs/ROADMAP.md Phase 7) -- deliberately NOT a Keycloak-specific
// integration. Any IdP that speaks standard OIDC discovery works the same way (Keycloak,
// Authentik, Auth0, Zitadel, ...); what differs between them is only WHERE the role claim
// lives, which is why the claim path and the three role names are all configurable instead of
// hardcoded to Keycloak's `realm_access.roles` convention.
//
// openid-client is pinned to the last v5.x release (5.7.1), not the current major: v6 rewrote
// the package as ESM-only, and this backend is plain CommonJS with no build step by design (see
// docs/ROADMAP.md's own stack notes) -- rewriting the whole backend as ESM just for this one
// dependency was not worth it. v5 handles discovery/PKCE/JWKS/token validation correctly, which
// is the actual point of using a real library here instead of hand-rolling OIDC crypto.

const { Issuer, generators } = require('openid-client');
const { isValidRole } = require('./permissions');

function config() {
  return {
    issuerUrl: process.env.REDROID_FORGE_OIDC_ISSUER_URL || '',
    clientId: process.env.REDROID_FORGE_OIDC_CLIENT_ID || '',
    clientSecret: process.env.REDROID_FORGE_OIDC_CLIENT_SECRET || '',
    redirectUri: process.env.REDROID_FORGE_OIDC_REDIRECT_URI || '',
    // Dotted path into the ID token/userinfo claims where role names live -- Keycloak's own
    // default location (realm_access.roles) is a sane default, but this is NOT Keycloak-
    // specific: an IdP that puts a flat array in `roles` just sets this to "roles" instead.
    rolesClaimPath: process.env.REDROID_FORGE_OIDC_ROLES_CLAIM || 'realm_access.roles',
    adminRole: process.env.REDROID_FORGE_OIDC_ADMIN_ROLE || 'redroid-forge-admin',
    operatorRole: process.env.REDROID_FORGE_OIDC_OPERATOR_ROLE || 'redroid-forge-operator',
    viewerRole: process.env.REDROID_FORGE_OIDC_VIEWER_ROLE || 'redroid-forge-viewer',
  };
}

function isEnabled() {
  const c = config();
  return !!(c.issuerUrl && c.clientId && c.redirectUri);
}

function getByPath(obj, dottedPath) {
  return dottedPath.split('.').reduce((acc, key) => (acc && typeof acc === 'object' ? acc[key] : undefined), obj);
}

// -> 'admin' | 'operator' | 'viewer'. Deliberately defaults to the LEAST privileged role when
// the claim is missing or matches none of the three configured role names -- unlike a missing
// local-account role (which cannot happen, createUser validates it), an IdP's claims are data
// from outside this project, and defaulting to viewer is the safe failure direction (never
// silently admin). Pure, independent of any live IdP -- unit-tested without one.
function mapRole(claims) {
  const c = config();
  const raw = getByPath(claims || {}, c.rolesClaimPath);
  const roles = Array.isArray(raw) ? raw : [];
  if (roles.includes(c.adminRole)) return 'admin';
  if (roles.includes(c.operatorRole)) return 'operator';
  if (roles.includes(c.viewerRole)) return 'viewer';
  return 'viewer';
}

let cachedClient = null;
async function getClient() {
  if (cachedClient) return cachedClient;
  const c = config();
  const issuer = await Issuer.discover(c.issuerUrl);
  cachedClient = new issuer.Client({
    client_id: c.clientId,
    ...(c.clientSecret ? { client_secret: c.clientSecret } : { token_endpoint_auth_method: 'none' }),
    redirect_uris: [c.redirectUri],
    response_types: ['code'],
  });
  return cachedClient;
}

// In-memory only (not persisted, not a new session-cookie concern) -- a login flow lives for
// at most a couple of minutes end to end, and if the process restarts mid-flow the user just
// retries the login link. Swept lazily on each read.
const pending = new Map();
const PENDING_TTL_MS = 5 * 60 * 1000;

function startLogin() {
  const state = generators.state();
  const entry = { state, codeVerifier: generators.codeVerifier(), nonce: generators.nonce(), createdAt: Date.now() };
  pending.set(state, entry);
  for (const [key, value] of pending) if (Date.now() - value.createdAt > PENDING_TTL_MS) pending.delete(key);
  return entry;
}

// -> the URL to redirect the browser to. The `state` embedded in it is also the lookup key
// `handleCallback` uses to find the matching PKCE verifier/nonce -- see its own comment for why
// that lookup is the actual CSRF defense, with no separate cookie needed for it.
async function getAuthorizationUrl() {
  const client = await getClient();
  const c = config();
  const { state, codeVerifier, nonce } = startLogin();
  const code_challenge = generators.codeChallenge(codeVerifier);
  return client.authorizationUrl({
    scope: 'openid profile',
    state,
    nonce,
    ...(c.clientSecret ? {} : { code_challenge, code_challenge_method: 'S256' }),
  });
}

// `params`: client.callbackParams()-shaped object (query/body from the IdP's redirect) -- its
// own `state` field is the lookup key into `pending`. Finding (and single-use consuming) an
// entry there IS the CSRF defense: the state value is unguessable and was only ever disclosed
// to the real browser via the real IdP redirect, so a forged callback has nothing to look up.
// openid-client's own `client.callback()` independently re-validates state/nonce/PKCE against
// what it stored in `checks` below -- this is defense in depth, not a redundant reimplementation
// of what it already does.
// -> {id, username, role} on success. Throws on anything invalid (bad/expired/replayed state,
// bad code, token validation failure) -- the route turns that into a redirect back to a login
// error, not a 500.
async function handleCallback(params) {
  const c = config();
  const entry = pending.get(params.state);
  pending.delete(params.state);
  if (!entry) {
    throw Object.assign(new Error('OIDC login state mismatch or expired -- please try logging in again.'), { httpStatus: 400 });
  }
  const client = await getClient();
  const tokenSet = await client.callback(c.redirectUri, params, {
    state: entry.state,
    nonce: entry.nonce,
    ...(c.clientSecret ? {} : { code_verifier: entry.codeVerifier }),
  });
  const claims = tokenSet.claims();
  const role = mapRole(claims);
  if (!isValidRole(role)) throw new Error('unreachable: mapRole always returns a valid role');
  return { id: claims.sub, username: claims.preferred_username || claims.email || claims.sub, role };
}

module.exports = {
  isEnabled, config, mapRole, getAuthorizationUrl, handleCallback,
};

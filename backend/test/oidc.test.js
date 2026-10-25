// Coverage of the parts of src/lib/oidc.js that do not need a live IdP: parsing
// REDROID_FORGE_OIDC_PROVIDERS and deriving each provider's redirect URI. getAuthorizationUrl/
// handleCallback need a real OIDC issuer to discover against and are NOT covered here -- see
// docs/ROADMAP.md Phase 7's note on that gap. Role mapping used to live here too (mapRole) until
// the 25/10/2026 redesign moved role resolution out of this module entirely -- see
// roleAssignments.test.js for that coverage now.
const test = require('node:test');
const assert = require('node:assert/strict');

function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) { prev[k] = process.env[k]; process.env[k] = v; }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

delete require.cache[require.resolve('../src/lib/oidc')];
const oidc = require('../src/lib/oidc');

const BASE_ENV = { REDROID_FORGE_OIDC_REDIRECT_BASE_URL: 'http://localhost:8099' };

test('isEnabled/listProviders: empty or unset -> no providers, disabled', () => {
  withEnv({ ...BASE_ENV, REDROID_FORGE_OIDC_PROVIDERS: '' }, () => {
    assert.deepEqual(oidc.listProviders(), []);
    assert.equal(oidc.isEnabled(), false);
  });
});

test('listProviders: derives each provider\'s redirectUri from the base url + its own id', () => {
  withEnv({
    ...BASE_ENV,
    REDROID_FORGE_OIDC_PROVIDERS: JSON.stringify([
      { id: 'google', label: 'Google', issuerUrl: 'https://accounts.google.com', clientId: 'g-client' },
      { id: 'keycloak', label: 'My Keycloak', issuerUrl: 'https://idp.example/realms/x', clientId: 'kc-client', clientSecret: 's3cr3t' },
    ]),
  }, () => {
    const providers = oidc.listProviders();
    assert.equal(providers.length, 2);
    assert.equal(providers[0].redirectUri, 'http://localhost:8099/api/auth/oidc/google/callback');
    assert.equal(providers[1].redirectUri, 'http://localhost:8099/api/auth/oidc/keycloak/callback');
    assert.equal(providers[1].clientSecret, 's3cr3t');
    assert.equal(providers[0].clientSecret, '');
    assert.equal(oidc.isEnabled(), true);
    assert.ok(oidc.getProvider('google'));
    assert.equal(oidc.getProvider('nonexistent'), undefined);
  });
});

test('listProviders: drops an invalid id, a duplicate id, and an entry missing required fields -- keeps the rest', () => {
  withEnv({
    ...BASE_ENV,
    REDROID_FORGE_OIDC_PROVIDERS: JSON.stringify([
      { id: 'Bad ID!', label: 'x', issuerUrl: 'https://a.example', clientId: 'a' },
      { id: 'ok', label: 'Ok Provider', issuerUrl: 'https://b.example', clientId: 'b' },
      { id: 'ok', label: 'Duplicate', issuerUrl: 'https://c.example', clientId: 'c' },
      { id: 'missing-fields', label: 'No issuer' },
    ]),
  }, () => {
    const providers = oidc.listProviders();
    assert.equal(providers.length, 1);
    assert.equal(providers[0].id, 'ok');
  });
});

test('listProviders: malformed JSON or a non-array -> empty, never throws', () => {
  withEnv({ ...BASE_ENV, REDROID_FORGE_OIDC_PROVIDERS: 'not json' }, () => {
    assert.deepEqual(oidc.listProviders(), []);
  });
  withEnv({ ...BASE_ENV, REDROID_FORGE_OIDC_PROVIDERS: '{"not":"an array"}' }, () => {
    assert.deepEqual(oidc.listProviders(), []);
  });
});

test('listProviders: every entry dropped if REDROID_FORGE_OIDC_REDIRECT_BASE_URL is not set', () => {
  withEnv({
    REDROID_FORGE_OIDC_REDIRECT_BASE_URL: '',
    REDROID_FORGE_OIDC_PROVIDERS: JSON.stringify([{ id: 'google', label: 'Google', issuerUrl: 'https://accounts.google.com', clientId: 'g' }]),
  }, () => {
    assert.deepEqual(oidc.listProviders(), []);
  });
});

test('module surface: config/mapRole no longer exist -- identity only, multi-provider', () => {
  assert.equal('config' in oidc, false);
  assert.equal('mapRole' in oidc, false);
});

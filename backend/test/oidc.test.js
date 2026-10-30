// Coverage of the parts of src/lib/oidc.js that do not need a live IdP: parsing
// REDROID_FORGE_OIDC_PROVIDERS and deriving each provider's redirect URI. getAuthorizationUrl/
// handleCallback need a real OIDC issuer to discover against and are NOT covered here -- see
// docs/ROADMAP.md Phase 7's note on that gap. Role mapping used to live here too (mapRole) until
// the 25/10/2026 redesign moved role resolution out of this module entirely -- see
// roleAssignments.test.js for that coverage now.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

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

// REDROID_FORGE_SETTINGS_FILE keeps listProviders()'s settings.json read (see rawProviderList's
// precedence comment) off this host's real backend/data/settings.json -- otherwise a real
// redroid-forge instance that has ever had OIDC providers added through the Identities panel
// would leak into every test below instead of each test's own REDROID_FORGE_OIDC_PROVIDERS.
// Nonexistent-but-writable (os.tmpdir() itself always exists) -- settings.get() treats a
// missing file as {} (DEFAULTS), so this reliably means "providers were never managed through
// the UI" without ever touching this host's real backend/data/settings.json.
const NONEXISTENT_SETTINGS_FILE = path.join(os.tmpdir(), `redroid-forge-test-settings-${process.pid}.json`);

const BASE_ENV = {
  REDROID_FORGE_OIDC_REDIRECT_BASE_URL: 'http://localhost:8099',
  REDROID_FORGE_SETTINGS_FILE: NONEXISTENT_SETTINGS_FILE,
};

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
    ...BASE_ENV,
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

function tmpSettingsFile() {
  const fs = require('fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oidc-providers-'));
  return path.join(dir, 'settings.json');
}

test('addProvider/updateProvider/removeProvider: settings.json becomes the source of truth, takes over from REDROID_FORGE_OIDC_PROVIDERS', () => {
  withEnv({ ...BASE_ENV, REDROID_FORGE_SETTINGS_FILE: tmpSettingsFile(), REDROID_FORGE_OIDC_PROVIDERS: JSON.stringify([{ id: 'legacy', label: 'Legacy env-var provider', issuerUrl: 'https://legacy.example', clientId: 'l' }]) }, () => {
    // Before any UI write, the env var is still what listProviders() sees.
    assert.deepEqual(oidc.listProviders().map((p) => p.id), ['legacy']);

    const added = oidc.addProvider({ id: 'kc', label: 'Keycloak', issuerUrl: 'https://idp.example', clientId: 'kc-client', clientSecret: 's3cr3t' });
    assert.equal(added.id, 'kc');
    // addProvider starts from whatever is currently active (rawProviderList(), the env var on
    // this first call) and appends -- "legacy" is carried over into settings.json, not dropped,
    // so adding one more provider never silently deletes an existing env-configured one.
    assert.deepEqual(oidc.listProviders().map((p) => p.id), ['legacy', 'kc']);
    assert.equal(oidc.getProvider('kc').clientSecret, 's3cr3t');

    oidc.updateProvider('kc', { label: 'Keycloak (renamed)' });
    assert.equal(oidc.getProvider('kc').label, 'Keycloak (renamed)');
    // clientSecret untouched by an update that does not mention it.
    assert.equal(oidc.getProvider('kc').clientSecret, 's3cr3t');

    oidc.updateProvider('kc', { clientSecret: '' });
    assert.equal(oidc.getProvider('kc').clientSecret, '');

    oidc.removeProvider('kc');
    // Only "kc" is gone -- "legacy" (carried into settings.json by the addProvider above) is
    // untouched, and settings.json (not the env var) is now listProviders()'s only source.
    assert.deepEqual(oidc.listProviders().map((p) => p.id), ['legacy']);
  });
});

test('addProvider: rejects a duplicate id, an invalid id, and a missing required field', () => {
  withEnv({ ...BASE_ENV, REDROID_FORGE_SETTINGS_FILE: tmpSettingsFile() }, () => {
    oidc.addProvider({ id: 'kc', label: 'Keycloak', issuerUrl: 'https://idp.example', clientId: 'kc-client' });
    assert.throws(() => oidc.addProvider({ id: 'kc', label: 'Dup', issuerUrl: 'https://x.example', clientId: 'x' }), /already exists/);
    assert.throws(() => oidc.addProvider({ id: 'Bad ID!', label: 'x', issuerUrl: 'https://x.example', clientId: 'x' }), /"id"/);
    assert.throws(() => oidc.addProvider({ id: 'ok2', label: 'x', clientId: 'x' }), /issuerUrl/);
  });
});

test('updateProvider/removeProvider: 404-shaped error on an unknown id', () => {
  withEnv({ ...BASE_ENV, REDROID_FORGE_SETTINGS_FILE: tmpSettingsFile() }, () => {
    assert.throws(() => oidc.updateProvider('nonexistent', { label: 'x' }), (e) => e.httpStatus === 404);
    assert.throws(() => oidc.removeProvider('nonexistent'), (e) => e.httpStatus === 404);
  });
});

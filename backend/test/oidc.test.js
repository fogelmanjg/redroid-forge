// Coverage of the parts of src/lib/oidc.js that do not need a live IdP: role-claim mapping and
// enablement detection. getAuthorizationUrl/handleCallback need a real OIDC issuer to discover
// against and are NOT covered here -- see docs/ROADMAP.md Phase 7's note on that gap.
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

// oidc.js reads env vars once per call (config() is called fresh each time, not cached), so
// re-requiring between tests is not needed -- but isolate require() cache just in case anything
// about openid-client itself is sensitive to load order across other suites.
delete require.cache[require.resolve('../src/lib/oidc')];
const oidc = require('../src/lib/oidc');

test('isEnabled: false unless issuer, client id and redirect uri are all set', () => {
  withEnv({ REDROID_FORGE_OIDC_ISSUER_URL: '', REDROID_FORGE_OIDC_CLIENT_ID: '', REDROID_FORGE_OIDC_REDIRECT_URI: '' }, () => {
    assert.equal(oidc.isEnabled(), false);
  });
  withEnv({
    REDROID_FORGE_OIDC_ISSUER_URL: 'https://idp.example/realms/x',
    REDROID_FORGE_OIDC_CLIENT_ID: 'redroid-forge',
    REDROID_FORGE_OIDC_REDIRECT_URI: 'http://localhost:8099/api/auth/oidc/callback',
  }, () => {
    assert.equal(oidc.isEnabled(), true);
  });
});

test('mapRole: Keycloak-style default claim path (realm_access.roles)', () => {
  withEnv({}, () => {
    assert.equal(oidc.mapRole({ realm_access: { roles: ['redroid-forge-admin', 'offline_access'] } }), 'admin');
    assert.equal(oidc.mapRole({ realm_access: { roles: ['redroid-forge-operator'] } }), 'operator');
    assert.equal(oidc.mapRole({ realm_access: { roles: ['redroid-forge-viewer'] } }), 'viewer');
  });
});

test('mapRole: missing claim, empty roles, or none of the three configured names -> viewer (safe default, never admin)', () => {
  withEnv({}, () => {
    assert.equal(oidc.mapRole({}), 'viewer');
    assert.equal(oidc.mapRole({ realm_access: { roles: [] } }), 'viewer');
    assert.equal(oidc.mapRole({ realm_access: { roles: ['some-other-app-role'] } }), 'viewer');
    assert.equal(oidc.mapRole(null), 'viewer');
  });
});

test('mapRole: admin takes priority if a claim somehow lists more than one of the three roles', () => {
  withEnv({}, () => {
    assert.equal(oidc.mapRole({ realm_access: { roles: ['redroid-forge-admin', 'redroid-forge-viewer'] } }), 'admin');
  });
});

test('mapRole: configurable claim path and role names (not Keycloak-specific)', () => {
  withEnv({
    REDROID_FORGE_OIDC_ROLES_CLAIM: 'roles',
    REDROID_FORGE_OIDC_ADMIN_ROLE: 'forge-admin',
    REDROID_FORGE_OIDC_OPERATOR_ROLE: 'forge-op',
    REDROID_FORGE_OIDC_VIEWER_ROLE: 'forge-view',
  }, () => {
    assert.equal(oidc.mapRole({ roles: ['forge-admin'] }), 'admin');
    assert.equal(oidc.mapRole({ roles: ['forge-op'] }), 'operator');
    assert.equal(oidc.mapRole({ realm_access: { roles: ['redroid-forge-admin'] } }), 'viewer'); // wrong path now, falls to default
  });
});

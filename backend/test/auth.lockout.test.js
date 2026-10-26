// Coverage of auth.js's self-lockout guard (26/10/2026) -- "local"/"both" with
// REDROID_FORGE_AUTH set but no local account reachable (no user yet, and
// REDROID_FORGE_LOCAL_ADMIN_USER/_PASSWORD not set either) used to mean a permanently locked
// login screen, since the Identities setup wizard only shows itself while AUTH_MODE is "none".
// localPathOpen/oidcPathOpen are the exact functions the require-time downgrade in auth.js
// itself calls -- tested directly here against an isolated temp users file (never the real
// backend/data/users.json, see auth.js's own comment on why `usersFile` exists) rather than by
// re-require()ing the whole module, which could only be driven by the real on-disk file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

delete require.cache[require.resolve('../src/lib/auth')];
const auth = require('../src/lib/auth');

function tmpUsersFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-lockout-'));
  return path.join(dir, 'users.json');
}

function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) { prev[k] = process.env[k]; process.env[k] = v; }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('localPathOpen: false when the file has no users and no bootstrap vars are set', () => {
  withEnv({ REDROID_FORGE_LOCAL_ADMIN_USER: '', REDROID_FORGE_LOCAL_ADMIN_PASSWORD: '' }, () => {
    assert.equal(auth.localPathOpen(tmpUsersFile()), false);
  });
});

test('localPathOpen: true when both bootstrap vars are set, even with zero users on disk', () => {
  withEnv({ REDROID_FORGE_LOCAL_ADMIN_USER: 'admin', REDROID_FORGE_LOCAL_ADMIN_PASSWORD: 'x' }, () => {
    assert.equal(auth.localPathOpen(tmpUsersFile()), true);
  });
});

test('localPathOpen: true when a user already exists on disk, even with no bootstrap vars', () => {
  const file = tmpUsersFile();
  require('../src/lib/userStore').createUser({ username: 'alice', password: 'longenough1', role: 'viewer' }, file);
  withEnv({ REDROID_FORGE_LOCAL_ADMIN_USER: '', REDROID_FORGE_LOCAL_ADMIN_PASSWORD: '' }, () => {
    assert.equal(auth.localPathOpen(file), true);
  });
});

test('localPathOpen: false when only ONE of the two bootstrap vars is set', () => {
  withEnv({ REDROID_FORGE_LOCAL_ADMIN_USER: 'admin', REDROID_FORGE_LOCAL_ADMIN_PASSWORD: '' }, () => {
    assert.equal(auth.localPathOpen(tmpUsersFile()), false);
  });
});

test('oidcPathOpen: false with no providers configured', () => {
  withEnv({ REDROID_FORGE_OIDC_PROVIDERS: '' }, () => {
    assert.equal(auth.oidcPathOpen(), false);
  });
});

test('oidcPathOpen: true with at least one valid provider configured', () => {
  withEnv({
    REDROID_FORGE_OIDC_PROVIDERS: JSON.stringify([{ id: 'kc', label: 'KC', issuerUrl: 'https://idp.example', clientId: 'x' }]),
    REDROID_FORGE_OIDC_REDIRECT_BASE_URL: 'https://app.example',
  }, () => {
    assert.equal(auth.oidcPathOpen(), true);
  });
});

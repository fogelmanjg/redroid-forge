const express = require('express');
const auth = require('../lib/auth');
const userStore = require('../lib/userStore');
const oidc = require('../lib/oidc');
const roleAssignments = require('../lib/roleAssignments');
const permissions = require('../lib/permissions');

const router = express.Router();

function httpError(message, httpStatus) {
  return Object.assign(new Error(message), { httpStatus });
}
function sendError(res, e, fallbackStatus = 500) {
  res.status(e.httpStatus || fallbackStatus).json({ error: e.message });
}

// Always reachable, in every auth mode, with no login required -- the frontend's very first
// call on load, to decide whether to render the app or a login screen, and which kind.
// `capabilities`/`canManageSettings` are computed here (not re-derived from the role name in
// the frontend) so the role -> capability table lives in exactly one place, permissions.js.
router.get('/me', (req, res) => {
  const user = req.user || null;
  res.json({
    authMode: auth.AUTH_MODE,
    user,
    capabilities: user ? permissions.CAPABILITIES.filter((c) => permissions.can(user, c)) : [],
    canManageSettings: permissions.canManageSettings(user),
  });
});

router.post('/logout', (req, res) => {
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

router.post('/login', (req, res) => {
  if (auth.AUTH_MODE !== 'local') return res.status(404).json({ error: 'REDROID_FORGE_AUTH is not "local"' });
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: '"username" and "password" are required' });
  }
  const user = userStore.verifyCredentials(username, password);
  if (!user) return res.status(401).json({ error: 'Wrong username or password' });
  auth.setSessionCookie(res, user);
  res.json({ user });
});

// OIDC flow -- see src/lib/oidc.js for why it is generic (not Keycloak-specific), multi-provider
// (any number of configured trust sources, the person picks which one at login time), and why
// the CSRF defense needs no extra cookie of its own. Public, no login required -- the login
// screen needs this to even know which "Log in with X" buttons to draw, before anyone is
// authenticated.
router.get('/oidc/providers', (req, res) => {
  if (auth.AUTH_MODE !== 'oidc') return res.status(404).json({ error: 'REDROID_FORGE_AUTH is not "oidc"' });
  res.json(oidc.listProviders().map((p) => ({ id: p.id, label: p.label })));
});

router.get('/oidc/:providerId/login', async (req, res) => {
  if (auth.AUTH_MODE !== 'oidc') return res.status(404).json({ error: 'REDROID_FORGE_AUTH is not "oidc"' });
  try {
    res.redirect(await oidc.getAuthorizationUrl(req.params.providerId));
  } catch (e) {
    sendError(res, e);
  }
});

router.get('/oidc/:providerId/callback', async (req, res) => {
  if (auth.AUTH_MODE !== 'oidc') return res.status(404).json({ error: 'REDROID_FORGE_AUTH is not "oidc"' });
  try {
    // handleCallback only ever proves IDENTITY (see oidc.js's own comment on why) -- the role,
    // if any, comes from this project's own table, never from whichever provider the person
    // picked. upsertSeen always records/refreshes the identity (so an admin can see and approve
    // it) even when it is not granted anything yet; the session cookie is only ever set once a
    // real role exists.
    const identity = await oidc.handleCallback(req.params.providerId, req.query);
    const seen = roleAssignments.upsertSeen(identity);
    if (!seen.role) {
      return res.status(403).send(
        'Login succeeded, but no role has been assigned to this account yet -- ask a redroid-forge admin to approve it.',
      );
    }
    auth.setSessionCookie(res, { id: identity.id, username: identity.username, role: seen.role });
    res.redirect('/');
  } catch (e) {
    res.status(e.httpStatus || 400).send(`Login failed: ${e.message}`);
  }
});

// Local user management -- admin only, and only meaningful in "local" mode (there is nowhere
// else to create an account: "oidc" accounts come from the IdP, "none" has no accounts at all).
// This is the ONLY way to add a user beyond the bootstrap admin (userStore.ensureBootstrapAdmin)
// -- there is no separate setup wizard.
function requireLocalAdmin(req, res, next) {
  if (auth.AUTH_MODE !== 'local') return res.status(404).json({ error: 'REDROID_FORGE_AUTH is not "local"' });
  if (!permissions.canManageSettings(req.user)) return res.status(403).json({ error: 'Admin only' });
  next();
}

router.get('/users', requireLocalAdmin, (req, res) => {
  res.json(userStore.listUsers());
});

router.post('/users', requireLocalAdmin, (req, res) => {
  try {
    const { username, password, role } = req.body || {};
    res.status(201).json(userStore.createUser({ username, password, role }));
  } catch (e) {
    sendError(res, e, 400);
  }
});

router.delete('/users/:id', requireLocalAdmin, (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete your own account while logged in as it' });
  }
  userStore.deleteUser(req.params.id);
  res.status(204).end();
});

// OIDC identity/role management -- admin only, only meaningful in "oidc" mode (see
// roleAssignments.js). Unlike /users, there is no "create" route here: an identity only ever
// comes into existence by actually logging in once (upsertSeen, see /oidc/callback above) --
// an admin approves/assigns a role to one that already showed up, never invents one from
// scratch.
function requireOidcAdmin(req, res, next) {
  if (auth.AUTH_MODE !== 'oidc') return res.status(404).json({ error: 'REDROID_FORGE_AUTH is not "oidc"' });
  if (!permissions.canManageSettings(req.user)) return res.status(403).json({ error: 'Admin only' });
  next();
}

router.get('/identities', requireOidcAdmin, (req, res) => {
  res.json(roleAssignments.listAssignments());
});

router.put('/identities/:externalId/role', requireOidcAdmin, (req, res) => {
  try {
    const { role } = req.body || {};
    res.json(roleAssignments.setRole(req.params.externalId, role === undefined ? null : role));
  } catch (e) {
    sendError(res, e, 400);
  }
});

router.delete('/identities/:externalId', requireOidcAdmin, (req, res) => {
  if (req.params.externalId === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete your own identity while logged in as it' });
  }
  roleAssignments.deleteAssignment(req.params.externalId);
  res.status(204).end();
});

module.exports = router;

const express = require('express');
const auth = require('../lib/auth');
const userStore = require('../lib/userStore');
const oidc = require('../lib/oidc');
const roleAssignments = require('../lib/roleAssignments');
const accountLinks = require('../lib/accountLinks');
const permissions = require('../lib/permissions');
const settings = require('../lib/settings');

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

// Minimal id+username directory (docs/ROADMAP.md Phase 7, 25/10/2026) -- any logged-in user, not
// just admin, unlike /users and /identities below. Needed so an operator sharing an instance
// (PUT /api/instances/:id/owners, "transfer-ownership") has a way to find who to share it WITH
// by username, without needing admin's own account-management view -- no role, no provider, no
// passwordHash, nothing beyond what is already shown on screen elsewhere (every username). OIDC
// identities that have never been granted a role are left out: sharing an instance with someone
// who cannot even log in yet would just be confusing, not useful.
router.get('/directory', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  const rows = [];
  if (auth.LOCAL_ENABLED) {
    for (const u of userStore.listUsers()) rows.push({ id: u.id, username: u.username });
  }
  if (auth.OIDC_ENABLED) {
    for (const a of roleAssignments.listAssignments()) {
      if (a.role) rows.push({ id: a.externalId, username: a.username });
    }
  }
  res.json(rows);
});

// First-run setup wizard (26/10/2026) -- turning on security today means hand-editing
// REDROID_FORGE_AUTH in .env and restarting, with no in-app way to even create the first admin
// account beforehand (the normal /identities routes below all 404 while AUTH_MODE is "none").
// These two routes close only that gap: creating the local admin row can happen live, no
// restart needed (userStore.js is a plain data layer, see its own comment -- it never gated on
// auth mode itself, only the routes did). The mode flip itself still is NOT done here -- see the
// module-level comment below on why self-recreating this container from inside itself (even
// though it already holds the Docker socket for managing redroid instances) is not a risk worth
// taking for a security-mode change; the frontend shows the exact .env line + restart command
// instead, and polls GET /me to detect once a human has actually done it.
//
// No extra privilege boundary is added by either route: "none" mode already means whoever can
// reach this app has full admin capability over every instance (see docker-compose.yml's own
// comment on REDROID_FORGE_BIND_HOST) -- being able to also pre-create a pending local admin row
// is not a new hole, it is the same posture.
router.get('/setup/status', (req, res) => {
  res.json({
    authMode: auth.AUTH_MODE,
    localUsernames: userStore.listUsers().map((u) => u.username),
    // See docker-compose.yml's own comment on REDROID_FORGE_REPO_DIR -- null if whoever runs
    // this container did not pass it through (e.g. a hand-rolled `docker run`, not this repo's
    // compose file), the wizard just falls back to a vaguer instruction in that case.
    repoDir: process.env.REDROID_FORGE_REPO_DIR || null,
  });
});

router.post('/setup/admin', (req, res) => {
  if (auth.AUTH_MODE !== 'none') {
    return res.status(403).json({ error: 'Setup only applies while REDROID_FORGE_AUTH is "none" -- use the Identities panel once an admin is logged in.' });
  }
  try {
    const { username, password } = req.body || {};
    const user = userStore.createUser({ username, password, role: 'admin' });
    res.status(201).json({ id: user.id, username: user.username, role: user.role });
  } catch (e) {
    sendError(res, e, 400);
  }
});

router.post('/login', (req, res) => {
  if (!auth.LOCAL_ENABLED) return res.status(404).json({ error: 'REDROID_FORGE_AUTH has local accounts disabled' });
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
  if (!auth.OIDC_ENABLED) return res.status(404).json({ error: 'REDROID_FORGE_AUTH has OIDC disabled' });
  res.json(oidc.listProviders().map((p) => ({ id: p.id, label: p.label })));
});

router.get('/oidc/:providerId/login', async (req, res) => {
  if (!auth.OIDC_ENABLED) return res.status(404).json({ error: 'REDROID_FORGE_AUTH has OIDC disabled' });
  try {
    res.redirect(await oidc.getAuthorizationUrl(req.params.providerId));
  } catch (e) {
    sendError(res, e);
  }
});

router.get('/oidc/:providerId/callback', async (req, res) => {
  if (!auth.OIDC_ENABLED) return res.status(404).json({ error: 'REDROID_FORGE_AUTH has OIDC disabled' });
  try {
    // handleCallback only ever proves IDENTITY (see oidc.js's own comment on why) -- the role,
    // if any, comes from this project's own table, never from whichever provider the person
    // picked.
    const identity = await oidc.handleCallback(req.params.providerId, req.query);

    // Account linking (26/10/2026, see accountLinks.js) -- this callback is completing a "link
    // another login method" request started from /me/links/:providerId/start while already
    // logged in as a local account, not a fresh login. Record the link and leave the person's
    // EXISTING session alone (they are already logged in as that local account; nothing about
    // their session needs to change) rather than running the normal role-lookup flow below.
    if (identity.linkLocalUserId) {
      const localUser = userStore.findById(identity.linkLocalUserId);
      if (!localUser) {
        return res.status(400).send('Cannot link: the local account this was started from no longer exists.');
      }
      // An externalId that already has its OWN assigned role (not just a pending, never-
      // approved one) is a separate identity an admin deliberately granted access to -- absorb
      // it into a link only with an explicit unlink-then-relink, never silently here.
      const existingAssignment = roleAssignments.findByExternalId(identity.id);
      if (existingAssignment && existingAssignment.role) {
        return res.status(409).send(
          `"${identity.username}" already has its own role ("${existingAssignment.role}") as a separate identity -- `
          + 'remove that role first (Identities panel) before linking it to a local account.',
        );
      }
      try {
        accountLinks.link({
          externalId: identity.id, localUserId: identity.linkLocalUserId, username: identity.username,
          providerId: identity.providerId, providerLabel: identity.providerLabel,
        });
      } catch (e) {
        return res.status(e.httpStatus || 400).send(e.message);
      }
      // Superseded by the link now -- an unlinked, never-approved pending row left behind would
      // just be confusing clutter in the Identities panel.
      if (existingAssignment) roleAssignments.deleteAssignment(identity.id);
      return res.redirect('/');
    }

    // Not a link -- a fresh login. A PREVIOUSLY linked identity logs in AS its anchor local
    // account (same session id, so quotas/ownership/capabilities all key off the one stable
    // identity) -- re-reading the local user fresh rather than trusting anything cached on the
    // link record, so a role change made after linking still applies immediately.
    const existingLink = accountLinks.findByExternalId(identity.id);
    if (existingLink) {
      const localUser = userStore.findById(existingLink.localUserId);
      if (localUser) {
        auth.setSessionCookie(res, { id: localUser.id, username: localUser.username, role: localUser.role });
        return res.redirect('/');
      }
      // The linked local account was deleted since -- fall through to the normal unlinked flow
      // below rather than erroring, same as any other never-approved identity.
    }

    // upsertSeen always records/refreshes the identity (so an admin can see and approve it)
    // even when it is not granted anything yet; the session cookie is only ever set once a real
    // role exists.
    //
    // oidc.js names this field `id` (its own identity-shaped contract); roleAssignments.js
    // names the same value `externalId` (its own storage-shaped contract) -- map explicitly
    // here rather than passing `identity` straight through, or every identity collapses onto
    // a single stored row (externalId ends up undefined for all of them, and undefined ===
    // undefined matches the first one ever created) and BOOTSTRAP_ADMIN_ID can never match
    // anything real. Found live 26/10/2026 -- unit tests call upsertSeen directly with the
    // correct shape, so they never exercised this call site.
    const seen = roleAssignments.upsertSeen({
      externalId: identity.id,
      username: identity.username,
      providerId: identity.providerId,
      providerLabel: identity.providerLabel,
    });
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

// Self-service account linking (26/10/2026, see accountLinks.js) -- "link another login method
// to MY account", available to ANY logged-in local user (not just admin), never admin-on-behalf-
// of-someone-else: the whole point is the proof of sameness comes from the person demonstrating
// control of BOTH sides in their own browser, right now. The anchor must be a local session --
// linking only ever points an OIDC externalId AT a local account, never OIDC-to-OIDC (see the
// module comment in accountLinks.js), so starting this from an OIDC-logged-in session would have
// no local id to link to.
function requireLocalSession(req, res, next) {
  if (!req.user || findIdentitySource(req.user.id) !== 'local') {
    return res.status(403).json({ error: 'Only a local account can link another login method to itself' });
  }
  next();
}

router.get('/me/links', requireLocalSession, (req, res) => {
  res.json(accountLinks.findByLocalUserId(req.user.id));
});

router.get('/me/links/:providerId/start', requireLocalSession, async (req, res) => {
  if (!auth.OIDC_ENABLED) return res.status(404).json({ error: 'REDROID_FORGE_AUTH has OIDC disabled' });
  try {
    res.redirect(await oidc.getAuthorizationUrl(req.params.providerId, { linkLocalUserId: req.user.id }));
  } catch (e) {
    sendError(res, e);
  }
});

router.delete('/me/links/:externalId', requireLocalSession, (req, res) => {
  const existing = accountLinks.findByExternalId(req.params.externalId);
  if (!existing || existing.localUserId !== req.user.id) {
    return res.status(404).json({ error: 'No such linked identity on your account' });
  }
  accountLinks.unlink(req.params.externalId);
  res.status(204).end();
});

// Unified identity management (redesigned 26/10/2026) -- one admin-facing table covering BOTH
// local accounts (userStore.js) and OIDC identities (roleAssignments.js), since from here on
// they share the exact same role/quota concepts (permissions.js, quotas.js never cared which
// backend produced a user id) and "both" mode means a single install can have rows from either
// source at once. Each row is tagged `source: 'local' | 'oidc'` so the frontend can decide which
// actions apply (password reset/email only make sense for `local`; `providerLabel` only exists
// for `oidc`). There is still no "create" for an `oidc` row -- same reasoning as before, an
// identity only comes into existence by actually logging in once (upsertSeen, see
// /oidc/callback above); `POST /identities` below only ever creates a `local` one.
function toLocalRow(u) {
  return {
    id: u.id, source: 'local', username: u.username, email: u.email ?? null, role: u.role,
    providerId: null, providerLabel: null, createdAt: u.createdAt, lastSeenAt: null,
  };
}
function toOidcRow(a) {
  return {
    id: a.externalId, source: 'oidc', username: a.username, email: null, role: a.role,
    providerId: a.providerId, providerLabel: a.providerLabel, createdAt: a.createdAt, lastSeenAt: a.lastSeenAt,
  };
}
function listIdentityRows() {
  const rows = [];
  if (auth.LOCAL_ENABLED) for (const u of userStore.listUsers()) rows.push(toLocalRow(u));
  if (auth.OIDC_ENABLED) for (const a of roleAssignments.listAssignments()) rows.push(toOidcRow(a));
  return rows;
}
// Which store actually has this id -- `null` if neither (lets every route below 404 the same
// way instead of guessing from the id's shape, e.g. assuming a ":" means "oidc").
function findIdentitySource(id) {
  if (auth.LOCAL_ENABLED && userStore.findById(id)) return 'local';
  if (auth.OIDC_ENABLED && roleAssignments.findByExternalId(id)) return 'oidc';
  return null;
}

function requireIdentityAdmin(req, res, next) {
  if (auth.AUTH_MODE === 'none') return res.status(404).json({ error: 'REDROID_FORGE_AUTH is "none" -- no accounts exist' });
  if (!permissions.canManageSettings(req.user)) return res.status(403).json({ error: 'Admin only' });
  next();
}

router.get('/identities', requireIdentityAdmin, (req, res) => {
  res.json(listIdentityRows());
});

// `local` only -- see the module comment above on why `oidc` rows can't be created here.
router.post('/identities', requireIdentityAdmin, (req, res) => {
  if (!auth.LOCAL_ENABLED) return res.status(404).json({ error: 'REDROID_FORGE_AUTH has local accounts disabled' });
  try {
    const { username, password, role, email } = req.body || {};
    res.status(201).json(toLocalRow(userStore.createUser({ username, password, role, email })));
  } catch (e) {
    sendError(res, e, 400);
  }
});

router.put('/identities/:id/role', requireIdentityAdmin, (req, res) => {
  const source = findIdentitySource(req.params.id);
  if (!source) return res.status(404).json({ error: `No identity with id "${req.params.id}"` });
  try {
    const { role } = req.body || {};
    if (source === 'local') return res.json(toLocalRow(userStore.setRole(req.params.id, role)));
    return res.json(toOidcRow(roleAssignments.setRole(req.params.id, role === undefined ? null : role)));
  } catch (e) {
    sendError(res, e, 400);
  }
});

// `local` only -- an OIDC identity's password lives at the IdP, not here.
router.put('/identities/:id/password', requireIdentityAdmin, (req, res) => {
  if (findIdentitySource(req.params.id) !== 'local') {
    return res.status(404).json({ error: 'Password reset only applies to a local account' });
  }
  try {
    const { password } = req.body || {};
    res.json(toLocalRow(userStore.resetPassword(req.params.id, password)));
  } catch (e) {
    sendError(res, e, 400);
  }
});

// `local` only -- same reasoning as password above (an OIDC row has no field to edit here).
router.put('/identities/:id/email', requireIdentityAdmin, (req, res) => {
  if (findIdentitySource(req.params.id) !== 'local') {
    return res.status(404).json({ error: 'Email only applies to a local account' });
  }
  try {
    const { email } = req.body || {};
    res.json(toLocalRow(userStore.setEmail(req.params.id, email)));
  } catch (e) {
    sendError(res, e, 400);
  }
});

router.delete('/identities/:id', requireIdentityAdmin, (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete your own identity while logged in as it' });
  }
  const source = findIdentitySource(req.params.id);
  if (!source) return res.status(404).json({ error: `No identity with id "${req.params.id}"` });
  if (source === 'local') {
    // A deleted local account can't stay anyone's link anchor -- clear its links too, rather
    // than leaving externalId rows that point at a local user id that no longer exists.
    for (const l of accountLinks.findByLocalUserId(req.params.id)) accountLinks.unlink(l.externalId);
    userStore.deleteUser(req.params.id);
  } else {
    roleAssignments.deleteAssignment(req.params.id);
  }
  res.status(204).end();
});

// Admin view of a local account's linked login methods -- same data as GET /me/links, just for
// any account (support/security: "what else can log in as pepito"), admin-only, read + revoke
// only -- there is still no admin-initiated "create a link", same reasoning as /me/links/start.
router.get('/identities/:id/links', requireIdentityAdmin, (req, res) => {
  if (findIdentitySource(req.params.id) !== 'local') {
    return res.status(404).json({ error: 'Linked login methods only apply to a local account' });
  }
  res.json(accountLinks.findByLocalUserId(req.params.id));
});

router.delete('/identities/:id/links/:externalId', requireIdentityAdmin, (req, res) => {
  const existing = accountLinks.findByExternalId(req.params.externalId);
  if (!existing || existing.localUserId !== req.params.id) {
    return res.status(404).json({ error: 'No such linked identity on that account' });
  }
  accountLinks.unlink(req.params.externalId);
  res.status(204).end();
});

// Auth-mode switching (Identities panel, 30/10/2026) -- settings.json's `authMode` is the
// persisted value auth.js reads at require time (see its own comment on precedence over
// REDROID_FORGE_AUTH); writing it here never flips the LIVE auth.AUTH_MODE in this process, by
// design -- a restart is still required to actually apply it, same as every other "needs
// restart" setting in this app (appBindHosts), and for the same extra reason auth.js's own
// module comment gives for the setup wizard: this container holds the Docker socket, and
// automating its own restart for a security-mode change is not a risk worth taking from in here.
// Every route below checks canManageSettings(req.user) directly rather than reusing
// requireIdentityAdmin, because that helper 404s while AUTH_MODE is "none" -- exactly the state
// none->local needs to be reachable FROM, and the state every one of these oidc-providers routes
// should also work in (bootstrapping providers before ever leaving "none").
//
// "oidc" alone is deliberately not a reachable destination here (see auth.js's own comment): a
// misconfigured or unreachable sole IdP has no self-service way back in, unlike "both", which
// always keeps a local admin account as a fallback. Going there is still possible by hand-editing
// REDROID_FORGE_AUTH, for whoever wants it anyway, just never through this UI.
const ALLOWED_MODE_TRANSITIONS = {
  none: ['local'],
  local: ['both', 'none'],
  both: ['local'],
};

router.put('/mode', (req, res) => {
  if (!permissions.canManageSettings(req.user)) return res.status(403).json({ error: 'Admin only' });
  const current = auth.AUTH_MODE;
  const { mode, confirm } = req.body || {};
  const allowed = ALLOWED_MODE_TRANSITIONS[current] || [];
  if (!allowed.includes(mode)) {
    return res.status(400).json({
      error: `Cannot switch from "${current}" to ${JSON.stringify(mode)} here. Allowed from "${current}": ${allowed.map((m) => `"${m}"`).join(', ') || '(none)'}.`,
    });
  }
  // none -> local: a password login mode with nobody who could ever use it would be a dead-end
  // login screen the instant this restarts (see auth.js's self-lockout guard) -- /setup/admin
  // (above) is how the admin row gets created first; this just refuses to switch before that.
  if (current === 'none' && userStore.listUsers().length === 0) {
    return res.status(400).json({ error: 'Create a local admin account first (POST /api/auth/setup/admin) before switching to "local".' });
  }
  // local -> both: not unsafe (the existing local admin stays intact either way), just pointless
  // without at least one provider configured yet.
  if (mode === 'both' && oidc.listProviders().length === 0) {
    return res.status(400).json({ error: 'Add at least one OIDC provider before switching to "both".' });
  }
  // both -> local: whoever's only identity is an OIDC one would be locked out the moment OIDC
  // stops being checked -- refuse unless some local admin account already exists to get back in.
  if (current === 'both' && mode === 'local' && !userStore.listUsers().some((u) => u.role === 'admin')) {
    return res.status(400).json({ error: 'No local admin account exists yet -- create one before disabling OIDC, or nobody will be able to log in.' });
  }
  // local -> none: the widest exposure change of the four (anyone who can reach this app gets
  // full admin access, no login at all) -- the only transition that needs an explicit, separate
  // confirmation rather than just being blocked by a missing prerequisite.
  if (current === 'local' && mode === 'none' && confirm !== true) {
    return res.status(400).json({
      error: 'Switching to "none" removes all login protection -- anyone who can reach this app gets full admin access. Resend with confirm: true to proceed.',
    });
  }
  settings.update({ authMode: mode });
  res.json({ authMode: mode, restartRequired: true });
});

function toProviderRow(p) {
  return { id: p.id, label: p.label, issuerUrl: p.issuerUrl, clientId: p.clientId, hasClientSecret: !!p.clientSecret };
}

// rawProviderList(), not listProviders() -- the admin view of what is configured should show
// every saved entry, including one that is not usable YET (e.g. before
// REDROID_FORGE_OIDC_REDIRECT_BASE_URL is set, exactly like a hand-edited
// REDROID_FORGE_OIDC_PROVIDERS entry can already sit there "saved but not live"); listProviders()
// silently drops those, which would make a provider the admin just added here look like it had
// vanished.
router.get('/oidc-providers', (req, res) => {
  if (!permissions.canManageSettings(req.user)) return res.status(403).json({ error: 'Admin only' });
  res.json(oidc.rawProviderList().map(toProviderRow));
});

router.post('/oidc-providers', (req, res) => {
  if (!permissions.canManageSettings(req.user)) return res.status(403).json({ error: 'Admin only' });
  try {
    res.status(201).json(toProviderRow(oidc.addProvider(req.body || {})));
  } catch (e) {
    sendError(res, e, 400);
  }
});

// Fields left out of the body keep their previous value, including clientSecret -- see oidc.js's
// updateProvider comment on why (this route never hands a secret back out via GET, so there is
// nothing for the admin to have re-typed from). Pass clientSecret: "" explicitly to clear it.
router.put('/oidc-providers/:id', (req, res) => {
  if (!permissions.canManageSettings(req.user)) return res.status(403).json({ error: 'Admin only' });
  try {
    res.json(toProviderRow(oidc.updateProvider(req.params.id, req.body || {})));
  } catch (e) {
    sendError(res, e, 400);
  }
});

router.delete('/oidc-providers/:id', (req, res) => {
  if (!permissions.canManageSettings(req.user)) return res.status(403).json({ error: 'Admin only' });
  try {
    oidc.removeProvider(req.params.id);
    res.status(204).end();
  } catch (e) {
    sendError(res, e, 400);
  }
});

module.exports = router;

'use strict';

// Express-facing orchestration for the pluggable auth backend (docs/ROADMAP.md Phase 7):
// which mode is active, who the current request's user is, and the two gating middlewares
// every protected route uses. The actual login mechanics live in userStore.js (local) and
// oidc.js (oidc); this module only turns "a valid session cookie" into `req.user`.

const session = require('./session');
const userStore = require('./userStore');
const oidc = require('./oidc');
const settings = require('./settings');

// "both" (26/10/2026): local accounts and OIDC providers accepted at the same login screen at
// once -- e.g. an admin who wants a password-based account for themselves (no IdP dependency to
// go down) while everyone else logs in through a real identity provider. Session cookies from
// either path are identical (see setSessionCookie/attachUser below) -- "both" changes nothing
// about how a session is verified, only which of the two login routes answer instead of 404,
// and which rows the merged identities table (routes/auth.js's GET /identities) can contain.
const VALID_MODES = ['none', 'local', 'oidc', 'both'];

// Live-manageable mode (Identities panel, 30/10/2026): settings.json's `authMode` wins once an
// admin has ever set it through PUT /api/auth/mode, same precedence as appBindHosts vs
// REDROID_FORGE_BIND_HOST (settings.js's own comment). REDROID_FORGE_AUTH stays the bootstrap
// default for a fresh install, and the only way to ever reach "oidc" alone -- see routes/auth.js's
// PUT /mode, which deliberately never writes that one value, so it is only reachable by hand-
// editing this env var (see the PR/commit that added the mode-switch UI for why).
const CONFIGURED_AUTH_MODE = settings.get().authMode;
const RAW_AUTH_MODE = (CONFIGURED_AUTH_MODE !== null && CONFIGURED_AUTH_MODE !== undefined)
  ? CONFIGURED_AUTH_MODE
  : (process.env.REDROID_FORGE_AUTH || 'none');
if (!VALID_MODES.includes(RAW_AUTH_MODE)) {
  throw new Error(`REDROID_FORGE_AUTH must be one of: ${VALID_MODES.join(', ')} (got "${JSON.stringify(RAW_AUTH_MODE)}")`);
}

// Self-lockout guard (26/10/2026) -- "local"/"both" with REDROID_FORGE_AUTH set but nobody who
// could ever log in (no local user yet, and REDROID_FORGE_LOCAL_ADMIN_USER/_PASSWORD not set
// either, so userStore.ensureBootstrapAdmin will also no-op) used to mean a permanently locked
// login screen: the Identities setup wizard (routes/auth.js's /setup/* routes, app.js's
// renderSetupWizard) only shows itself while AUTH_MODE is "none", so there would be no way back
// in at all without editing data/users.json by hand. Downgrading to the mode that is actually
// reachable, computed once here (same "restart to apply a config change" rule as every other
// env var in this app -- see oidc.js's own comment on why that is fine), turns that dead end
// back into exactly the normal "none -> wizard -> set the real mode -> restart" flow: running
// unprotected for one more boot is no worse than the "none" default this app already shipped
// with for its first several months, and it self-heals the instant someone restarts again.
// `usersFile` is only ever passed by test/auth.lockout.test.js, to check this against an
// isolated temp file instead of the real backend/data/users.json -- every real call site
// (including the require-time check right below) omits it and gets userStore's own default.
function localPathOpen(usersFile) {
  if (userStore.listUsers(usersFile).length > 0) return true;
  return !!(process.env.REDROID_FORGE_LOCAL_ADMIN_USER && process.env.REDROID_FORGE_LOCAL_ADMIN_PASSWORD);
}
// OIDC never locks itself out the same way -- a "log in with X" button is always clickable
// regardless of whether anyone has been approved yet (see oidc.js's module comment and
// roleAssignments.js's BOOTSTRAP_ADMIN_ID: the documented recovery is "log in once, find your
// own id in the JSON file, set that env var, log in again"), so "both" with zero local users is
// NOT a lockout as long as at least one provider is configured: the OIDC half of the login
// screen still works, and once someone is an OIDC admin they can create a local account from the
// (non-wizard, admin-only) Identities panel -- LOCAL_ENABLED stays true for exactly that, "both"
// is only downgraded when NEITHER half has any way in at all.
function oidcPathOpen() {
  return oidc.listProviders().length > 0;
}

let AUTH_MODE = RAW_AUTH_MODE;
if (RAW_AUTH_MODE === 'local' && !localPathOpen()) {
  console.warn(
    'redroid-forge: REDROID_FORGE_AUTH=local but no local account exists yet and '
    + 'REDROID_FORGE_LOCAL_ADMIN_USER/_PASSWORD are not set -- running as "none" (no login) for '
    + 'now so the Identities setup wizard is reachable. Create an admin there, then restart.',
  );
  AUTH_MODE = 'none';
} else if (RAW_AUTH_MODE === 'both' && !localPathOpen() && !oidcPathOpen()) {
  console.warn(
    'redroid-forge: REDROID_FORGE_AUTH=both but neither a local account nor an OIDC provider is '
    + 'usable yet -- running as "none" (no login) for now so the Identities setup wizard is '
    + 'reachable. Create an admin there, then restart.',
  );
  AUTH_MODE = 'none';
}

const LOCAL_ENABLED = AUTH_MODE === 'local' || AUTH_MODE === 'both';
const OIDC_ENABLED = AUTH_MODE === 'oidc' || AUTH_MODE === 'both';

// The "zero auth, any user sees/does everything" default -- every request acts as this single
// always-admin user, identical to this app's behavior before auth existed at all. No cookie
// parsing, no login routes even need to be reachable in this mode.
const NONE_MODE_USER = { id: null, role: 'admin', username: null };

// No cookie-parser dependency -- reading req.headers.cookie by hand is a few lines, and this
// project already prefers a built-in over a new package for something this small (see
// userStore.js's scrypt-over-bcrypt reasoning). Writing cookies uses Express's own res.cookie(),
// which needs no extra middleware either.
function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

// Whoever can already reach this app from THIS SAME HOST has more power than the API grants
// anyway (read data/*.json directly, manage Docker, ...) -- same baseline trust this app always
// had before Phase 7's auth even existed, just narrowed to loopback instead of applying to every
// request. Added 28/10/2026 so a local tool (e.g. this host's own scrcpy-redroid.sh, which SSHes
// in and reads the API over localhost) can work in "local"/"oidc"/"both" mode without needing
// credentials of its own. `req.ip` is the raw socket address, never a spoofable header (this app
// never sets `trust proxy`), so this cannot be faked by anything that is not actually loopback.
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// Sets req.user from the session cookie (local/oidc), the fixed bypass user (none), or the same
// bypass user for a loopback request regardless of mode. Runs on every request, including
// unauthenticated ones -- it never itself rejects a request, that is requireAuth/
// requireCapability's job, so that e.g. GET /api/auth/me can answer "not logged in" instead of
// 401ing before the frontend even gets to render a login screen.
function attachUser(req, res, next) {
  if (AUTH_MODE === 'none' || LOOPBACK_ADDRESSES.has(req.ip)) { req.user = NONE_MODE_USER; return next(); }
  const payload = session.verify(readCookie(req, session.COOKIE_NAME));
  if (payload) req.user = { id: payload.uid, role: payload.role, username: payload.username };
  next();
}

function setSessionCookie(res, user) {
  const cookie = session.sign({ uid: user.id, role: user.role, username: user.username });
  res.cookie(session.COOKIE_NAME, cookie, {
    httpOnly: true, sameSite: 'lax', maxAge: session.SESSION_TTL_MS,
    // secure: the app binds to 127.0.0.1 by default (docs/ROADMAP.md Phase 6) and is reached
    // over plain HTTP in the common case (direct, or through an SSH tunnel) -- marking the
    // cookie `secure` unconditionally would silently break login for exactly that default
    // setup. Whoever terminates real TLS in front of this (reverse proxy, federation mode) is
    // also the one who would need to set this; not asked for yet, left as a known gap.
  });
}

function clearSessionCookie(res) {
  res.clearCookie(session.COOKIE_NAME);
}

// Blocks a request with no logged-in user. A no-op in "none" mode -- req.user is always set.
function requireAuth(req, res, next) {
  if (AUTH_MODE === 'none') return next();
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  next();
}

module.exports = {
  AUTH_MODE, LOCAL_ENABLED, OIDC_ENABLED, VALID_MODES, attachUser, requireAuth, setSessionCookie, clearSessionCookie, readCookie,
  localPathOpen, oidcPathOpen,
};

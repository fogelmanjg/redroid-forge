'use strict';

// Express-facing orchestration for the pluggable auth backend (docs/ROADMAP.md Phase 7):
// which mode is active, who the current request's user is, and the two gating middlewares
// every protected route uses. The actual login mechanics live in userStore.js (local) and
// oidc.js (oidc); this module only turns "a valid session cookie" into `req.user`.

const session = require('./session');

const VALID_MODES = ['none', 'local', 'oidc'];
const AUTH_MODE = process.env.REDROID_FORGE_AUTH || 'none';
if (!VALID_MODES.includes(AUTH_MODE)) {
  throw new Error(`REDROID_FORGE_AUTH must be one of: ${VALID_MODES.join(', ')} (got "${JSON.stringify(AUTH_MODE)}")`);
}

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

// Sets req.user from the session cookie (local/oidc) or the fixed bypass user (none). Runs on
// every request, including unauthenticated ones -- it never itself rejects a request, that is
// requireAuth/requireCapability's job, so that e.g. GET /api/auth/me can answer "not logged in"
// instead of 401ing before the frontend even gets to render a login screen.
function attachUser(req, res, next) {
  if (AUTH_MODE === 'none') { req.user = NONE_MODE_USER; return next(); }
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
  AUTH_MODE, attachUser, requireAuth, setSessionCookie, clearSessionCookie, readCookie,
};

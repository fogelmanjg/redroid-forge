'use strict';

// Stateless signed session cookies (HMAC-SHA256 via Node's own crypto) -- no session store, no
// new dependency, same reasoning as userStore.js preferring scrypt over adding bcrypt. Used by
// both the "local" and "oidc" auth backends (auth.js) for the SAME kind of cookie once a login
// of either kind succeeds; only how the cookie gets issued differs between them.

const path = require('path');
const crypto = require('crypto');
const { readJsonObject, writeJsonObject } = require('./jsonFileStore');

const SECRET_FILE = path.join(__dirname, '..', '..', 'data', 'session-secret.json');
const COOKIE_NAME = 'redroid_forge_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Generated once per file and persisted (not re-derived from an env var) so existing sessions
// do not all get invalidated on every restart -- same "auto-generate, persist to the
// gitignored data dir" pattern as everything else under backend/data/. Keyed by file path, not
// a single value: tests pass a different tmp file per case, and a single shared cache would
// silently ignore that and keep answering with whichever file was read first.
const secretCache = new Map();
function getSecret(file = SECRET_FILE) {
  if (secretCache.has(file)) return secretCache.get(file);
  const stored = readJsonObject(file);
  const secret = stored.secret || crypto.randomBytes(32).toString('hex');
  if (!stored.secret) writeJsonObject(file, { secret });
  secretCache.set(file, secret);
  return secret;
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromBase64url(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function sign(payload, file = SECRET_FILE) {
  const body = base64url(Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + SESSION_TTL_MS })));
  const mac = crypto.createHmac('sha256', getSecret(file)).update(body).digest();
  return `${body}.${base64url(mac)}`;
}

// -> the payload object (without `exp`, already validated as not expired), or null for
// anything invalid, expired, or tampered with. Never throws -- a malformed/missing cookie is
// an expected case (not logged in), not an error.
function verify(cookieValue, file = SECRET_FILE) {
  if (typeof cookieValue !== 'string') return null;
  const [body, mac] = cookieValue.split('.');
  if (!body || !mac) return null;
  const expectedMac = base64url(crypto.createHmac('sha256', getSecret(file)).update(body).digest());
  const a = Buffer.from(mac);
  const b = Buffer.from(expectedMac);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(fromBase64url(body).toString('utf-8'));
  } catch {
    return null;
  }
  if (!payload.exp || Date.now() > payload.exp) return null;
  const { exp, ...rest } = payload;
  return rest;
}

module.exports = { sign, verify, COOKIE_NAME, SESSION_TTL_MS };

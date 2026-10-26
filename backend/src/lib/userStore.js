'use strict';

const path = require('path');
const crypto = require('crypto');
const { readJsonArray, writeJsonArray } = require('./jsonFileStore');
const { isValidRole } = require('./permissions');

const STORE_FILE = path.join(__dirname, '..', '..', 'data', 'users.json');

// scrypt (Node's own crypto, no new dependency) rather than bcrypt -- this project already
// prefers a built-in over adding a package when one exists (see DEFAULTS in settings.js's own
// reasoning elsewhere). N=16384/r=8/p=1 is Node's documented recommended minimum.
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password, salt = crypto.randomBytes(16)) {
  const hash = crypto.scryptSync(password, salt, SCRYPT_PARAMS.keylen, SCRYPT_PARAMS);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPasswordHash(password, stored) {
  const [saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, salt, SCRYPT_PARAMS.keylen, SCRYPT_PARAMS);
  // timingSafeEqual throws on length mismatch instead of returning false -- expected's length
  // is fixed by SCRYPT_PARAMS.keylen, so this only differs for a corrupt/foreign hash.
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function httpError(message, httpStatus) {
  return Object.assign(new Error(message), { httpStatus });
}

const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function listUsers(file = STORE_FILE) {
  // Never return passwordHash past this module -- every route-facing read goes through this.
  return readJsonArray(file).map(({ passwordHash, ...safe }) => safe);
}

function findByUsername(username, file = STORE_FILE) {
  return readJsonArray(file).find((u) => u.username === username);
}

function findById(id, file = STORE_FILE) {
  return readJsonArray(file).find((u) => u.id === id);
}

// `email` is purely informational (never used for login or sent anything to) -- so an admin
// managing several local accounts can tell them apart beyond just a username. Optional, no
// format check beyond "a string" -- this is not the identity-providing field OIDC's `claims.sub`
// is, there is nothing here that needs to be unique or verified.
function normalizeEmail(email) {
  if (email === undefined || email === null || email === '') return null;
  if (typeof email !== 'string') throw httpError('"email" must be a string', 400);
  return email;
}

// -> the created user (without passwordHash). Throws Error with httpStatus 400/409.
function createUser({ username, password, role, email }, file = STORE_FILE) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    throw httpError('"username" must be lowercase letters, digits, "-" and "_" (1-32 characters)', 400);
  }
  if (typeof password !== 'string' || password.length < 8) {
    throw httpError('"password" must be at least 8 characters', 400);
  }
  if (!isValidRole(role)) {
    throw httpError('"role" must be one of: admin, operator, viewer', 400);
  }
  const all = readJsonArray(file);
  if (all.some((u) => u.username === username)) {
    throw httpError(`A user named "${username}" already exists`, 409);
  }
  const user = {
    id: crypto.randomUUID(),
    username,
    role,
    email: normalizeEmail(email),
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
  };
  all.push(user);
  writeJsonArray(file, all);
  const { passwordHash, ...safe } = user;
  return safe;
}

function deleteUser(id, file = STORE_FILE) {
  const all = readJsonArray(file);
  writeJsonArray(file, all.filter((u) => u.id !== id));
}

// Three single-field updates (role/password/email) rather than one generic "patch" -- matches
// the existing per-field route convention (see roleAssignments.setRole) and keeps each one's own
// validation obvious at the call site. All three throw httpStatus 404 if `id` does not exist, so
// routes/auth.js never has to check existence itself first.
function requireUser(all, id) {
  const user = all.find((u) => u.id === id);
  if (!user) throw httpError(`No local user with id "${id}"`, 404);
  return user;
}

function setRole(id, role, file = STORE_FILE) {
  if (!isValidRole(role)) throw httpError('"role" must be one of: admin, operator, viewer', 400);
  const all = readJsonArray(file);
  const user = requireUser(all, id);
  user.role = role;
  writeJsonArray(file, all);
  const { passwordHash, ...safe } = user;
  return safe;
}

function resetPassword(id, password, file = STORE_FILE) {
  if (typeof password !== 'string' || password.length < 8) {
    throw httpError('"password" must be at least 8 characters', 400);
  }
  const all = readJsonArray(file);
  const user = requireUser(all, id);
  user.passwordHash = hashPassword(password);
  writeJsonArray(file, all);
  const { passwordHash, ...safe } = user;
  return safe;
}

function setEmail(id, email, file = STORE_FILE) {
  const all = readJsonArray(file);
  const user = requireUser(all, id);
  user.email = normalizeEmail(email);
  writeJsonArray(file, all);
  const { passwordHash, ...safe } = user;
  return safe;
}

// -> {id, username, role} on success, null on a wrong username/password. Never throws for
// bad credentials -- that is an expected outcome of a login attempt, not an error.
function verifyCredentials(username, password, file = STORE_FILE) {
  const user = findByUsername(username, file);
  if (!user || !verifyPasswordHash(password, user.passwordHash)) return null;
  const { passwordHash, ...safe } = user;
  return safe;
}

// Seeds the very first admin account from REDROID_FORGE_LOCAL_ADMIN_USER/_PASSWORD when the
// store is empty -- otherwise "local" mode has no way to log in at all on a fresh install (no
// setup UI exists before the first login). No-op once any user exists, so it never resets an
// admin's changed password on a later restart. Logs a clear message either way (startup-time,
// not silent) since forgetting to set these two vars locks the UI behind a login nobody can
// pass.
function ensureBootstrapAdmin(file = STORE_FILE) {
  if (readJsonArray(file).length > 0) return;
  const username = process.env.REDROID_FORGE_LOCAL_ADMIN_USER;
  const password = process.env.REDROID_FORGE_LOCAL_ADMIN_PASSWORD;
  if (!username || !password) {
    console.warn(
      'redroid-forge: REDROID_FORGE_AUTH=local but no users exist yet and '
      + 'REDROID_FORGE_LOCAL_ADMIN_USER/_PASSWORD are not set -- nobody will be able to log in.',
    );
    return;
  }
  createUser({ username, password, role: 'admin' }, file);
  console.log(`redroid-forge: bootstrapped the first local admin account ("${username}").`);
}

module.exports = {
  listUsers, findByUsername, findById, createUser, deleteUser, verifyCredentials, ensureBootstrapAdmin,
  setRole, resetPassword, setEmail,
  hashPassword, verifyPasswordHash, USERNAME_RE,
};

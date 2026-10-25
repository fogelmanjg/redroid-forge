'use strict';

// Fixed role x capability x ownership model (docs/ROADMAP.md Phase 7). Deliberately NOT a
// custom role editor -- three built-in roles cover the motivating example from the roadmap
// discussion ("a user who can only see/start-stop their own instances, not create or delete
// any" + "another who can create and see everyone's") without the much larger surface of
// letting an admin define arbitrary roles. Pure, no I/O -- used the same way regardless of
// which auth backend (none/local/oidc) produced `user`.

const ROLES = ['admin', 'operator', 'viewer'];

// Per-instance capabilities (every one of these also needs an instance to check ownership
// against, except where noted). `manage-settings` is NOT in this list -- it is global, not
// per-instance, checked separately via canManageSettings().
//
// `transfer-ownership` (25/10/2026): editing an instance's `ownerId` list (who can see/use it --
// see `ownerIds()` below) and attributing/reassigning its `createdId` (who the quota,
// src/lib/quotas.js, counts against) -- two different questions sharing one capability because
// both are only ever exercised by someone who already has access to the instance (see
// routes/instances.js's PUT /:id/owners and /:id/created-by), same as `configure`.
const CAPABILITIES = ['view', 'start-stop', 'create', 'delete', 'configure', 'backup-restore', 'transfer-ownership'];

// What each role can do, before ownership is even considered. `create` has no owner yet (the
// instance being created *becomes* owned by whoever creates it) -- it is really "can this role
// create at all", not scoped.
const ROLE_CAPABILITIES = {
  admin: new Set(CAPABILITIES),
  operator: new Set(CAPABILITIES),
  viewer: new Set(['view', 'start-stop']),
};

// `instance.ownerId` is a list (25/10/2026 -- an instance can be shared by several people at
// once, e.g. a household's shared TV instance) but is tolerated in its pre-migration shape too
// (a bare string, or missing) so this module never has to assume `store.js`'s own self-healing
// migration already ran on whatever object a caller hands it (tests build plain instance
// literals directly, never through the store).
function ownerIds(instance) {
  if (!instance) return [];
  const o = instance.ownerId;
  if (Array.isArray(o)) return o;
  return o ? [o] : [];
}

// Which roles bypass the ownership check entirely (see every instance, act on every instance
// their role's capabilities allow) -- only admin. operator/viewer are always scoped to "own".
const OWNERSHIP_BYPASS_ROLES = new Set(['admin']);

function isValidRole(role) {
  return ROLES.includes(role);
}

// `user`: {id, role} (id is a stable identifier -- local username, or an OIDC `sub`; null/
// undefined when auth mode is "none", see auth.js's always-admin bypass user for that case).
// `instance`: the instance object (needs `.ownerId`), or undefined for a capability that is not
// instance-scoped yet (e.g. "create", checked before the instance exists).
// -> boolean. Never throws -- an unknown role or missing user simply has no capabilities.
function can(user, capability, instance) {
  if (!user || !isValidRole(user.role)) return false;
  if (!ROLE_CAPABILITIES[user.role].has(capability)) return false;
  if (capability === 'create') return true;
  if (OWNERSHIP_BYPASS_ROLES.has(user.role)) return true;
  if (!instance) return true; // nothing to scope against yet -- caller checks again once it has one
  return ownerIds(instance).includes(user.id);
}

// manage-settings (global backup folder, local user management) -- admin only, not part of the
// per-instance model above.
function canManageSettings(user) {
  return !!user && user.role === 'admin';
}

// Which of `instances` this user is even allowed to see at all -- the roadmap's own framing
// ("a user who can only see their own instances") is about visibility, not just actions, so a
// non-admin never sees another user's instance in GET /api/instances to begin with.
function visibleInstances(user, instances) {
  if (!user || !isValidRole(user.role)) return [];
  if (OWNERSHIP_BYPASS_ROLES.has(user.role)) return instances;
  return instances.filter((i) => ownerIds(i).includes(user.id));
}

function httpError(message, httpStatus) {
  return Object.assign(new Error(message), { httpStatus });
}

// Route-facing wrapper over can() -- throws instead of returning a boolean, with the
// instances.js convention (Error + httpStatus, caught by its own sendError). 404, not 403, when
// the instance is invisible to this user at all (not owned, not admin) -- same message as a
// genuinely nonexistent instance, so a non-admin cannot tell "not yours" apart from "does not
// exist" by probing ids. 403 only once the instance IS visible but the action itself is not
// allowed (e.g. a viewer who owns the instance but lacks "configure").
function assertCan(user, capability, instance) {
  if (instance && visibleInstances(user, [instance]).length === 0) {
    throw httpError('Instance not found', 404);
  }
  if (!can(user, capability, instance)) {
    throw httpError(`Not allowed: missing "${capability}"`, 403);
  }
}

module.exports = {
  ROLES, CAPABILITIES, ROLE_CAPABILITIES, isValidRole, can, canManageSettings, visibleInstances, assertCan, ownerIds,
};

const path = require('path');
const { readJsonObject, writeJsonObject } = require('./jsonFileStore');

const DEFAULT_SETTINGS_FILE = path.join(__dirname, '..', '..', 'data', 'settings.json');

// Test-only override (same escape-hatch idiom as every other path/env knob in this app).
// auth.js and oidc.js now read settings.get()/.update() at require time and on every request
// respectively, with no explicit `file` argument -- without this, that would hit THIS HOST's
// real backend/data/settings.json, the exact file this project's own live redroid-forge
// instance (docker-compose bind-mounts ./backend/data into the running container) writes real
// authMode/oidcProviders changes into. Read fresh on every call, not cached at module load, so
// a test can set/unset it per-call with no require-cache dance.
function settingsFile() {
  return process.env.REDROID_FORGE_SETTINGS_FILE || DEFAULT_SETTINGS_FILE;
}

// First (and for now only) global setting: where instance backups land by default.
// REDROID_FORGE_BACKUPS_DIR (see docker-compose.yml) is a real HOST path, bound at the
// same path inside this container too -- backup.js needs that to be true because it
// bind-mounts this same directory into throwaway sibling containers via the Docker
// socket, which resolves paths against the host, not against this process's own
// filesystem view. The fallback (no Docker/tests) is just a plain local folder.
const DEFAULTS = {
  backupDir: process.env.REDROID_FORGE_BACKUPS_DIR || path.join(__dirname, '..', '..', 'data', 'backups'),
  // Per-interface exceptions to networkInterfaceFilter.js's default heuristic (docs/ROADMAP.md
  // Phase 6) -- {[ifaceName]: boolean}. Empty by default: a fresh install gets the heuristic's
  // own judgment with nothing to configure; an admin only needs this once a specific interface
  // on their own host is mis-classified either way.
  networkInterfaceOverrides: {},
  // Which addresses THIS APP's own server listens on, IN ADDITION to 127.0.0.1 (not any
  // instance's) -- same shape as an instance's own bindHosts, except localhost is implicit and
  // can never be left out (see routes/settings.js), since nothing else can reach this app at all
  // once it is not even listening on loopback (real incident, 28/10/2026: this host's own
  // scrcpy-redroid.sh script SSHes in and reaches for localhost, which stopped working the moment
  // this was a single address pinned to the Tailscale interface only). Empty means "nothing beyond
  // localhost, unless REDROID_FORGE_BIND_HOST says otherwise" (see server.js's own comment on why
  // that env var only wins before this has ever been set through the UI, and why either way it
  // needs a restart to actually take effect).
  appBindHosts: [],
  // Shared ceiling across every "operator" at once (docs/ROADMAP.md Phase 7, 25/10/2026) -- the
  // other half of src/lib/quotas.js's quota model, which also supports a per-operator limit
  // (that one keyed by user id, so it lives in its own store, not here). null = unlimited, same
  // as every other optional field in this file.
  operatorPoolMaxVcpus: null,
  operatorPoolMaxMemoryMb: null,
  // Auth mode + OIDC provider management, moved into the UI (Identities panel, 30/10/2026) --
  // null means "never touched through the UI", in which case auth.js/oidc.js fall back to
  // REDROID_FORGE_AUTH/REDROID_FORGE_OIDC_PROVIDERS, same precedence rule as appBindHosts vs
  // REDROID_FORGE_BIND_HOST above. Once set (even to "none" or []), the UI-chosen value wins --
  // both still need a restart to actually apply (see auth.js's own comment on why the restart
  // itself is never automated from inside this app).
  authMode: null,
  oidcProviders: null,
};

function get(file = settingsFile()) {
  const raw = readJsonObject(file);
  // Migration (28/10/2026): appBindHost (a single string) -> appBindHosts (an array, localhost
  // implicit) -- transparent so an install already past first boot does not silently lose
  // whatever address it had chosen the moment this field is read with the old name still on
  // disk (caught on this very host before it shipped: the UI became loopback-only on upgrade).
  if (raw && 'appBindHost' in raw && !('appBindHosts' in raw)) {
    const { appBindHost, ...rest } = raw;
    rest.appBindHosts = appBindHost && appBindHost !== '127.0.0.1' ? [appBindHost] : [];
    return { ...DEFAULTS, ...rest };
  }
  return { ...DEFAULTS, ...raw };
}

function update(partial, file = settingsFile()) {
  const next = { ...get(file), ...partial };
  writeJsonObject(file, next);
  return next;
}

module.exports = { get, update, DEFAULTS };

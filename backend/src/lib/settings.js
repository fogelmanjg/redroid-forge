const path = require('path');
const { readJsonObject, writeJsonObject } = require('./jsonFileStore');

const SETTINGS_FILE = path.join(__dirname, '..', '..', 'data', 'settings.json');

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
  // Which address THIS APP's own server listens on (not any instance's) -- null means "defer to
  // REDROID_FORGE_BIND_HOST, or 127.0.0.1 if that is unset too" (see server.js's own comment on
  // why this, not the env var, wins once it is set, and why either way it needs a restart to
  // actually take effect).
  appBindHost: null,
};

function get(file = SETTINGS_FILE) {
  return { ...DEFAULTS, ...readJsonObject(file) };
}

function update(partial, file = SETTINGS_FILE) {
  const next = { ...get(file), ...partial };
  writeJsonObject(file, next);
  return next;
}

module.exports = { get, update, DEFAULTS };

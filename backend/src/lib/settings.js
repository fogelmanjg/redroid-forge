const path = require('path');
const { readJsonObject, writeJsonObject } = require('./jsonFileStore');

const SETTINGS_FILE = path.join(__dirname, '..', '..', 'data', 'settings.json');

// First (and for now only) global setting: where instance backups land by default --
// right next to redroid-forge's own persistent state (instances.json, etc.), not inside
// any instance's own volume. The actual backup/restore feature is built separately; this
// just gives it (and the user) a place to look.
const DEFAULTS = {
  backupDir: path.join(__dirname, '..', '..', 'data', 'backups'),
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

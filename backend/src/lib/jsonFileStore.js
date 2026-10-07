const fs = require('fs');
const path = require('path');

// Primitives shared by store.js (instances) and moduleAcceptance.js (module
// acceptances) -- the same pattern ("read with a fallback to [] if it does not
// exist or is corrupt" + atomic write via tmp+rename) that used to live
// duplicated byte for byte in both files.

function ensureDirFor(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJsonArray(filePath) {
  ensureDirFor(filePath);
  if (!fs.existsSync(filePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return [];
  }
}

// Atomic write (tmp + rename) so as not to leave the file corrupt if the
// process dies in the middle of a write.
function writeJsonArray(filePath, data) {
  ensureDirFor(filePath);
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

module.exports = { readJsonArray, writeJsonArray };

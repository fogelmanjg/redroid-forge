'use strict';

// Pure helpers about a "package defined by files" (`archivos`: [{ path, sha256, tamano? }]):
// validation of its paths/hashes and the digest of the whole set. Shared by the gapps module
// (modules/gapps/bundle.js, which verifies the files on disk) and by the known-combinations
// database (lib/knownDb.js, which checks that a package's "sha256" is the digest of its
// "archivos"). No I/O.

const crypto = require('crypto');
const path = require('path');

// Only these partitions of /system are written to, and only these sub-folders: a package
// definition (which can come from outside, e.g. a downloaded database) can never make the
// module write anywhere else in the instance.
const ALLOWED_PARTITIONS = ['product', 'system_ext'];
const ALLOWED_SUBDIRS = ['priv-app', 'app', 'etc', 'framework', 'lib64'];

const SHA256_RE = /^[0-9a-f]{64}$/;

// Validates a package definition and returns the list of problems (empty = valid).
// `archivos`: [{ path, sha256, tamano? }]
function validateFiles(files) {
  const problems = [];
  if (!Array.isArray(files) || files.length === 0) return ['the package has no "archivos"'];
  const seen = new Set();
  for (const f of files) {
    const p = f && f.path;
    if (typeof p !== 'string' || p.length === 0) { problems.push('a file without "path"'); continue; }
    if (path.isAbsolute(p) || p.split('/').includes('..') || p.includes('\\') || p.includes('\0')) {
      problems.push(`${p}: unsafe path`);
      continue;
    }
    const [partition, sub] = p.split('/');
    if (!ALLOWED_PARTITIONS.includes(partition) || !ALLOWED_SUBDIRS.includes(sub) || p.split('/').length < 3) {
      problems.push(`${p}: outside of ${ALLOWED_PARTITIONS.join('|')}/${ALLOWED_SUBDIRS.join('|')}`);
    }
    if (!SHA256_RE.test(f.sha256 || '')) problems.push(`${p}: "sha256" is mandatory (64 hex)`);
    if (seen.has(p)) problems.push(`${p}: duplicated`);
    seen.add(p);
  }
  return problems;
}

// Digest of the WHOLE package: sha256 of the sorted lines "<sha256>  <path>\n". It is the
// value that a package of the known-combinations database carries in its mandatory
// "sha256" when it is defined by files.
function bundleDigest(files) {
  const lines = files
    .map((f) => `${f.sha256}  ${f.path}\n`)
    .sort();
  return crypto.createHash('sha256').update(lines.join('')).digest('hex');
}

module.exports = {
  ALLOWED_PARTITIONS, ALLOWED_SUBDIRS, SHA256_RE, validateFiles, bundleDigest,
};

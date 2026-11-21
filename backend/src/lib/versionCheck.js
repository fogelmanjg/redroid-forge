const pkg = require('../../package.json');

// Checking GitHub for a newer release is a manual, explicit action ONLY (the "Chequear" button
// on the main screen) -- never on a timer, never on app startup, same reasoning as
// knownDbUpdate.js's own update step ("Applying is ALWAYS an explicit action"), but stricter:
// that one still has an opt-out `chequeoAutomatico` default-on daily check; this one has no
// automatic mode at all, by design -- nothing calls GitHub unless a person asks, right now.

const REPO = process.env.REDROID_FORGE_UPDATE_REPO || 'fogelmanjg/redroid-forge';
const TIMEOUT_MS = 10000;

class VersionCheckError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function getInstalledVersion() {
  return pkg.version;
}

// GitHub's REST API requires a User-Agent header on every request or it answers 403 regardless
// of rate limit -- "redroid-forge" is enough, it does not need to be unique per host.
async function fetchLatestRelease({ repo = REPO, fetchImpl = fetch } = {}) {
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  let res;
  try {
    res = await fetchImpl(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'User-Agent': 'redroid-forge', Accept: 'application/vnd.github+json' },
    });
  } catch (e) {
    throw new VersionCheckError(`could not reach GitHub: ${e.message}`, 'red');
  }
  if (res.status === 404) {
    throw new VersionCheckError(`${repo} has no published releases (only tags, or none at all)`, 'sin-releases');
  }
  if (!res.ok) {
    throw new VersionCheckError(`GitHub answered HTTP ${res.status}`, 'http');
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw new VersionCheckError('GitHub answered something that is not JSON', 'formato');
  }
  const tag = String(body.tag_name || '');
  if (!tag) throw new VersionCheckError('GitHub release without tag_name', 'formato');
  return { latest: tag.replace(/^v/, ''), url: body.html_url || null, publishedAt: body.published_at || null };
}

// "Is `latest` newer than `installed`", SemVer-style without a semver dependency: the numeric
// core (MAJOR.MINOR.PATCH, a missing part counts as 0) compared left to right; with equal cores,
// a release beats any pre-release of it (1.0.0 > 1.0.0-beta.1, SemVer 11.3), and two
// pre-releases compare identifier by identifier (numeric ones numerically: beta.10 > beta.2).
// 21/11/2026: the old loose compare parsed "0-beta" as 0, so 1.0.0 was NOT newer than
// 1.0.0-beta.1 -- a host on the first beta would never have been told about the final release.
// Anything unparseable still never throws: it falls back to a plain string comparison.
function splitVersion(v) {
  const str = String(v).trim().replace(/^v/, '');
  const dash = str.indexOf('-');
  const core = (dash === -1 ? str : str.slice(0, dash)).split('+')[0];
  const pre = dash === -1 ? null : str.slice(dash + 1).split('+')[0];
  return { core: core.split('.'), pre: pre ? pre.split('.') : null };
}

function comparePre(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1; // fewer identifiers = lower precedence (SemVer 11.4.4)
    if (b[i] === undefined) return 1;
    const an = /^\d+$/.test(a[i]) ? Number(a[i]) : null;
    const bn = /^\d+$/.test(b[i]) ? Number(b[i]) : null;
    if (an !== null && bn !== null) { if (an !== bn) return an > bn ? 1 : -1; continue; }
    if (an !== null) return -1; // numeric identifiers sort before alphanumeric ones
    if (bn !== null) return 1;
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

function isNewer(latest, installed) {
  const a = splitVersion(latest);
  const b = splitVersion(installed);
  for (let i = 0; i < Math.max(a.core.length, b.core.length, 3); i++) {
    const an = a.core[i] === undefined || a.core[i] === '' ? 0 : Number(a.core[i]);
    const bn = b.core[i] === undefined || b.core[i] === '' ? 0 : Number(b.core[i]);
    if (Number.isNaN(an) || Number.isNaN(bn)) return String(latest) !== String(installed) && String(latest) > String(installed);
    if (an !== bn) return an > bn;
  }
  if (!a.pre && !b.pre) return false;
  if (!a.pre) return true;   // release vs. one of its pre-releases
  if (!b.pre) return false;
  return comparePre(a.pre, b.pre) > 0;
}

async function checkForUpdate({ repo = REPO, installed = getInstalledVersion(), fetchImpl = fetch } = {}) {
  const { latest, url, publishedAt } = await fetchLatestRelease({ repo, fetchImpl });
  return { installed, latest, url, publishedAt, newer: isNewer(latest, installed) };
}

module.exports = { getInstalledVersion, fetchLatestRelease, isNewer, checkForUpdate, VersionCheckError, REPO };

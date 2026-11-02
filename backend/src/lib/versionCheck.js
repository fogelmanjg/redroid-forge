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

// Loose compare, good enough for "is there anything newer" -- not a strict semver library
// (this project has none as a dependency): numeric parts compared left to right, a missing
// part counts as 0, anything non-numeric (a suffix like "-beta") falls back to string compare
// of the whole remainder so it never throws, only possibly gives a less precise answer.
function isNewer(latest, installed) {
  const a = String(latest).split('.');
  const b = String(installed).split('.');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const an = Number.parseInt(a[i], 10);
    const bn = Number.parseInt(b[i], 10);
    if (Number.isNaN(an) || Number.isNaN(bn)) return String(latest) !== String(installed) && String(latest) > String(installed);
    if (an !== bn) return an > bn;
  }
  return false;
}

async function checkForUpdate({ repo = REPO, installed = getInstalledVersion(), fetchImpl = fetch } = {}) {
  const { latest, url, publishedAt } = await fetchLatestRelease({ repo, fetchImpl });
  return { installed, latest, url, publishedAt, newer: isNewer(latest, installed) };
}

module.exports = { getInstalledVersion, fetchLatestRelease, isNewer, checkForUpdate, VersionCheckError, REPO };

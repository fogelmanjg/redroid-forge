const net = require('net');
const express = require('express');
const path = require('path');
const auth = require('./lib/auth');

// Every host in the fleet has a global-scope IPv6 address from Tailscale (the ULA
// fd7a:115c:a1e0::/48) -- that makes Node's fetch() race real public IPv6 addresses too (Happy
// Eyeballs) whenever it looks up a dual-stack external host (e.g. aurora-store's module fetching
// its pinned APK from f-droid.org), even though that IPv6 cannot actually reach the public
// internet (Tailscale-only). Node's default per-attempt timeout (250ms) is shorter than the real
// RTT to many external hosts from here, so the real, working IPv4 address gets abandoned as
// "timed out" before it has a chance to answer -- confirmed live, 01/11/2026 (intermittent
// "fetch failed" installing aurora-store on a fresh host, root-caused with `node -e` reproducing
// AggregateError ETIMEDOUT on every IPv4 candidate within ~830ms while IPv6 failed instantly with
// ENETUNREACH). Raising the budget fixes it without needing Happy Eyeballs off entirely.
net.setDefaultAutoSelectFamilyAttemptTimeout(1500);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', '..', 'frontend')));

// Sets req.user on every request (the always-admin bypass user in "none" mode, or whoever the
// session cookie says in "local"/"oidc") -- runs before anything else so /api/auth/me can
// answer "not logged in" instead of being gated out by requireAuth itself (docs/ROADMAP.md
// Phase 7). /api/auth/* stays reachable with no login required (it IS the login surface); every
// other /api/* route requires one, in whichever mode is active (a no-op check in "none" mode).
app.use(auth.attachUser);
app.use('/api/auth', require('./routes/auth'));
app.use('/api', auth.requireAuth);

app.use('/api/instances', require('./routes/instances'));
app.use('/api/doctor', require('./routes/doctor'));
app.use('/api/images', require('./routes/images'));
app.use('/api/modules', require('./routes/modules'));
app.use('/api/db', require('./routes/db'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/quotas', require('./routes/quotas'));
app.use('/api/backups', require('./routes/backups'));
app.use('/api/network', require('./routes/network'));
app.use('/api/version', require('./routes/version'));

if (auth.LOCAL_ENABLED) require('./lib/userStore').ensureBootstrapAdmin();

const PORT = process.env.PORT || 8080;
// This app's own API/UI can create/delete/operate every instance (and, once Phase 7's
// `local`/`oidc` auth is on, manage every account), so whoever can reach it is able to do all of
// that -- the same reasoning as each instance's own ADB port (dockerRuntime.create's
// `bindHosts`), just for a much bigger surface. `network_mode: host` in docker-compose.yml means
// the bind addresses below are the real host's, not a container-internal one. Which addresses to
// listen on, and how a later change to that setting is applied without a manual restart, now
// lives in lib/httpListeners.js (routes/settings.js calls its restart() once appBindHosts
// actually changes).
require('./lib/httpListeners').listen(app, PORT);
// Checks (never applies) whether a newer combinations database exists: on
// open and once a day. Can be turned off with REDROID_FORGE_DB_CHECK=0.
require('./lib/knownDbUpdate').startScheduler();
// Port-knocking daemon (docs/ROADMAP.md Phase 9) -- idle until an instance actually opts an
// interface into knockRequiredHosts; see lib/fwknop.js for why this is safe to always run.
require('./lib/fwknop').start();

// Last safety net: a bug in a single request cannot bring down the whole process
// (and with it the management of ALL the running instances).
process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));
process.on('uncaughtException', (err) => console.error('uncaughtException:', err));

// This container runs with `pid: host` (docker-compose.yml): there is no PID namespace to
// clean up the fwknopd child on container stop the way there would be in a normal container,
// an unreaped child just becomes a REAL orphaned process on the host. `docker stop`/`compose
// down` sends SIGTERM to this process specifically (the one Docker actually exec'd), not to
// PID 1 -- explicitly killing the child here is what makes shutdown actually clean instead of
// leaking an fwknopd that outlives its container (lib/fwknop.js's own start() also guards
// against that leftover on the NEXT start, but better to not rely on that every time).
function shutdown() {
  require('./lib/fwknop').stop();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

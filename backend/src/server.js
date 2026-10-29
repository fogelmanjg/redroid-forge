const express = require('express');
const path = require('path');
const auth = require('./lib/auth');
const settings = require('./lib/settings');

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

if (auth.LOCAL_ENABLED) require('./lib/userStore').ensureBootstrapAdmin();

const PORT = process.env.PORT || 8080;
// 127.0.0.1 is ALWAYS listened on, with no way to opt out (see routes/settings.js) -- nothing on
// this very host (e.g. scrcpy-redroid.sh, which SSHes in and reaches for localhost) could reach
// this app at all otherwise. Real incident, 28/10/2026: appBindHost used to be a SINGLE address,
// and once an admin pointed it at the Tailscale interface to reach the UI remotely, loopback
// access broke -- an http.Server only ever binds the one address it is given, so "pick one"
// quietly meant "give up the other one too", which nobody actually wants. Beyond that, this app's
// own API/UI can create/delete/operate every instance (and, once Phase 7's `local`/`oidc` auth is
// on, manage every account), so whoever can reach it is able to do all of that -- the same
// reasoning as each instance's own ADB port (dockerRuntime.create's `bindHosts`), just for a much
// bigger surface. `network_mode: host` in docker-compose.yml means these bind addresses are the
// real host's, not a container-internal one.
//
// Settings' `appBindHosts` (set from the Settings tab's "App network" section, same
// already-filtered interfaces list as the per-instance picker -- docs/ROADMAP.md Phase 6) is
// ADDED to localhost once an admin has actually chosen at least one through the UI;
// REDROID_FORGE_BIND_HOST stays as the env-var escape hatch for before that UI has ever been
// touched (first boot, headless setups), ignored once appBindHosts is non-empty. Either way this
// is read once, at process start -- an http.Server cannot be rebound to a different address
// without restarting the listener, so a changed value only takes effect after the container is
// restarted; the Settings UI says so rather than pretending it is live (same honesty as the OIDC
// "secure cookie" gap noted in auth.js).
const configuredHosts = settings.get().appBindHosts;
const extraHosts = configuredHosts.length ? configuredHosts : (
  process.env.REDROID_FORGE_BIND_HOST && process.env.REDROID_FORGE_BIND_HOST !== '127.0.0.1'
    ? [process.env.REDROID_FORGE_BIND_HOST] : []
);
// 0.0.0.0 already covers 127.0.0.1 too -- binding both separately is the same port claimed
// twice, which a real listen() (unlike this app's own address picker) does not tolerate at all:
// confirmed live, the second bind fails outright with EADDRINUSE.
const BIND_HOSTS = extraHosts.includes('0.0.0.0') ? ['0.0.0.0'] : [...new Set(['127.0.0.1', ...extraHosts])];
for (const host of BIND_HOSTS) {
  app.listen(PORT, host, () => console.log(`redroid-forge listening on ${host}:${PORT}`));
}
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

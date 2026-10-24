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
app.use('/api/backups', require('./routes/backups'));
app.use('/api/network', require('./routes/network'));

if (auth.AUTH_MODE === 'local') require('./lib/userStore').ensureBootstrapAdmin();

const PORT = process.env.PORT || 8080;
// Localhost-only by default (docs/ROADMAP.md Phase 6): this app's own API/UI can
// create/delete/operate every instance (and, once Phase 7's `local`/`oidc` auth is on, manage
// every account), so whoever can reach it is able to do all of that -- the same reasoning as
// each instance's own ADB port (dockerRuntime.create's `bindHosts`), just for a much bigger
// surface. `network_mode: host` in docker-compose.yml means this bind address is the real
// host's, not a container-internal one.
//
// Settings' `appBindHost` (set from the Settings tab's "App network" section, same discovered-
// interfaces list as the per-instance picker) takes priority once an admin has actually chosen
// one through the UI; REDROID_FORGE_BIND_HOST stays as the env-var escape hatch for before that
// UI has ever been touched (first boot, headless setups). Either way this is read once, at
// process start -- an http.Server cannot be rebound to a different address without restarting
// the listener, so a changed value only takes effect after the container is restarted; the
// Settings UI says so rather than pretending it is live (same honesty as the OIDC "secure
// cookie" gap noted in auth.js).
const BIND_HOST = settings.get().appBindHost || process.env.REDROID_FORGE_BIND_HOST || '127.0.0.1';
app.listen(PORT, BIND_HOST, () => {
  console.log(`redroid-forge listening on ${BIND_HOST}:${PORT}`);
  // Checks (never applies) whether a newer combinations database exists: on
  // open and once a day. Can be turned off with REDROID_FORGE_DB_CHECK=0.
  require('./lib/knownDbUpdate').startScheduler();
});

// Last safety net: a bug in a single request cannot bring down the whole process
// (and with it the management of ALL the running instances).
process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));
process.on('uncaughtException', (err) => console.error('uncaughtException:', err));

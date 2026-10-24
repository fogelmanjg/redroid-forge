const express = require('express');
const path = require('path');
const auth = require('./lib/auth');

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
// Localhost-only by default (docs/ROADMAP.md Phase 6): in standalone mode there is no auth of
// any kind yet (Phase 7), so whoever can reach this API can create/delete/operate every
// instance -- the same reasoning as each instance's own ADB port (dockerRuntime.create's
// `bindHosts`). `network_mode: host` in docker-compose.yml means this bind address is the
// real host's, not a container-internal one. REDROID_FORGE_BIND_HOST=0.0.0.0 (or a specific
// interface) opts in deliberately.
const BIND_HOST = process.env.REDROID_FORGE_BIND_HOST || '127.0.0.1';
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

'use strict';

const settings = require('./settings');

// Owns the actual http.Server instances this app is listening on, so they can be closed and
// reopened later (routes/settings.js, once appBindHosts changes) without server.js itself
// needing to know how that works. `app`/`port` are captured on the first listen() and reused by
// restart() -- an Express app never changes identity for the life of the process, so there is
// nothing to pass in a second time.
let activeServers = [];
let boundApp = null;
let boundPort = null;

// 127.0.0.1 is ALWAYS listened on, with no way to opt out -- nothing on this very host (e.g.
// scrcpy-redroid.sh, which SSHes in and reaches for localhost) could reach this app at all
// otherwise. Real incident, 28/10/2026: appBindHost used to be a SINGLE address, and once an
// admin pointed it at the Tailscale interface to reach the UI remotely, loopback access broke --
// an http.Server only ever binds the one address it is given, so "pick one" quietly meant "give
// up the other one too", which nobody actually wants.
//
// Settings' `appBindHosts` (set from the Settings tab's "App network" section) is ADDED to
// localhost once an admin has actually chosen at least one through the UI; REDROID_FORGE_BIND_HOST
// stays as the env-var escape hatch for before that UI has ever been touched (first boot,
// headless setups), ignored once appBindHosts is non-empty.
function computeBindHosts() {
  const configuredHosts = settings.get().appBindHosts;
  const extraHosts = configuredHosts.length ? configuredHosts : (
    process.env.REDROID_FORGE_BIND_HOST && process.env.REDROID_FORGE_BIND_HOST !== '127.0.0.1'
      ? [process.env.REDROID_FORGE_BIND_HOST] : []
  );
  // 0.0.0.0 already covers 127.0.0.1 too -- binding both separately is the same port claimed
  // twice, which a real listen() does not tolerate at all: confirmed live, the second bind fails
  // outright with EADDRINUSE.
  return extraHosts.includes('0.0.0.0') ? ['0.0.0.0'] : [...new Set(['127.0.0.1', ...extraHosts])];
}

// Binds every host from computeBindHosts(). A failed bind (e.g. EADDRINUSE) is left fatal,
// whether this runs at process start or from a later rebind (restart() below): without a real
// listener the app is unreachable either way, and by the time a rebind runs the setting that
// caused it is already saved (routes/settings.js calls settings.update() first), so nothing is
// lost -- `restart: unless-stopped` (docker-compose.yml) then brings the app back up clean,
// showing a crash-looping container instead of a deceptive "Up" rather than silently swallowing
// the failure.
//
// Resolves only once every host is actually accepting connections, not merely once listen() has
// been called on it -- binding is asynchronous, so a caller (restart() below, or whichever test
// fires a request right after) racing ahead of the real 'listening' event could hit a socket
// that is not there yet. Never rejects: a bind failure is fatal via process.exit() below, same
// reasoning either way (see module comment), so there is nothing for a caller to catch here.
function listen(app, port) {
  boundApp = app;
  boundPort = port;
  return Promise.all(computeBindHosts().map((host) => new Promise((resolve) => {
    const server = app.listen(port, host, () => {
      console.log(`redroid-forge listening on ${host}:${port}`);
      resolve();
    }).on('error', (err) => {
      console.error(`Failed to listen on ${host}:${port}: ${err.message}`);
      console.error('Is another process already using this port? Set PORT in .env to a free one.');
      process.exit(1);
    });
    activeServers.push(server);
  })));
}

// Closes every currently-listening server and waits for each one's own close() callback before
// resolving -- same "wait for the old one to really be gone before starting the new one"
// reasoning as hwAccel.js's restartDaemonWithCurrentSettings, and for the same kind of reason:
// two servers racing for the same port would just fail outright (EADDRINUSE), not silently
// misbehave, so there is nothing to gain from racing it.
function closeAll() {
  const toClose = activeServers;
  activeServers = [];
  return Promise.all(toClose.map((server) => new Promise((resolve) => {
    // close()'s own callback only fires once every existing connection (including a lingering
    // keep-alive one -- e.g. the very request that triggered this restart, still open while its
    // own response is in flight) has ended, which could take a while. The underlying listening
    // socket is released synchronously by close() itself regardless, so the 3s timeout fallback
    // here (same reasoning/duration as hwAccel.js's restartDaemonWithCurrentSettings) is safe:
    // the next listen() either way is binding a socket that has already been freed.
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    server.close(done);
    setTimeout(done, 3000);
  })));
}

// Called from routes/settings.js once appBindHosts actually changed. An http.Server cannot be
// rebound to a different address in place, so this closes the old one(s) and opens new ones for
// the current settings instead -- the only way described above, just run again after the first
// boot.
async function restart() {
  await closeAll();
  await listen(boundApp, boundPort);
}

module.exports = { computeBindHosts, listen, closeAll, restart };

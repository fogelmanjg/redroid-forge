'use strict';

// Live reconciliation of container starts that did not come from this app (21/11/2026,
// 1.0.0-beta.4). `docker start` by hand, or Docker itself (restart policy `unless-stopped`: after
// a crash, a Docker restart or a host reboot / power cut), can start an instance's container
// without any of what the app's own start does -- the hwenc daemon, watchdogs, fake-wifi radios,
// knock guards -- and without respecting a lock. Found for real after a power cut on server01
// (18/11/2026: three instances back up, cifi watchdog silently not running).
//
// This follows Docker's event stream; every container `start` that runtime.start()/restart()
// did not announce (dockerRuntime.expectStart) and that belongs to an instance is handed to
// `onExternalStart(instance)` (routes/instances.js: stop it if locked, otherwise run the same
// post-start steps as the start route). Preventing the start outright is a separate, later
// design (docs/ROADMAP.md / CHANGELOG: planned for 1.0.1 or 1.1).

const runtime = require('./dockerRuntime');
const store = require('./store');

function log(msg) { console.log(`[externalStart] ${msg}`); }

let started = false;
const inFlight = new Set();

async function handleEvent(evt, onExternalStart) {
  if (!evt || evt.Type !== 'container' || (evt.Action || evt.status) !== 'start') return;
  const id = String(evt.id || (evt.Actor && evt.Actor.ID) || '');
  if (!id) return;
  if (runtime.consumeExpectedStart(id)) return; // this app asked for it
  const instance = store.readAll().find((i) => i.containerId && (id.startsWith(i.containerId) || i.containerId.startsWith(id)));
  if (!instance) return; // not one of this app's instances
  if (inFlight.has(instance.id)) return;
  inFlight.add(instance.id);
  try {
    log(`"${instance.name}" was started outside the app -- reconciling`);
    await onExternalStart(instance);
  } catch (e) {
    log(`could not reconcile "${instance.name}": ${e.message}`);
  } finally {
    inFlight.delete(instance.id);
  }
}

function start(onExternalStart) {
  if (started) return;
  started = true;
  let backoffMs = 1000;
  const connect = () => {
    runtime.docker.getEvents({ filters: { type: ['container'], event: ['start'] } }, (err, stream) => {
      if (err) {
        log(`could not follow Docker events (${err.message}); retrying in ${Math.round(backoffMs / 1000)} s`);
        setTimeout(connect, backoffMs).unref();
        backoffMs = Math.min(backoffMs * 2, 60000);
        return;
      }
      backoffMs = 1000;
      let buf = '';
      stream.on('data', (chunk) => {
        buf += chunk.toString('utf-8');
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let evt;
          try { evt = JSON.parse(line); } catch { continue; }
          handleEvent(evt, onExternalStart);
        }
      });
      let reconnecting = false; // 'end' and 'error' can both fire for one broken stream
      const again = () => { if (reconnecting) return; reconnecting = true; setTimeout(connect, 1000).unref(); };
      stream.on('end', again);
      stream.on('error', again);
    });
  };
  connect();
}

module.exports = { start, handleEvent };

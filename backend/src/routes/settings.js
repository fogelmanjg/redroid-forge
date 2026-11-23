const express = require('express');
const settings = require('../lib/settings');
const permissions = require('../lib/permissions');
const hwAccel = require('../lib/hwAccel');
const httpListeners = require('../lib/httpListeners');
const fwknop = require('../lib/fwknop');
const portAllocator = require('../lib/portAllocator');
const { IP_SHAPE_RE } = require('../lib/instanceParams');

const router = express.Router();

// Admin only, and OIDC client secrets never leave the server (1.0.0-beta.7 security review): this
// used to answer any logged-in account -- a "viewer" too -- with the whole settings file, including
// the clientSecret of every OIDC provider added from the UI. The Settings tab is admin-only anyway,
// and the providers' own editor (GET /api/auth/oidc-providers) already keeps secrets out.
// Host name, IPv4, or a bracket-less IPv6 -- what goes before ":<port>" in an address.
const ADB_HOST_RE = /^([A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|[0-9A-Fa-f:.]{2,45})$/;

// What any logged-in page needs from the settings, nothing else (GET / above is admin only).
function clientSettings(all, env = process.env) {
  return { adbHost: all.adbHost || env.REDROID_FORGE_ADB_HOST || null };
}

function redactSettings(all) {
  const out = { ...all };
  if (Array.isArray(out.oidcProviders)) {
    out.oidcProviders = out.oidcProviders.map(({ clientSecret, ...p }) => ({ ...p, hasClientSecret: !!clientSecret }));
  }
  return out;
}

router.get('/client', (req, res) => {
  res.json(clientSettings(settings.get()));
});

router.get('/', (req, res) => {
  if (!permissions.canManageSettings(req.user)) return res.status(403).json({ error: 'Admin only' });
  res.json(redactSettings(settings.get()));
});

// Live check while the admin is still typing a range in Settings, before saving it -- same
// portAllocator.rangeStatus() the Doctor tab's "ADB port range availability" check and the
// saved PUT below both use, so the three never disagree. Declared before PUT '/' so this path
// is never swallowed by anything -- there is no other '/:something' route on this router to
// collide with, but same defensive habit as modules.js's gapps/arm-translation status routes.
router.get('/adb-port-range-check', async (req, res) => {
  const start = Number(req.query.start);
  const end = Number(req.query.end);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > 65535 || start > end) {
    return res.status(400).json({ error: '"start"/"end" must be integers with 1 <= start <= end <= 65535' });
  }
  try {
    const { total, taken } = await portAllocator.rangeStatus({ start, end });
    res.json({ total, taken, ok: taken.length === 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin only (docs/ROADMAP.md Phase 7) -- this changes where every instance's backups land,
// which interfaces are offered at all, and (appBindHosts) this app's OWN listen addresses -- none
// of it scoped to any one instance's ownership.
// Shared hwenc (VA-API) daemon: state + a manual restart (21/11/2026, 1.0.0-beta.4). Until now
// the only way to relaunch it from the UI was changing the encode backend; restarting it by hand
// (killing the process) was a routine fix while its memory leak existed. Admin only, like every
// other host-wide setting here: a restart cuts hardware encode for EVERY instance on this host
// for a few seconds (the same blip as the daemon's own crash-restart supervisor).
router.get('/hwenc-daemon', async (req, res) => {
  if (!permissions.canManageSettings(req.user)) return res.status(403).json({ error: 'Admin only' });
  res.json(await hwAccel.daemonStatus());
});

router.post('/hwenc-daemon/restart', async (req, res) => {
  if (!permissions.canManageSettings(req.user)) return res.status(403).json({ error: 'Admin only' });
  const before = await hwAccel.daemonStatus();
  if (before.adopted) {
    // Another forge on this host owns it (same socket path): killing it is not this forge's call.
    return res.status(409).json({ error: `The VA-API daemon at ${before.socketPath} belongs to another forge on this host -- restart it from there` });
  }
  try {
    await hwAccel.restartDaemonWithCurrentSettings();
    res.json(await hwAccel.daemonStatus());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/', async (req, res) => {
  if (!permissions.canManageSettings(req.user)) return res.status(403).json({ error: 'Admin only' });
  const {
    backupDir, networkInterfaceOverrides, appBindHosts, operatorPoolMaxVcpus, operatorPoolMaxMemoryMb, encodeBackend,
    adbPortStart, adbPortEnd, adbHost, backupKeepPerInstance,
  } = req.body || {};
  if (backupKeepPerInstance !== undefined && !(Number.isInteger(backupKeepPerInstance) && backupKeepPerInstance >= 0 && backupKeepPerInstance <= 1000)) {
    return res.status(400).json({ error: 'backupKeepPerInstance must be an integer from 0 (keep all) to 1000' });
  }
  if (adbHost !== undefined && adbHost !== null && adbHost !== ''
    && (typeof adbHost !== 'string' || !ADB_HOST_RE.test(adbHost.trim()))) {
    return res.status(400).json({ error: 'adbHost must be a host name or an IP address (no port, no scheme), or empty' });
  }
  if (backupDir !== undefined && (typeof backupDir !== 'string' || backupDir.trim() === '')) {
    return res.status(400).json({ error: 'backupDir must be a non-empty string' });
  }
  if (networkInterfaceOverrides !== undefined) {
    if (typeof networkInterfaceOverrides !== 'object' || networkInterfaceOverrides === null || Array.isArray(networkInterfaceOverrides)) {
      return res.status(400).json({ error: 'networkInterfaceOverrides must be an object of {ifaceName: boolean}' });
    }
    for (const [name, value] of Object.entries(networkInterfaceOverrides)) {
      if (typeof value !== 'boolean') {
        return res.status(400).json({ error: `networkInterfaceOverrides["${name}"] must be a boolean` });
      }
    }
  }
  // 127.0.0.1 is implicit (server.js always binds it regardless) and never needs to be listed
  // here -- an empty array = "nothing beyond localhost, or REDROID_FORGE_BIND_HOST" (server.js).
  if (appBindHosts !== undefined) {
    if (!Array.isArray(appBindHosts)) {
      return res.status(400).json({ error: 'appBindHosts must be an array of IP addresses' });
    }
    for (const h of appBindHosts) {
      if (typeof h !== 'string' || !IP_SHAPE_RE.test(h)) {
        return res.status(400).json({ error: `appBindHosts contains an invalid address: ${JSON.stringify(h)}` });
      }
    }
  }
  // Shared ceiling across every operator at once (src/lib/quotas.js) -- null/empty = unlimited.
  for (const [key, value] of [['operatorPoolMaxVcpus', operatorPoolMaxVcpus], ['operatorPoolMaxMemoryMb', operatorPoolMaxMemoryMb]]) {
    if (value !== undefined && value !== null && value !== '' && !(Number.isInteger(value) && value > 0)) {
      return res.status(400).json({ error: `${key} must be a positive integer, or null/empty to leave it unlimited` });
    }
  }
  if (encodeBackend !== undefined && encodeBackend !== null && encodeBackend !== 'legacy' && encodeBackend !== 'ffmpeg') {
    return res.status(400).json({ error: 'encodeBackend must be "legacy", "ffmpeg", or null (automatic)' });
  }
  // Validated as a PAIR even though each can be omitted independently (a partial PUT only
  // sending one of the two) -- the "effective" other side is whatever is already saved, same
  // null-falls-back-to-env rule portAllocator.range() itself applies. Only this project's own
  // sanity bounds (1-65535, start<=end) are enforced here; whether the range is actually FREE on
  // the host is never a hard block, same as the Doctor tab's own check -- see the
  // adb-port-range-check route above for the live warning this is paired with in the UI.
  if (adbPortStart !== undefined || adbPortEnd !== undefined) {
    const current = settings.get();
    const effectiveStart = adbPortStart !== undefined ? adbPortStart : current.adbPortStart;
    const effectiveEnd = adbPortEnd !== undefined ? adbPortEnd : current.adbPortEnd;
    const start = effectiveStart === null || effectiveStart === '' ? Number(process.env.ADB_PORT_START || 5555) : Number(effectiveStart);
    const end = effectiveEnd === null || effectiveEnd === '' ? Number(process.env.ADB_PORT_END || 5595) : Number(effectiveEnd);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > 65535 || start > end) {
      return res.status(400).json({ error: 'adbPortStart/adbPortEnd must be integers with 1 <= start <= end <= 65535' });
    }
  }
  const patch = {};
  if (backupDir !== undefined) patch.backupDir = backupDir.trim();
  if (networkInterfaceOverrides !== undefined) patch.networkInterfaceOverrides = networkInterfaceOverrides;
  const beforeAppBindHosts = settings.get().appBindHosts;
  if (appBindHosts !== undefined) {
    const deduped = [...new Set(appBindHosts)].filter((h) => h !== '127.0.0.1');
    patch.appBindHosts = deduped.includes('0.0.0.0') ? ['0.0.0.0'] : deduped;
  }
  if (operatorPoolMaxVcpus !== undefined) patch.operatorPoolMaxVcpus = operatorPoolMaxVcpus || null;
  if (operatorPoolMaxMemoryMb !== undefined) patch.operatorPoolMaxMemoryMb = operatorPoolMaxMemoryMb || null;
  const beforeEncodeBackend = settings.get().encodeBackend;
  if (encodeBackend !== undefined) patch.encodeBackend = encodeBackend || null;
  const beforeAdbPorts = { start: settings.get().adbPortStart, end: settings.get().adbPortEnd };
  if (adbPortStart !== undefined) patch.adbPortStart = adbPortStart === '' ? null : adbPortStart;
  if (adbPortEnd !== undefined) patch.adbPortEnd = adbPortEnd === '' ? null : adbPortEnd;
  if (adbHost !== undefined) patch.adbHost = adbHost ? adbHost.trim() : null;
  if (backupKeepPerInstance !== undefined) patch.backupKeepPerInstance = backupKeepPerInstance;
  const updated = settings.update(patch);
  // Unlike authMode (needs a full app restart, never automated -- see auth.js's own comment),
  // this one can be hot-applied: hwAccel.restartDaemonWithCurrentSettings() waits for the old
  // native daemon to actually exit before relaunching it with the new backend (see its own
  // comment on why that matters). It briefly cuts hw-accel for EVERY instance on this host (the
  // daemon is shared, not per-instance -- see settings.js's comment on encodeBackend), the same
  // kind of blip the daemon's own crash-restart supervisor already causes on its own. Never
  // fails the request: the setting is saved either way, and a manual restart still applies it if
  // this hot-restart itself has trouble.
  if (encodeBackend !== undefined && patch.encodeBackend !== beforeEncodeBackend) {
    try {
      await hwAccel.restartDaemonWithCurrentSettings();
    } catch (e) {
      console.warn(`[settings] could not relaunch the VA-API daemon with the new encode backend: ${e.message}`);
    }
  }
  // Same "hot-apply, never fail the request over it" reasoning, for the ADB port range --
  // portAllocator.js itself needs nothing special (settings.get() is read fresh on every
  // nextPort()/portStatus() call already), but fwknop.js's access.conf is a FILE, only ever
  // written at ensureConfigFiles() time: without this, OPEN_PORTS there would keep listing the
  // OLD range until the next full container restart, silently refusing a legitimate knock on
  // any port in the new one. fwknop.restart() is a local SIGKILL+respawn (a few ms), not worth
  // delaying the response for.
  const adbPortsChanged = (adbPortStart !== undefined && patch.adbPortStart !== beforeAdbPorts.start)
    || (adbPortEnd !== undefined && patch.adbPortEnd !== beforeAdbPorts.end);
  if (adbPortsChanged) {
    try {
      fwknop.restart();
    } catch (e) {
      console.warn(`[settings] could not reload fwknopd with the new ADB port range: ${e.message}`);
    }
  }
  // Same "hot-apply, never fail the request over it" reasoning as encodeBackend above, but for
  // this app's OWN listeners (lib/httpListeners.js) instead of the native daemon -- a changed
  // appBindHosts used to need a manual `docker compose restart` (real gotcha, 28/10/2026: "up -d"
  // alone does nothing, since this setting lives in data, not .env/the image); now the close+
  // relisten happens here instead. Compared by value, not reference: patch.appBindHosts is a new
  // deduped array every time, so `!==` would "change" on every save even with the same hosts.
  const appBindHostsChanged = appBindHosts !== undefined && JSON.stringify([...patch.appBindHosts].sort())
    !== JSON.stringify([...beforeAppBindHosts].sort());
  // Responds BEFORE restarting, unlike encodeBackend above: the admin's own request may itself be
  // arriving on the very address about to be closed, and httpListeners.closeAll() waits (with a
  // timeout) for that connection to end -- awaiting it before res.json() would deadlock the
  // request against its own response. The setting is already saved either way (settings.update()
  // ran above), so there's nothing wrong with the client getting its answer first.
  res.json(redactSettings(updated));
  if (appBindHostsChanged) {
    try {
      await httpListeners.restart();
    } catch (e) {
      console.warn(`[settings] could not rebind this app's own listeners with the new network settings: ${e.message}`);
    }
  }
});

module.exports = router;
module.exports.redactSettings = redactSettings;
module.exports.clientSettings = clientSettings;
module.exports.ADB_HOST_RE = ADB_HOST_RE;

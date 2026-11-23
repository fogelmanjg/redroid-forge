'use strict';

// Cross-site request protection (1.0.0-beta.7). Over HTTPS the session cookie is SameSite=None --
// it has to be, for the Plenum iframe embed (see auth.js setSessionCookie) -- so a browser attaches
// it to requests ANOTHER site's page fires at this app too. Without a check, any page a logged-in
// admin visits could POST to /api/... (body-less ones work: restart the hwenc daemon, apply the
// known-combinations DB, start/stop/lock an instance whose id it knows) or open a viewer WebSocket.
//
// The check: a browser always sends Origin on cross-origin POST/PUT/PATCH/DELETE and on every
// WebSocket handshake. If Origin is there and is not this app's own origin, refuse. No Origin at
// all = not a browser cross-site request (curl, the local tools, scripts): allowed, they are
// authenticated like any other request. Requests from inside the Plenum iframe come from this app's
// own origin, so the embed keeps working. Extra trusted origins: REDROID_FORGE_ALLOWED_ORIGINS
// (comma-separated, e.g. "https://dashboard.example.org").

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function allowedExtraOrigins(env = process.env) {
  return String(env.REDROID_FORGE_ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim().replace(/\/+$/, '').toLowerCase()).filter(Boolean);
}

// The host this request was addressed to: the Host header (reverse proxies like Caddy keep the
// original one), or X-Forwarded-Host when a proxy rewrote Host and said so.
function requestHosts(req) {
  const hosts = new Set();
  if (req.headers.host) hosts.add(String(req.headers.host).toLowerCase());
  const xfh = req.headers['x-forwarded-host'];
  if (xfh) for (const h of String(xfh).split(',')) hosts.add(h.trim().toLowerCase());
  return hosts;
}

// -> true when the request may proceed.
function isAllowedOrigin(req, env = process.env) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (origin === 'null') return false; // sandboxed iframes, file://, some redirects: never this app
  let url;
  try { url = new URL(origin); } catch (e) { return false; }
  if (requestHosts(req).has(url.host.toLowerCase())) return true;
  return allowedExtraOrigins(env).includes(`${url.protocol}//${url.host}`.toLowerCase());
}

// Express middleware for /api: state-changing methods only (a cross-site GET cannot read the
// answer anyway, CORS sees to that).
function middleware(req, res, next) {
  if (SAFE_METHODS.has(req.method) || isAllowedOrigin(req)) return next();
  res.status(403).json({ error: 'Cross-site request refused (Origin does not match this redroid-forge)' });
}

module.exports = { isAllowedOrigin, middleware, allowedExtraOrigins };

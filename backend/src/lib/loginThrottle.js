'use strict';

// Login attempt limit (1.0.0-beta.7). Before, POST /api/auth/login accepted unlimited guesses.
// Per client: MAX_FAILURES wrong passwords within WINDOW_MS and further attempts get 429 until the
// window of the oldest counted failure passes. A successful login clears the client's count.
// In memory on purpose: a restart forgets it, which is fine for a rate limit.
//
// The client is the TCP peer -- except when the peer is loopback AND the request carries
// X-Forwarded-For: that is the reverse proxy on this same host (auth.js's isTrustedLocalTool
// reasoning), and the client is the LAST address it appended (earlier entries come from the
// client itself and can be anything).

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;
const MAX_TRACKED = 10_000; // memory bound: a flood of distinct addresses cannot grow this forever

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function clientKey(req) {
  const peer = req.socket?.remoteAddress || req.ip || 'unknown';
  const xff = req.headers['x-forwarded-for'];
  if (LOOPBACK.has(peer) && xff) {
    const parts = String(xff).split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return peer;
}

function createThrottle({ now = () => Date.now(), windowMs = WINDOW_MS, maxFailures = MAX_FAILURES } = {}) {
  const failures = new Map(); // key -> [timestamps]

  function recent(key) {
    const t = now();
    const list = (failures.get(key) || []).filter((ts) => t - ts < windowMs);
    if (list.length) failures.set(key, list); else failures.delete(key);
    return list;
  }

  // -> { allowed: true } or { allowed: false, retryAfterS }
  function check(key) {
    const list = recent(key);
    if (list.length < maxFailures) return { allowed: true };
    return { allowed: false, retryAfterS: Math.max(1, Math.ceil((list[0] + windowMs - now()) / 1000)) };
  }

  function fail(key) {
    if (!failures.has(key) && failures.size >= MAX_TRACKED) {
      failures.delete(failures.keys().next().value); // oldest inserted
    }
    failures.set(key, [...recent(key), now()]);
  }

  function succeed(key) { failures.delete(key); }

  return { check, fail, succeed };
}

const shared = createThrottle();

module.exports = { createThrottle, clientKey, shared, WINDOW_MS, MAX_FAILURES };

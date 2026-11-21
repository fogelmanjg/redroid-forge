'use strict';

// Shared live preview capture (21/11/2026). Before this, routes/viewer.js started its OWN
// screenshotCapture loop per WebSocket: every open frontend (each browser tab, each PC, the
// "completo" 👁 toggle AND the "visores" grid) ran a separate `adb exec-out screencap` per
// instance every 1.5 s -- N viewers = N captures of the same screen. Asked for explicitly: "la
// conexion de la captura deberia pedirla el backend y el frontend acceder a la ultima pedida".
//
// Now there is at most ONE capture loop per instance, owned here, alive only while at least one
// viewer is subscribed; each tick's screencap is shrunk once per DISTINCT size its subscribers
// asked for (the "visores" slider lets each one pick its own) and every subscriber gets the
// latest frame at its size. A viewer that joins late gets the last frame right away instead of
// waiting for the next tick.
//
// Failure handling keeps routes/viewer.js's old per-connection rule, just owned here: one failed
// capture is routine (adb busy, mid-boot) and the loop keeps going; MAX_CONSECUTIVE_ERRORS in a
// row means the instance is not there (stopped, offline) -- every subscriber is told to give up
// (the route closes its WS) and the loop ends, instead of each of N viewers hammering adb against
// an instance that is gone (prod's log had ~2500 "device not found" from exactly that).

const screenshotCapture = require('./screenshotCapture');

const MAX_CONSECUTIVE_ERRORS = 3;

// Injectable capture/shrink so the tests run without adb or a device.
function createRegistry({
  capture = screenshotCapture.captureScreenshot,
  shrink = screenshotCapture.shrinkForPreview,
  clampSize = screenshotCapture.clampSize,
} = {}) {
  const hubs = new Map(); // instanceId -> hub

  function makeHub(instanceId, host, adbPort, intervalMs) {
    const hub = {
      instanceId, host, adbPort, intervalMs,
      subscribers: new Set(),
      timer: null,
      capturing: false,
      lastPng: null,
      jpegBySize: new Map(), // shrunk versions of lastPng, per size, reused by late joiners
      consecutiveErrors: 0,
    };
    hubs.set(instanceId, hub);
    return hub;
  }

  function dispose(hub) {
    if (hub.timer) clearTimeout(hub.timer);
    hub.timer = null;
    if (hubs.get(hub.instanceId) === hub) hubs.delete(hub.instanceId);
  }

  async function jpegFor(hub, size) {
    let jpeg = hub.jpegBySize.get(size);
    if (!jpeg) {
      jpeg = await shrink(hub.lastPng, size);
      hub.jpegBySize.set(size, jpeg);
    }
    return jpeg;
  }

  async function tick(hub) {
    hub.timer = null;
    if (hub.subscribers.size === 0) { dispose(hub); return; }
    hub.capturing = true;
    try {
      const png = await capture(hub.host, hub.adbPort);
      hub.lastPng = png;
      hub.jpegBySize = new Map();
      hub.consecutiveErrors = 0;
      const sizes = new Set([...hub.subscribers].map((s) => s.size));
      for (const size of sizes) {
        // eslint-disable-next-line no-await-in-loop
        const jpeg = await jpegFor(hub, size);
        for (const sub of hub.subscribers) if (sub.size === size) sub.onFrame(jpeg);
      }
    } catch (e) {
      hub.consecutiveErrors += 1;
      // Logged once here, not once per subscriber.
      console.error(`live preview capture error for instance ${hub.instanceId}:`, e.message);
      for (const sub of hub.subscribers) if (sub.onError) sub.onError(e);
      if (hub.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        hub.capturing = false;
        const subs = [...hub.subscribers];
        hub.subscribers.clear();
        dispose(hub);
        for (const sub of subs) if (sub.onGiveUp) sub.onGiveUp(e);
        return;
      }
    }
    hub.capturing = false;
    if (hub.subscribers.size === 0) { dispose(hub); return; }
    hub.timer = setTimeout(() => tick(hub), hub.intervalMs);
    // Never the thing that keeps a process alive on its own (the HTTP server does that in prod);
    // without this, a test that failed before unsubscribing hung the whole `node --test` run.
    if (hub.timer.unref) hub.timer.unref();
  }

  // -> { setSize, unsubscribe }. onFrame(jpeg) for every frame at this subscriber's size,
  // onError(err) for each failed capture, onGiveUp(err) once if the instance looks gone (the
  // subscription is already removed by then).
  function subscribe(instanceId, { host, adbPort, intervalMs, size, onFrame, onError, onGiveUp }) {
    let hub = hubs.get(instanceId);
    // The port can change if the instance was recreated; start over against the new one.
    if (hub && hub.adbPort !== adbPort) { hub.subscribers.clear(); dispose(hub); hub = null; }
    if (!hub) hub = makeHub(instanceId, host, adbPort, intervalMs);

    const sub = { size: clampSize(size), onFrame, onError, onGiveUp };
    hub.subscribers.add(sub);

    if (hub.lastPng) {
      // Late joiner: the last frame now, at its own size, not after a full interval.
      jpegFor(hub, sub.size).then((jpeg) => { if (hub.subscribers.has(sub)) sub.onFrame(jpeg); }).catch(() => {});
    }
    if (!hub.timer && !hub.capturing) tick(hub);

    return {
      setSize(next) { sub.size = clampSize(next); },
      unsubscribe() {
        hub.subscribers.delete(sub);
        if (hub.subscribers.size === 0 && !hub.capturing) dispose(hub);
      },
    };
  }

  function stats() {
    return [...hubs.values()].map((h) => ({ instanceId: h.instanceId, subscribers: h.subscribers.size }));
  }

  return { subscribe, stats };
}

module.exports = { createRegistry, MAX_CONSECUTIVE_ERRORS, ...createRegistry() };

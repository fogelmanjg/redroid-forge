// Ventanita player -- WebSocket delivering a small, heavily-compressed JPEG screenshot every
// couple of seconds, shown in an <img>, nothing else. Changed 15/11/2026 from an earlier
// WebCodecs/H.264 version: the
// shared VA-API encode daemon this host's scrcpy-server path depends on turned out to fail
// intermittently under host-wide concurrent load (killing the whole scrcpy-server process, not
// just that connection), and the ventanita never needed real video to begin with (decided
// explicitly: "no necesito fluidez"). `adb exec-out screencap` on the backend side
// (screenshotCapture.js) never touches that encoder at all, so this sidesteps the bug by
// construction instead of working around it. The real scrcpy/WebCodecs pipeline this replaced is
// still what Hito 4 (expandida/pantalla completa, which DOES need real video+audio) will use.
//
// mount/unmount are keyed by instanceId and idempotent -- app.js's per-row toggle (persisted in
// localStorage, see its own comment) just calls these on click/reload, never has to track
// whether a session is already running itself.
const Viewer = (() => {
  const sessions = new Map(); // instanceId -> { ws, img, url }

  function wsUrl(instanceId, size) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const base = `${proto}://${location.host}/api/instances/${encodeURIComponent(instanceId)}/viewer`;
    return size ? `${base}?size=${encodeURIComponent(size)}` : base;
  }

  // Each message is one complete JPEG (screenshotCapture.js shrinks+recompresses the raw PNG
  // screencap server-side before sending -- see its own comment for why: screencap itself has no
  // scale-down option, so a full-resolution lossless PNG would cost far more bandwidth than this
  // ~160px, intentionally-lossy thumbnail needs). Blob URL, not a base64 data: URL -- avoids a
  // string round-trip of the image on every frame. The previous URL is revoked right after the
  // new one takes over (not before -- revoking while still assigned to img.src would race the
  // browser's own decode of it).
  function handleMessage(state, data) {
    const oldUrl = state.url;
    state.url = URL.createObjectURL(new Blob([data], { type: 'image/jpeg' }));
    state.img.src = state.url;
    if (oldUrl) URL.revokeObjectURL(oldUrl);
  }

  // Idempotent AND safe to call on every re-render of a row that still wants its ventanita on --
  // app.js's table is fully rebuilt from scratch on every background poll (loadInstances'
  // own module comment), so a naive "always create a new img" here would tear down and reopen
  // the WS every few seconds. If a session already exists, just move its existing (still-live)
  // img into the new container instead of opening a new one.
  //
  // `size` (optional) is the short-side target in px the backend should capture+shrink to
  // (screenshotCapture.js) -- omitted for the "completo" tab's per-row 👁 toggle, which keeps the
  // server's own unconfigured default; passed by the "visores" grid view, which wants a bigger,
  // live-adjustable preview instead of the default thumbnail stretched blurry with CSS. Found the
  // hard way (15/11/2026, "cuando cambias a la vista visores... no envia el valor del slider"):
  // when REUSING an existing session (e.g. an instance whose "completo"-tab 👁 toggle is also on,
  // so it already connected at the server's default size before "visores" ever asked for one),
  // just moving the img left that session's own capture size exactly as it was before -- this
  // call's own `size` was silently never applied to it, only the next slider drag would. Calling
  // setSize() here too closes that gap: every mount (new or reused) now asks for the CURRENT
  // size, not just connection-time.
  function mountVentanita(container, instanceId, size) {
    const existing = sessions.get(instanceId);
    if (existing) {
      container.appendChild(existing.img);
      if (size) setSize(instanceId, size);
      return;
    }
    const img = document.createElement('img');
    img.className = 'viewer-ventanita-img';
    container.appendChild(img);

    const state = { instanceId, img, url: null, ws: null };
    sessions.set(instanceId, state);

    const ws = new WebSocket(wsUrl(instanceId, size));
    ws.binaryType = 'arraybuffer';
    state.ws = ws;
    ws.addEventListener('message', (ev) => handleMessage(state, ev.data));
    ws.addEventListener('close', () => unmountVentanita(instanceId));
    ws.addEventListener('error', () => {}); // 'close' always follows -- nothing extra to do here
  }

  function unmountVentanita(instanceId) {
    const state = sessions.get(instanceId);
    if (!state) return;
    sessions.delete(instanceId);
    try { state.ws.close(); } catch (e) { /* already closing/closed */ }
    if (state.url) URL.revokeObjectURL(state.url);
    state.img.remove();
  }

  // Resizes an ALREADY-OPEN session's capture live (routes/viewer.js's own matching comment) --
  // "la proxima actualizacion viene el tamaño nuevo": the backend applies it starting with
  // whichever capture tick hasn't started yet, no reconnect. A session not open yet (or already
  // gone) just has nothing to send to -- the next mountVentanita's own `size` argument covers
  // that case instead.
  function setSize(instanceId, size) {
    const state = sessions.get(instanceId);
    if (!state || state.ws.readyState !== WebSocket.OPEN) return;
    try { state.ws.send(JSON.stringify({ size })); } catch (e) { /* best effort */ }
  }
  function setSizeAll(size) {
    for (const id of sessions.keys()) setSize(id, size);
  }

  function isMounted(instanceId) { return sessions.has(instanceId); }
  function mountedIds() { return Array.from(sessions.keys()); }

  return { mountVentanita, unmountVentanita, setSize, setSizeAll, isMounted, mountedIds };
})();

// "Expandida" viewer -- Hitos 3+4 of the web viewer plan (/home/jgustavo/.claude/plans/
// recursive-dreaming-honey.md), merged into one deliverable since input only makes sense once a
// live video session exists to point it at. Real scrcpy video (H.264, WebCodecs VideoDecoder) +
// audio (Opus, WebCodecs AudioDecoder) + pointer/keyboard input, full-screen -- the streaming-
// quality experience the ventanita (viewer.js, screencap-based) explicitly does not try to be.
//
// Unlike Viewer (viewer.js), which tracks one session per instance (several ventanitas can be on
// at once), this is a single full-screen overlay -- opening a second instance's expandida closes
// whichever one was already open, same as any other full-screen modal on this page. No
// localStorage persistence either: this is always an explicit, one-shot "open" action (the
// plan's own "acción explícita, independiente del toggle de la ventanita"), never something that
// should come back on its own after a reload.
const ViewerExpanded = (() => {
  let state = null; // { instanceId, ws, overlay, canvas, ctx, videoDecoder, audioDecoder,
  // audioCtx, nextAudioStartTime, pendingConfigPayload, activePointerId, textInput }

  // Android keycodes (frameworks/base/core/java/android/view/KeyEvent.java) this bar needs --
  // not re-deriving them from anywhere else, they are fixed OS constants.
  const KEYCODE = { BACK: 4, HOME: 3, APP_SWITCH: 187, VOLUME_UP: 24, VOLUME_DOWN: 25 };

  const TAG_VIDEO = 0x01;
  const TAG_AUDIO = 0x02;

  function wsUrl(instanceId) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/api/instances/${encodeURIComponent(instanceId)}/viewer/full`;
  }

  // Finds the first NAL unit of a given type in an Annex B byte stream (start codes
  // 00 00 01 / 00 00 00 01 between units) and returns its payload (header byte included, so
  // byte 0 of the result is the NAL header -- callers that need profile/level skip past it
  // themselves). Only used once, at VideoDecoder.configure() time, to build a real codec string
  // instead of guessing one -- see buildAvcCodecString below.
  function findNal(buf, nalType) {
    let i = 0;
    while (i < buf.length - 3) {
      if (buf[i] === 0 && buf[i + 1] === 0 && (buf[i + 2] === 1 || (buf[i + 2] === 0 && buf[i + 3] === 1))) {
        const start = i + (buf[i + 2] === 1 ? 3 : 4);
        let end = buf.length;
        for (let j = start; j < buf.length - 3; j++) {
          if (buf[j] === 0 && buf[j + 1] === 0 && (buf[j + 2] === 1 || (buf[j + 2] === 0 && buf[j + 3] === 1))) { end = j; break; }
        }
        if (start < buf.length && (buf[start] & 0x1f) === nalType) return buf.subarray(start, end);
        i = end;
      } else {
        i += 1;
      }
    }
    return null;
  }

  // avc1.PPCCLL (profile_idc, constraint flags, level_idc -- all hex), read straight off the real
  // SPS this device sent, not assumed: per the plan, "no asumir un valor fijo". Falls back to a
  // common Baseline/4.1 string (what this project's own test instance negotiates, confirmed live)
  // only if no SPS is found at all, which should not happen given scrcpy always sends one.
  function buildAvcCodecString(configPayload) {
    const sps = findNal(configPayload, 7);
    if (!sps || sps.length < 4) return 'avc1.42C029';
    const hex = (b) => b.toString(16).padStart(2, '0').toUpperCase();
    return `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`;
  }

  function configureVideoDecoder(st, firstPayload) {
    const codec = buildAvcCodecString(firstPayload);
    st.videoDecoder = new VideoDecoder({
      output: (frame) => {
        if (st.canvas.width !== frame.displayWidth || st.canvas.height !== frame.displayHeight) {
          st.canvas.width = frame.displayWidth;
          st.canvas.height = frame.displayHeight;
        }
        st.ctx.drawImage(frame, 0, 0);
        frame.close();
      },
      error: (e) => console.error('ViewerExpanded video decode error:', e),
    });
    try {
      st.videoDecoder.configure({ codec, avc: { format: 'annexb' }, optimizeForLatency: true });
    } catch (e) {
      console.error('ViewerExpanded: VideoDecoder.configure failed', e);
    }
  }

  // scrcpy-server sends the SPS/PPS as a separate, non-keyframe "config" packet (flags bit1, set
  // by backend/src/routes/viewerExpanded.js from protocol.js's own isConfig), and never repeats
  // it before the IDR frame that follows (confirmed live, Paso A probe: packet #1 isConfig
  // size=32, packet #2 the real 15KB keyframe) -- so a config packet is buffered rather than
  // decoded on its own, and prepended to the NEXT packet's payload instead, giving the decoder
  // one self-contained Annex B access unit (SPS+PPS immediately followed by the frame data)
  // exactly the way `avc: {format:'annexb'}` expects to see one. Handled generically (not just
  // for the very first packet) -- scrcpy-server can send a fresh config packet later too (e.g. a
  // resolution change).
  function handleVideoPacket(st, flags, pts, payload) {
    const isKeyFrame = !!(flags & 0x01);
    const isConfig = !!(flags & 0x02);
    if (isConfig) {
      st.pendingConfigPayload = st.pendingConfigPayload
        ? new Uint8Array([...st.pendingConfigPayload, ...payload]) : payload;
      return;
    }
    let data = payload;
    if (st.pendingConfigPayload) {
      data = new Uint8Array(st.pendingConfigPayload.length + payload.length);
      data.set(st.pendingConfigPayload, 0);
      data.set(payload, st.pendingConfigPayload.length);
      st.pendingConfigPayload = null;
    }
    if (!st.videoDecoderConfigured) {
      configureVideoDecoder(st, data);
      st.videoDecoderConfigured = true;
    }
    try {
      st.videoDecoder.decode(new EncodedVideoChunk({ type: isKeyFrame ? 'key' : 'delta', timestamp: pts, data }));
    } catch (e) { console.error('ViewerExpanded: video decode() threw', e); }
  }

  function configureAudioDecoder(st) {
    st.audioDecoderConfiguring = true;
    const config = { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 };
    AudioDecoder.isConfigSupported(config).then((support) => {
      if (!support.supported) { console.warn('ViewerExpanded: Opus decode not supported by this browser, audio disabled.'); return; }
      st.audioDecoder = new AudioDecoder({
        output: (audioData) => playAudioData(st, audioData),
        error: (e) => console.error('ViewerExpanded audio decode error:', e),
      });
      st.audioDecoder.configure(config);
      st.audioDecoderReady = true;
      for (const pkt of st.pendingAudioPackets) decodeAudioChunk(st, pkt.pts, pkt.payload);
      st.pendingAudioPackets = [];
    }).catch((e) => console.warn('ViewerExpanded: AudioDecoder.isConfigSupported failed', e));
  }

  function decodeAudioChunk(st, pts, payload) {
    try {
      st.audioDecoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: pts, data: payload }));
    } catch (e) { console.error('ViewerExpanded: audio decode() threw', e); }
  }

  function handleAudioPacket(st, pts, payload) {
    // isConfigSupported() is async -- audioDecoderConfiguring (set synchronously, before any
    // other packet can be seen) is what stops the next packet (they arrive every ~20ms, faster
    // than that promise resolves) from kicking off a second, redundant configure in parallel.
    if (!st.audioDecoder && !st.audioDecoderConfiguring) configureAudioDecoder(st);
    if (st.audioDecoderReady) decodeAudioChunk(st, pts, payload);
    else st.pendingAudioPackets.push({ pts, payload });
  }

  // Sequential scheduling against the AudioContext's own clock -- no resampler, no shared clock
  // with the video PTS: the plan's own ~100ms sync tolerance explicitly allows this, the simplest
  // approach that does not glitch/overlap between consecutive Opus frames.
  function playAudioData(st, audioData) {
    try {
      const buffer = st.audioCtx.createBuffer(audioData.numberOfChannels, audioData.numberOfFrames, audioData.sampleRate);
      for (let ch = 0; ch < audioData.numberOfChannels; ch++) {
        const dest = buffer.getChannelData(ch);
        audioData.copyTo(dest, { planeIndex: ch, format: 'f32-planar' });
      }
      const source = st.audioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(st.audioCtx.destination);
      const startAt = Math.max(st.nextAudioStartTime, st.audioCtx.currentTime);
      source.start(startAt);
      st.nextAudioStartTime = startAt + buffer.duration;
    } finally {
      audioData.close();
    }
  }

  function handleMessage(st, data) {
    const buf = new Uint8Array(data);
    if (buf.length < 10) return;
    const tag = buf[0];
    const flags = buf[1];
    const dv = new DataView(buf.buffer, buf.byteOffset + 2, 8);
    const pts = Number(dv.getBigUint64(0));
    const payload = buf.subarray(10);
    if (tag === TAG_VIDEO) handleVideoPacket(st, flags, pts, payload);
    else if (tag === TAG_AUDIO) handleAudioPacket(st, pts, payload);
  }

  function sendControl(st, msg) {
    if (st.ws.readyState !== WebSocket.OPEN) return;
    try { st.ws.send(JSON.stringify(msg)); } catch (e) { /* best effort, same as viewer.js's setSize */ }
  }

  function tapKey(st, keycode) {
    sendControl(st, { type: 'key', action: 'down', keycode });
    sendControl(st, { type: 'key', action: 'up', keycode });
  }

  function canvasPointToDevice(st, clientX, clientY) {
    const rect = st.canvas.getBoundingClientRect();
    const x = Math.round((clientX - rect.left) / rect.width * st.canvas.width);
    const y = Math.round((clientY - rect.top) / rect.height * st.canvas.height);
    return { x, y, screenWidth: st.canvas.width, screenHeight: st.canvas.height };
  }

  function attachInput(st) {
    st.canvas.style.touchAction = 'none'; // no browser-native scroll/zoom/pinch stealing the gesture
    st.canvas.addEventListener('pointerdown', (e) => {
      if (st.activePointerId !== null) return; // single pointer only, per the plan -- ignore a second one
      st.activePointerId = e.pointerId;
      st.canvas.setPointerCapture(e.pointerId);
      sendControl(st, { type: 'touch', action: 'down', ...canvasPointToDevice(st, e.clientX, e.clientY) });
    });
    st.canvas.addEventListener('pointermove', (e) => {
      if (e.pointerId !== st.activePointerId) return;
      sendControl(st, { type: 'touch', action: 'move', ...canvasPointToDevice(st, e.clientX, e.clientY) });
    });
    const end = (e) => {
      if (e.pointerId !== st.activePointerId) return;
      sendControl(st, { type: 'touch', action: 'up', ...canvasPointToDevice(st, e.clientX, e.clientY) });
      st.activePointerId = null;
    };
    st.canvas.addEventListener('pointerup', end);
    st.canvas.addEventListener('pointercancel', end);

    // Plain committed text only (no IME/composition handling, per the plan) -- the hidden input
    // gets the browser's/OS's own composition for free, and only this handler's 'input' event
    // (fired once per committed change) ever reaches sendText. Backspace-only edits are not
    // forwarded as deletions (out of scope -- "no se necesita IME propio"), typing new text is.
    st.textInput.addEventListener('input', () => {
      if (st.textInput.value) { sendControl(st, { type: 'text', text: st.textInput.value }); st.textInput.value = ''; }
    });

    st.overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  }

  function buildOverlay(instanceId) {
    const overlay = document.createElement('div');
    overlay.className = 'viewer-expanded-overlay';
    overlay.tabIndex = -1;

    const canvas = document.createElement('canvas');
    canvas.className = 'viewer-expanded-canvas';
    overlay.appendChild(canvas);

    const textInput = document.createElement('input');
    textInput.type = 'text';
    textInput.className = 'viewer-expanded-text-input';
    textInput.setAttribute('autocomplete', 'off');
    textInput.setAttribute('autocapitalize', 'off');
    overlay.appendChild(textInput);

    const bar = document.createElement('div');
    bar.className = 'viewer-expanded-navbar';
    const addBtn = (label, title, onClick) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'viewer-expanded-navbtn';
      btn.textContent = label;
      btn.title = title;
      btn.addEventListener('click', onClick);
      bar.appendChild(btn);
      return btn;
    };
    const st = { instanceId, overlay, canvas, ctx: canvas.getContext('2d'), textInput };
    addBtn('◀', I18n.t('instances.viewer.expandedBack'), () => tapKey(st, KEYCODE.BACK));
    addBtn('○', I18n.t('instances.viewer.expandedHome'), () => tapKey(st, KEYCODE.HOME));
    addBtn('□', I18n.t('instances.viewer.expandedRecents'), () => tapKey(st, KEYCODE.APP_SWITCH));
    addBtn('−', I18n.t('instances.viewer.expandedVolumeDown'), () => tapKey(st, KEYCODE.VOLUME_DOWN));
    addBtn('+', I18n.t('instances.viewer.expandedVolumeUp'), () => tapKey(st, KEYCODE.VOLUME_UP));
    addBtn('⌨', I18n.t('instances.viewer.expandedKeyboard'), () => st.textInput.focus());
    addBtn('⛶', I18n.t('instances.viewer.expandedFullscreen'), () => {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else overlay.requestFullscreen().catch(() => {});
    });
    addBtn('✕', I18n.t('instances.viewer.expandedClose'), () => close());
    overlay.appendChild(bar);

    document.body.appendChild(overlay);
    return st;
  }

  function open(instanceId) {
    if (state) close();

    const st = buildOverlay(instanceId);
    st.pendingConfigPayload = null;
    st.videoDecoder = null;
    st.videoDecoderConfigured = false;
    st.audioDecoder = null;
    st.audioDecoderReady = false;
    st.audioDecoderConfiguring = false;
    st.pendingAudioPackets = [];
    st.activePointerId = null;
    // Created synchronously inside this click handler's call stack -- satisfies autoplay
    // policies (no separate user gesture needed to unlock it later). Found live (15/11/2026,
    // real test: video worked, audio was silent with no error): creating it inside the gesture
    // is not enough on its own -- some browsers still hand it back in 'suspended' state, and it
    // only starts producing sound after an explicit resume(). Call it unconditionally; resuming
    // an already-running context is a harmless no-op.
    st.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    st.audioCtx.resume().catch((e) => console.warn('ViewerExpanded: audioCtx.resume() failed', e));
    st.nextAudioStartTime = 0;

    const ws = new WebSocket(wsUrl(instanceId));
    ws.binaryType = 'arraybuffer';
    st.ws = ws;
    ws.addEventListener('message', (ev) => handleMessage(st, ev.data));
    ws.addEventListener('close', () => { if (state === st) close(); });
    ws.addEventListener('error', () => {}); // 'close' always follows, same as viewer.js

    attachInput(st);
    state = st;
    st.overlay.focus();
  }

  function close() {
    if (!state) return;
    const st = state;
    state = null;
    try { st.ws.close(); } catch (e) { /* already closing/closed */ }
    try { st.videoDecoder?.close(); } catch (e) { /* already closed/errored */ }
    try { st.audioDecoder?.close(); } catch (e) { /* already closed/errored */ }
    try { st.audioCtx.close(); } catch (e) { /* best effort */ }
    if (document.fullscreenElement === st.overlay) document.exitFullscreen().catch(() => {});
    st.overlay.remove();
  }

  function isOpen(instanceId) { return !!state && state.instanceId === instanceId; }

  return { open, close, isOpen };
})();

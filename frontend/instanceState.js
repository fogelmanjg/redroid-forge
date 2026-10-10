// Pure logic of "what can be done with an instance in each state" (no DOM), so it can be
// tested from node (backend/test/instanceState.test.js) and used by app.js in the browser.
//
// `status` is the Docker container state that GET /api/instances reports
// (created | running | restarting | paused | removing | exited | dead) or 'missing', which
// the backend answers when the container no longer exists.
(function (root) {
  const STATES = {
    running:    { tone: 'ok',   actions: ['stop', 'restart', 'delete'] },
    restarting: { tone: 'warn', actions: ['stop', 'delete'] }, // stop breaks a restart loop
    paused:     { tone: 'warn', actions: ['stop', 'delete'] },
    created:    { tone: 'idle', actions: ['start', 'delete'] },
    exited:     { tone: 'idle', actions: ['start', 'delete'] },
    removing:   { tone: 'warn', actions: [] },
    dead:       { tone: 'fail', actions: ['delete'] },
    missing:    { tone: 'fail', actions: ['delete'] },
  };
  const UNKNOWN = { tone: 'warn', actions: ['delete'] };

  // -> { key, tone: 'ok'|'warn'|'fail'|'idle', actions: ['start'|'stop'|'restart'|'delete'] }
  function describe(status) {
    const known = STATES[status];
    const s = known || UNKNOWN;
    return { key: known ? status : 'unknown', tone: s.tone, actions: s.actions.slice() };
  }

  const api = { describe };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.InstanceState = api;
}(typeof window !== 'undefined' ? window : globalThis));

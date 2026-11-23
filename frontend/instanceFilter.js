// Which instances the Instances tab shows, and in what order (1.0.0-beta.9) -- pure logic, no DOM,
// so it can be tested from node (backend/test/instanceFilter.test.js) and used by app.js in the
// browser, same split as instanceState.js.
//
// The same filter applies to the three views (Full, Minimal, Viewers):
//   - state: 'all' | 'active' | 'stopped'. Active = running, restarting or paused (it is still
//     holding CPU/RAM); everything else counts as stopped.
//   - query: part of the name, case-insensitive.
//   - hideLocked: leaves out the locked instances.
// An instance in trouble (dead, container missing, an unknown state) or with a backup/restore in
// progress is "pinned": the state filter and hideLocked never hide it, so a crash or a running job
// cannot go unnoticed behind a filter. The name search does hide it -- typing a name is asking for
// that one.
//
// Order, in every view: active first, then the ones in trouble, then the rest; alphabetical
// (natural: "inst-2" before "inst-10") inside each group.
(function (root) {
  const ACTIVE = new Set(['running', 'restarting', 'paused']);
  const KNOWN_QUIET = new Set(['created', 'exited', 'removing']);
  const FILTERS = ['all', 'active', 'stopped'];

  function group(status) {
    return ACTIVE.has(status) ? 'active' : 'stopped';
  }

  function isProblem(status) {
    return !ACTIVE.has(status) && !KNOWN_QUIET.has(status);
  }

  function rank(inst) {
    if (ACTIVE.has(inst.status)) return 0;
    if (isProblem(inst.status)) return 1;
    return 2;
  }

  function byName(a, b) {
    return String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true, sensitivity: 'base' });
  }

  // -> { visible: [...], counts: { all, active, stopped } }
  // `counts` follow the search and hideLocked but not the state filter, so each button says how
  // many it would show.
  function apply(instances, { filter = 'all', query = '', hideLocked = false, busyIds = new Set() } = {}) {
    const state = FILTERS.includes(filter) ? filter : 'all';
    const q = String(query || '').trim().toLowerCase();
    const pinned = (inst) => isProblem(inst.status) || busyIds.has(inst.id);
    const base = (instances || []).filter((inst) => {
      if (q && !String(inst.name || '').toLowerCase().includes(q)) return false;
      if (hideLocked && inst.locked && !pinned(inst)) return false;
      return true;
    });
    const counts = { all: base.length, active: 0, stopped: 0 };
    for (const inst of base) counts[group(inst.status)]++;
    const visible = base
      .filter((inst) => state === 'all' || group(inst.status) === state || pinned(inst))
      .sort((a, b) => (rank(a) - rank(b)) || byName(a, b));
    return { visible, counts };
  }

  const api = { apply, group, isProblem, FILTERS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.InstanceFilter = api;
}(typeof window !== 'undefined' ? window : globalThis));

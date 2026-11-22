const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const { t, loc } = I18n;

function switchTab(name) {
  $$('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
  if (name === 'instances') loadInstances();
  if (name === 'modules') loadModules();
  if (name === 'user-modules') loadUserModulesTab();
  if (name === 'doctor') loadDoctor();
  if (name === 'settings') loadSettings();
  if (name === 'identities') loadIdentities();
}

$$('.tab-btn').forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

async function api(path, opts) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    // The session cookie expired or was never there (docs/ROADMAP.md Phase 7) -- the simplest
    // correct recovery is a reload, which re-runs AuthUi's own gate and shows the login dialog
    // again instead of this call's caller trying to render a now-stale, now-inaccessible UI.
    if (res.status === 401) { window.location.reload(); throw new Error('Session expired'); }
    const body = await res.json().catch(() => ({}));
    // status + modules (manifests pending acceptance, see moduleGate.js
    // in the backend) travel in the error so the caller can show the
    // contract modal without asking for it again.
    throw Object.assign(new Error(body.error || `HTTP ${res.status}`), {
      status: res.status,
      modules: body.modules,
    });
  }
  if (res.status === 204) return null;
  return res.json();
}

// Live "is this ADB port free?" check shared by the create dialog, the Configure panel and
// Settings' own range field -- all three talk to the same backend source of truth
// (portAllocator.js) through two thin endpoints (GET /instances/adb-port-check,
// GET /settings/adb-port-range-check), so this is wiring, not business logic. Debounced by a
// token (same "it was unticked while checking" race-guard shape as fileModuleOption further
// down, just generalized to "the input changed again before this reply came back") rather than
// a timer id, since a fast typist can fire several requests whose replies arrive out of order.
function wireLivePortCheck(input, warnEl, buildCheck) {
  let token = 0;
  let timer = null;
  const run = async () => {
    const mine = ++token;
    const result = await buildCheck(input.value).catch(() => null);
    if (mine !== token) return; // superseded by a later keystroke -- its own reply wins instead
    if (result) { warnEl.hidden = false; warnEl.textContent = result; } else { warnEl.hidden = true; warnEl.textContent = ''; }
  };
  input.addEventListener('input', () => {
    warnEl.hidden = true;
    clearTimeout(timer);
    timer = setTimeout(run, 400);
  });
  input.addEventListener('blur', () => { clearTimeout(timer); run(); });
}

// Matches the backend's own name rule (routes/instances.js, both at creation and at
// PUT /:id/name): lowercase letters, digits and hyphens, 1-40 chars, not starting with a
// hyphen. Rather than reject "cifi nuevo nuevo" outright, turn whitespace/underscores into
// hyphens and drop anything else not allowed -- the same one-time papercut otherwise hits both
// the create form and the rename field for the exact same rule.
function normalizeInstanceName(raw) {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 40);
}

// Copies text to the clipboard. navigator.clipboard only exists in a "secure context" (https or
// localhost): when the UI is opened by IP over plain http (e.g. through Tailscale) it is missing, so
// there is a fallback that uses a temporary textarea. Both have to be called from a user gesture.
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* falls through to the fallback */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

function androidIdCellHtml(inst) {
  if (!inst.hasGapps) return '<span class="muted">-</span>';
  if (!inst.androidId) return `<span class="muted">${t('instances.waitingBoot')}</span>`;
  if (inst.androidIdRegisteredAt) {
    return `<code>${inst.androidId}</code><br><span class="ok-text">${t('instances.registered')}</span>`;
  }
  const hoursLeft = Math.round(48 - (Date.now() - new Date(inst.createdAt).getTime()) / 3_600_000);
  const urgent = hoursLeft <= 12;
  return `
    <code>${inst.androidId}</code>
    <br>
    <span class="${urgent ? 'fail-text' : 'warn-text'}">
      ${t('instances.unregistered')}${hoursLeft > 0 ? ` (~${hoursLeft}h)` : t('instances.expired')}
    </span>
  `;
}

// Applies (profileValue='redroid') or reverts a device profile; handles the Phase 4 contract
// gate the same way createInstance does (428 + pending manifests -> show the modal -> retry once).
async function applyDeviceProfile(instanceId, profileValue) {
  const body = { profile: profileValue === 'redroid' ? undefined : profileValue };
  try {
    await api(`/instances/${instanceId}/device-profile`, { method: 'POST', body: JSON.stringify(body) });
  } catch (err) {
    if (err.status === 428 && err.modules) {
      const allAccepted = await Contracts.ensureAccepted(err.modules);
      if (allAccepted) return applyDeviceProfile(instanceId, profileValue);
      return;
    }
    throw err;
  }
}

// Unlike device profile (which needs the overlay writable, so only while running), Docker's own
// Update API accepts Memory/CpusetCpus changes regardless of the container's state -- no
// running-only gate here. No module contract gate either: cpu/RAM limits are plain Docker
// resource limits (HostConfig.Memory/CpusetCpus), the same thing any container orchestrator
// does -- nothing third-party, nothing touching the host beyond what Docker itself already
// does for every container, nothing worth a "read and accept" step.
async function applyResources(instanceId, { memoryMb, cpusetCpus }) {
  const body = {};
  if (memoryMb !== undefined) body.memoryMb = memoryMb;
  if (cpusetCpus !== undefined) body.cpusetCpus = cpusetCpus;
  await api(`/instances/${instanceId}/resources`, { method: 'POST', body: JSON.stringify(body) });
}

// Host core count, for the per-core checkbox grid (see buildResourcesEditRow) -- fetched once
// at startup (loadHostCoreCount, called near the bottom of this file), not on every table
// refresh. Falls back to 16 (this host's real count) if Doctor could not be reached yet.
let hostCoreCount = null;
async function loadHostCoreCount() {
  try {
    const checks = await api('/doctor');
    const cpu = checks.find((c) => c.id === 'cpu-count');
    hostCoreCount = cpu && typeof cpu.cores === 'number' ? cpu.cores : null;
  } catch { hostCoreCount = null; }
}

// Installed version: free (no network call -- see versionCheck.js) and shown on every load.
// Whether a newer one exists on GitHub is NEVER checked on its own, only by this button, right
// now, on demand -- see backend/src/routes/version.js's own comment for why.
let installedVersion = null;
async function loadInstalledVersion() {
  try {
    const { installed } = await api('/version');
    installedVersion = installed;
    $('#app-version').textContent = `v${installed}`;
  } catch { $('#app-version').textContent = ''; }
}

async function checkForNewerVersion() {
  const btn = $('#btn-version-check');
  const label = $('#app-version');
  btn.disabled = true;
  const prevLabel = label.textContent;
  label.textContent = t('version.checking');
  try {
    const r = await api('/version/check', { method: 'POST' });
    label.textContent = r.newer
      ? t('version.newer', { latest: r.latest, installed: r.installed })
      : t('version.upToDate', { version: r.installed });
    if (r.newer && r.url) label.title = r.url;
  } catch (e) {
    label.textContent = t('version.error', { error: e.message });
    setTimeout(() => { if (label.textContent === t('version.error', { error: e.message })) label.textContent = prevLabel; }, 5000);
  } finally {
    btn.disabled = false;
  }
}
$('#btn-version-check').addEventListener('click', checkForNewerVersion);

// Instances redesign (24/10/2026): every per-instance editable thing used to be its own
// chip-click-to-toggle panel (openResourcesId/openDisplayId/openCodecId/openWifiInternoId).
// Now there are only two edit panels, opened by two dedicated buttons in the secondary line --
// grouped by what applying them actually costs, not by what they edit:
//   - openNoRestartId: CPU/RAM (Docker's live Update API, nothing interrupted).
//   - openRestartId: resolution/DPI/FPS/GPU mode, hwenc/hwdec, internal WiFi (all go through
//     the same POST /:id/display recreate) and device profile (a different route, but it also
//     restarts/interrupts whatever's running) -- one panel, several sub-sections.
// Storage/backups keeps its own existing toggle (openStorageId) -- it edits DATA, not instance
// options, so it was deliberately left out of this split.
let openNoRestartId = null;
let openRestartId = null;
let openOwnersId = null;
// Same purpose as the others above but for the inline name edit (pencil next to the name,
// buildInstanceRow below): without this, the background auto-poll's loadInstances({silent:true})
// rebuilds the row mid-edit and silently throws away whatever the user had just typed.
let openRenameId = null;
// {id, username} for every known account/identity -- fetched lazily the first time the Owners
// panel opens (see its toggle button below), same pattern as userModulesCache/
// networkInterfacesCache for the other edit panels.
let directoryCache = null;

// Live preview toggle state (Hito 2 of the web viewer work), per user via localStorage -- default
// off for every instance: nobody pays the cost of a real scrcpy-server session (real encode on
// the device, even at 5fps) just for having opened the dashboard, per the plan's own decided
// "native capability, opt-in behavior" split. Persisted so a reload keeps whatever the user
// explicitly turned on, same spirit as I18n's own `lang` localStorage key.
function loadPreviewIds() {
  // 'ventanitaIds' is the same setting's key before the 21/11/2026 rename (ventanita -> live
  // preview): read it as a fallback so nobody loses the previews they had turned on.
  try {
    return new Set(JSON.parse(localStorage.getItem('previewIds') || localStorage.getItem('ventanitaIds') || '[]'));
  } catch (e) { return new Set(); }
}
function savePreviewIds(ids) {
  try { localStorage.setItem('previewIds', JSON.stringify(Array.from(ids))); } catch (e) { /* no storage: just won't persist across reloads */ }
}
let previewIds = loadPreviewIds();

// Instances tab view mode (15/11/2026) -- "full" (today's row-pair table, unchanged), "minimal"
// (name+address+actions only, for someone who, in the user's own words, "no quiere saber nada de
// nada"), "viewers" (a grid of live previews, one per instance). Persisted per browser, same
// spirit as previewIds/I18n's own `lang` key -- a reload keeps whichever view this user picked,
// not necessarily what anyone else using this dashboard prefers.
function loadInstanceViewMode() {
  const v = localStorage.getItem('instanceViewMode');
  return (v === 'minimal' || v === 'viewers') ? v : 'full';
}
function saveInstanceViewMode(mode) {
  try { localStorage.setItem('instanceViewMode', mode); } catch (e) { /* no storage: just won't persist */ }
}
let instanceViewMode = loadInstanceViewMode();

// Preview tile size for "viewers" mode only -- the slider's current value in px. Drives BOTH the
// CSS display size (.instances-grid .viewer-preview-img in style.css) AND, since 15/11/2026,
// the actual backend capture size (screenshotCapture.js, via Viewer.mountPreview's `size`
// argument and Viewer.setSize/setSizeAll for a live resize) -- stretching the old fixed ~80px
// capture past its native size with CSS alone just looked blurry, so the slider now asks the
// backend to capture bigger instead of faking it client-side. Clamped to the slider's own
// [60,400] range so a hand-edited/stale localStorage value can't push it absurdly large or to 0;
// the backend clamps independently too (screenshotCapture.js's own clampSize), since this value
// also travels over the wire and must not be trusted as-is there either.
function loadViewersSize() {
  const v = parseInt(localStorage.getItem('viewersSize'), 10);
  return (Number.isFinite(v) && v >= 60 && v <= 400) ? v : 200;
}
function saveViewersSize(px) {
  try { localStorage.setItem('viewersSize', String(px)); } catch (e) { /* no storage: just won't persist */ }
}
let viewersSize = loadViewersSize();

$$('.view-mode-btn').forEach((btn) => {
  btn.classList.toggle('active', btn.dataset.viewMode === instanceViewMode);
  btn.addEventListener('click', () => {
    if (btn.dataset.viewMode === instanceViewMode) return;
    instanceViewMode = btn.dataset.viewMode;
    saveInstanceViewMode(instanceViewMode);
    $$('.view-mode-btn').forEach((b) => b.classList.toggle('active', b === btn));
    loadInstances({ silent: true });
  });
});
const viewersSizeSlider = $('#viewers-size-slider');
viewersSizeSlider.value = viewersSize;
$('#instances-grid').style.setProperty('--live preview-size', `${viewersSize}px`);
viewersSizeSlider.addEventListener('input', () => {
  viewersSize = parseInt(viewersSizeSlider.value, 10);
  saveViewersSize(viewersSize);
  $('#instances-grid').style.setProperty('--live preview-size', `${viewersSize}px`);
  // Live, while dragging -- every card's own session gets the new capture size right away
  // (next tick, see screenshotCapture.js's own comment), not just on the next full reload.
  if (instanceViewMode === 'viewers') Viewer.setSizeAll(effectiveViewersSize());
});

// Per-row layout of the "viewers" grid (21/11/2026, 1.0.0-beta.2 -- the beta1 pending item "how
// many per row, or use the whole width"; both, as a choice): 'auto' keeps the original
// behaviour (as many cards per row as fit at the slider's size), a number lays the cards out in
// that many equal columns sharing the full width. In column mode the slider does not apply: each
// preview fills its column, and the backend is asked to capture at that real width (same reason
// the slider drives the capture size -- a small capture stretched by CSS just looks blurry).
// Persisted per browser like the view mode and the slider.
const VIEWERS_COLUMN_CHOICES = ['auto', '1', '2', '3', '4', '6'];
function loadViewersColumns() {
  let v = null;
  try { v = localStorage.getItem('viewersColumns'); } catch (e) { /* no storage */ }
  return VIEWERS_COLUMN_CHOICES.includes(v) ? v : 'auto';
}
let viewersColumns = loadViewersColumns();

// The capture size (short side, px) every live preview in the grid should ask the backend for.
function effectiveViewersSize() {
  if (viewersColumns === 'auto') return viewersSize;
  const grid = $('#instances-grid');
  const n = Number(viewersColumns);
  const gapPx = 16;   // .instances-grid gap: 1rem
  const cardPadPx = 24; // .instance-card padding 0.7rem on both sides + its 1px borders
  const colPx = (grid.clientWidth - gapPx * (n - 1)) / n - cardPadPx;
  // Same [60,480] range the backend clamps to anyway (screenshotCapture.js's clampSize).
  return Math.max(60, Math.min(480, Math.round(colPx)));
}

function applyViewersLayout() {
  const grid = $('#instances-grid');
  const fixed = viewersColumns !== 'auto';
  grid.classList.toggle('instances-grid-columns', fixed);
  grid.style.setProperty('--viewer-columns', fixed ? viewersColumns : '1');
  viewersSizeSlider.disabled = fixed;
}
const viewersColumnsSelect = $('#viewers-columns');
viewersColumnsSelect.value = viewersColumns;
applyViewersLayout();
viewersColumnsSelect.addEventListener('change', () => {
  viewersColumns = VIEWERS_COLUMN_CHOICES.includes(viewersColumnsSelect.value) ? viewersColumnsSelect.value : 'auto';
  try { localStorage.setItem('viewersColumns', viewersColumns); } catch (e) { /* no storage */ }
  applyViewersLayout();
  if (instanceViewMode === 'viewers') Viewer.setSizeAll(effectiveViewersSize());
});
// In column mode a window/panel resize changes every column's width: ask for the new capture
// size, debounced so dragging the window edge does not send a resize per pixel.
let viewersResizeTimer = null;
if (window.ResizeObserver) {
  new ResizeObserver(() => {
    if (viewersColumns === 'auto' || instanceViewMode !== 'viewers') return;
    clearTimeout(viewersResizeTimer);
    viewersResizeTimer = setTimeout(() => Viewer.setSizeAll(effectiveViewersSize()), 300);
  }).observe($('#instances-grid'));
}

async function loadDirectoryCache() {
  try {
    directoryCache = await api('/auth/directory');
  } catch {
    directoryCache = [];
  }
}

// "0,1,8,9" or "0-3" (Docker's own cpuset syntax, see instanceParams.js) -> Set of core
// numbers, for the checkbox grid and conflict detection below.
function parseCoreSet(str) {
  const set = new Set();
  if (!str) return set;
  for (const part of str.split(',')) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      for (let i = Number(range[1]); i <= Number(range[2]); i++) set.add(i);
    } else if (/^\d+$/.test(part)) {
      set.add(Number(part));
    }
  }
  return set;
}
function coreSetToCpuset(set) {
  return Array.from(set).sort((a, b) => a - b).join(',');
}

// Informational only now -- editing happens through the dedicated "Resources" button, which
// opens the shared no-restart panel (see openNoRestartId above). Two separate chips, same as
// before, just no click handler of their own any more.
function buildResourcesChips(inst) {
  const frag = document.createDocumentFragment();
  const mk = (text) => {
    const chip = document.createElement('span');
    chip.className = 'resource-chip';
    chip.textContent = text;
    return chip;
  };
  frag.appendChild(mk(`cpu: ${inst.cpusetCpus || t('instances.resources.noLimit')}`));
  frag.appendChild(mk(`ram: ${inst.memoryMb ? `${inst.memoryMb}MB` : t('instances.resources.noLimit')}`));
  return frag;
}

// The expandable panel a chip click opens, spanning the full table width -- same idea as
// jg-dashboard's "edit-row" (an inline panel in the table flow, not a modal). `allInstances`
// is only used to compute cpuset conflicts against the OTHER rows already loaded, nothing of
// its own is fetched here.
// Owners (who can see/use this instance -- a list since 25/10/2026, e.g. a household's shared
// TV instance) + createdId attribution (who the quota, backend's quotas.js, counts against) --
// docs/ROADMAP.md Phase 7. Pure metadata, no Docker/restart involved, so it is its own
// lightweight panel rather than grouped with Resources/Configure. `directory`: {id, username}
// pairs from GET /auth/directory, used to show real names instead of opaque ids.
function buildOwnersEditRow(inst, directory) {
  const tr = document.createElement('tr');
  tr.className = 'edit-row';
  const td = document.createElement('td');
  td.colSpan = 1;
  const panel = document.createElement('div');
  panel.className = 'resources-edit-panel';

  const byId = new Map((directory || []).map((d) => [d.id, d.username]));
  const nameOf = (id) => byId.get(id) || id;
  const owners = inst.ownerId || [];

  const ownersHeader = document.createElement('div');
  ownersHeader.className = 'resources-edit-header';
  ownersHeader.textContent = t('instances.owners.header');
  panel.appendChild(ownersHeader);

  const list = document.createElement('ul');
  list.className = 'doctor-list';
  for (const ownerId of owners) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = nameOf(ownerId);
    li.appendChild(span);
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'secondary';
    rm.textContent = t('instances.owners.remove');
    rm.disabled = owners.length <= 1; // never allowed to leave the list empty
    rm.title = rm.disabled ? t('instances.owners.lastOwnerHint') : '';
    rm.addEventListener('click', async () => {
      try {
        await api(`/instances/${inst.id}/owners`, {
          method: 'PUT',
          body: JSON.stringify({ ownerIds: owners.filter((id) => id !== ownerId) }),
        });
        await loadInstances({ silent: true });
      } catch (e) {
        alert(e.message);
      }
    });
    li.appendChild(rm);
    list.appendChild(li);
  }
  if (owners.length === 0) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = t('instances.owners.none');
    list.appendChild(li);
  }
  panel.appendChild(list);

  const addRow = document.createElement('div');
  const select = document.createElement('select');
  const blankOpt = document.createElement('option');
  blankOpt.value = '';
  blankOpt.textContent = t('instances.owners.addPlaceholder');
  select.appendChild(blankOpt);
  for (const d of directory || []) {
    if (owners.includes(d.id)) continue;
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = d.username;
    select.appendChild(opt);
  }
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'secondary';
  addBtn.textContent = t('instances.owners.add');
  addBtn.addEventListener('click', async () => {
    if (!select.value) return;
    try {
      await api(`/instances/${inst.id}/owners`, {
        method: 'PUT',
        body: JSON.stringify({ ownerIds: [...owners, select.value] }),
      });
      await loadInstances({ silent: true });
    } catch (e) {
      alert(e.message);
    }
  });
  addRow.appendChild(select);
  addRow.appendChild(addBtn);
  panel.appendChild(addRow);

  // createdId -- who the quota counts against (never who can see/use it, that is ownerId just
  // above). An operator can only claim it for THEMSELVES, and only because they already have
  // "transfer-ownership" on this instance (gated the same way the panel's own toggle button is);
  // admin can attribute it to anyone in the directory, including themselves (the "rescue" case
  // that exempts an instance from every quota from then on -- see quotas.js's own comment).
  const createdHeader = document.createElement('div');
  createdHeader.className = 'resources-edit-header';
  createdHeader.textContent = t('instances.owners.createdByHeader');
  panel.appendChild(createdHeader);
  const createdP = document.createElement('p');
  createdP.className = 'muted';
  createdP.textContent = t('instances.owners.createdByCurrent', { name: inst.createdId ? nameOf(inst.createdId) : t('instances.owners.nobody') });
  panel.appendChild(createdP);

  const me = AuthUi.currentUser();
  if (me && me.role === 'admin') {
    const adminSelect = document.createElement('select');
    for (const d of directory || []) {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.username;
      opt.selected = d.id === inst.createdId;
      adminSelect.appendChild(opt);
    }
    adminSelect.addEventListener('change', async () => {
      try {
        await api(`/instances/${inst.id}/created-by`, { method: 'PUT', body: JSON.stringify({ createdId: adminSelect.value }) });
        await loadInstances({ silent: true });
      } catch (e) {
        alert(e.message);
        adminSelect.value = inst.createdId || '';
      }
    });
    panel.appendChild(adminSelect);
  } else if (me && inst.createdId !== me.id && owners.includes(me.id)) {
    const claimBtn = document.createElement('button');
    claimBtn.type = 'button';
    claimBtn.className = 'secondary';
    claimBtn.textContent = t('instances.owners.claim');
    claimBtn.addEventListener('click', async () => {
      try {
        await api(`/instances/${inst.id}/created-by`, { method: 'PUT', body: JSON.stringify({ createdId: me.id }) });
        await loadInstances({ silent: true });
      } catch (e) {
        alert(e.message);
      }
    });
    panel.appendChild(claimBtn);
  }

  td.appendChild(panel);
  tr.appendChild(td);
  return tr;
}

function buildResourcesEditRow(inst, allInstances) {
  const tr = document.createElement('tr');
  tr.className = 'edit-row';
  const td = document.createElement('td');
  td.colSpan = 1;
  const panel = document.createElement('div');
  panel.className = 'resources-edit-panel';

  // --- CPU affinity: a checkbox per core, never free text a user has to get the syntax of
  // right by hand -- and a live warning if the selection overlaps a core another instance
  // already has, the same conflict check jg-dashboard's panel does.
  const cpuHeader = document.createElement('div');
  cpuHeader.className = 'resources-edit-header';
  cpuHeader.textContent = t('instances.resources.cpuHeader');
  panel.appendChild(cpuHeader);

  const selected = parseCoreSet(inst.cpusetCpus);
  const othersUsing = new Map(); // core number -> [instance names using it]
  for (const other of allInstances) {
    if (other.id === inst.id || !other.cpusetCpus) continue;
    for (const core of parseCoreSet(other.cpusetCpus)) {
      if (!othersUsing.has(core)) othersUsing.set(core, []);
      othersUsing.get(core).push(other.name);
    }
  }

  // SMT pairing: on this host's convention (confirmed by the user on a 5700G, but it's the
  // standard Linux x86 SMT enumeration in general, Intel included) logical core N and N+half
  // are two threads of the SAME physical core, sharing part of its circuitry -- core 0 shares
  // with 8, 1 with 9, and so on up to half-1 with hostCoreCount-1. Laid out flat (flex-wrap)
  // this pairing was invisible; placed on an explicit CSS grid with one column per physical
  // core and one row per thread, core N sits directly above N+half so the shared pair is
  // visually obvious instead of having to do the arithmetic by eye.
  const half = Math.ceil((hostCoreCount || 16) / 2);
  const grid = document.createElement('div');
  grid.className = 'resources-cpu-grid';
  grid.style.gridTemplateColumns = `repeat(${half}, auto)`;
  const warnBox = document.createElement('div');
  function renderWarnings() {
    warnBox.innerHTML = '';
    if (selected.size === 0) {
      const w = document.createElement('div');
      w.className = 'resources-warn resources-warn-error';
      w.textContent = t('instances.resources.pickAtLeastOne');
      warnBox.appendChild(w);
    }
    const coresByConflictingName = new Map();
    for (const core of selected) {
      for (const name of (othersUsing.get(core) || [])) {
        if (!coresByConflictingName.has(name)) coresByConflictingName.set(name, []);
        coresByConflictingName.get(name).push(core);
      }
    }
    for (const [name, cores] of coresByConflictingName) {
      const w = document.createElement('div');
      w.className = 'resources-warn resources-warn-error';
      w.textContent = t('instances.resources.conflict', { cores: cores.join(', '), name });
      warnBox.appendChild(w);
    }
  }
  for (let i = 0; i < (hostCoreCount || 16); i++) {
    const label = document.createElement('label');
    label.className = 'resources-core-check';
    label.style.gridColumn = String((i % half) + 1);
    label.style.gridRow = String(Math.floor(i / half) + 1);
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = selected.has(i);
    chk.addEventListener('change', () => {
      if (chk.checked) selected.add(i); else selected.delete(i);
      renderWarnings();
    });
    label.appendChild(chk);
    label.appendChild(document.createTextNode(String(i)));
    grid.appendChild(label);
  }
  panel.appendChild(grid);
  renderWarnings();
  panel.appendChild(warnBox);

  // --- RAM: unlike cpuset, raising it is always a plain Docker live update. Lowering a RUNNING
  // container's memory.max means the kernel has to reclaim pages the instance is already using
  // right now -- confirmed for real against jg-dashboard (user tested it directly): it also just
  // calls Docker's live update for a lower value, no separate recreate path despite its own UI
  // text -- and in practice it does not take effect while running (the call is wrapped in
  // try/catch there and the failure is only logged, never surfaced, which from the UI looks
  // exactly like "no me deja bajarla"). So here: raising while running goes straight through;
  // lowering while running is confirmed first, then done as stop -> apply -> start (both values
  // just become the next start()'s container creation, no live-update risk at all) -- never a
  // silent attempt the user can't tell failed.
  const ramHeader = document.createElement('div');
  ramHeader.className = 'resources-edit-header';
  ramHeader.textContent = t('instances.resources.ramHeader');
  panel.appendChild(ramHeader);

  const ramInput = document.createElement('input');
  ramInput.type = 'number';
  ramInput.min = '1024'; // starting point, not 256: redroid under 1 GB is not a realistic choice
  ramInput.max = '65536';
  ramInput.step = '256'; // matches jg-dashboard's rd-input-sm
  ramInput.placeholder = t('instances.resources.ramNoLimit');
  ramInput.value = inst.memoryMb || '';
  panel.appendChild(ramInput);
  panel.appendChild(document.createTextNode(' MB'));

  if (inst.status === 'running') {
    const ramHint = document.createElement('div');
    ramHint.className = 'resources-warn';
    ramHint.textContent = t('instances.resources.ramLowerHint');
    panel.appendChild(ramHint);
  }

  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'secondary';
  applyBtn.textContent = t('instances.resources.apply');
  applyBtn.addEventListener('click', async () => {
    if (selected.size === 0) return;
    const memoryMb = ramInput.value === '' ? undefined : Number(ramInput.value);
    const lowering = memoryMb !== undefined && !!inst.memoryMb && memoryMb < inst.memoryMb;
    if (lowering && inst.status === 'running' && !confirm(t('instances.resources.ramLowerConfirm'))) return;
    applyBtn.disabled = true;
    try {
      if (lowering && inst.status === 'running') {
        await api(`/instances/${inst.id}/stop`, { method: 'POST' });
        await applyResources(inst.id, { cpusetCpus: coreSetToCpuset(selected), memoryMb });
        await api(`/instances/${inst.id}/start`, { method: 'POST' });
      } else {
        await applyResources(inst.id, { cpusetCpus: coreSetToCpuset(selected), memoryMb });
      }
      openNoRestartId = null;
      await loadInstances({ silent: true });
    } catch (e) {
      alert(e.message);
      applyBtn.disabled = false;
    }
  });
  panel.appendChild(applyBtn);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = t('common.cancel');
  cancelBtn.addEventListener('click', () => {
    openNoRestartId = null;
    loadInstances({ silent: true });
  });
  panel.appendChild(cancelBtn);

  td.appendChild(panel);
  tr.appendChild(td);
  return tr;
}

// width/height/dpi/fps/gpuMode/hwenc/hwdec/wifi-interno all go through the same POST
// /:id/display route (see routes/instances.js) -- there is no live-update path for any of
// them, changing one always means a real recreate (/data is preserved, the container itself
// is not). One payload, one 428 + pending-manifests -> modal -> retry gate, shared by the
// merged restart panel below (replaces the old separate applyDisplay/applyCodec, which only
// differed in which fields of the same body they set).
async function applyInstanceConfig(instanceId, payload) {
  try {
    await api(`/instances/${instanceId}/display`, { method: 'POST', body: JSON.stringify(payload) });
  } catch (err) {
    if (err.status === 428 && err.modules) {
      const allAccepted = await Contracts.ensureAccepted(err.modules);
      if (allAccepted) return applyInstanceConfig(instanceId, payload);
      return;
    }
    throw err;
  }
}

// Informational chips for the secondary line -- no click handlers of their own any more.
// Editing all three (plus device profile) happens through the single "Configure" button, which
// opens buildRestartEditRow below.
function buildDisplayChip(inst) {
  if (!inst.display) return null;
  const d = inst.display;
  const chip = document.createElement('span');
  chip.className = 'resource-chip';
  chip.textContent = `${d.width}×${d.height} · ${d.dpi} dpi · ${d.fps} fps${inst.gpuMode ? ` · gpu:${inst.gpuMode}` : ''}`;
  return chip;
}
function buildCodecChips(inst) {
  const frag = document.createDocumentFragment();
  const ids = inst.requiredModuleIds || [];
  const mk = (label, mechanism) => {
    const chip = document.createElement('span');
    chip.className = 'resource-chip';
    chip.textContent = `${label}: ${mechanism}`;
    return chip;
  };
  const encodeMechanism = ids.includes('nvenc') ? 'nvenc' : ids.includes('hwenc') ? 'hwenc' : 'soft';
  frag.appendChild(mk('encode', encodeMechanism));
  frag.appendChild(mk('decode', ids.includes('hwdec') ? 'hwdec' : 'soft'));
  return frag;
}
function buildWifiInternoChip(inst) {
  const ids = inst.requiredModuleIds || [];
  const activeVirt = ids.includes('wifi-interno-virtwifi');
  const active = ids.includes('wifi-interno') || activeVirt;
  const chip = document.createElement('span');
  chip.className = 'resource-chip';
  chip.textContent = t(activeVirt ? 'instances.wifiInterno.onVirt' : (active ? 'instances.wifiInterno.on' : 'instances.wifiInterno.off'));
  return chip;
}
function buildDeviceProfileChip(inst) {
  const current = inst.deviceProfile || 'redroid';
  const chip = document.createElement('span');
  chip.className = 'resource-chip';
  chip.textContent = `profile: ${current === 'redroid' ? t('instances.deviceProfile.default') : current}`;
  return chip;
}
function buildNetworkChip(inst) {
  const hosts = inst.bindHosts && inst.bindHosts.length ? inst.bindHosts : ['127.0.0.1'];
  const localOnly = hosts.every((h) => h === '127.0.0.1' || h === '::1');
  const chip = document.createElement('span');
  chip.className = `resource-chip${localOnly ? '' : ' resource-chip-warn'}`;
  chip.textContent = `net: ${hosts.join(', ')}`;
  chip.title = localOnly ? t('instances.network.localOnlyHint') : t('instances.network.exposedHint');
  return chip;
}

// The one panel for everything that interrupts the instance to apply (recreate: display/gpu
// mode/hwenc/hwdec/wifi-interno -- restart: device profile). Replaces the four previously
// separate chip-toggle panels (buildDisplayEditRow/buildCodecEditRow/buildWifiInternoEditRow/
// the device-profile select) with one panel, several sub-sections, opened by the single
// "Configure" button -- all sub-sections are visible at once, no further nested toggles.
function buildRestartEditRow(inst) {
  const tr = document.createElement('tr');
  tr.className = 'edit-row';
  const td = document.createElement('td');
  td.colSpan = 1;
  const panel = document.createElement('div');
  panel.className = 'resources-edit-panel';

  const recreateHeader = document.createElement('div');
  recreateHeader.className = 'resources-edit-header';
  recreateHeader.textContent = t('instances.configure.recreateHeader');
  panel.appendChild(recreateHeader);

  // --- Screen & GPU mode ---
  const screenHeader = document.createElement('div');
  screenHeader.className = 'resources-edit-header';
  screenHeader.textContent = t('instances.configure.screenHeader');
  panel.appendChild(screenHeader);

  const grid = document.createElement('div');
  grid.className = 'display-edit-grid';
  const d = inst.display || {};
  const fields = [
    ['width', t('new.width'), d.width, 240, 7680],
    ['height', t('new.height'), d.height, 240, 7680],
    ['dpi', t('new.dpi'), d.dpi, 72, 640],
    ['fps', t('new.fps'), d.fps, 1, 120],
  ];
  const inputs = {};
  for (const [key, label, value, min, max] of fields) {
    const wrap = document.createElement('label');
    wrap.className = 'display-edit-field';
    const span = document.createElement('span');
    span.textContent = label;
    const input = document.createElement('input');
    input.type = 'number';
    input.min = String(min);
    input.max = String(max);
    input.value = value ?? '';
    inputs[key] = input;
    wrap.appendChild(span);
    wrap.appendChild(input);
    grid.appendChild(wrap);
  }
  panel.appendChild(grid);

  // --- ADB port: same family as width/height/etc above (Docker's PortBindings are immutable
  // once a container exists, so this also always means a recreate) -- but kept as its own
  // field, not folded into `fields`/`grid`, since it needs the live free/taken check the
  // display fields don't (wireLivePortCheck, shared with the create dialog and Settings).
  const adbPortWrap = document.createElement('label');
  adbPortWrap.className = 'display-edit-field';
  const adbPortSpan = document.createElement('span');
  adbPortSpan.textContent = t('instances.adbPort.label');
  const adbPortInput = document.createElement('input');
  adbPortInput.type = 'number';
  adbPortInput.min = '1';
  adbPortInput.max = '65535';
  adbPortInput.value = inst.adbPort ?? '';
  adbPortWrap.appendChild(adbPortSpan);
  adbPortWrap.appendChild(adbPortInput);
  panel.appendChild(adbPortWrap);
  const adbPortWarn = document.createElement('p');
  adbPortWarn.className = 'resources-warn-error';
  adbPortWarn.hidden = true;
  panel.appendChild(adbPortWarn);
  wireLivePortCheck(adbPortInput, adbPortWarn, async (value) => {
    const port = Number(value);
    if (!value || port === inst.adbPort) return null; // unchanged, or momentarily empty while editing
    const status = await api(`/instances/adb-port-check?port=${port}&excludeInstanceId=${inst.id}`);
    if (status.free) return null;
    return status.usedBy === 'host'
      ? t('instances.adbPort.inUseHost')
      : t('instances.adbPort.inUseInstance', { name: status.usedBy.slice('instance:'.length) });
  });

  const gpuWrap = document.createElement('label');
  gpuWrap.className = 'display-edit-field';
  const gpuSpan = document.createElement('span');
  gpuSpan.textContent = t('new.gpuMode');
  const gpuSelect = document.createElement('select');
  for (const [value, text] of [['host', t('new.gpuModeHost')], ['guest', t('new.gpuModeGuest')]]) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = text;
    if (value === inst.gpuMode) opt.selected = true;
    gpuSelect.appendChild(opt);
  }
  gpuWrap.appendChild(gpuSpan);
  gpuWrap.appendChild(gpuSelect);
  panel.appendChild(gpuWrap);
  const gpuModeNote = document.createElement('p');
  gpuModeNote.className = 'muted';
  gpuModeNote.textContent = t('new.gpuModeNote');
  panel.appendChild(gpuModeNote);

  const ids = inst.requiredModuleIds || [];
  const checks = {};

  // venus3d: real 3D acceleration, part of what gpuMode=host means on this GPU rather than a
  // separate capability -- placed right under the gpuMode select for that reason, above encode.
  // Stays opt-in (never forced/auto-checked, same "explicit informed choice" reasoning as
  // hwdec/hwenc below) -- NOT blocked when unticked on host either, since deliberately
  // reproducing/diagnosing the broken path is a legitimate reason to pick that combination on
  // purpose. On an NVIDIA host specifically, plain gpuMode=host without it is a known-broken
  // combination (stock GBM/Mesa gralloc crash-loops SurfaceFlinger, see the module's own
  // README), so it gets a loud red warning instead of silence. Disabled-but-visible in guest
  // mode (not hidden) -- same convention as every other gpuMode-gated option here, so its own
  // state doesn't silently vanish out of the panel.
  const venus3dWrap = document.createElement('label');
  venus3dWrap.className = 'display-edit-field';
  venus3dWrap.style.flexDirection = 'row';
  const venus3dChk = document.createElement('input');
  venus3dChk.type = 'checkbox';
  venus3dChk.checked = ids.includes('venus3d');
  checks.venus3d = venus3dChk;
  venus3dWrap.appendChild(venus3dChk);
  venus3dWrap.appendChild(document.createTextNode(t('new.venus3d')));
  panel.appendChild(venus3dWrap);
  const venus3dStatus = document.createElement('p');
  venus3dStatus.hidden = true;
  panel.appendChild(venus3dStatus);

  function refreshVenus3dStatus() {
    if (gpuSelect.value !== 'host') {
      venus3dStatus.hidden = false;
      venus3dStatus.className = 'resources-warn';
      venus3dStatus.textContent = t('new.venus3dNeedsHost');
      return;
    }
    if (checks.venus3d.checked) { venus3dStatus.hidden = true; return; }
    api(`/modules/venus3d?imageId=${encodeURIComponent(inst.imageId)}`).then((m) => {
      venus3dStatus.hidden = !(gpuSelect.value === 'host' && !checks.venus3d.checked && m.hostCompatible);
      venus3dStatus.className = 'resources-warn resources-warn-error';
      venus3dStatus.textContent = t('new.venus3dRecommendedWarn');
    }).catch(() => { venus3dStatus.hidden = true; });
  }
  checks.venus3d.addEventListener('change', refreshVenus3dStatus);

  // --- Hardware encode/decode ---
  const codecHeader = document.createElement('div');
  codecHeader.className = 'resources-edit-header';
  codecHeader.textContent = t('instances.configure.codecHeader');
  panel.appendChild(codecHeader);

  // Encode: same mutually-exclusive-by-vendor select as the new-instance dialog (see
  // updateEncodeSelect) -- this instance's own imageId/hwEncCapable are already on `inst`
  // (set at creation, routes/instances.js), no catalog lookup needed.
  const encodeWrap = document.createElement('label');
  encodeWrap.className = 'display-edit-field';
  const encodeSpan = document.createElement('span');
  encodeSpan.textContent = t('new.encodeLabel');
  const encodeSelect = document.createElement('select');
  for (const [value, textKey] of [['', 'new.encodeNone'], ['hwenc', 'new.encodeHwenc'], ['nvenc', 'new.nvenc']]) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = t(textKey);
    encodeSelect.appendChild(opt);
  }
  const optHwenc = encodeSelect.options[1];
  const optNvenc = encodeSelect.options[2];
  encodeSelect.value = ids.includes('nvenc') ? 'nvenc' : ids.includes('hwenc') ? 'hwenc' : '';
  encodeWrap.appendChild(encodeSpan);
  encodeWrap.appendChild(encodeSelect);
  panel.appendChild(encodeWrap);
  const encodeStatus = document.createElement('p');
  encodeStatus.className = 'muted';
  encodeStatus.hidden = true;
  panel.appendChild(encodeStatus);

  // nvenc + venus3d together is a known-broken combination (01/11/2026 -- crashed the Android
  // guest's own system_server under load, root cause not yet found) -- see the matching comment
  // in the new-instance dialog's refreshNvencVenus3dWarn for the full reasoning. Not blocked,
  // just flagged.
  const nvencVenus3dWarn = document.createElement('p');
  nvencVenus3dWarn.className = 'resources-warn resources-warn-error';
  nvencVenus3dWarn.textContent = t('new.nvencVenus3dWarn');
  nvencVenus3dWarn.hidden = true;
  panel.appendChild(nvencVenus3dWarn);
  function refreshNvencVenus3dWarn() {
    nvencVenus3dWarn.hidden = !(encodeSelect.value === 'nvenc' && checks.venus3d.checked);
  }
  encodeSelect.addEventListener('change', refreshNvencVenus3dWarn);
  checks.venus3d.addEventListener('change', refreshNvencVenus3dWarn);

  // Decode (hwdec): no vendor split -- the same module id works on AMD/Intel (VA-API) and
  // NVIDIA (NVDEC), both only via gpuMode=host.
  const codecWarn = document.createElement('div');
  codecWarn.className = 'resources-warn';
  codecWarn.textContent = t('instances.codec.needsHost');
  panel.appendChild(codecWarn);
  const hwdecWrap = document.createElement('label');
  hwdecWrap.className = 'display-edit-field';
  hwdecWrap.style.flexDirection = 'row';
  const hwdecChk = document.createElement('input');
  hwdecChk.type = 'checkbox';
  hwdecChk.checked = ids.includes('hwdec');
  checks.hwdec = hwdecChk;
  hwdecWrap.appendChild(hwdecChk);
  hwdecWrap.appendChild(document.createTextNode(t('new.hwdec')));
  panel.appendChild(hwdecWrap);

  // Mirrors the "new instance" form: a module requiring a specific gpuMode must not stay
  // checkable/selectable once the select is switched away from it, instead of only warning
  // and letting the apply fail server-side with a 409 from moduleGate.check.
  function refreshCodecAvailability() {
    const needsHost = gpuSelect.value !== 'host';
    codecWarn.hidden = !needsHost;
    checks.hwdec.disabled = needsHost;
    if (needsHost) checks.hwdec.checked = false;
    checks.venus3d.disabled = needsHost;
    if (needsHost) checks.venus3d.checked = false;
    refreshVenus3dStatus();
    updateEncodeSelect({
      select: encodeSelect, optHwenc, optNvenc, status: encodeStatus,
      imageId: inst.imageId, hwEncCapable: inst.hwEncCapable, gpuMode: gpuSelect.value,
    }).then(refreshNvencVenus3dWarn);
  }
  gpuSelect.addEventListener('change', refreshCodecAvailability);
  refreshCodecAvailability();

  // --- Internal WiFi ---
  const wifiHeader = document.createElement('div');
  wifiHeader.className = 'resources-edit-header';
  wifiHeader.textContent = t('instances.configure.wifiHeader');
  panel.appendChild(wifiHeader);

  const wifiWrap = document.createElement('label');
  wifiWrap.className = 'display-edit-field';
  wifiWrap.style.flexDirection = 'row';
  const wifiChk = document.createElement('input');
  wifiChk.type = 'checkbox';
  wifiChk.checked = ids.includes('wifi-interno');
  wifiWrap.appendChild(wifiChk);
  wifiWrap.appendChild(document.createTextNode(t('instances.wifiInterno.label')));
  panel.appendChild(wifiWrap);

  // --- Network: which host interfaces this instance's ADB port binds to (docs/ROADMAP.md
  // Phase 6). Multi-select for any combination of specific addresses (e.g. localhost and a
  // Tailscale IP together) -- except "All interfaces (0.0.0.0)", which is not additive with
  // anything else: confirmed live that Docker either rejects binding 0.0.0.0 and a specific
  // address on the same port at once, or worse, silently publishes no port at all. Checking it
  // disables (and the backend independently collapses) every other option, so the UI never
  // promises a combination that cannot actually work. `redroid` itself has no access control,
  // so anything beyond localhost gets a visible warning that updates live, never a hard block.
  const netHeader = document.createElement('div');
  netHeader.className = 'resources-edit-header';
  netHeader.textContent = t('instances.configure.networkHeader');
  panel.appendChild(netHeader);

  const currentBindHosts = inst.bindHosts && inst.bindHosts.length ? inst.bindHosts : ['127.0.0.1'];
  const netOptions = [{ address: '127.0.0.1', label: t('instances.network.localhost') }];
  for (const i of (networkInterfacesCache || [])) {
    if (i.address === '127.0.0.1' || i.internal) continue;
    netOptions.push({ address: i.address, label: `${i.iface} (${i.address})` });
  }
  netOptions.push({ address: '0.0.0.0', label: t('instances.network.allInterfaces') });

  const netChecks = [];
  for (const opt of netOptions) {
    const wrap = document.createElement('label');
    wrap.className = 'display-edit-field';
    wrap.style.flexDirection = 'row';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = currentBindHosts.includes(opt.address);
    netChecks.push({ address: opt.address, chk });
    wrap.appendChild(chk);
    wrap.appendChild(document.createTextNode(opt.label));
    panel.appendChild(wrap);
  }
  const allIfacesCheck = netChecks.find(({ address }) => address === '0.0.0.0');
  const updateNetExclusivity = () => {
    const allChecked = allIfacesCheck.chk.checked;
    for (const { address, chk } of netChecks) {
      if (address === '0.0.0.0') continue;
      chk.disabled = allChecked;
      if (allChecked) chk.checked = false;
    }
  };
  allIfacesCheck.chk.addEventListener('change', updateNetExclusivity);
  updateNetExclusivity();

  const netWarn = document.createElement('div');
  netWarn.className = 'resources-warn resources-warn-error';
  netWarn.textContent = t('instances.network.warnExposed');
  const updateNetWarn = () => {
    const anyNonLocal = netChecks.some(({ address, chk }) => chk.checked && address !== '127.0.0.1');
    netWarn.style.display = anyNonLocal ? '' : 'none';
  };
  for (const { chk } of netChecks) chk.addEventListener('change', updateNetWarn);
  updateNetWarn();
  panel.appendChild(netWarn);

  // --- Port-knocking (docs/ROADMAP.md Phase 9): per bound interface (localhost/wildcard
  // excluded -- see instanceParams.parseKnockRequiredHosts for why), whether the ADB port
  // requires a knock before it answers at all. Applied together with everything else below
  // (single "Apply" button) even though, unlike bindHosts, this alone never needs a container
  // recreate (lib/fwknop.js) -- two "Apply"/"Guardar" buttons on the same panel was the exact
  // confusion already fixed once for device profile; no reason to leave a second one here.
  const knockHeader = document.createElement('div');
  knockHeader.className = 'resources-edit-header';
  knockHeader.textContent = t('instances.knock.header');
  panel.appendChild(knockHeader);

  const currentKnockHosts = new Set(inst.knockRequiredHosts || []);
  const knockChecks = [];
  for (const host of currentBindHosts) {
    if (['127.0.0.1', '::1', '0.0.0.0', '::'].includes(host)) continue;
    const wrap = document.createElement('label');
    wrap.className = 'display-edit-field';
    wrap.style.flexDirection = 'row';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = currentKnockHosts.has(host);
    knockChecks.push({ address: host, chk });
    wrap.appendChild(chk);
    wrap.appendChild(document.createTextNode(t('instances.knock.requireLabel', { address: host })));
    panel.appendChild(wrap);
  }

  // Opening access itself is a routine, frequent action (every time someone wants to
  // connect), not a configuration change -- it lives in its own top-level row
  // (buildAdbAccessEditRow, next to the "Storage" button) instead of here. This panel only
  // ever decides WHICH interfaces are gated at all, which is the rare, admin-y part -- saved
  // by the single "Apply" button further down, not its own button.

  // --- Optional modules: gapps/arm-translation (hardcoded, same as the create form) plus
  // whatever stage-7 "user modules" the catalog has (CIFI today, see loadUserModulesCache) --
  // full parity with what the create form already lets you choose, just reachable after the
  // fact too. wifi-interno-virtwifi (EXPERIMENTAL) has no checkbox here either, same as
  // creation -- preserved automatically below instead of silently dropped.
  const modulesHeader = document.createElement('div');
  modulesHeader.className = 'resources-edit-header';
  modulesHeader.textContent = t('instances.configure.modulesHeader');
  panel.appendChild(modulesHeader);

  const gappsWrap = document.createElement('label');
  gappsWrap.className = 'display-edit-field';
  gappsWrap.style.flexDirection = 'row';
  const gappsChk = document.createElement('input');
  gappsChk.type = 'checkbox';
  gappsChk.checked = ids.includes('gapps');
  gappsWrap.appendChild(gappsChk);
  gappsWrap.appendChild(document.createTextNode(t('new.gapps')));
  panel.appendChild(gappsWrap);

  const armWrap = document.createElement('label');
  armWrap.className = 'display-edit-field';
  armWrap.style.flexDirection = 'row';
  const armChk = document.createElement('input');
  armChk.type = 'checkbox';
  armChk.checked = ids.includes('arm-translation');
  armWrap.appendChild(armChk);
  armWrap.appendChild(document.createTextNode(t('new.arm')));
  panel.appendChild(armWrap);

  const auroraWrap = document.createElement('label');
  auroraWrap.className = 'display-edit-field';
  auroraWrap.style.flexDirection = 'row';
  const auroraChk = document.createElement('input');
  auroraChk.type = 'checkbox';
  auroraChk.checked = ids.includes('aurora-store');
  auroraWrap.appendChild(auroraChk);
  auroraWrap.appendChild(document.createTextNode(t('new.auroraStore')));
  panel.appendChild(auroraWrap);

  const userModuleChecks = [];
  for (const m of (userModulesCache || [])) {
    const wrap = document.createElement('label');
    wrap.className = 'display-edit-field';
    wrap.style.flexDirection = 'row';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = ids.includes(m.id);
    userModuleChecks.push({ id: m.id, chk });
    wrap.appendChild(chk);
    wrap.appendChild(document.createTextNode(loc(m, 'nombre')));
    panel.appendChild(wrap);
  }

  // --- Device profile: a different backend route (restarts the container instead of
  // recreating it) than the resources/modules/network payload below, but both now apply from
  // the single button further down -- having two separate "Apply" buttons on the same panel
  // (one general, one device-profile-only) was confusing and gave no indication of which one
  // covered what. Only called when actually changed, so picking "no change" never forces an
  // extra restart on top of whatever the main payload already triggers.
  const profileHeader = document.createElement('div');
  profileHeader.className = 'resources-edit-header';
  profileHeader.textContent = t('instances.deviceProfile.header');
  panel.appendChild(profileHeader);

  const current = inst.deviceProfile || 'redroid';
  const profileSelect = document.createElement('select');
  for (const [value, text] of [['redroid', t('instances.deviceProfile.default')], ['samsung', 'Samsung Galaxy A55']]) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = text;
    if (value === current) opt.selected = true;
    profileSelect.appendChild(opt);
  }
  panel.appendChild(profileSelect);

  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'secondary';
  applyBtn.textContent = t('instances.resources.apply');
  applyBtn.addEventListener('click', async () => {
    if (inst.status === 'running' && !confirm(t('instances.display.confirmRunning'))) return;
    const modules = ids.filter((id) => id === 'wifi-interno-virtwifi');
    if (encodeSelect.value) modules.push(encodeSelect.value);
    if (checks.hwdec.checked) modules.push('hwdec');
    if (checks.venus3d.checked) modules.push('venus3d');
    if (wifiChk.checked) modules.push('wifi-interno');
    if (gappsChk.checked) modules.push('gapps');
    if (armChk.checked) modules.push('arm-translation');
    if (auroraChk.checked) modules.push('aurora-store');
    for (const { id, chk } of userModuleChecks) if (chk.checked) modules.push(id);
    const bindHosts = netChecks.filter(({ chk }) => chk.checked).map(({ address }) => address);
    // Checked BEFORE disabling the button/calling the API -- this is a form mistake the user
    // can fix immediately, not a reason to touch the panel at all.
    if (bindHosts.length === 0) { alert(t('instances.network.selectAtLeastOne')); return; }
    applyBtn.disabled = true;
    try {
      await applyInstanceConfig(inst.id, {
        width: Number(inputs.width.value),
        height: Number(inputs.height.value),
        dpi: Number(inputs.dpi.value),
        fps: Number(inputs.fps.value),
        gpuMode: gpuSelect.value,
        modules,
        bindHosts,
        // Empty (cleared by hand) falls back to the instance's own current port, same
        // "omitted = keep it" convention as every other field here (instanceParams.parseAdbPort).
        adbPort: adbPortInput.value ? Number(adbPortInput.value) : undefined,
      });
      if (profileSelect.value !== current) await applyDeviceProfile(inst.id, profileSelect.value);
      if (knockChecks.length) {
        const knockRequiredHosts = knockChecks.filter(({ chk }) => chk.checked).map(({ address }) => address);
        await api(`/instances/${inst.id}/knock-hosts`, { method: 'PUT', body: JSON.stringify({ knockRequiredHosts }) });
      }
      // Only close/reload on success. On failure (e.g. a missing hwenc artifact) the panel
      // must stay exactly as the user left it -- reloading on every outcome used to rebuild
      // this panel from the instance's still-unchanged data, silently wiping every checkbox
      // the user had just ticked and making it look like "nothing happened" with no clue why.
      openRestartId = null;
      await loadInstances({ silent: true });
    } catch (e) {
      alert(e.message);
      applyBtn.disabled = false;
    }
  });
  panel.appendChild(applyBtn);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = t('common.cancel');
  cancelBtn.addEventListener('click', () => {
    openRestartId = null;
    loadInstances({ silent: true });
  });
  panel.appendChild(cancelBtn);

  td.appendChild(panel);
  tr.appendChild(td);
  return tr;
}

// Raw module ids are already short and self-explanatory (same ids used in the Configure panel
// above and in the "new instance" form) -- a separate display-name map would be one more place to
// forget to update whenever a module is added (see the "wifi: off" bug this replaced). Shows
// everything in requiredModuleIds, including modules the image implied rather than the user
// picked (e.g. redroid-gralloc-fix) -- the point of this column is "what's actually loaded".
function buildModulesCell(inst) {
  const wrap = document.createElement('div');
  wrap.className = 'modules-cell-chips';
  const ids = inst.requiredModuleIds || [];
  if (ids.length === 0) {
    wrap.textContent = t('instances.modules.none');
    wrap.classList.add('muted');
    return wrap;
  }
  const watchdogs = new Map((inst.watchdogs || []).map((w) => [w.moduleId, w]));
  for (const id of ids) {
    const wd = watchdogs.get(id);
    if (wd) { wrap.appendChild(buildWatchdogChip(inst, wd)); continue; }
    const chip = document.createElement('span');
    chip.className = 'resource-chip';
    chip.textContent = id;
    wrap.appendChild(chip);
  }
  const openWd = openWatchdogKey && openWatchdogKey.startsWith(`${inst.id}:`)
    ? watchdogs.get(openWatchdogKey.slice(inst.id.length + 1)) : null;
  if (openWd) wrap.appendChild(buildWatchdogPanel(inst, openWd));
  return wrap;
}

// Watchdog modules (stage 7: cifi today) get a live on/off chip instead of a plain id
// (21/11/2026, asked by the user: "no tengo control real, y debería"). The backend already had
// pause/resume per instance; there was no way to reach it from the UI. Clicking the chip opens a
// small panel under the module chips with the last pass and an on/off button. Turning it on
// restarts the watchdog from zero and runs one pass right away (backend: resumeNow).
// `openWatchdogKey` = "<instanceId>:<moduleId>", kept across the table's periodic re-renders.
let openWatchdogKey = null;

function buildWatchdogChip(inst, wd) {
  const chip = document.createElement('span');
  chip.className = `resource-chip watchdog-chip ${wd.paused ? 'watchdog-off' : 'watchdog-on'}`;
  chip.textContent = `${wd.moduleId} ${wd.paused ? '○ off' : '● on'}`;
  chip.title = t('instances.watchdog.chipHint');
  chip.tabIndex = 0;
  const key = `${inst.id}:${wd.moduleId}`;
  const toggle = () => { openWatchdogKey = openWatchdogKey === key ? null : key; loadInstances({ silent: true }); };
  chip.addEventListener('click', toggle);
  chip.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  return chip;
}

function describeWatchdogLastPass(wd) {
  if (!wd.running) return t('instances.watchdog.notRunning');
  if (!wd.lastRunAt) return t('instances.watchdog.noPassYet', { minutes: Math.round(wd.intervalMs / 60000) });
  const when = new Date(wd.lastRunAt).toLocaleTimeString();
  return wd.lastOk
    ? t('instances.watchdog.lastPassOk', { time: when })
    : t('instances.watchdog.lastPassError', { time: when, error: wd.lastError || '?' });
}

function buildWatchdogPanel(inst, wd) {
  const panel = document.createElement('div');
  panel.className = 'watchdog-panel';
  const state = document.createElement('div');
  state.className = 'watchdog-panel-state';
  state.textContent = wd.paused ? t('instances.watchdog.stateOff') : t('instances.watchdog.stateOn', { minutes: Math.round(wd.intervalMs / 60000) });
  panel.appendChild(state);
  const last = document.createElement('div');
  last.className = `watchdog-panel-last${wd.lastOk === false ? ' watchdog-panel-error' : ''}`;
  last.textContent = describeWatchdogLastPass(wd);
  panel.appendChild(last);
  if (AuthUi.can('configure')) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = wd.paused ? t('instances.watchdog.turnOn') : t('instances.watchdog.turnOff');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api(`/instances/${encodeURIComponent(inst.id)}/watchdogs/${encodeURIComponent(wd.moduleId)}/${wd.paused ? 'resume' : 'pause'}`, { method: 'POST' });
        await loadInstances({ silent: true });
        // Turning on runs one pass right away; it takes a few seconds (open the app + taps), so
        // refresh once more to show its result without waiting for the next background poll.
        if (wd.paused) setTimeout(() => loadInstances({ silent: true }), 8000);
      } catch (e) {
        alert(e.message);
        btn.disabled = false;
      }
    });
    panel.appendChild(btn);
  }
  return panel;
}

// `inst.soporte` comes straight from the backend (GET /api/instances already attaches it per
// row, see instanceSupport.attachSupport -- one db load + one GPU detection for the whole
// list, not per instance). Absent only if the backend predates this (defensive fallback).
function buildSupportCell(inst) {
  const soporte = inst.soporte;
  const chip = document.createElement('span');
  chip.className = 'support-chip';
  if (!soporte) {
    chip.textContent = t('instances.soporte.unknown');
    return chip;
  }
  const niveles = {
    oficial: 'instances.soporte.oficial',
    'piezas-validadas': 'instances.soporte.piezasValidadas',
    comunidad: 'instances.soporte.comunidad',
    'sin-soporte': 'instances.soporte.sinSoporte',
  };
  const hints = {
    'piezas-validadas': 'instances.soporte.hintPiezasValidadas',
    comunidad: 'instances.soporte.hintComunidad',
    'sin-soporte': 'instances.soporte.hintSinSoporte',
  };
  chip.classList.add(soporte.nivel);
  chip.textContent = t(niveles[soporte.nivel] || soporte.nivel);
  if (soporte.nivel === 'oficial') {
    chip.title = t('instances.soporte.hintOficial', { combo: soporte.combinacion || '' });
  } else {
    const reasons = (soporte.motivos || []).join('; ');
    chip.title = t(hints[soporte.nivel] || 'instances.soporte.hintSinSoporte', { reasons });
  }
  return chip;
}

let openStorageId = null;
const storageCache = {}; // inst.id -> { volumeName, mountpoint } | { error } -- fetched on demand (needs a live docker inspect, not already in the /instances payload), kept around so toggling closed and back open doesn't re-fetch.

// Same toggle pattern as openStorageId, for the "open ADB access" row (docs/ROADMAP.md Phase
// 9) -- a routine, frequent action (every time someone wants to connect), not a configuration
// change, so it lives next to "Storage" rather than inside the Configure panel.
let openAdbAccessId = null;

// Stage-7 "user modules" (see loadUserModules's own comment -- CIFI today, discovered by
// etapa rather than hardcoded) also need to be toggleable from the Configure panel, not only
// at creation. Fetched once like hostCoreCount, not per instance -- the catalog is the same for
// everyone's panel.
let userModulesCache = null;
async function loadUserModulesCache() {
  if (userModulesCache !== null) return userModulesCache;
  userModulesCache = await api('/modules').then(
    (list) => list.filter((m) => Array.isArray(m.etapa) && m.etapa.includes(7)),
  ).catch(() => []);
  return userModulesCache;
}

// Host network interfaces (docs/ROADMAP.md Phase 6), for the Configure panel's "Network"
// sub-section -- same lazy-fetch-once pattern as loadUserModulesCache, the host's interface
// list does not change per instance.
let networkInterfacesCache = null;
async function loadNetworkInterfacesCache() {
  if (networkInterfacesCache !== null) return networkInterfacesCache;
  networkInterfacesCache = await api('/network/interfaces').catch(() => []);
  return networkInterfacesCache;
}
let backupsCache = null; // not per-instance -- GET /api/backups is a global list (see backend/src/routes/backups.js); null means "not fetched yet", reset to null after a create/restore so the next render picks up the change.

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n;
  let u = -1;
  do { v /= 1024; u += 1; } while (v >= 1024 && u < units.length - 1);
  return `${v.toFixed(1)} ${units[u]}`;
}

async function createBackupNow(inst, btn) {
  btn.disabled = true;
  try {
    await api(`/instances/${inst.id}/backup`, { method: 'POST' });
    backupsCache = null;
  } catch (e) {
    alert(e.message);
  } finally {
    btn.disabled = false;
    loadInstances({ silent: true });
  }
}

async function restoreBackupOnto(inst, file, resetIdentity, btn) {
  if (!confirm(t('instances.storage.restoreConfirm', { file, name: inst.name }))) return;
  btn.disabled = true;
  try {
    const { warnings } = await api(`/instances/${inst.id}/restore`, {
      method: 'POST', body: JSON.stringify({ file, resetIdentity }),
    });
    alert(warnings.length ? warnings.join('\n\n') : t('instances.storage.restoreNoWarnings'));
  } catch (e) {
    alert(e.message);
  } finally {
    btn.disabled = false;
    loadInstances({ silent: true });
  }
}

async function deleteBackupFile(file, btn) {
  if (!confirm(t('instances.storage.deleteConfirm', { file }))) return;
  btn.disabled = true;
  try {
    await api(`/backups/${encodeURIComponent(file)}`, { method: 'DELETE' });
    backupsCache = null;
  } catch (e) {
    alert(e.message);
    btn.disabled = false;
  } finally {
    loadInstances({ silent: true });
  }
}

// Backups are a global pool (any instance can restore from any backup -- see
// routes/backups.js), so this is the same list/markup regardless of which instance's panel
// is open; only the Restore target (and the running-state check the backend itself enforces)
// is instance-specific.
function buildBackupsSection(inst) {
  const wrap = document.createElement('div');
  const header = document.createElement('div');
  header.className = 'resources-edit-header';
  header.textContent = t('instances.storage.backupsHeader');
  wrap.appendChild(header);

  // Backup/restore/delete are gated on "backup-restore" (docs/ROADMAP.md Phase 7) -- the
  // volume info and the list of what exists above/below stay visible to anyone who can see the
  // instance at all (read-only, not sensitive), only the actions that change something disappear.
  if (AuthUi.can('backup-restore')) {
    const createBtn = document.createElement('button');
    createBtn.type = 'button';
    createBtn.className = 'secondary';
    createBtn.textContent = t('instances.storage.createBackup');
    createBtn.addEventListener('click', () => createBackupNow(inst, createBtn));
    wrap.appendChild(createBtn);
  }

  if (backupsCache === null) {
    wrap.appendChild(document.createTextNode(t('instances.storage.loading')));
    return wrap;
  }
  if (backupsCache.length === 0) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = t('instances.storage.noBackups');
    wrap.appendChild(p);
    return wrap;
  }

  const resetLabel = document.createElement('label');
  resetLabel.className = 'contract-checkbox';
  const resetChk = document.createElement('input');
  resetChk.type = 'checkbox';
  resetLabel.appendChild(resetChk);
  resetLabel.appendChild(document.createTextNode(t('instances.storage.resetIdentity')));
  wrap.appendChild(resetLabel);

  const ul = document.createElement('ul');
  for (const b of backupsCache) {
    const li = document.createElement('li');
    const when = b.meta?.createdAt ? new Date(b.meta.createdAt).toLocaleString() : '?';
    const fromImage = b.meta?.dockerImage ? ` · ${b.meta.dockerImage}` : '';
    li.innerHTML = `<code>${b.file}</code> <span class="muted">(${formatBytes(b.sizeBytes)}, ${when}${fromImage})</span> `;
    if (AuthUi.can('backup-restore')) {
      const restoreBtn = document.createElement('button');
      restoreBtn.type = 'button';
      restoreBtn.className = 'secondary';
      restoreBtn.textContent = t('instances.storage.restore');
      restoreBtn.addEventListener('click', () => restoreBackupOnto(inst, b.file, resetChk.checked, restoreBtn));
      li.appendChild(restoreBtn);
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'secondary';
      deleteBtn.textContent = t('instances.storage.delete');
      deleteBtn.addEventListener('click', () => deleteBackupFile(b.file, deleteBtn));
      li.appendChild(deleteBtn);
    }
    ul.appendChild(li);
  }
  wrap.appendChild(ul);
  return wrap;
}

// Read-only: where this instance's /data really lives on the host. Fetched on demand (not
// batched into loadInstances' periodic poll, unlike soporte -- this is a live `docker volume
// inspect`, only worth paying for when someone actually opens the panel) and cached per
// instance id so re-opening it doesn't hit the backend again.
function buildStorageEditRow(inst) {
  const tr = document.createElement('tr');
  tr.className = 'edit-row';
  const td = document.createElement('td');
  td.colSpan = 1;
  const panel = document.createElement('div');
  panel.className = 'resources-edit-panel';

  const header = document.createElement('div');
  header.className = 'resources-edit-header';
  header.textContent = t('instances.storage.header');
  panel.appendChild(header);

  const info = storageCache[inst.id];
  if (!info) {
    panel.appendChild(document.createTextNode(t('instances.storage.loading')));
  } else if (info.error || !info.mountpoint) {
    panel.appendChild(document.createTextNode(t('instances.storage.unavailable')));
  } else {
    const p1 = document.createElement('p');
    p1.innerHTML = `<strong>${t('instances.storage.volume')}:</strong> <code>${info.volumeName}</code>`;
    const p2 = document.createElement('p');
    p2.innerHTML = `<strong>${t('instances.storage.path')}:</strong> <code>${info.mountpoint}</code>`;
    panel.appendChild(p1);
    panel.appendChild(p2);
  }

  panel.appendChild(buildBackupsSection(inst));

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = t('common.cancel');
  closeBtn.addEventListener('click', () => {
    openStorageId = null;
    loadInstances({ silent: true });
  });
  panel.appendChild(closeBtn);

  td.appendChild(panel);
  tr.appendChild(td);
  return tr;
}

// Which "reachability family" an IPv4 address falls into -- used only to pick which flavor of
// hint buildLocalIpHelp() below shows (Tailscale's own CGNAT range vs. a private LAN), not to
// filter or verify anything. Tried first actually filtering real candidates gathered in-page via
// WebRTC's old ICE-candidate leak -- confirmed live (08/11/2026) across Firefox ESR (does not
// leak at all for this user's profile) and documented separately for Chrome/Edge/Brave (mDNS-
// obfuscate it) and Safari (never exposed it): no major browser still gives a page this
// information, so there is nothing left in-page to filter. See buildLocalIpHelp for what this
// feeds into instead.
function ipFamily(ip) {
  const octets = String(ip).split('.').map(Number);
  if (octets.length !== 4 || octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) return null;
  const [a, b] = octets;
  if (a === 100 && b >= 64 && b <= 127) return 'tailscale';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  return null;
}

// Hands the user a command to run in THEIR OWN terminal instead of trying (and failing, see
// ipFamily's comment above) to read their local IP from inside the page -- the OS itself is the
// only thing left that still knows this answer. A collapsed <details> rather than always-visible
// text: this is a fallback for the uncommon case of not already knowing your own device's address,
// not something every admin needs to see on every single row.
function buildLocalIpHelp(host) {
  const details = document.createElement('details');
  details.className = 'muted';
  const summary = document.createElement('summary');
  summary.textContent = t('instances.knock.ipHelpSummary');
  details.appendChild(summary);

  const family = ipFamily(host);
  const note = document.createElement('div');
  note.textContent = family === 'tailscale' ? t('instances.knock.ipHelpTailscale')
    : family === 'private' ? t('instances.knock.ipHelpPrivate')
      : t('instances.knock.ipHelpGeneric');
  details.appendChild(note);

  // One command per OS, each already filtered to "an actual interface address", not every line
  // ipconfig/ifconfig would otherwise print -- the user still has to pick the right one out of
  // however many it shows (the `note` above says which prefix to look for), this just saves them
  // from a wall of unrelated adapter/DNS/subnet-mask output first.
  for (const { label, cmd } of [
    { label: 'Linux', cmd: "hostname -I | tr ' ' '\\n'" },
    { label: 'macOS', cmd: 'ifconfig | grep "inet " | grep -v 127.0.0.1' },
    { label: 'Windows', cmd: 'ipconfig | findstr IPv4' },
  ]) {
    const row = document.createElement('div');
    row.appendChild(document.createTextNode(`${label}: `));
    const code = document.createElement('code');
    code.textContent = cmd;
    row.appendChild(code);
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'secondary';
    copyBtn.textContent = t('instances.knock.ipHelpCopy');
    copyBtn.addEventListener('click', () => {
      navigator.clipboard?.writeText(cmd).then(() => {
        copyBtn.textContent = t('instances.knock.ipHelpCopied');
        setTimeout(() => { copyBtn.textContent = t('instances.knock.ipHelpCopy'); }, 1500);
      }).catch(() => {});
    });
    row.appendChild(copyBtn);
    details.appendChild(row);
  }
  return details;
}

// The actual "open access" controls (docs/ROADMAP.md Phase 9) -- which interfaces are gated at
// all is decided in the Configure panel (rare, admin-y); this row is the frequent action of
// actually opening one, one per `knockRequiredHosts` entry, same toggle pattern as
// buildStorageEditRow (openAdbAccessId instead of openStorageId).
function buildAdbAccessEditRow(inst) {
  const tr = document.createElement('tr');
  tr.className = 'edit-row';
  const td = document.createElement('td');
  td.colSpan = 1;
  const panel = document.createElement('div');
  panel.className = 'resources-edit-panel';

  const header = document.createElement('div');
  header.className = 'resources-edit-header';
  header.textContent = t('instances.knock.header');
  panel.appendChild(header);

  for (const host of (inst.knockRequiredHosts || [])) {
    const row = document.createElement('div');
    row.className = 'display-edit-field';

    // Read-only -- this is the instance's own fixed listening address (docker-published, set in
    // the Configure panel), never something to type here. Said explicitly (08/11/2026): the
    // field below it looked editable enough that it was not obvious this one line above it is a
    // completely different, fixed thing.
    const serverLabel = document.createElement('div');
    serverLabel.textContent = t('instances.knock.serverListensOn', { address: host });
    row.appendChild(serverLabel);

    const ipFieldLabel = document.createElement('div');
    ipFieldLabel.textContent = t('instances.knock.connectFromLabel');
    row.appendChild(ipFieldLabel);

    const ipInput = document.createElement('input');
    ipInput.type = 'text';
    ipInput.placeholder = t('instances.knock.ipPlaceholder');
    // Wider than .display-edit-field's shared 6em default (style.css) -- 6em is not enough room
    // to comfortably read/type a full IPv4 address in this one.
    ipInput.style.width = '10em';
    row.appendChild(ipInput);
    row.appendChild(buildLocalIpHelp(host));

    const ipHint = document.createElement('div');
    ipHint.className = 'muted';
    ipHint.textContent = t('instances.knock.ipHint');
    row.appendChild(ipHint);

    const minutesInput = document.createElement('input');
    minutesInput.type = 'number';
    minutesInput.min = '1';
    minutesInput.value = '1';
    minutesInput.style.width = '4em';
    row.appendChild(minutesInput);
    row.appendChild(document.createTextNode(t('instances.knock.minutesLabel')));

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'secondary';
    openBtn.textContent = t('instances.knock.open');
    row.appendChild(openBtn);

    const stateLine = document.createElement('div');
    row.appendChild(stateLine);

    const warnLine = document.createElement('div');
    warnLine.className = 'resources-warn resources-warn-error';
    warnLine.style.display = 'none';
    warnLine.textContent = t('instances.knock.longWindowWarn');
    row.appendChild(warnLine);

    const renderState = (state) => {
      stateLine.textContent = (state && state.open)
        ? t('instances.knock.stateOpenUntil', { time: new Date(state.openUntil).toLocaleTimeString() })
        : t('instances.knock.stateClosed');
    };

    api(`/instances/${inst.id}/adb-access?hostIp=${encodeURIComponent(host)}`)
      .then((state) => renderState(state))
      .catch(() => {});

    openBtn.addEventListener('click', async () => {
      openBtn.disabled = true;
      try {
        const minutes = Number(minutesInput.value) || 1;
        warnLine.style.display = minutes > 1 ? '' : 'none';
        const body = { hostIp: host, minutes };
        if (ipInput.value) body.sourceIp = ipInput.value;
        const state = await api(`/instances/${inst.id}/adb-access`, { method: 'POST', body: JSON.stringify(body) });
        renderState(state);
      } catch (err) {
        stateLine.textContent = err.message;
      } finally {
        openBtn.disabled = false;
      }
    });

    panel.appendChild(row);
  }

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = t('common.cancel');
  closeBtn.addEventListener('click', () => {
    openAdbAccessId = null;
    loadInstances({ silent: true });
  });
  panel.appendChild(closeBtn);

  td.appendChild(panel);
  tr.appendChild(td);
  return tr;
}

// `silent`: the periodic refresh does not flash "Loading..." over the table.
// Instances redesign (24/10/2026): each instance renders as a pair of rows, not a row of
// columns -- see the CSS comment above .instance-primary/.instance-secondary. Row 1 (bigger
// font) is "I already know how this is set up, just let me connect": name, status, address.
// Row 2 (smaller) is everything else -- info chips AND every button, including the ones that
// used to sit in their own always-visible column (device profile, register/mark-registered).
async function loadInstances({ silent = false } = {}) {
  const table = $('#instances-table');
  const tbody = $('#instances-table tbody');
  const grid = $('#instances-grid');
  const isViewers = instanceViewMode === 'viewers';
  table.hidden = isViewers;
  grid.hidden = !isViewers;
  $('#viewers-size-control').hidden = !isViewers;
  const target = isViewers ? grid : tbody;
  if (!silent) target.innerHTML = isViewers ? `<p>${t('common.loading')}</p>` : `<tr><td>${t('common.loading')}</td></tr>`;
  try {
    const instances = await api('/instances');
    if (instances.length === 0) {
      target.innerHTML = isViewers ? `<p>${t('instances.none')}</p>` : `<tr><td>${t('instances.none')}</td></tr>`;
      return;
    }
    // Built off-screen and swapped in one go, so a refresh never leaves the table/grid half drawn.
    const rows = document.createDocumentFragment();
    const cards = document.createDocumentFragment();
    for (const inst of instances) {
      const state = InstanceState.describe(inst.status);

      // Shared across all three view modes -- "mínimo" and "visores" need exactly the same
      // start/stop/restart/delete buttons "completo" already builds, just inside a smaller
      // container with nothing else around them. Defined once per instance so the three modes
      // below never hand-roll their own copy of the recreate/confirm/alert/reload logic.
      const mk = (label, action) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.className = 'secondary';
        b.addEventListener('click', async () => {
          b.disabled = true;
          try {
            await api(`/instances/${inst.id}/${action}`, { method: 'POST' });
          } catch (e) {
            alert(e.message);
          } finally {
            b.disabled = false;
            await loadInstances({ silent: true });
          }
        });
        return b;
      };
      const buildDeleteBtn = () => {
        const del = document.createElement('button');
        del.textContent = t('instances.delete');
        del.className = 'secondary';
        del.addEventListener('click', async () => {
          if (!confirm(t('instances.confirmDelete', { name: inst.name }))) return;
          try {
            await api(`/instances/${inst.id}`, { method: 'DELETE' });
            await loadInstances({ silent: true });
          } catch (e) {
            alert(e.message);
          }
        });
        return del;
      };
      // Locked instances (1.0.0-beta.4): start/restart/delete stay visible but disabled, with
      // the lock's reason as their tooltip, so it is obvious WHY they do nothing.
      const lockedHint = inst.locked
        ? t('instances.lock.hint', { reason: inst.locked.reason || t('instances.lock.noReason'), by: inst.locked.by || '?', at: inst.locked.at ? new Date(inst.locked.at).toLocaleString() : '?' })
        : null;
      const disableForLock = (btn) => { btn.disabled = true; btn.title = lockedHint; return btn; };
      const buildLockBtn = () => {
        const b = document.createElement('button');
        b.className = 'secondary';
        if (inst.locked) {
          b.textContent = `🔓 ${t('instances.lock.unlock')}`;
          b.addEventListener('click', async () => {
            if (!confirm(t('instances.lock.confirmUnlock', { name: inst.name }))) return;
            try { await api(`/instances/${inst.id}/unlock`, { method: 'POST' }); } catch (e) { alert(e.message); }
            await loadInstances({ silent: true });
          });
        } else {
          b.textContent = `🔒 ${t('instances.lock.lock')}`;
          b.title = t('instances.lock.lockHint');
          b.addEventListener('click', async () => {
            const reason = prompt(t('instances.lock.promptReason', { name: inst.name }));
            if (reason === null) return; // cancelled
            b.disabled = true;
            try { await api(`/instances/${inst.id}/lock`, { method: 'POST', body: JSON.stringify({ reason }) }); } catch (e) { alert(e.message); }
            await loadInstances({ silent: true });
          });
        }
        return b;
      };
      // Only the actions that make sense for the current state (see instanceState.js).
      const appendActionButtons = (container) => {
        for (const action of state.actions) {
          if (action === 'delete') {
            if (AuthUi.can('delete')) container.appendChild(inst.locked ? disableForLock(buildDeleteBtn()) : buildDeleteBtn());
          } else if (AuthUi.can('start-stop')) {
            const btn = mk(t(`instances.${action}`), action);
            container.appendChild(inst.locked && (action === 'start' || action === 'restart') ? disableForLock(btn) : btn);
          }
        }
        if (AuthUi.can('configure')) container.appendChild(buildLockBtn());
      };
      const buildLockChip = () => {
        const chip = document.createElement('span');
        chip.className = 'resource-chip lock-chip';
        chip.textContent = `🔒 ${t('instances.lock.chip')}`;
        chip.title = lockedHint;
        return chip;
      };
      // The expanded viewer button, shared by the "full" rows and the "viewers" cards (1.0.0-beta.5:
      // the cards had no way to open it).
      const buildExpandBtn = () => {
        const expandBtn = document.createElement('button');
        expandBtn.type = 'button';
        expandBtn.className = 'icon-button';
        expandBtn.textContent = '⛶';
        expandBtn.title = t('instances.viewer.expandHint');
        expandBtn.addEventListener('click', () => ViewerExpanded.open(inst.id));
        return expandBtn;
      };
      // "Open in local scrcpy" (1.0.0-beta.5) -- only when this browser passed the launcher test and
      // has it turned on (frontend/scrcpyLauncher.js), and only for a running instance. A plain link:
      // the browser hands scrcpy-redroid:// to the local launcher.
      const buildScrcpyBtn = () => {
        if (!ScrcpyLauncher.isEnabled() || inst.status !== 'running') return null;
        const a = document.createElement('a');
        a.className = 'icon-button scrcpy-link';
        a.href = ScrcpyLauncher.linkFor(inst);
        a.textContent = '\u{1F4F2}'; // 📲
        a.title = t('instances.viewer.scrcpyHint');
        return a;
      };
      const buildAddressSpan = (className) => {
        const address = `${location.hostname}:${inst.adbPort}`;
        const addrSpan = document.createElement('span');
        addrSpan.className = className;
        addrSpan.textContent = address;
        addrSpan.title = t('instances.addressCopyHint');
        addrSpan.addEventListener('click', async () => {
          const ok = await copyText(address);
          addrSpan.textContent = ok ? t('instances.copied') : t('instances.copyFailed');
          setTimeout(() => { addrSpan.textContent = address; }, 1500);
        });
        return addrSpan;
      };

      if (instanceViewMode === 'minimal') {
        // "Mínimo" (15/11/2026) -- name, address, start/stop/restart/delete, nothing else: no
        // chips, no viewer, no edit panels, no rename -- explicitly, "para el que no quiere
        // saber nada de nada". One compact row per instance instead of "completo"'s row-pair.
        const trMin = document.createElement('tr');
        trMin.className = 'instance-row-minimal';
        const tdMin = document.createElement('td');
        const minWrap = document.createElement('div');
        minWrap.className = 'instance-minimal';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'instance-name';
        nameSpan.textContent = inst.name;
        minWrap.appendChild(nameSpan);
        if (inst.locked) minWrap.appendChild(buildLockChip());
        minWrap.appendChild(buildAddressSpan('instance-minimal-address'));

        const minButtons = document.createElement('div');
        minButtons.className = 'instance-minimal-buttons';
        appendActionButtons(minButtons);
        minWrap.appendChild(minButtons);

        tdMin.appendChild(minWrap);
        trMin.appendChild(tdMin);
        rows.appendChild(trMin);
        continue;
      }

      if (instanceViewMode === 'viewers') {
        // "Visores" (15/11/2026) -- a grid card per instance: name, address, its own live
        // live preview (always mounted here, independent of the "completo" tab's per-row 👁
        // toggle -- showing the preview IS this view's whole point), and the same action
        // buttons as every other mode.
        const card = document.createElement('div');
        card.className = 'instance-card';

        const nameDiv = document.createElement('div');
        nameDiv.className = 'instance-card-name';
        nameDiv.textContent = inst.name;
        card.appendChild(nameDiv);
        if (inst.locked) card.appendChild(buildLockChip());
        card.appendChild(buildAddressSpan('instance-card-address'));

        if (AuthUi.can('view')) {
          const viewerWrap = document.createElement('div');
          viewerWrap.className = 'instance-card-viewer';
          Viewer.mountPreview(viewerWrap, inst.id, effectiveViewersSize());
          card.appendChild(viewerWrap);
        }

        if (AuthUi.can('view')) {
          const viewerButtons = document.createElement('div');
          viewerButtons.className = 'instance-card-viewer-buttons';
          viewerButtons.appendChild(buildExpandBtn());
          const scrcpyBtn = buildScrcpyBtn();
          if (scrcpyBtn) viewerButtons.appendChild(scrcpyBtn);
          card.appendChild(viewerButtons);
        }

        const cardButtons = document.createElement('div');
        cardButtons.className = 'instance-card-buttons';
        appendActionButtons(cardButtons);
        card.appendChild(cardButtons);

        cards.appendChild(card);
        continue;
      }

      // --- "Completo" (default, unchanged) ---
      // Row 1: name, status, address (host:adbPort -- click to copy, same as the Android
      // ID copy-on-click pattern) ---
      const trPrimary = document.createElement('tr');
      trPrimary.className = 'instance-row-primary';
      const tdPrimary = document.createElement('td');
      const primary = document.createElement('div');
      primary.className = 'instance-primary';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'instance-name';
      nameSpan.textContent = inst.name;
      primary.appendChild(nameSpan);

      // Renaming is a plain metadata update on the backend (PUT /:id/name, no recreate) --
      // same permission tier as the rest of the Configure panel, not its own capability.
      if (AuthUi.can('configure')) {
        const renameBtn = document.createElement('button');
        renameBtn.type = 'button';
        renameBtn.className = 'icon-button';
        renameBtn.textContent = '✎';
        renameBtn.title = t('instances.rename.hint');
        renameBtn.addEventListener('click', () => {
          const nameInput = document.createElement('input');
          nameInput.type = 'text';
          nameInput.value = inst.name;
          nameInput.className = 'instance-name-edit';
          nameInput.maxLength = 40;

          const saveBtn = document.createElement('button');
          saveBtn.type = 'button';
          saveBtn.textContent = t('common.save');
          const cancelEditBtn = document.createElement('button');
          cancelEditBtn.type = 'button';
          cancelEditBtn.textContent = t('common.cancel');

          openRenameId = inst.id;
          const restore = () => {
            openRenameId = null;
            nameInput.replaceWith(nameSpan);
            saveBtn.remove();
            cancelEditBtn.remove();
            renameBtn.hidden = false;
          };
          cancelEditBtn.addEventListener('click', restore);

          const save = async () => {
            const newName = normalizeInstanceName(nameInput.value);
            if (!newName || newName === inst.name) { restore(); return; }
            saveBtn.disabled = true;
            try {
              await api(`/instances/${inst.id}/name`, { method: 'PUT', body: JSON.stringify({ name: newName }) });
              openRenameId = null;
              await loadInstances({ silent: true });
            } catch (e) {
              alert(e.message);
              saveBtn.disabled = false;
            }
          };
          saveBtn.addEventListener('click', save);
          nameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') save();
            if (e.key === 'Escape') restore();
          });

          nameSpan.replaceWith(nameInput);
          renameBtn.hidden = true;
          nameInput.after(saveBtn, cancelEditBtn);
          nameInput.focus();
          nameInput.select();
        });
        primary.appendChild(renameBtn);
      }

      const statusSpan = document.createElement('span');
      statusSpan.className = 'instance-status';
      statusSpan.innerHTML = `<span class="status-dot ${state.tone}"></span>${t('instances.status.' + state.key)}`;
      primary.appendChild(statusSpan);
      if (inst.locked) primary.appendChild(buildLockChip());

      primary.appendChild(buildAddressSpan('instance-address'));

      tdPrimary.appendChild(primary);
      trPrimary.appendChild(tdPrimary);

      // Viewer column (eye toggle, inline preview, expand button) -- a column of its own
      // instead of mixed into the chips flow (found for real 17/11/2026: a 160px preview sitting
      // inline among text chips forced "completo" rows to wrap tall). rowspan=2 so this one cell
      // sits beside BOTH row 1 (name/status) and row 2 (chips) as a single block, same visual
      // height as the two rows combined, no matter whether the preview is on or off.
      if (AuthUi.can('view')) {
        const tdViewer = document.createElement('td');
        tdViewer.className = 'instance-viewer-cell';
        tdViewer.rowSpan = 2;
        const viewerCol = document.createElement('div');
        viewerCol.className = 'instance-viewer-col';

        const viewerBtns = document.createElement('div');
        viewerBtns.className = 'instance-viewer-col-btns';

        // Live preview toggle (Hito 2 of the web viewer work) -- explicit, per-instance, default
        // off, independent of the "expanded viewer"/fullscreen viewer (Hito 4): turning this on does
        // not turn that on, and vice versa, per the plan's own decided "native capability,
        // opt-in behavior" split.
        const previewBtn = document.createElement('button');
        previewBtn.type = 'button';
        previewBtn.className = 'icon-button';
        const isOn = previewIds.has(inst.id);
        previewBtn.textContent = isOn ? '\u{1F441}\u{FE0F}' : '\u{1F441}'; // 👁️ on / 👁 off
        previewBtn.title = t(isOn ? 'instances.viewer.previewHideHint' : 'instances.viewer.previewShowHint');
        previewBtn.addEventListener('click', () => {
          if (previewIds.has(inst.id)) { previewIds.delete(inst.id); Viewer.unmountPreview(inst.id); } else { previewIds.add(inst.id); }
          savePreviewIds(previewIds);
          loadInstances({ silent: true });
        });
        viewerBtns.appendChild(previewBtn);

        // "expanded viewer" (Hitos 3+4) -- a one-shot action, not a toggle: opening it does not turn
        // the live preview above on or off, and vice versa (independent, per the plan).
        viewerBtns.appendChild(buildExpandBtn());
        const scrcpyBtn = buildScrcpyBtn();
        if (scrcpyBtn) viewerBtns.appendChild(scrcpyBtn);

        viewerCol.appendChild(viewerBtns);

        // The preview image itself, in its OWN wrap below the buttons rather than next to the
        // eye button (Viewer.mountPreview just appends an <img> into whatever container it's
        // given) -- that's what lets the column stay narrow while the preview below it is free
        // to be full-size.
        const previewWrap = document.createElement('div');
        previewWrap.className = 'viewer-live preview-wrap';
        if (isOn) Viewer.mountPreview(previewWrap, inst.id);
        viewerCol.appendChild(previewWrap);

        tdViewer.appendChild(viewerCol);
        trPrimary.appendChild(tdViewer);
      }

      // --- Row 2: every other info chip, then every button ---
      const trSecondary = document.createElement('tr');
      trSecondary.className = 'instance-row-secondary';
      const tdSecondary = document.createElement('td');
      const secondary = document.createElement('div');
      secondary.className = 'instance-secondary';

      const imageChip = document.createElement('span');
      imageChip.className = 'resource-chip';
      imageChip.textContent = inst.dockerImage;
      secondary.appendChild(imageChip);
      const displayChip = buildDisplayChip(inst);
      if (displayChip) secondary.appendChild(displayChip);
      secondary.appendChild(buildDeviceProfileChip(inst));
      secondary.appendChild(buildResourcesChips(inst));
      secondary.appendChild(buildCodecChips(inst));
      secondary.appendChild(buildWifiInternoChip(inst));
      secondary.appendChild(buildNetworkChip(inst));
      secondary.appendChild(buildModulesCell(inst));
      secondary.appendChild(buildSupportCell(inst));
      const androidIdSpan = document.createElement('span');
      androidIdSpan.className = 'android-id-cell';
      androidIdSpan.innerHTML = androidIdCellHtml(inst);
      secondary.appendChild(androidIdSpan);

      const buttons = document.createElement('div');
      buttons.className = 'instance-secondary-buttons';

      if (inst.hasGapps && inst.androidId && !inst.androidIdRegisteredAt && AuthUi.can('configure')) {
        const link = document.createElement('a');
        link.href = 'https://www.google.com/android/uncertified';
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = t('instances.register');
        link.title = t('instances.registerHint');
        link.className = 'link-btn';
        // The page of Google asks for the Android ID: it is copied in the same click that opens
        // it (the link still navigates; no preventDefault), so it only has to be pasted there.
        link.addEventListener('click', async () => {
          const ok = await copyText(inst.androidId);
          link.textContent = t(ok ? 'instances.copied' : 'instances.copyFailed');
          setTimeout(() => { link.textContent = t('instances.register'); }, 2500);
        });
        buttons.appendChild(link);
        const markBtn = document.createElement('button');
        markBtn.textContent = t('instances.markRegistered');
        markBtn.className = 'secondary';
        markBtn.addEventListener('click', async () => {
          try {
            await api(`/instances/${inst.id}/android-id/registered`, { method: 'POST' });
            await loadInstances();
          } catch (e) {
            alert(e.message);
          }
        });
        buttons.appendChild(markBtn);
      }

      if (AuthUi.can('configure')) {
        const resourcesBtn = document.createElement('button');
        resourcesBtn.type = 'button';
        resourcesBtn.className = 'secondary';
        resourcesBtn.textContent = t('instances.resources.toggle');
        resourcesBtn.title = t('instances.resources.changeHint');
        resourcesBtn.addEventListener('click', () => {
          openNoRestartId = openNoRestartId === inst.id ? null : inst.id;
          loadInstances({ silent: true });
        });
        buttons.appendChild(resourcesBtn);

        const configureBtn = document.createElement('button');
        configureBtn.type = 'button';
        configureBtn.className = 'secondary';
        configureBtn.textContent = t('instances.configure.toggle');
        configureBtn.title = t('instances.configure.changeHint');
        configureBtn.addEventListener('click', async () => {
          const opening = openRestartId !== inst.id;
          openRestartId = opening ? inst.id : null;
          if (opening && (userModulesCache === null || networkInterfacesCache === null)) {
            loadInstances({ silent: true }); // shows the panel's "loading" state while this resolves
            await Promise.all([loadUserModulesCache(), loadNetworkInterfacesCache()]);
          }
          loadInstances({ silent: true });
        });
        buttons.appendChild(configureBtn);
      }

      if (AuthUi.can('transfer-ownership')) {
        const ownersBtn = document.createElement('button');
        ownersBtn.type = 'button';
        ownersBtn.className = 'secondary';
        ownersBtn.textContent = t('instances.owners.toggle');
        ownersBtn.title = t('instances.owners.changeHint');
        ownersBtn.addEventListener('click', async () => {
          const opening = openOwnersId !== inst.id;
          openOwnersId = opening ? inst.id : null;
          if (opening && directoryCache === null) {
            loadInstances({ silent: true });
            await loadDirectoryCache();
          }
          loadInstances({ silent: true });
        });
        buttons.appendChild(ownersBtn);
      }

      const storageBtn = document.createElement('button');
      storageBtn.type = 'button';
      storageBtn.className = 'secondary';
      storageBtn.textContent = t('instances.storage.toggle');
      storageBtn.title = t('instances.storage.changeHint');
      storageBtn.addEventListener('click', async () => {
        const opening = openStorageId !== inst.id;
        openStorageId = opening ? inst.id : null;
        if (opening && (!storageCache[inst.id] || backupsCache === null)) {
          loadInstances({ silent: true }); // shows the "loading" row while the fetches below run
          if (!storageCache[inst.id]) {
            try {
              storageCache[inst.id] = await api(`/instances/${inst.id}/storage`);
            } catch (e) {
              storageCache[inst.id] = { error: e.message };
            }
          }
          if (backupsCache === null) backupsCache = await api('/backups').catch(() => []);
        }
        loadInstances({ silent: true });
      });
      buttons.appendChild(storageBtn);

      if ((inst.knockRequiredHosts || []).length > 0) {
        const adbAccessBtn = document.createElement('button');
        adbAccessBtn.type = 'button';
        adbAccessBtn.className = 'secondary';
        adbAccessBtn.textContent = t('instances.knock.toggle');
        adbAccessBtn.addEventListener('click', () => {
          openAdbAccessId = openAdbAccessId === inst.id ? null : inst.id;
          loadInstances({ silent: true });
        });
        buttons.appendChild(adbAccessBtn);
      }

      appendActionButtons(buttons);

      secondary.appendChild(buttons);
      tdSecondary.appendChild(secondary);
      trSecondary.appendChild(tdSecondary);

      rows.appendChild(trPrimary);
      rows.appendChild(trSecondary);
      if (openNoRestartId === inst.id) rows.appendChild(buildResourcesEditRow(inst, instances));
      if (openRestartId === inst.id) rows.appendChild(buildRestartEditRow(inst));
      if (openOwnersId === inst.id) rows.appendChild(buildOwnersEditRow(inst, directoryCache));
      if (openStorageId === inst.id) rows.appendChild(buildStorageEditRow(inst));
      if (openAdbAccessId === inst.id) rows.appendChild(buildAdbAccessEditRow(inst));
    }
    if (isViewers) grid.replaceChildren(cards); else tbody.replaceChildren(rows);
    // Sweep sessions nobody asked to keep any more. Which instances SHOULD have a mounted
    // viewer right now depends on the active mode: "completo" only the ones whose own 👁 toggle
    // is on, "visores" every instance (that is the whole point of that mode), "mínimo" none at
    // all. An instance that got deleted (so its row/card never ran a mount call above this
    // poll) is the normal way this also fires, not just a mode switch or an explicit toggle-off
    // (that already unmounts inline, see the click handler above).
    const instanceIds = new Set(instances.map((i) => i.id));
    const shouldBeMounted = (id) => instanceIds.has(id)
      && (instanceViewMode === 'viewers' || (instanceViewMode === 'full' && previewIds.has(id)));
    for (const id of Viewer.mountedIds()) {
      if (!shouldBeMounted(id)) Viewer.unmountPreview(id);
    }
  } catch (e) {
    target.innerHTML = isViewers ? `<p>${t('common.error', { msg: e.message })}</p>` : `<tr><td>${t('common.error', { msg: e.message })}</td></tr>`;
  }
}

function moduleStatusBadge(m) {
  if (m.accepted) return `<span class="status-dot ok"></span> ${t('modules.accepted', { v: m.acceptedVersion })}`;
  if (m.acceptedVersion) return `<span class="status-dot warn"></span> ${t('modules.oldAccepted', { old: m.acceptedVersion, cur: m.version })}`;
  return `<span class="status-dot warn"></span> ${t('modules.pending')}`;
}

// Same 3 states moduleStatusBadge renders, ranked worst-first -- never accepted (nothing decided
// yet) ranks above accepted-but-outdated (something to re-review), which ranks above accepted
// (nothing to do). Same idea as DOCTOR_STATUS_ORDER below, just derived from two booleans
// instead of read off an explicit backend `status` field.
function moduleStatusRank(m) {
  if (m.accepted) return 2;
  if (m.acceptedVersion) return 1;
  return 0;
}

// Shared renderer for both the Modules tab and the User modules tab -- same card shape (status
// badge, description, what it touches, accept/revoke), the only difference between the two tabs
// is WHICH modules get fetched/filtered before calling this (see loadModules/loadUserModulesTab).
function renderModuleCards(list, modules, { onChange }) {
  list.innerHTML = '';
  // Worst first (16/11/2026, same ask and the same pattern as loadDoctor's own sort) -- modules
  // needing a decision should never be buried below a page of already-accepted ones. Stable sort
  // (spec-guaranteed since ES2019), so modules tied on status keep the backend's own order among
  // themselves instead of reshuffling for no reason.
  const sorted = modules.slice().sort((a, b) => moduleStatusRank(a) - moduleStatusRank(b));
  for (const m of sorted) {
    const li = document.createElement('li');
    li.className = 'doctor-item';
    const tipo = m.esTerceroNoLibre ? t('modules.thirdParty') : t('modules.own');
    li.innerHTML = `
      <div class="label">${moduleStatusBadge(m)} — <strong>${loc(m, 'nombre')}</strong> <span class="muted">(${tipo}, v${m.version})</span></div>
      <p class="detail">${loc(m, 'descripcion')}</p>
      <p class="detail muted">${t('modules.compatible', { android: m.compatibleCon.androidVersion.join('/'), gpu: m.compatibleCon.gpuMode.join('/') })}</p>
      <ul>${loc(m, 'queToca').map((item) => `<li>${item}</li>`).join('')}</ul>
    `;
    // Accepting from here is the same contract flow the reactive 428 path already uses
    // (Contracts.ensureAccepted) -- this just lets it be done ahead of time instead of only
    // at the moment something needs it.
    if (!m.accepted) {
      const btn = document.createElement('button');
      btn.textContent = t('contract.accept');
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await Contracts.ensureAccepted([m]);
        } catch (e) {
          alert(e.message);
        } finally {
          await onChange();
        }
      });
      li.appendChild(btn);
    } else {
      // Deliberate stub, not a real feature yet (22/10/2026): whether revoking should even be
      // possible is an open question (an instance already using the module keeps running on
      // what it has -- does revoking block its NEXT start/restart? does it force-stop it?),
      // not decided. This button exists on purpose so the gap stays visible in the UI instead
      // of silently missing, until that design question gets resolved.
      const btn = document.createElement('button');
      btn.className = 'secondary';
      btn.textContent = t('modules.revoke');
      btn.addEventListener('click', () => alert(t('modules.revokeNotImplemented')));
      li.appendChild(btn);
    }
    list.appendChild(li);
  }
}

const isUserModule = (m) => Array.isArray(m.etapa) && m.etapa.includes(7);

// The generic per-instance capabilities (gapps/hwenc/arm/etc.) -- user modules (stage 7, CIFI
// today) are excluded here and shown in their own tab instead (loadUserModulesTab), not
// duplicated in both -- explicit feedback from the user, 22/10/2026.
async function loadModules() {
  const list = $('#modules-list');
  list.innerHTML = `<li>${t('common.loading')}</li>`;
  try {
    const modules = (await api('/modules')).filter((m) => !isUserModule(m));
    renderModuleCards(list, modules, { onChange: loadModules });
  } catch (e) {
    list.innerHTML = `<li>${t('common.error', { msg: e.message })}</li>`;
  }
}

// Per-game/situation automations (stage 7) -- a different category from the generic
// capabilities above: they don't apply to "any instance", they automate ONE specific thing.
async function loadUserModulesTab() {
  const list = $('#user-modules-tab-list');
  list.innerHTML = `<li>${t('common.loading')}</li>`;
  try {
    const modules = (await api('/modules')).filter(isUserModule);
    if (modules.length === 0) {
      list.innerHTML = `<li class="muted">${t('new.noUserModules')}</li>`;
      return;
    }
    renderModuleCards(list, modules, { onChange: loadUserModulesTab });
  } catch (e) {
    list.innerHTML = `<li>${t('common.error', { msg: e.message })}</li>`;
  }
}

// The heuristic in backend/src/lib/networkInterfaceFilter.js decides a sane default (hide
// docker0/br-*/veth*/CNI noise, show everything else) -- this panel is only for the exceptions:
// an admin forcing one it hid back into view, or hiding one it let through. Each checkbox
// remembers the heuristic's own verdict in a data attribute, so the submit handler below only
// has to send what actually *differs* from it, not a full replacement (see there for why).
function renderNetIfacesSettings(ifaces) {
  const list = $('#settings-net-ifaces-list');
  list.innerHTML = '';
  if (ifaces.length === 0) {
    list.innerHTML = `<li class="muted">${t('settings.netIfaces.none')}</li>`;
    return;
  }
  for (const i of ifaces) {
    const li = document.createElement('li');
    const label = document.createElement('label');
    label.className = 'contract-checkbox';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = i.visible;
    chk.dataset.iface = i.iface;
    chk.dataset.heuristicVisible = String(i.heuristicVisible);
    label.appendChild(chk);
    label.appendChild(document.createTextNode(` ${i.iface} (${i.addresses.join(', ')})`));
    if (!i.heuristicVisible) {
      const badge = document.createElement('span');
      badge.className = 'muted';
      badge.textContent = ` ${t('settings.netIfaces.hiddenByDefault')}`;
      label.appendChild(badge);
    }
    li.appendChild(label);
    list.appendChild(li);
  }
}

// This app's OWN listen addresses, not any instance's -- a checklist, same shape and same
// already-filtered interface list (networkInterfacesCache, via loadNetworkInterfacesCache,
// reused not re-fetched) as the per-instance Network picker above, not the unfiltered
// /interfaces/all list the OTHER fieldset on this page uses (that one is for correcting the
// filter itself; this one should only ever offer what the filter already lets through).
// 127.0.0.1 is pinned: unlike an instance, this app always listens on it with no way to opt out
// (server.js), so unlike the instance picker's localhost checkbox, this one is checked+disabled.
function updateAppBindHostWarn() {
  const warn = $('#settings-app-bind-host-warn');
  const exposed = $$('#settings-app-bind-hosts-list input[type="checkbox"]')
    .some((chk) => chk.checked && chk.dataset.address !== '127.0.0.1');
  if (!exposed) { warn.hidden = true; return; }
  warn.hidden = false;
  // "none" mode has no login at all -- exposing the APP ITSELF (not just one instance) beyond
  // localhost with no auth behind it means anyone who can reach it can create/delete/operate
  // every instance and, in "local"/"oidc" mode, read the Users panel too.
  warn.textContent = AuthUi.authMode() === 'none'
    ? t('settings.appBindHost.warnExposedNoAuth')
    : t('settings.appBindHost.warnExposed');
}

function renderAppBindHostsList(currentHosts, ifaces) {
  const list = $('#settings-app-bind-hosts-list');
  list.innerHTML = '';
  const addRow = (address, labelText, { pinned = false } = {}) => {
    const li = document.createElement('li');
    const label = document.createElement('label');
    label.className = 'contract-checkbox';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.dataset.address = address;
    chk.checked = pinned || currentHosts.includes(address);
    chk.disabled = pinned;
    label.appendChild(chk);
    label.appendChild(document.createTextNode(` ${labelText}`));
    li.appendChild(label);
    list.appendChild(li);
    return chk;
  };
  addRow('127.0.0.1', t('instances.network.localhost'), { pinned: true });
  const addrChecks = [];
  for (const i of ifaces) {
    if (i.address === '127.0.0.1' || i.internal) continue;
    addrChecks.push(addRow(i.address, `${i.iface} (${i.address})`));
  }
  const allIfacesChk = addRow('0.0.0.0', t('instances.network.allInterfaces'));
  const updateExclusivity = () => {
    for (const chk of addrChecks) {
      chk.disabled = allIfacesChk.checked;
      if (allIfacesChk.checked) chk.checked = false;
    }
    updateAppBindHostWarn();
  };
  for (const chk of [...addrChecks, allIfacesChk]) chk.addEventListener('change', updateExclusivity);
  updateExclusivity();
}

// Shared hwenc daemon: state line + manual restart (1.0.0-beta.4). Admin only on the backend; a
// non-admin just gets the 403 and the row stays hidden.
function formatDuration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} h ${m % 60} min` : `${Math.floor(h / 24)} d ${h % 24} h`;
}

async function loadHwencDaemonStatus() {
  const row = $('.hwenc-daemon-row');
  const line = $('#settings-hwenc-daemon-status');
  const btn = $('#settings-hwenc-daemon-restart');
  try {
    const st = await api('/settings/hwenc-daemon');
    row.hidden = false;
    if (st.adopted) {
      line.textContent = t('settings.hwencDaemon.adopted', { socket: st.socketPath });
      btn.disabled = true;
    } else if (!st.running) {
      line.textContent = t('settings.hwencDaemon.notRunning');
      btn.disabled = false;
    } else {
      line.textContent = t('settings.hwencDaemon.running', {
        uptime: st.startedAt ? formatDuration(Date.now() - new Date(st.startedAt).getTime()) : '?',
        rss: st.rssKb != null ? `${Math.round(st.rssKb / 1024)} MB` : '?',
      });
      btn.disabled = false;
    }
  } catch (e) {
    row.hidden = true;
  }
}

$('#settings-hwenc-daemon-restart').addEventListener('click', async () => {
  if (!confirm(t('settings.hwencDaemon.confirm'))) return;
  const btn = $('#settings-hwenc-daemon-restart');
  btn.disabled = true;
  $('#settings-hwenc-daemon-status').textContent = t('settings.hwencDaemon.restarting');
  try {
    await api('/settings/hwenc-daemon/restart', { method: 'POST' });
  } catch (e) {
    alert(e.message);
  }
  loadHwencDaemonStatus();
});

async function loadSettings() {
  try {
    const settings = await api('/settings');
    $('#settings-backup-dir').value = settings.backupDir;
    renderNetIfacesSettings(await api('/network/interfaces/all'));
    renderAppBindHostsList(settings.appBindHosts || [], await loadNetworkInterfacesCache());
    // Operator quotas (docs/ROADMAP.md Phase 7, 25/10/2026) only mean anything once there is
    // more than one person -- in "none" mode the only user is the always-admin bypass, which
    // never counts against any quota (src/lib/quotas.js), so the fieldset stays hidden there.
    const poolFieldset = $('#settings-operator-pool-fieldset');
    poolFieldset.hidden = AuthUi.authMode() === 'none';
    $('#settings-pool-max-vcpus').value = settings.operatorPoolMaxVcpus || '';
    $('#settings-pool-max-memory-mb').value = settings.operatorPoolMaxMemoryMb || '';
    $('#settings-encode-backend').value = settings.encodeBackend || '';
    $('#settings-adb-port-start').value = settings.adbPortStart || '';
    $('#settings-adb-port-end').value = settings.adbPortEnd || '';
    loadHwencDaemonStatus();
  } catch (e) {
    alert(e.message);
  }
}

// Both fields checked together regardless of which one the admin just edited -- unlike a
// single-port check (wireLivePortCheck above), a range is only meaningful as a pair. The
// 1-65535/start<=end shape check is the same one routes/settings.js's PUT also enforces, done
// here first only so a nonsense range never even reaches the host port lookup.
async function checkAdbPortRangeLive() {
  const warnEl = $('#settings-adb-port-range-warn');
  const start = Number($('#settings-adb-port-start').value || 5555);
  const end = Number($('#settings-adb-port-end').value || 5595);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > 65535 || start > end) {
    warnEl.hidden = false;
    warnEl.textContent = t('settings.adbPortRange.invalidRange');
    return;
  }
  try {
    const { taken } = await api(`/settings/adb-port-range-check?start=${start}&end=${end}`);
    if (taken.length === 0) { warnEl.hidden = true; warnEl.textContent = ''; return; }
    warnEl.hidden = false;
    warnEl.textContent = t('settings.adbPortRange.taken', { ports: taken.join(', ') });
  } catch (e) {
    warnEl.hidden = true; // a check that itself failed should never block saving
  }
}
{
  let rangeCheckTimer = null;
  const scheduleRangeCheck = () => { clearTimeout(rangeCheckTimer); rangeCheckTimer = setTimeout(checkAdbPortRangeLive, 400); };
  $('#settings-adb-port-start').addEventListener('input', scheduleRangeCheck);
  $('#settings-adb-port-end').addEventListener('input', scheduleRangeCheck);
  $('#settings-adb-port-start').addEventListener('blur', checkAdbPortRangeLive);
  $('#settings-adb-port-end').addEventListener('blur', checkAdbPortRangeLive);
}

$('#settings-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const saved = $('#settings-saved');
  saved.hidden = true;
  try {
    const backupDir = $('#settings-backup-dir').value;
    // Based on the CURRENT stored overrides, not a blank object -- this panel only ever
    // renders the interfaces that exist on the host right now, so an interface that is
    // temporarily absent (e.g. a VPN that is down) would otherwise silently lose its stored
    // override just because it had no checkbox to carry it forward this time.
    const current = await api('/settings');
    const networkInterfaceOverrides = { ...current.networkInterfaceOverrides };
    for (const chk of $$('#settings-net-ifaces-list input[type="checkbox"]')) {
      const heuristic = chk.dataset.heuristicVisible === 'true';
      if (chk.checked === heuristic) delete networkInterfaceOverrides[chk.dataset.iface];
      else networkInterfaceOverrides[chk.dataset.iface] = chk.checked;
    }
    const appBindHosts = $$('#settings-app-bind-hosts-list input[type="checkbox"]')
      .filter((chk) => chk.checked && chk.dataset.address !== '127.0.0.1')
      .map((chk) => chk.dataset.address);
    const vcpusVal = $('#settings-pool-max-vcpus').value;
    const memVal = $('#settings-pool-max-memory-mb').value;
    const adbStartVal = $('#settings-adb-port-start').value;
    const adbEndVal = $('#settings-adb-port-end').value;
    const settings = await api('/settings', {
      method: 'PUT',
      body: JSON.stringify({
        backupDir, networkInterfaceOverrides, appBindHosts,
        operatorPoolMaxVcpus: vcpusVal ? Number(vcpusVal) : null,
        operatorPoolMaxMemoryMb: memVal ? Number(memVal) : null,
        encodeBackend: $('#settings-encode-backend').value || null,
        adbPortStart: adbStartVal ? Number(adbStartVal) : null,
        adbPortEnd: adbEndVal ? Number(adbEndVal) : null,
      }),
    });
    $('#settings-backup-dir').value = settings.backupDir;
    $('#settings-encode-backend').value = settings.encodeBackend || '';
    $('#settings-adb-port-start').value = settings.adbPortStart || '';
    $('#settings-adb-port-end').value = settings.adbPortEnd || '';
    networkInterfacesCache = null; // the new filter (if changed above) applies to this list too, and to the per-instance Configure panel next time it opens
    renderAppBindHostsList(settings.appBindHosts || [], await loadNetworkInterfacesCache());
    saved.hidden = false;
  } catch (e) {
    alert(e.message);
  }
});

// Per-operator resource quota fields (docs/ROADMAP.md Phase 7, 25/10/2026, see src/lib/
// quotas.js) -- shown only on operator rows (admin has no limit, viewer can never create/
// configure an instance so a quota on one would never do anything). Fire-and-save on change,
// same pattern as the Identities role <select> just below: no separate "Save" button, empty =
// unlimited for that dimension. Shared by the "+ New local user" dialog and loadIdentities(), since quotas are
// keyed by user id regardless of which auth backend produced it.
function appendQuotaFields(li, userId, role, quotasById) {
  if (role !== 'operator') return;
  const q = quotasById.get(userId) || {};
  const vcpuInput = document.createElement('input');
  vcpuInput.type = 'number';
  vcpuInput.min = '1';
  vcpuInput.className = 'quota-input';
  vcpuInput.title = t('quotas.vcpuLabel');
  vcpuInput.placeholder = t('quotas.vcpuLabel');
  vcpuInput.value = q.maxVcpus || '';
  const ramInput = document.createElement('input');
  ramInput.type = 'number';
  ramInput.min = '1';
  ramInput.step = '256';
  ramInput.className = 'quota-input';
  ramInput.title = t('quotas.ramLabel');
  ramInput.placeholder = t('quotas.ramLabel');
  ramInput.value = q.maxMemoryMb || '';
  const save = async () => {
    try {
      await api(`/quotas/${encodeURIComponent(userId)}`, {
        method: 'PUT',
        body: JSON.stringify({
          maxVcpus: vcpuInput.value ? Number(vcpuInput.value) : null,
          maxMemoryMb: ramInput.value ? Number(ramInput.value) : null,
        }),
      });
    } catch (e) {
      alert(e.message);
    }
  };
  vcpuInput.addEventListener('change', save);
  ramInput.addEventListener('change', save);
  li.appendChild(vcpuInput);
  li.appendChild(ramInput);
}

// Unified identity management (docs/ROADMAP.md Phase 7, redesigned 26/10/2026) -- admin, any
// auth mode other than "none". One table for both local accounts and OIDC identities (see
// routes/auth.js's GET /identities -- each row carries `source: 'local'|'oidc'`), since they
// share the exact same role/quota concepts underneath. Only `source: 'local'` rows get an email
// field and a password-reset button; an OIDC row has neither (its password lives at the IdP,
// its email if any comes from the IdP's own claims, not stored here) and has no "new" dialog --
// it only exists once it has actually logged in (see routes/auth.js's /oidc/callback), an admin
// only ever approves/changes/revokes one that already showed up.
// Setup wizard (26/10/2026) -- "none" mode has no identities to manage, so loadIdentities()
// renders this instead: create the first local admin NOW (live, no restart -- see
// routes/auth.js's /setup/admin), then show the exact .env line + restart command and poll GET
// /me until a human has actually done that restart, rather than trying to flip
// REDROID_FORGE_AUTH and recreate this container from inside itself (see that route's own
// comment on why that is not worth the risk). The poll is the "check it took effect"; the login
// dialog that appears after the page reloads (authUi.js's normal gate, nothing special needed
// here) is the actual end-to-end validation -- if that login works, the whole chain (admin
// created + .env edited + container restarted) really worked.
let setupPollInterval = null;
async function renderSetupWizard(list) {
  clearInterval(setupPollInterval);
  setupPollInterval = null;
  $('#tab-identities .tab-intro').textContent = t('setup.intro');
  let status;
  try {
    status = await api('/auth/setup/status');
  } catch (e) {
    list.innerHTML = `<li class="fail-text">${t('common.error', { msg: e.message })}</li>`;
    return;
  }
  list.innerHTML = '';
  const li = document.createElement('li');

  if (status.localUsernames.length === 0) {
    const form = document.createElement('form');
    form.className = 'setup-form';
    const userInput = document.createElement('input');
    userInput.placeholder = t('setup.username');
    userInput.required = true;
    userInput.autocomplete = 'username';
    const passInput = document.createElement('input');
    passInput.type = 'password';
    passInput.placeholder = t('setup.password');
    passInput.required = true;
    passInput.autocomplete = 'new-password';
    const submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.textContent = t('setup.createAdmin');
    const errorEl = document.createElement('p');
    errorEl.className = 'fail-text';
    errorEl.hidden = true;
    form.append(userInput, passInput, submitBtn, errorEl);
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      errorEl.hidden = true;
      try {
        await api('/auth/setup/admin', {
          method: 'POST',
          body: JSON.stringify({ username: userInput.value, password: passInput.value }),
        });
        // Flips settings.json's authMode to "local" right away (PUT /api/auth/mode, 30/10/2026)
        // -- the admin row just created above is exactly what that route's "none -> local"
        // check requires, so this always succeeds here. No more manual .env edit: only a
        // restart is left, shown below.
        await api('/auth/mode', { method: 'PUT', body: JSON.stringify({ mode: 'local' }) });
        renderSetupWizard(list);
      } catch (e) {
        errorEl.hidden = false;
        errorEl.textContent = e.message;
      }
    });
    li.appendChild(form);
    list.appendChild(li);
    return;
  }

  const created = document.createElement('p');
  created.textContent = t('setup.adminCreated', { username: status.localUsernames.join(', ') });
  li.appendChild(created);

  // "restart", not "up -d" -- a mode/settings change lives in backend/data/settings.json (a
  // bind-mounted data file), never in .env or the image, so "up -d" sees no config diff and
  // does nothing at all (real gotcha hit live, 30/10/2026) -- only an actual restart re-reads it.
  const restartCmd = status.repoDir ? `cd ${status.repoDir} && docker compose restart` : 'docker compose restart';
  const savedRow = document.createElement('p');
  savedRow.textContent = t('setup.modeSaved');
  li.appendChild(savedRow);
  {
    const row = document.createElement('p');
    const code = document.createElement('code');
    code.textContent = restartCmd;
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'secondary';
    copyBtn.textContent = t('common.copy');
    copyBtn.addEventListener('click', () => navigator.clipboard.writeText(restartCmd).catch(() => {}));
    row.append(`${t('setup.restartLabel')} `, code, ' ', copyBtn);
    li.appendChild(row);
  }

  const waiting = document.createElement('p');
  waiting.className = 'muted';
  waiting.textContent = t('setup.waiting');
  li.appendChild(waiting);
  list.appendChild(li);

  setupPollInterval = setInterval(async () => {
    try {
      const me = await fetch('/api/auth/me').then((r) => r.json());
      if (me.authMode !== 'none') {
        clearInterval(setupPollInterval);
        waiting.className = '';
        waiting.textContent = t('setup.activated');
        const reloadBtn = document.createElement('button');
        reloadBtn.type = 'button';
        reloadBtn.textContent = t('setup.reloadNow');
        reloadBtn.addEventListener('click', () => window.location.reload());
        li.appendChild(reloadBtn);
      }
    } catch {
      // a transient fetch failure here just means the next tick tries again -- the container
      // may well be mid-restart right now, which is exactly the case this is waiting out.
    }
  }, 3000);
}

// Auth-mode switching + OIDC provider management (Identities panel, 30/10/2026) -- admin only
// (AuthUi.canManageSettings()), in every mode including "none" (the OIDC-providers half is
// useful to pre-populate before ever leaving "none"; see PUT /api/auth/mode's own comment on
// why "oidc" alone is never offered as a target here). Mode changes still need a restart (same
// "this container holds the Docker socket" reasoning as the setup wizard above) -- this reuses
// that exact poll-GET-/me-until-it-takes-effect pattern, generalized to any target mode instead
// of just "local".
const ALLOWED_MODE_TRANSITIONS_UI = { local: ['both', 'none'], both: ['local'] };
let authModePollInterval = null;

async function showAuthModeRestartNotice(resultEl, target) {
  clearInterval(authModePollInterval);
  authModePollInterval = null;
  const status = await api('/auth/setup/status').catch(() => ({}));
  // "restart", not "up -d" -- see renderSetupWizard's own comment on this same gotcha.
  const restartCmd = status.repoDir ? `cd ${status.repoDir} && docker compose restart` : 'docker compose restart';
  resultEl.hidden = false;
  resultEl.className = '';
  resultEl.innerHTML = '';
  const msg = document.createElement('p');
  msg.textContent = t('authmode.saved', { mode: target });
  const row = document.createElement('p');
  const code = document.createElement('code');
  code.textContent = restartCmd;
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'secondary';
  copyBtn.textContent = t('common.copy');
  copyBtn.addEventListener('click', () => navigator.clipboard.writeText(restartCmd).catch(() => {}));
  row.append(`${t('setup.restartLabel')} `, code, ' ', copyBtn);
  const waiting = document.createElement('p');
  waiting.className = 'muted';
  waiting.textContent = t('setup.waiting');
  resultEl.append(msg, row, waiting);

  authModePollInterval = setInterval(async () => {
    try {
      const me = await fetch('/api/auth/me').then((r) => r.json());
      if (me.authMode === target) {
        clearInterval(authModePollInterval);
        authModePollInterval = null;
        waiting.textContent = t('setup.activated');
        const reloadBtn = document.createElement('button');
        reloadBtn.type = 'button';
        reloadBtn.textContent = t('setup.reloadNow');
        reloadBtn.addEventListener('click', () => window.location.reload());
        resultEl.appendChild(reloadBtn);
      }
    } catch {
      // mid-restart, same as the setup wizard's own poll -- the next tick tries again.
    }
  }, 3000);
}

async function switchAuthMode(resultEl, current, target) {
  resultEl.hidden = false;
  resultEl.className = '';
  resultEl.textContent = '';
  if (target === 'none' && !confirm(t('authmode.confirmNone'))) return;
  try {
    await api('/auth/mode', {
      method: 'PUT',
      body: JSON.stringify({ mode: target, ...(target === 'none' ? { confirm: true } : {}) }),
    });
    await showAuthModeRestartNotice(resultEl, target);
  } catch (e) {
    resultEl.className = 'fail-text';
    resultEl.textContent = e.message;
  }
}

function buildAuthModeSection(mode) {
  const section = document.createElement('div');
  const badge = document.createElement('p');
  const strong = document.createElement('strong');
  strong.textContent = mode;
  badge.append(`${t('authmode.current')} `, strong);
  section.appendChild(badge);

  const resultEl = document.createElement('p');
  resultEl.hidden = true;

  const actions = document.createElement('div');
  actions.className = 'toolbar';
  for (const target of (ALLOWED_MODE_TRANSITIONS_UI[mode] || [])) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'secondary';
    btn.textContent = t(`authmode.switchTo.${target}`);
    btn.addEventListener('click', () => switchAuthMode(resultEl, mode, target));
    actions.appendChild(btn);
  }
  section.appendChild(actions);
  section.appendChild(resultEl);
  return section;
}

// Plain entry shape {id, label, issuerUrl, clientId, clientSecret} -- same fields
// addProvider/updateProvider validate server-side (src/lib/oidc.js). One inline form, reused
// for both "+ Add provider" and "Edit": editing locks the id field (it is the array key) and
// leaves clientSecret blank with a placeholder explaining that blank means "keep the current
// one" -- GET /auth/oidc-providers never hands a secret back out to fill it with (see
// routes/auth.js's own comment on that route).
function buildOidcProviderForm({ existing, onDone }) {
  const form = document.createElement('form');
  form.className = 'setup-form';
  const idInput = document.createElement('input');
  idInput.placeholder = t('oidcProviders.idPlaceholder');
  idInput.required = true;
  idInput.disabled = !!existing;
  idInput.value = existing ? existing.id : '';
  const labelInput = document.createElement('input');
  labelInput.placeholder = t('oidcProviders.labelPlaceholder');
  labelInput.required = true;
  labelInput.value = existing ? existing.label : '';
  const issuerInput = document.createElement('input');
  issuerInput.placeholder = t('oidcProviders.issuerPlaceholder');
  issuerInput.required = true;
  issuerInput.value = existing ? existing.issuerUrl : '';
  const clientIdInput = document.createElement('input');
  clientIdInput.placeholder = t('oidcProviders.clientIdPlaceholder');
  clientIdInput.required = true;
  clientIdInput.value = existing ? existing.clientId : '';
  const secretInput = document.createElement('input');
  secretInput.type = 'password';
  secretInput.autocomplete = 'off';
  secretInput.placeholder = existing ? t('oidcProviders.secretKeepPlaceholder') : t('oidcProviders.secretPlaceholder');
  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.textContent = existing ? t('oidcProviders.save') : t('oidcProviders.add');
  const errorEl = document.createElement('p');
  errorEl.className = 'fail-text';
  errorEl.hidden = true;
  form.append(idInput, labelInput, issuerInput, clientIdInput, secretInput, submitBtn, errorEl);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    errorEl.hidden = true;
    const body = { id: idInput.value, label: labelInput.value, issuerUrl: issuerInput.value, clientId: clientIdInput.value };
    if (secretInput.value) body.clientSecret = secretInput.value;
    try {
      if (existing) {
        await api(`/auth/oidc-providers/${encodeURIComponent(existing.id)}`, { method: 'PUT', body: JSON.stringify(body) });
      } else {
        await api('/auth/oidc-providers', { method: 'POST', body: JSON.stringify(body) });
      }
      onDone();
    } catch (e) {
      errorEl.hidden = false;
      errorEl.textContent = e.message;
    }
  });
  return form;
}

async function buildOidcProvidersSection() {
  const section = document.createElement('div');
  const heading = document.createElement('p');
  heading.innerHTML = '';
  const strongHeading = document.createElement('strong');
  strongHeading.textContent = t('oidcProviders.heading');
  heading.appendChild(strongHeading);
  section.appendChild(heading);

  const listEl = document.createElement('ul');
  listEl.className = 'doctor-list';
  section.appendChild(listEl);

  const formHolder = document.createElement('div');
  section.appendChild(formHolder);

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.textContent = t('oidcProviders.new');

  async function refresh() {
    listEl.innerHTML = `<li class="muted">${t('common.loading')}</li>`;
    formHolder.innerHTML = '';
    let providers;
    try {
      providers = await api('/auth/oidc-providers');
    } catch (e) {
      listEl.innerHTML = `<li class="fail-text">${t('common.error', { msg: e.message })}</li>`;
      return;
    }
    listEl.innerHTML = '';
    if (providers.length === 0) listEl.innerHTML = `<li class="muted">${t('oidcProviders.none')}</li>`;
    for (const p of providers) {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = `${p.label} (${p.id}) — ${p.issuerUrl}`;
      li.appendChild(label);

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'secondary';
      editBtn.textContent = t('oidcProviders.edit');
      editBtn.addEventListener('click', () => {
        formHolder.innerHTML = '';
        formHolder.appendChild(buildOidcProviderForm({ existing: p, onDone: refresh }));
      });
      li.appendChild(editBtn);

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'secondary';
      delBtn.textContent = t('identities.delete');
      delBtn.addEventListener('click', async () => {
        if (!confirm(t('oidcProviders.deleteConfirm', { label: p.label }))) return;
        try {
          await api(`/auth/oidc-providers/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
          refresh();
        } catch (e) {
          alert(e.message);
        }
      });
      li.appendChild(delBtn);
      listEl.appendChild(li);
    }
  }

  addBtn.addEventListener('click', () => {
    formHolder.innerHTML = '';
    formHolder.appendChild(buildOidcProviderForm({ existing: null, onDone: refresh }));
  });
  section.appendChild(addBtn);

  await refresh();
  return section;
}

async function renderAuthModePanel() {
  const panel = $('#auth-mode-panel');
  if (!AuthUi.canManageSettings()) { panel.hidden = true; return; }
  panel.hidden = false;
  panel.innerHTML = '';
  clearInterval(authModePollInterval);
  authModePollInterval = null;
  const mode = AuthUi.authMode();
  if (mode !== 'none') panel.appendChild(buildAuthModeSection(mode));
  panel.appendChild(await buildOidcProvidersSection());
}

async function loadIdentities() {
  const list = $('#identities-list');
  list.innerHTML = `<li class="muted">${t('common.loading')}</li>`;
  $('#btn-new-user').hidden = !AuthUi.localEnabled();
  if (AuthUi.authMode() === 'none') {
    renderAuthModePanel(); // mode-switch buttons stay hidden for "none"; OIDC providers CRUD still shows
    return renderSetupWizard(list);
  }
  clearInterval(setupPollInterval);
  setupPollInterval = null;
  $('#tab-identities .tab-intro').textContent = t('identities.intro');
  renderAuthModePanel();
  try {
    const [identities, quotas, providers] = await Promise.all([
      api('/auth/identities'), api('/quotas'), fetch('/api/auth/oidc/providers').then((r) => (r.ok ? r.json() : [])),
    ]);
    const quotasById = new Map(quotas.map((q) => [q.userId, q]));
    list.innerHTML = '';
    if (identities.length === 0) list.innerHTML = `<li class="muted">${t('identities.none')}</li>`;
    for (const idn of identities) {
      const li = document.createElement('li');
      const label = document.createElement('span');
      const sourceTag = idn.source === 'local' ? t('identities.source.local') : (idn.providerLabel || idn.providerId || '?');
      const who = `${idn.username} [${sourceTag}]`;
      label.textContent = idn.role ? `${who} (${idn.role})` : `${who} — ${t('identities.pending')}`;
      li.appendChild(label);

      if (idn.source === 'local') {
        const emailInput = document.createElement('input');
        emailInput.type = 'email';
        emailInput.placeholder = t('identities.emailPlaceholder');
        emailInput.value = idn.email || '';
        emailInput.addEventListener('change', async () => {
          try {
            await api(`/auth/identities/${encodeURIComponent(idn.id)}/email`, {
              method: 'PUT',
              body: JSON.stringify({ email: emailInput.value || null }),
            });
          } catch (e) {
            alert(e.message);
            emailInput.value = idn.email || '';
          }
        });
        li.appendChild(emailInput);
      }

      const roleSelect = document.createElement('select');
      // A local row always has a role from creation -- '' (pending) only makes sense for an
      // OIDC row that has never been approved yet.
      const roleOptions = idn.source === 'local' ? ['viewer', 'operator', 'admin'] : ['', 'viewer', 'operator', 'admin'];
      for (const value of roleOptions) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = value || t('identities.pending');
        roleSelect.appendChild(opt);
      }
      roleSelect.value = idn.role || '';
      roleSelect.addEventListener('change', async () => {
        try {
          await api(`/auth/identities/${encodeURIComponent(idn.id)}/role`, {
            method: 'PUT',
            body: JSON.stringify({ role: roleSelect.value || null }),
          });
          loadIdentities();
        } catch (e) {
          alert(e.message);
          roleSelect.value = idn.role || '';
        }
      });
      li.appendChild(roleSelect);
      appendQuotaFields(li, idn.id, idn.role, quotasById);

      if (idn.source === 'local') {
        const resetBtn = document.createElement('button');
        resetBtn.type = 'button';
        resetBtn.className = 'secondary';
        resetBtn.textContent = t('identities.resetPassword');
        resetBtn.addEventListener('click', async () => {
          const password = prompt(t('identities.resetPasswordPrompt', { username: idn.username }));
          if (!password) return;
          try {
            await api(`/auth/identities/${encodeURIComponent(idn.id)}/password`, {
              method: 'PUT',
              body: JSON.stringify({ password }),
            });
          } catch (e) {
            alert(e.message);
          }
        });
        li.appendChild(resetBtn);
      }

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'secondary';
      delBtn.textContent = t('identities.delete');
      delBtn.disabled = AuthUi.currentUser() && AuthUi.currentUser().id === idn.id;
      delBtn.addEventListener('click', async () => {
        if (!confirm(t('identities.deleteConfirm', { username: idn.username }))) return;
        try {
          await api(`/auth/identities/${encodeURIComponent(idn.id)}`, { method: 'DELETE' });
          loadIdentities();
        } catch (e) {
          alert(e.message);
        }
      });
      li.appendChild(delBtn);
      list.appendChild(li);

      // Linked login methods (26/10/2026, see routes/auth.js's accountLinks.js-backed routes)
      // -- only a `local` row can be a link anchor. Adding a link is self-service only (own
      // row, proven by actually logging into that provider right now, see /me/links/:id/start);
      // an admin viewing someone else's row can still see/revoke, never add on their behalf.
      if (idn.source === 'local') {
        const isOwnRow = AuthUi.currentUser() && AuthUi.currentUser().id === idn.id;
        const linksLi = document.createElement('li');
        linksLi.className = 'identity-links';
        try {
          const links = await api(`/auth/identities/${encodeURIComponent(idn.id)}/links`);
          for (const lnk of links) {
            const tag = document.createElement('span');
            tag.className = 'muted';
            tag.textContent = `↳ ${lnk.username} [${lnk.providerLabel || lnk.providerId}]`;
            linksLi.appendChild(tag);
            const unlinkBtn = document.createElement('button');
            unlinkBtn.type = 'button';
            unlinkBtn.className = 'secondary';
            unlinkBtn.textContent = t('identities.unlink');
            unlinkBtn.addEventListener('click', async () => {
              try {
                await api(`/auth/identities/${encodeURIComponent(idn.id)}/links/${encodeURIComponent(lnk.externalId)}`, { method: 'DELETE' });
                loadIdentities();
              } catch (e) {
                alert(e.message);
              }
            });
            linksLi.appendChild(unlinkBtn);
          }
          if (isOwnRow) {
            for (const p of providers) {
              if (links.some((lnk) => lnk.providerId === p.id)) continue;
              const linkA = document.createElement('a');
              linkA.className = 'link-btn';
              linkA.href = `/api/auth/me/links/${encodeURIComponent(p.id)}/start`;
              linkA.textContent = t('identities.linkProvider', { provider: p.label });
              linksLi.appendChild(linkA);
            }
          }
          if (links.length === 0 && (!isOwnRow || providers.length === 0)) {
            const none = document.createElement('span');
            none.className = 'muted';
            none.textContent = t('identities.noLinks');
            linksLi.appendChild(none);
          }
        } catch (e) {
          linksLi.innerHTML = `<span class="fail-text">${t('common.error', { msg: e.message })}</span>`;
        }
        list.appendChild(linksLi);
      }
    }
  } catch (e) {
    list.innerHTML = `<li class="fail-text">${t('common.error', { msg: e.message })}</li>`;
  }
}

const newUserDialog = $('#new-user-dialog');
$('#btn-new-user').addEventListener('click', () => newUserDialog.showModal());
$('#btn-cancel-new-user').addEventListener('click', () => newUserDialog.close());
$('#new-user-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const form = ev.target;
  try {
    await api('/auth/identities', {
      method: 'POST',
      body: JSON.stringify({
        username: form.username.value, password: form.password.value, role: form.role.value, email: form.email.value || null,
      }),
    });
    form.reset();
    newUserDialog.close();
    loadIdentities();
  } catch (e) {
    alert(e.message);
  }
});

const DOCTOR_STATUS_ORDER = { fail: 0, warn: 1, ok: 2 };

async function loadDoctor() {
  const list = $('#doctor-list');
  list.innerHTML = `<li>${t('doctor.running')}</li>`;
  try {
    const checks = await api('/doctor');
    // Worst first (15/11/2026, explicit ask): what needs attention should never be buried below
    // a page of green checks. A stable sort, so checks that tie on status keep the backend's own
    // order among themselves (whatever sequence doctor.js runs them in) rather than reshuffling
    // for no reason -- Array.prototype.sort is spec-guaranteed stable since ES2019.
    const sorted = checks.slice().sort((a, b) => (DOCTOR_STATUS_ORDER[a.status] ?? 1) - (DOCTOR_STATUS_ORDER[b.status] ?? 1));
    list.innerHTML = '';
    for (const c of sorted) {
      const li = document.createElement('li');
      li.className = 'doctor-item';
      li.innerHTML = `
        <div class="label"><span class="status-dot ${c.status}"></span> ${c.label || c.id}</div>
        <p class="detail">${c.detail || ''}</p>
        ${c.fix ? `<pre>${c.fix.replace(/</g, '&lt;')}</pre>` : ''}
      `;
      // Known-combinations database (1.0.0-beta.4): the check looks for a newer signed database
      // when the Doctor runs; if there is one, offer to apply it right here (admin only on the
      // backend -- a non-admin just gets the error message).
      if (c.id === 'known-db' && c.updateAvailable) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = t('doctor.knownDb.update', { serial: c.remoteSerial });
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          btn.textContent = t('doctor.knownDb.updating');
          try {
            const r = await api('/db/update', { method: 'POST' });
            alert(t('doctor.knownDb.updated', { serial: r && r.serial != null ? r.serial : c.remoteSerial }));
          } catch (e) {
            alert(e.message);
          }
          loadDoctor();
          loadInstances({ silent: true }); // support levels come from this database
        });
        li.appendChild(btn);
      }
      list.appendChild(li);
    }
  } catch (e) {
    list.innerHTML = `<li>${t('common.error', { msg: e.message })}</li>`;
  }
}

$('#btn-refresh-instances').addEventListener('click', loadInstances);
ScrcpyLauncher.init({
  button: $('#btn-scrcpy-launcher'),
  dialogEl: $('#scrcpy-launcher-dialog'),
  changed: () => loadInstances({ silent: true }),
});
$('#btn-refresh-modules').addEventListener('click', loadModules);
$('#btn-refresh-user-modules').addEventListener('click', loadUserModulesTab);
$('#btn-refresh-identities').addEventListener('click', loadIdentities);
$('#btn-run-doctor').addEventListener('click', loadDoctor);

const dialog = $('#new-instance-dialog');
// Hardware encode (hwenc) and decode (hwdec) are two independent options of the instance (see
// the real asymmetry in hwAccel.js: encode is AMD/Intel-only, decode also works on NVIDIA via
// a different driver, and the two have caused a real reproducible hang together on at least
// one AMD GPU -- see both modules' manifests). Neither defaults to checked: this is a public,
// installable project, and a fresh install should just work out of the box without the user
// having to accept anything (same reasoning as gpuMode defaulting to guest) -- turning either
// of these on is an explicit, informed choice, never a silent default. Offered only when the
// chosen image includes the underlying infra AND the CURRENTLY SELECTED gpuMode is "host" (the
// gpu-mode select lives in the same form, see new.gpuMode) AND this host's GPU vendor supports
// that specific capability; otherwise the checkbox is disabled and says why, instead of
// letting the create fail afterwards.
//
// venus3d stays opt-in like the two above -- never auto-checked, same "explicit informed
// choice" reasoning. The one difference: on an NVIDIA host, plain gpuMode=host without it is a
// known-broken combination (stock GBM/Mesa gralloc crash-loops SurfaceFlinger, see the module's
// own README), not just an optional capability you can skip -- so instead of the normal "Ok"
// status it shows a "not recommended" warning for as long as the box stays unticked (see the
// venus3d-specific branch in refreshHwAccelOption below, and the change listener right after
// this dialog's other new-instance-form listeners). Found for real 01/11/2026: an instance
// switched to host without it hit exactly that crash loop.
let imagesById = {};
function hwAccelElements(id) {
  return { chk: $(`#chk-${id}`), status: $(`#${id}-status`) };
}
function setHwAccel(id, { enabled, text, tone }) {
  const { chk, status } = hwAccelElements(id);
  chk.disabled = !enabled;
  if (!enabled) chk.checked = false;
  status.hidden = !text;
  status.className = tone || 'muted';
  status.textContent = text || '';
}
async function refreshHwAccelOption(id) {
  const img = imagesById[$('#image-select').value];
  if (!img) { setHwAccel(id, { enabled: false }); return; }
  if (!img.hwEncCapable) {
    setHwAccel(id, { enabled: false, text: t(`new.${id}NoImage`), tone: 'muted' });
    return;
  }
  const effectiveGpuMode = $('#new-instance-form').gpuMode.value || img.gpuMode;
  if (effectiveGpuMode !== 'host') {
    setHwAccel(id, { enabled: false, text: t(`new.${id}NeedsHost`), tone: 'muted' });
    if (id === 'venus3d') venus3dLastCheck = null;
    return;
  }
  // setHwAccel's "Checking..." step below unconditionally sets checked=false (enabled=false
  // clears it) -- captured here, before that happens, so venus3d's own warn-vs-ok text can
  // still tell whether the user had it ticked.
  const wasChecked = hwAccelElements(id).chk.checked;
  setHwAccel(id, { enabled: false, text: t(`new.${id}Checking`), tone: 'muted' });
  try {
    const m = await api(`/modules/${id}?imageId=${encodeURIComponent(img.id)}`);
    if (imagesById[$('#image-select').value] !== img) return; // another image was chosen meanwhile
    if (m.hostCompatible === false) {
      setHwAccel(id, { enabled: false, text: t(`new.${id}NoHost`, { reason: m.hostIncompatibilityReason }), tone: 'warn-text' });
      if (id === 'venus3d') venus3dLastCheck = null;
    } else if (id === 'venus3d') {
      setHwAccel(id, { enabled: true, text: '', tone: 'muted' });
      hwAccelElements(id).chk.checked = wasChecked;
      venus3dLastCheck = m;
      updateVenus3dStatus();
    } else {
      setHwAccel(id, { enabled: true, text: t(`new.${id}Ok`, { vendor: m.hostGpuVendor || '?' }), tone: 'ok-text' });
    }
  } catch (e) {
    setHwAccel(id, { enabled: false, text: t('common.error', { msg: e.message }), tone: 'fail-text' });
  }
}
// Cache of the last successful /modules/venus3d check in this dialog session (null once gpuMode
// leaves host, or the host isn't NVIDIA) -- lets the checkbox's own change listener redraw the
// warn-vs-ok status text instantly, without a round trip through the function above, which would
// otherwise fight the very click that triggered it (its "Checking..." step force-unchecks the
// box, same as hwdec/hwenc; see wasChecked above for why that matters here).
let venus3dLastCheck = null;
function updateVenus3dStatus() {
  if (!venus3dLastCheck) return;
  const { chk, status } = hwAccelElements('venus3d');
  status.hidden = false;
  if (chk.checked) {
    status.className = 'ok-text';
    status.textContent = t('new.venus3dOk', { vendor: venus3dLastCheck.hostGpuVendor || '?' });
  } else {
    status.className = 'fail-text';
    status.textContent = t('new.venus3dRecommendedWarn');
  }
}
// Encode is a single select (none/hwenc/nvenc), not a checkbox like hwdec: hwenc and nvenc are
// still mutually exclusive by host GPU vendor (hwenc: AMD/Intel, needs gpuMode=host; nvenc:
// NVIDIA). Unlike before 31/10/2026, nvenc no longer needs gpuMode=guest specifically -- its own
// manifest now accepts both "guest" (standalone, a plain memfd transport) and "host" (together
// with the venus3d module active, a real dma-buf import instead -- see nvenc's own README), so on
// an NVIDIA host it is compatible with whichever gpuMode is live either way. Whichever vendor this
// host does NOT have is hidden outright (it will never work on this hardware, not merely "needs a
// setting changed"); the one that does apply is only disabled, with a hint, when gpuMode does not
// match ANY of its compatibleCon.gpuMode values -- that is a live, user-adjustable choice, in
// either form that uses this (the new-instance dialog and the per-instance Configure panel, see
// buildRestartEditRow).
//
// gpuMode here must already be the EFFECTIVE value ('host'/'guest', never '' / image-default) --
// callers resolve that themselves, since what "default" means differs between the two forms.
// Compared against `compatibleCon.gpuMode` from the API response (the manifest's own declared
// requirement) rather than its `compatible` field: that field is computed server-side against
// the catalog image's own DEFAULT gpuMode, not whatever the user has live-selected in the form.
// `isStale`, if given, is checked right after the API calls resolve (before touching the DOM)
// so a caller whose own selection can change while this is in flight (the new-instance dialog's
// image picker) can bail out instead of applying a now-outdated result.
async function updateEncodeSelect({ select, optHwenc, optNvenc, status, imageId, hwEncCapable, gpuMode, isStale }) {
  const setStatus = (text, tone) => {
    status.hidden = !text;
    status.className = tone || 'muted';
    status.textContent = text || '';
  };
  if (!imageId || !hwEncCapable) {
    optHwenc.hidden = true;
    optNvenc.hidden = true;
    select.value = '';
    select.disabled = true;
    setStatus(imageId ? t('new.encodeNoImage') : '', 'muted');
    return;
  }
  select.disabled = false;
  setStatus(t('new.hwencChecking'), 'muted');
  let hwenc;
  let nvenc;
  try {
    [hwenc, nvenc] = await Promise.all([
      api(`/modules/hwenc?imageId=${encodeURIComponent(imageId)}`),
      api(`/modules/nvenc?imageId=${encodeURIComponent(imageId)}`),
    ]);
  } catch (e) {
    setStatus(t('common.error', { msg: e.message }), 'fail-text');
    return;
  }
  if (isStale && isStale()) return;

  optHwenc.hidden = !hwenc.hostCompatible;
  optNvenc.hidden = !nvenc.hostCompatible;
  optHwenc.disabled = optHwenc.hidden || !hwenc.compatibleCon.gpuMode.includes(gpuMode);
  optNvenc.disabled = optNvenc.hidden || !nvenc.compatibleCon.gpuMode.includes(gpuMode);
  if ((select.value === 'hwenc' && optHwenc.disabled) || (select.value === 'nvenc' && optNvenc.disabled)) {
    select.value = '';
  }

  if (optHwenc.hidden && optNvenc.hidden) {
    setStatus(t('new.encodeNoVendor'), 'muted');
  } else if (!optHwenc.hidden && optHwenc.disabled) {
    setStatus(t('new.hwencNeedsHost'), 'warn-text');
  } else if (!optNvenc.hidden && optNvenc.disabled) {
    setStatus(t('new.nvencNeedsGuest'), 'warn-text');
  } else if (!optHwenc.hidden && !optHwenc.disabled && hwenc.encodeBackendWarning) {
    // Known risky backend/GPU combination (hwAccel.encodeBackendRisk, symmetric: ffmpeg on
    // Polaris, legacy on Intel) -- shown, never blocked (same "warns, does not gate" philosophy
    // as docs/KNOWN-COMBINATIONS.md). The option stays enabled and selectable.
    setStatus(hwenc.encodeBackendWarning, 'warn-text');
  } else {
    setStatus(t('new.hwencOk', { vendor: hwenc.hostGpuVendor || nvenc.hostGpuVendor || '?' }), 'ok-text');
  }
}
async function refreshEncodeOption() {
  const img = imagesById[$('#image-select').value];
  if (!img) {
    await updateEncodeSelect({
      select: $('#select-encode'), optHwenc: $('#opt-encode-hwenc'), optNvenc: $('#opt-encode-nvenc'),
      status: $('#encode-status'), imageId: null, hwEncCapable: false, gpuMode: null,
    });
    return;
  }
  const effectiveGpuMode = $('#new-instance-form').gpuMode.value || img.gpuMode;
  await updateEncodeSelect({
    select: $('#select-encode'), optHwenc: $('#opt-encode-hwenc'), optNvenc: $('#opt-encode-nvenc'),
    status: $('#encode-status'), imageId: img.id, hwEncCapable: img.hwEncCapable, gpuMode: effectiveGpuMode,
    isStale: () => imagesById[$('#image-select').value] !== img,
  });
}
// nvenc + venus3d together is a known-broken combination (01/11/2026: crashed the Android
// guest's own system_server under load, root cause not yet found) -- not blocked (an instance
// dedicated to diagnosing it is a legitimate reason to pick it anyway, same reasoning as the
// venus3d-without-host warning), just flagged loudly whenever both are selected together.
function refreshNvencVenus3dWarn() {
  const warn = $('#nvenc-venus3d-warn');
  warn.hidden = !($('#select-encode').value === 'nvenc' && $('#chk-venus3d').checked);
}
async function refreshHwencOption() {
  await Promise.all([refreshEncodeOption(), refreshHwAccelOption('hwdec'), refreshHwAccelOption('venus3d')]);
  refreshNvencVenus3dWarn();
}
$('#image-select').addEventListener('change', refreshHwencOption);
$('#new-instance-form').gpuMode.addEventListener('change', refreshHwencOption);
$('#chk-venus3d').addEventListener('change', () => { updateVenus3dStatus(); refreshNvencVenus3dWarn(); });
$('#select-encode').addEventListener('change', refreshNvencVenus3dWarn);

// Checked ids survive a re-render of #user-modules-list (see loadUserModules below) -- cleared
// only when a creation actually succeeds (createInstance's success path), not on every dialog
// close, so a retry after an unrelated error keeps the selection the user already made.
const checkedUserModuleIds = new Set();

// User modules (stage 7, see moduleRunner.js/moduleScheduler.js) are a separate category from the
// generic per-instance capabilities above (hwenc/gapps/arm) -- they automate ONE specific
// game/situation (CIFI today), not a capability any instance might want, so they get their own
// fieldset instead of being flat-listed next to the others (explicit feedback from the user,
// 22/10/2026). Discovered dynamically from the real module catalog (filtered by etapa including 7)
// instead of hardcoding "cifi" by name, so a future second one shows up here with no frontend change.
async function loadUserModules() {
  const box = $('#user-modules-list');
  box.textContent = t('common.loading');
  try {
    const modules = (await api('/modules')).filter((m) => Array.isArray(m.etapa) && m.etapa.includes(7));
    if (modules.length === 0) {
      box.innerHTML = `<span class="muted">${t('new.noUserModules')}</span>`;
      return;
    }
    // Re-checks whatever was already ticked before this re-render (checkedUserModuleIds, updated
    // on every change below) -- without this, reopening the dialog (e.g. to retry after an
    // unrelated error on a previous attempt) silently drops the selection back to nothing, with
    // no visual cue that it happened. Found for real 22/10/2026: a user retried after an
    // unrelated hwenc-artifacts error and the instance was created without CIFI, which they had
    // ticked on the earlier attempt.
    box.innerHTML = modules.map((m) => `
      <label class="contract-checkbox">
        <input type="checkbox" class="user-module-chk" data-id="${m.id}" ${checkedUserModuleIds.has(m.id) ? 'checked' : ''} />
        <span>${loc(m, 'nombre')}</span>
      </label>
    `).join('');
    for (const chk of box.querySelectorAll('.user-module-chk')) {
      chk.addEventListener('change', () => {
        if (chk.checked) checkedUserModuleIds.add(chk.dataset.id);
        else checkedUserModuleIds.delete(chk.dataset.id);
      });
    }
  } catch (e) {
    box.innerHTML = `<span class="fail-text">${t('common.error', { msg: e.message })}</span>`;
  }
}

$('#btn-new-instance').addEventListener('click', async () => {
  const select = $('#image-select');
  select.innerHTML = `<option>${t('common.loading')}</option>`;
  try {
    const images = await api('/images');
    imagesById = Object.fromEntries(images.map((i) => [i.id, i]));
    select.innerHTML = images
      .map((img) => {
        const tier = img.soporte === 'oficial' ? t('image.official') : t('image.community');
        const notPresent = img.present ? '' : t('image.notPresent');
        return `<option value="${img.id}" ${img.present ? '' : 'disabled'} title="${loc(img, 'notaSoporte') || ''}">${loc(img, 'label')} — ${tier}${notPresent}</option>`;
      })
      .join('');
    // Found live (15/11/2026): with no explicit selection the browser just lands on whichever
    // <option> is FIRST in images.json's own order (android-11-official, there only for HIDL
    // hwenc evaluation, community support, no Opus audio) -- not a deliberate default, just an
    // accident of list order. Default to the "oficial" tier instead (android-15-official today),
    // by that flag rather than a hardcoded id, so this keeps pointing at whichever image earns
    // that tier if it ever changes. Falls back to the first present image if somehow none is
    // "oficial" yet (e.g. a fresh host that hasn't pulled it).
    const preferred = images.find((img) => img.soporte === 'oficial' && img.present) || images.find((img) => img.present);
    if (preferred) select.value = preferred.id;
  } catch (e) {
    select.innerHTML = `<option>${t('common.error', { msg: e.message })}</option>`;
  }
  $('#chk-gapps').checked = false;
  $('#chk-arm').checked = false;
  $('#chk-aurora-store').checked = false;
  $('#select-encode').value = '';
  $('#chk-hwdec').checked = false;
  $('#chk-venus3d').checked = false;
  venus3dNudged = false;
  $('#chk-wifi-interno').checked = false;
  resetGappsStatus();
  dialog.showModal();
  refreshHwencOption();
  loadUserModules();
});
$('#btn-cancel-new-instance').addEventListener('click', () => dialog.close());

// Phase 4 gate: if the backend answers 428 with the pending manifests
// (see moduleGate.js), it shows the generic contract modal(s) before
// retrying -- the backend never creates the instance without that acceptance.
async function createInstance(name, imageId, form, modules, display) {
  try {
    await api('/instances', { method: 'POST', body: JSON.stringify({ name, imageId, modules, ...display }) });
    dialog.close();
    form.reset();
    resetGappsStatus();
    checkedUserModuleIds.clear();
    await loadInstances();
  } catch (err) {
    if (err.status === 428 && err.modules) {
      let allAccepted;
      try {
        allAccepted = await Contracts.ensureAccepted(err.modules);
      } catch (acceptErr) {
        alert(acceptErr.message);
        return;
      }
      if (allAccepted) {
        await createInstance(name, imageId, form, modules, display);
      }
      return;
    }
    alert(err.message);
  }
}

$('#new-instance-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const name = normalizeInstanceName(form.name.value);
  const imageId = form.imageId.value;
  // The list is explicit: what is not ticked/selected is not installed (that is how hwenc/nvenc
  // is opted out of). form.encode.value is '' (none), 'hwenc', or 'nvenc' -- the two encode
  // mechanisms are mutually exclusive, never both pushed.
  const modules = [];
  if (form.encode.value) modules.push(form.encode.value);
  if (form.hwdec.checked) modules.push('hwdec');
  if (form.venus3d.checked) modules.push('venus3d');
  if (form.gapps.checked) modules.push('gapps');
  if (form.arm.checked) modules.push('arm-translation');
  if (form.auroraStore.checked) modules.push('aurora-store');
  if (form.wifiInterno.checked) modules.push('wifi-interno');
  for (const chk of $$('.user-module-chk')) if (chk.checked) modules.push(chk.dataset.id);
  const display = {
    width: Number(form.width.value), height: Number(form.height.value), dpi: Number(form.dpi.value), fps: Number(form.fps.value),
  };
  // Empty = no limit (the backend's own default, see instanceParams.parseResources) -- only sent
  // when the user actually typed something.
  if (form.memoryMb.value) display.memoryMb = Number(form.memoryMb.value);
  if (form.cpusetCpus.value) display.cpusetCpus = form.cpusetCpus.value;
  // Empty option = the image's own default, same as never sending it (see instanceParams.parseGpuMode).
  if (form.gpuMode.value) display.gpuMode = form.gpuMode.value;
  // Empty = auto-allocated (portAllocator.nextPort()), same as never sending it.
  if (form.adbPort.value) display.adbPort = Number(form.adbPort.value);
  await createInstance(name, imageId, form, modules, display);
});

wireLivePortCheck($('#new-instance-adb-port'), $('#new-instance-adb-port-warn'), async (value) => {
  if (!value) return null; // empty = auto-assigned, nothing to check yet
  const status = await api(`/instances/adb-port-check?port=${encodeURIComponent(value)}`);
  if (status.free) return null;
  return status.usedBy === 'host'
    ? t('instances.adbPort.inUseHost')
    : t('instances.adbPort.inUseInstance', { name: status.usedBy.slice('instance:'.length) });
});

// Options whose files the user provides (GApps, ARM translation): when one is ticked, the backend
// verifies the files right away (the same verification the module does when injecting) so a missing
// folder is known before the contract is shown, not after.
function fileModuleOption({
  chk, status, endpoint, label,
}) {
  const reset = () => { status.hidden = true; status.textContent = ''; };
  chk.addEventListener('change', async () => {
    if (!chk.checked) { reset(); return; }
    status.hidden = false;
    status.className = 'muted';
    status.textContent = t('new.filesChecking', { what: label });
    try {
      const st = await api(endpoint);
      if (!chk.checked) return; // it was unticked while checking
      if (st.ok) {
        status.className = st.supported ? 'ok-text' : 'warn-text';
        status.textContent = t('new.filesOk', { pkg: st.packageId || label, n: st.files })
          + (st.supported ? '' : t('new.filesUnsupported'));
      } else {
        status.className = 'fail-text';
        status.textContent = t('new.filesMissing', { what: label, msg: st.message });
      }
    } catch (e) {
      status.className = 'fail-text';
      status.textContent = t('common.error', { msg: e.message });
    }
  });
  return reset;
}
const resetGapps = fileModuleOption({
  chk: $('#chk-gapps'), status: $('#gapps-status'), endpoint: '/modules/gapps/status', label: 'GApps',
});
const resetArm = fileModuleOption({
  chk: $('#chk-arm'), status: $('#arm-status'), endpoint: '/modules/arm-translation/status', label: 'ARM translation',
});
function resetGappsStatus() { resetGapps(); resetArm(); }

// Language: static texts are applied from the I18n table; dynamic views are re-rendered on change.
const langBtn = $('#btn-lang');
// Shows the CURRENT language, not the one clicking it switches to -- the
// opposite convention (showing the destination) read as confusing in
// practice: a user sees Spanish content + a button labeled "EN" and reads it
// as "currently in English", not "click to switch to English".
function syncLangButton() { langBtn.textContent = I18n.lang.toUpperCase(); }
langBtn.addEventListener('click', () => I18n.setLang(I18n.lang === 'es' ? 'en' : 'es'));
document.addEventListener('langchange', () => {
  syncLangButton();
  const active = $('.tab-btn.active');
  if (active) switchTab(active.dataset.tab);
});
I18n.apply();
syncLangButton();

// Everything below waits on AuthUi.ready (docs/ROADMAP.md Phase 7): in "none" mode it resolves
// immediately with the fixed admin bypass user, so this changes nothing from before Phase 7; in
// "local"/"oidc" mode it only resolves once there is an actual logged-in user, so nothing here
// ever races a still-open login dialog.
AuthUi.ready.then(() => {
  AuthUi.renderHeaderChrome();
  // "Hides/disables rather than only failing after the fact" (docs/ROADMAP.md Phase 7's own
  // wording) -- a viewer/operator without "create" never sees the button at all, and Settings
  // (which only admin can write) is dropped from the nav entirely rather than shown read-only
  // for a feature nobody but admin has any use for.
  $('#btn-new-instance').hidden = !AuthUi.can('create');
  $('.tab-btn[data-tab="settings"]').hidden = !AuthUi.canManageSettings();

  loadHostCoreCount();
  loadInstalledVersion();
  loadInstances();

  // The state of an instance changes by itself (it boots, it crashes, someone uses adb/docker): refresh
  // every few seconds while the Instances tab is the one on screen. It does not run while a dialog is
  // open, while a resources or display edit panel is open (same reasoning -- it rebuilds the whole
  // table from the server's last-known values, which would silently wipe out whatever the user
  // already typed/checked there before they got to click Apply; found for real, 22/10/2026) nor
  // when the browser tab is hidden.
  setInterval(() => {
    const onInstances = $('.tab-btn.active')?.dataset.tab === 'instances';
    const dialogOpen = $$('dialog').some((d) => d.open);
    if (onInstances && !dialogOpen && openNoRestartId === null && openRestartId === null && openOwnersId === null && openStorageId === null && openAdbAccessId === null && openRenameId === null && !document.hidden) loadInstances({ silent: true });
  }, 4000);
});

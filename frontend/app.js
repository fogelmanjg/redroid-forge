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
  if (name === 'users') loadUsers();
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

  const grid = document.createElement('div');
  grid.className = 'resources-cpu-grid';
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

  const cpuApplyBtn = document.createElement('button');
  cpuApplyBtn.type = 'button';
  cpuApplyBtn.className = 'secondary';
  cpuApplyBtn.textContent = t('instances.resources.apply');
  cpuApplyBtn.addEventListener('click', async () => {
    if (selected.size === 0) return;
    cpuApplyBtn.disabled = true;
    try {
      await applyResources(inst.id, { cpusetCpus: coreSetToCpuset(selected) });
      openNoRestartId = null;
    } catch (e) {
      alert(e.message);
    } finally {
      cpuApplyBtn.disabled = false;
      await loadInstances({ silent: true });
    }
  });
  panel.appendChild(cpuApplyBtn);

  // --- RAM: a plain MB input, but it can only be RAISED live (same rule jg-dashboard already
  // learned: Docker's Update API lowering a running cgroup's limit below what it may already be
  // using is not something to do blind from here -- lowering needs a real recreate instead).
  const ramHeader = document.createElement('div');
  ramHeader.className = 'resources-edit-header';
  ramHeader.textContent = t('instances.resources.ramHeader');
  panel.appendChild(ramHeader);

  const ramInput = document.createElement('input');
  ramInput.type = 'number';
  ramInput.min = '256'; // matches jg-dashboard's rd-input-sm (min/step 256)
  ramInput.max = '65536';
  ramInput.step = '256';
  ramInput.placeholder = 'MB';
  ramInput.value = inst.memoryMb || '';
  panel.appendChild(ramInput);

  const ramWarn = document.createElement('div');
  panel.appendChild(ramWarn);

  const ramApplyBtn = document.createElement('button');
  ramApplyBtn.type = 'button';
  ramApplyBtn.className = 'secondary';
  ramApplyBtn.textContent = t('instances.resources.apply');

  // Lowering a RUNNING container's memory.max means the kernel has to reclaim pages the
  // instance is already using right now to get under the new limit -- confirmed for real
  // against jg-dashboard (user tested it directly): it also just calls Docker's live update
  // for a lower value, no separate recreate path despite its own UI text -- and in practice
  // it does not take effect while running (the call is wrapped in try/catch there and the
  // failure is only logged, never surfaced, which from the UI looks exactly like "no me deja
  // bajarla"). So: block it the same way, but say why, and point at the real fix -- stop the
  // instance (then raising OR lowering both just become the next start()'s container creation,
  // no live-update risk at all).
  function isLowering(v) {
    return !!inst.memoryMb && v > 0 && v < inst.memoryMb;
  }
  function refreshRamState() {
    const v = Number(ramInput.value);
    const blocked = isLowering(v) && inst.status === 'running';
    ramWarn.innerHTML = blocked ? `<div class="resources-warn">${t('instances.resources.ramLowerBlocked')}</div>` : '';
    ramApplyBtn.disabled = !v || blocked;
  }
  ramInput.addEventListener('input', refreshRamState);
  refreshRamState();

  ramApplyBtn.addEventListener('click', async () => {
    ramApplyBtn.disabled = true;
    try {
      await applyResources(inst.id, { memoryMb: Number(ramInput.value) });
      openNoRestartId = null;
    } catch (e) {
      alert(e.message);
    } finally {
      await loadInstances({ silent: true });
    }
  });
  panel.appendChild(ramApplyBtn);

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
  const mk = (label, active) => {
    const chip = document.createElement('span');
    chip.className = 'resource-chip';
    chip.textContent = `${label}: ${active ? 'hw' : 'off'}`;
    return chip;
  };
  frag.appendChild(mk('encode', ids.includes('hwenc')));
  frag.appendChild(mk('decode', ids.includes('hwdec')));
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

  // --- Hardware encode/decode ---
  const codecHeader = document.createElement('div');
  codecHeader.className = 'resources-edit-header';
  codecHeader.textContent = t('instances.configure.codecHeader');
  panel.appendChild(codecHeader);

  const ids = inst.requiredModuleIds || [];
  const needsHost = gpuSelect.value !== 'host';
  if (needsHost) {
    const warn = document.createElement('div');
    warn.className = 'resources-warn';
    warn.textContent = t('instances.codec.needsHost');
    panel.appendChild(warn);
  }
  const checks = {};
  for (const [key, label] of [['hwenc', t('new.hwenc')], ['hwdec', t('new.hwdec')]]) {
    const wrap = document.createElement('label');
    wrap.className = 'display-edit-field';
    wrap.style.flexDirection = 'row';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = ids.includes(key);
    checks[key] = chk;
    wrap.appendChild(chk);
    wrap.appendChild(document.createTextNode(label));
    panel.appendChild(wrap);
  }

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

  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'secondary';
  applyBtn.textContent = t('instances.resources.apply');
  applyBtn.addEventListener('click', async () => {
    if (inst.status === 'running' && !confirm(t('instances.display.confirmRunning'))) return;
    applyBtn.disabled = true;
    try {
      const modules = ids.filter((id) => id === 'wifi-interno-virtwifi');
      if (checks.hwenc.checked) modules.push('hwenc');
      if (checks.hwdec.checked) modules.push('hwdec');
      if (wifiChk.checked) modules.push('wifi-interno');
      if (gappsChk.checked) modules.push('gapps');
      if (armChk.checked) modules.push('arm-translation');
      for (const { id, chk } of userModuleChecks) if (chk.checked) modules.push(id);
      const bindHosts = netChecks.filter(({ chk }) => chk.checked).map(({ address }) => address);
      if (bindHosts.length === 0) { alert(t('instances.network.selectAtLeastOne')); return; }
      await applyInstanceConfig(inst.id, {
        width: Number(inputs.width.value),
        height: Number(inputs.height.value),
        dpi: Number(inputs.dpi.value),
        fps: Number(inputs.fps.value),
        gpuMode: gpuSelect.value,
        modules,
        bindHosts,
      });
      openRestartId = null;
    } catch (e) {
      alert(e.message);
    } finally {
      applyBtn.disabled = false;
      await loadInstances({ silent: true });
    }
  });
  panel.appendChild(applyBtn);

  // --- Device profile: a different backend route (restarts the container instead of
  // recreating it), kept as its own sub-section with its own Apply button rather than folded
  // into the payload above.
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
  const profileBtn = document.createElement('button');
  profileBtn.type = 'button';
  profileBtn.className = 'secondary';
  profileBtn.textContent = t('instances.deviceProfile.apply');
  profileBtn.title = inst.status === 'running' ? t('instances.deviceProfile.applyNowHint') : t('instances.deviceProfile.applyNextStartHint');
  profileBtn.addEventListener('click', async () => {
    profileBtn.disabled = true;
    try {
      await applyDeviceProfile(inst.id, profileSelect.value);
    } catch (e) {
      alert(e.message);
    } finally {
      profileBtn.disabled = false;
      await loadInstances({ silent: true });
    }
  });
  panel.appendChild(profileSelect);
  panel.appendChild(profileBtn);

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
  for (const id of ids) {
    const chip = document.createElement('span');
    chip.className = 'resource-chip';
    chip.textContent = id;
    wrap.appendChild(chip);
  }
  return wrap;
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
  const niveles = { oficial: 'instances.soporte.oficial', comunidad: 'instances.soporte.comunidad', 'sin-soporte': 'instances.soporte.sinSoporte' };
  chip.classList.add(soporte.nivel);
  chip.textContent = t(niveles[soporte.nivel] || soporte.nivel);
  if (soporte.nivel === 'oficial') {
    chip.title = t('instances.soporte.hintOficial', { combo: soporte.combinacion || '' });
  } else {
    const reasons = (soporte.motivos || []).join('; ');
    chip.title = t(soporte.nivel === 'comunidad' ? 'instances.soporte.hintComunidad' : 'instances.soporte.hintSinSoporte', { reasons });
  }
  return chip;
}

let openStorageId = null;
const storageCache = {}; // inst.id -> { volumeName, mountpoint } | { error } -- fetched on demand (needs a live docker inspect, not already in the /instances payload), kept around so toggling closed and back open doesn't re-fetch.

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

// `silent`: the periodic refresh does not flash "Loading..." over the table.
// Instances redesign (24/10/2026): each instance renders as a pair of rows, not a row of
// columns -- see the CSS comment above .instance-primary/.instance-secondary. Row 1 (bigger
// font) is "I already know how this is set up, just let me connect": name, status, address.
// Row 2 (smaller) is everything else -- info chips AND every button, including the ones that
// used to sit in their own always-visible column (device profile, register/mark-registered).
async function loadInstances({ silent = false } = {}) {
  const tbody = $('#instances-table tbody');
  if (!silent) tbody.innerHTML = `<tr><td>${t('common.loading')}</td></tr>`;
  try {
    const instances = await api('/instances');
    if (instances.length === 0) {
      tbody.innerHTML = `<tr><td>${t('instances.none')}</td></tr>`;
      return;
    }
    // Built off-screen and swapped in one go, so a refresh never leaves the table half drawn.
    const rows = document.createDocumentFragment();
    for (const inst of instances) {
      const state = InstanceState.describe(inst.status);

      // --- Row 1: name, status, address (host:adbPort -- click to copy, same as the Android
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

      const statusSpan = document.createElement('span');
      statusSpan.className = 'instance-status';
      statusSpan.innerHTML = `<span class="status-dot ${state.tone}"></span>${t('instances.status.' + state.key)}`;
      primary.appendChild(statusSpan);

      const address = `${location.hostname}:${inst.adbPort}`;
      const addrSpan = document.createElement('span');
      addrSpan.className = 'instance-address';
      addrSpan.textContent = address;
      addrSpan.title = t('instances.addressCopyHint');
      addrSpan.addEventListener('click', async () => {
        const ok = await copyText(address);
        addrSpan.textContent = ok ? t('instances.copied') : t('instances.copyFailed');
        setTimeout(() => { addrSpan.textContent = address; }, 1500);
      });
      primary.appendChild(addrSpan);

      tdPrimary.appendChild(primary);
      trPrimary.appendChild(tdPrimary);

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

      // Only the actions that make sense for the current state (see instanceState.js).
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
      for (const action of state.actions) {
        if (action === 'delete') {
          if (!AuthUi.can('delete')) continue;
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
          buttons.appendChild(del);
        } else if (AuthUi.can('start-stop')) {
          buttons.appendChild(mk(t(`instances.${action}`), action));
        }
      }

      secondary.appendChild(buttons);
      tdSecondary.appendChild(secondary);
      trSecondary.appendChild(tdSecondary);

      rows.appendChild(trPrimary);
      rows.appendChild(trSecondary);
      if (openNoRestartId === inst.id) rows.appendChild(buildResourcesEditRow(inst, instances));
      if (openRestartId === inst.id) rows.appendChild(buildRestartEditRow(inst));
      if (openStorageId === inst.id) rows.appendChild(buildStorageEditRow(inst));
    }
    tbody.replaceChildren(rows);
  } catch (e) {
    tbody.innerHTML = `<tr><td>${t('common.error', { msg: e.message })}</td></tr>`;
  }
}

function moduleStatusBadge(m) {
  if (m.accepted) return `<span class="status-dot ok"></span> ${t('modules.accepted', { v: m.acceptedVersion })}`;
  if (m.acceptedVersion) return `<span class="status-dot warn"></span> ${t('modules.oldAccepted', { old: m.acceptedVersion, cur: m.version })}`;
  return `<span class="status-dot warn"></span> ${t('modules.pending')}`;
}

// Shared renderer for both the Modules tab and the User modules tab -- same card shape (status
// badge, description, what it touches, accept/revoke), the only difference between the two tabs
// is WHICH modules get fetched/filtered before calling this (see loadModules/loadUserModulesTab).
function renderModuleCards(list, modules, { onChange }) {
  list.innerHTML = '';
  for (const m of modules) {
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

async function loadSettings() {
  try {
    const settings = await api('/settings');
    $('#settings-backup-dir').value = settings.backupDir;
    renderNetIfacesSettings(await api('/network/interfaces/all'));
  } catch (e) {
    alert(e.message);
  }
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
    const settings = await api('/settings', { method: 'PUT', body: JSON.stringify({ backupDir, networkInterfaceOverrides }) });
    $('#settings-backup-dir').value = settings.backupDir;
    networkInterfacesCache = null; // the per-instance Configure panel re-fetches with the new filter next time it opens
    saved.hidden = false;
  } catch (e) {
    alert(e.message);
  }
});

// Local user management (docs/ROADMAP.md Phase 7) -- admin + "local" auth mode only, same
// pattern as the Doctor/Modules lists (ul#...-list rebuilt from scratch on every load).
async function loadUsers() {
  const list = $('#users-list');
  list.innerHTML = `<li class="muted">${t('common.loading')}</li>`;
  try {
    const users = await api('/auth/users');
    list.innerHTML = '';
    if (users.length === 0) list.innerHTML = `<li class="muted">${t('users.none')}</li>`;
    for (const u of users) {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = `${u.username} (${u.role})`;
      li.appendChild(label);
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'secondary';
      delBtn.textContent = t('users.delete');
      delBtn.disabled = AuthUi.currentUser() && AuthUi.currentUser().id === u.id;
      delBtn.addEventListener('click', async () => {
        if (!confirm(t('users.deleteConfirm', { username: u.username }))) return;
        try {
          await api(`/auth/users/${u.id}`, { method: 'DELETE' });
          loadUsers();
        } catch (e) {
          alert(e.message);
        }
      });
      li.appendChild(delBtn);
      list.appendChild(li);
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
    await api('/auth/users', {
      method: 'POST',
      body: JSON.stringify({
        username: form.username.value, password: form.password.value, role: form.role.value,
      }),
    });
    form.reset();
    newUserDialog.close();
    loadUsers();
  } catch (e) {
    alert(e.message);
  }
});

async function loadDoctor() {
  const list = $('#doctor-list');
  list.innerHTML = `<li>${t('doctor.running')}</li>`;
  try {
    const checks = await api('/doctor');
    list.innerHTML = '';
    for (const c of checks) {
      const li = document.createElement('li');
      li.className = 'doctor-item';
      li.innerHTML = `
        <div class="label"><span class="status-dot ${c.status}"></span> ${c.label || c.id}</div>
        <p class="detail">${c.detail || ''}</p>
        ${c.fix ? `<pre>${c.fix.replace(/</g, '&lt;')}</pre>` : ''}
      `;
      list.appendChild(li);
    }
  } catch (e) {
    list.innerHTML = `<li>${t('common.error', { msg: e.message })}</li>`;
  }
}

$('#btn-refresh-instances').addEventListener('click', loadInstances);
$('#btn-refresh-modules').addEventListener('click', loadModules);
$('#btn-refresh-user-modules').addEventListener('click', loadUserModulesTab);
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
    return;
  }
  setHwAccel(id, { enabled: false, text: t(`new.${id}Checking`), tone: 'muted' });
  try {
    const m = await api(`/modules/${id}?imageId=${encodeURIComponent(img.id)}`);
    if (imagesById[$('#image-select').value] !== img) return; // another image was chosen meanwhile
    if (m.hostCompatible === false) {
      setHwAccel(id, { enabled: false, text: t(`new.${id}NoHost`, { reason: m.hostIncompatibilityReason }), tone: 'warn-text' });
    } else {
      setHwAccel(id, { enabled: true, text: t(`new.${id}Ok`, { vendor: m.hostGpuVendor || '?' }), tone: 'ok-text' });
    }
  } catch (e) {
    setHwAccel(id, { enabled: false, text: t('common.error', { msg: e.message }), tone: 'fail-text' });
  }
}
function refreshHwencOption() {
  refreshHwAccelOption('hwenc');
  refreshHwAccelOption('hwdec');
}
$('#image-select').addEventListener('change', refreshHwencOption);
$('#new-instance-form').gpuMode.addEventListener('change', refreshHwencOption);

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
  } catch (e) {
    select.innerHTML = `<option>${t('common.error', { msg: e.message })}</option>`;
  }
  $('#chk-gapps').checked = false;
  $('#chk-arm').checked = false;
  $('#chk-hwenc').checked = false;
  $('#chk-hwdec').checked = false;
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
  const name = form.name.value.trim();
  const imageId = form.imageId.value;
  // The list is explicit: what is not ticked is not installed (that is how hwenc is opted out of).
  const modules = [];
  if (form.hwenc.checked) modules.push('hwenc');
  if (form.hwdec.checked) modules.push('hwdec');
  if (form.gapps.checked) modules.push('gapps');
  if (form.arm.checked) modules.push('arm-translation');
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
  await createInstance(name, imageId, form, modules, display);
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
    if (onInstances && !dialogOpen && openNoRestartId === null && openRestartId === null && openStorageId === null && !document.hidden) loadInstances({ silent: true });
  }, 4000);
});

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
}

$$('.tab-btn').forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

async function api(path, opts) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
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
// running-only gate here.
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

// Which instance's resources panel is open, like jg-dashboard's affinityId()/rdRamId()
// signals -- one at a time, both CPU and RAM together (simpler than its two separate toggles,
// same underlying idea). Re-rendered via the normal loadInstances() cycle, not a separate
// DOM-patching path -- consistent with how this file already rebuilds the whole tbody on every
// refresh.
let openResourcesId = null;

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

function buildResourcesCell(inst) {
  const wrap = document.createElement('div');
  const mk = (text, hint) => {
    const chip = document.createElement('span');
    chip.className = 'resource-chip';
    chip.textContent = text;
    chip.title = hint;
    chip.addEventListener('click', () => {
      openResourcesId = openResourcesId === inst.id ? null : inst.id;
      loadInstances({ silent: true });
    });
    return chip;
  };
  wrap.appendChild(mk(`cpu: ${inst.cpusetCpus || t('instances.resources.noLimit')}`, t('instances.resources.changeAffinity')));
  wrap.appendChild(document.createElement('br'));
  wrap.appendChild(mk(`ram: ${inst.memoryMb ? `${inst.memoryMb}MB` : t('instances.resources.noLimit')}`, t('instances.resources.changeRam')));
  return wrap;
}

// The expandable panel a chip click opens, spanning the full table width -- same idea as
// jg-dashboard's "edit-row" (an inline panel in the table flow, not a modal). `allInstances`
// is only used to compute cpuset conflicts against the OTHER rows already loaded, nothing of
// its own is fetched here.
function buildResourcesEditRow(inst, allInstances) {
  const tr = document.createElement('tr');
  tr.className = 'edit-row';
  const td = document.createElement('td');
  td.colSpan = 8;
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
      openResourcesId = null;
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
  ramInput.min = '128';
  ramInput.max = '65536';
  ramInput.placeholder = 'MB';
  ramInput.value = inst.memoryMb || '';
  panel.appendChild(ramInput);

  const ramWarn = document.createElement('div');
  panel.appendChild(ramWarn);

  const ramApplyBtn = document.createElement('button');
  ramApplyBtn.type = 'button';
  ramApplyBtn.className = 'secondary';
  ramApplyBtn.textContent = t('instances.resources.apply');

  function refreshRamState() {
    const v = Number(ramInput.value);
    const tooLow = !!inst.memoryMb && v > 0 && v <= inst.memoryMb;
    ramWarn.innerHTML = tooLow ? `<div class="resources-warn">${t('instances.resources.ramLowerNotLive')}</div>` : '';
    ramApplyBtn.disabled = !v || tooLow;
  }
  ramInput.addEventListener('input', refreshRamState);
  refreshRamState();

  ramApplyBtn.addEventListener('click', async () => {
    ramApplyBtn.disabled = true;
    try {
      await applyResources(inst.id, { memoryMb: Number(ramInput.value) });
      openResourcesId = null;
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
    openResourcesId = null;
    loadInstances({ silent: true });
  });
  panel.appendChild(cancelBtn);

  td.appendChild(panel);
  tr.appendChild(td);
  return tr;
}

// The backend only allows applying a profile while the instance is running (it needs the overlay
// writable, see deviceProfile.js) -- the select+button only render in that state, matching how the
// Actions column already hides start/stop/restart/delete that do not apply to the current status.
function buildDeviceProfileCell(inst) {
  const wrap = document.createElement('div');
  const current = inst.deviceProfile || 'redroid';
  const label = document.createElement('span');
  label.className = 'muted';
  label.textContent = current === 'redroid' ? t('instances.deviceProfile.default') : current;
  wrap.appendChild(label);
  if (inst.status !== 'running') return wrap;
  wrap.appendChild(document.createElement('br'));
  const select = document.createElement('select');
  for (const [value, text] of [['redroid', t('instances.deviceProfile.default')], ['samsung', 'Samsung Galaxy A55']]) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = text;
    if (value === current) opt.selected = true;
    select.appendChild(opt);
  }
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'secondary';
  btn.textContent = t('instances.deviceProfile.apply');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await applyDeviceProfile(inst.id, select.value);
    } catch (e) {
      alert(e.message);
    } finally {
      btn.disabled = false;
      await loadInstances({ silent: true });
    }
  });
  wrap.appendChild(select);
  wrap.appendChild(btn);
  return wrap;
}

// `silent`: the periodic refresh does not flash "Loading..." over the table.
async function loadInstances({ silent = false } = {}) {
  const tbody = $('#instances-table tbody');
  if (!silent) tbody.innerHTML = `<tr><td colspan="8">${t('common.loading')}</td></tr>`;
  try {
    const instances = await api('/instances');
    if (instances.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8">${t('instances.none')}</td></tr>`;
      return;
    }
    // Built off-screen and swapped in one go, so a refresh never leaves the table half drawn.
    const rows = document.createDocumentFragment();
    for (const inst of instances) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${inst.name}${inst.display ? `<span class="instance-meta muted">${inst.display.width}×${inst.display.height} · ${inst.display.dpi} dpi · ${inst.display.fps} fps</span>` : ''}</td>
        <td>${inst.dockerImage}</td>
        <td class="status-cell"></td>
        <td>${inst.adbPort}</td>
        <td class="android-id-cell">${androidIdCellHtml(inst)}</td>
        <td class="device-profile-cell"></td>
        <td class="resources-cell"></td>
        <td class="actions"></td>
      `;
      const state = InstanceState.describe(inst.status);
      tr.querySelector('.status-cell').innerHTML = `<span class="status-dot ${state.tone}"></span>${t('instances.status.' + state.key)}`;
      tr.querySelector('.device-profile-cell').appendChild(buildDeviceProfileCell(inst));
      tr.querySelector('.resources-cell').appendChild(buildResourcesCell(inst));
      const actions = tr.querySelector('.actions');
      if (inst.hasGapps && inst.androidId && !inst.androidIdRegisteredAt) {
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
        actions.appendChild(link);
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
        actions.appendChild(markBtn);
      }
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
          actions.appendChild(del);
        } else {
          actions.appendChild(mk(t(`instances.${action}`), action));
        }
      }
      rows.appendChild(tr);
      if (openResourcesId === inst.id) rows.appendChild(buildResourcesEditRow(inst, instances));
    }
    tbody.replaceChildren(rows);
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="8">${t('common.error', { msg: e.message })}</td></tr>`;
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
// Hardware acceleration (hwenc) is an option of the instance, on by default. It is offered only
// when the chosen image includes it AND this host's GPU can run it; otherwise the checkbox is
// disabled and says why, instead of letting the create fail afterwards.
let imagesById = {};
const hwencChk = $('#chk-hwenc');
const hwencStatus = $('#hwenc-status');
function setHwenc({ enabled, checked, text, tone }) {
  hwencChk.disabled = !enabled;
  hwencChk.checked = checked;
  hwencStatus.hidden = !text;
  hwencStatus.className = tone || 'muted';
  hwencStatus.textContent = text || '';
}
async function refreshHwencOption() {
  const img = imagesById[$('#image-select').value];
  if (!img) { setHwenc({ enabled: false, checked: false }); return; }
  if (!img.hwEncCapable) {
    setHwenc({ enabled: false, checked: false, text: t('new.hwencNoImage'), tone: 'muted' });
    return;
  }
  setHwenc({ enabled: false, checked: false, text: t('new.hwencChecking'), tone: 'muted' });
  try {
    const m = await api(`/modules/hwenc?imageId=${encodeURIComponent(img.id)}`);
    if (imagesById[$('#image-select').value] !== img) return; // another image was chosen meanwhile
    if (m.hostCompatible === false) {
      setHwenc({ enabled: false, checked: false, text: t('new.hwencNoHost', { reason: m.hostIncompatibilityReason }), tone: 'warn-text' });
    } else {
      setHwenc({ enabled: true, checked: true, text: t('new.hwencOk', { vendor: m.hostGpuVendor || '?' }), tone: 'ok-text' });
    }
  } catch (e) {
    setHwenc({ enabled: false, checked: false, text: t('common.error', { msg: e.message }), tone: 'fail-text' });
  }
}
$('#image-select').addEventListener('change', refreshHwencOption);

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
  if (form.gapps.checked) modules.push('gapps');
  if (form.arm.checked) modules.push('arm-translation');
  for (const chk of $$('.user-module-chk')) if (chk.checked) modules.push(chk.dataset.id);
  const display = {
    width: Number(form.width.value), height: Number(form.height.value), dpi: Number(form.dpi.value), fps: Number(form.fps.value),
  };
  // Empty = no limit (the backend's own default, see instanceParams.parseResources) -- only sent
  // when the user actually typed something.
  if (form.memoryMb.value) display.memoryMb = Number(form.memoryMb.value);
  if (form.cpusetCpus.value) display.cpusetCpus = form.cpusetCpus.value;
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

loadHostCoreCount();
loadInstances();

// The state of an instance changes by itself (it boots, it crashes, someone uses adb/docker): refresh
// every few seconds while the Instances tab is the one on screen. It does not run while a dialog is open
// (the user is typing) nor when the browser tab is hidden.
setInterval(() => {
  const onInstances = $('.tab-btn.active')?.dataset.tab === 'instances';
  const dialogOpen = $$('dialog').some((d) => d.open);
  if (onInstances && !dialogOpen && !document.hidden) loadInstances({ silent: true });
}, 4000);

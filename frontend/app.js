const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function switchTab(name) {
  $$('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
  if (name === 'instances') loadInstances();
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
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

function androidIdCellHtml(inst) {
  if (!inst.hasGapps) return '<span class="muted">-</span>';
  if (!inst.androidId) return '<span class="muted">esperando boot...</span>';
  if (inst.androidIdRegisteredAt) {
    return `<code>${inst.androidId}</code><br><span class="ok-text">registrado</span>`;
  }
  const hoursLeft = Math.round(48 - (Date.now() - new Date(inst.createdAt).getTime()) / 3_600_000);
  const urgent = hoursLeft <= 12;
  return `
    <code>${inst.androidId}</code>
    <br>
    <span class="${urgent ? 'fail-text' : 'warn-text'}">
      sin registrar${hoursLeft > 0 ? ` (~${hoursLeft}hs)` : ' (VENCIDO)'}
    </span>
  `;
}

async function loadInstances() {
  const tbody = $('#instances-table tbody');
  tbody.innerHTML = '<tr><td colspan="6">Cargando...</td></tr>';
  try {
    const instances = await api('/instances');
    if (instances.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6">No hay instancias todavia.</td></tr>';
      return;
    }
    tbody.innerHTML = '';
    for (const inst of instances) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${inst.name}</td>
        <td>${inst.dockerImage}</td>
        <td>${inst.status}</td>
        <td>${inst.adbPort}</td>
        <td class="android-id-cell">${androidIdCellHtml(inst)}</td>
        <td class="actions"></td>
      `;
      const actions = tr.querySelector('.actions');
      if (inst.hasGapps && inst.androidId && !inst.androidIdRegisteredAt) {
        const link = document.createElement('a');
        link.href = 'https://www.google.com/android/uncertified';
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = 'Registrar';
        link.className = 'link-btn';
        actions.appendChild(link);
        const markBtn = document.createElement('button');
        markBtn.textContent = 'Ya lo registre';
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
      const mk = (label, action) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.className = 'secondary';
        b.addEventListener('click', async () => {
          b.disabled = true;
          try {
            await api(`/instances/${inst.id}/${action}`, { method: 'POST' });
            await loadInstances();
          } catch (e) {
            alert(e.message);
          } finally {
            b.disabled = false;
          }
        });
        return b;
      };
      actions.appendChild(mk('Start', 'start'));
      actions.appendChild(mk('Stop', 'stop'));
      actions.appendChild(mk('Restart', 'restart'));
      const del = document.createElement('button');
      del.textContent = 'Borrar';
      del.className = 'secondary';
      del.addEventListener('click', async () => {
        if (!confirm(`Borrar la instancia "${inst.name}"? Esto elimina tambien su volumen de datos.`)) return;
        try {
          await api(`/instances/${inst.id}`, { method: 'DELETE' });
          await loadInstances();
        } catch (e) {
          alert(e.message);
        }
      });
      actions.appendChild(del);
      tbody.appendChild(tr);
    }
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="6">Error: ${e.message}</td></tr>`;
  }
}

async function loadDoctor() {
  const list = $('#doctor-list');
  list.innerHTML = '<li>Corriendo diagnostico...</li>';
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
    list.innerHTML = `<li>Error: ${e.message}</li>`;
  }
}

$('#btn-refresh-instances').addEventListener('click', loadInstances);
$('#btn-run-doctor').addEventListener('click', loadDoctor);

const dialog = $('#new-instance-dialog');
$('#btn-new-instance').addEventListener('click', async () => {
  const select = $('#image-select');
  select.innerHTML = '<option>Cargando...</option>';
  try {
    const images = await api('/images');
    select.innerHTML = images
      .map((img) => {
        const tier = img.soporte === 'oficial' ? '✅ oficial' : '⚠️ comunidad';
        const notPresent = img.present ? '' : ' (no presente localmente)';
        return `<option value="${img.id}" ${img.present ? '' : 'disabled'} title="${img.notaSoporte || ''}">${img.label} — ${tier}${notPresent}</option>`;
      })
      .join('');
  } catch (e) {
    select.innerHTML = `<option>Error: ${e.message}</option>`;
  }
  dialog.showModal();
});
$('#btn-cancel-new-instance').addEventListener('click', () => dialog.close());

$('#new-instance-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const name = form.name.value.trim();
  const imageId = form.imageId.value;
  try {
    await api('/instances', { method: 'POST', body: JSON.stringify({ name, imageId }) });
    dialog.close();
    form.reset();
    await loadInstances();
  } catch (err) {
    alert(err.message);
  }
});

loadInstances();

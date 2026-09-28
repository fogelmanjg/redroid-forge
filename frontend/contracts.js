// Modal de contrato genérico (sección 5 de docs/REQUIREMENTS.md): lee un
// manifest de módulo (JSON servido por /api/modules) y renderiza siempre el
// mismo diálogo -- título, descripción, disclaimer si es de terceros no
// libre, qué toca/permisos, y el botón de aceptar -- sin programar una
// pantalla especial por módulo.
const Contracts = (() => {
  const dialog = document.getElementById('contract-dialog');
  const form = document.getElementById('contract-form');
  const els = {
    title: document.getElementById('contract-title'),
    disclaimer: document.getElementById('contract-disclaimer'),
    descripcion: document.getElementById('contract-descripcion'),
    licencia: document.getElementById('contract-licencia'),
    origen: document.getElementById('contract-origen'),
    compatible: document.getElementById('contract-compatible'),
    quetoca: document.getElementById('contract-quetoca'),
    checkbox: document.getElementById('contract-checkbox'),
    cancelBtn: document.getElementById('btn-cancel-contract'),
  };

  function setHiddenText(el, text) {
    if (text) {
      el.hidden = false;
      el.textContent = text;
    } else {
      el.hidden = true;
      el.textContent = '';
    }
  }

  function render(manifest) {
    els.title.textContent = manifest.nombre;
    els.descripcion.textContent = manifest.descripcion;
    els.checkbox.checked = false;

    // Sección 6: todo módulo de terceros no libre lleva el disclaimer
    // obligatorio de que no es parte de redroid-forge, sin excepción.
    setHiddenText(
      els.disclaimer,
      manifest.esTerceroNoLibre
        ? 'Este módulo integra software de terceros no libre — no es parte de redroid-forge. Se instala/ejecuta bajo tu propia responsabilidad.'
        : null,
    );
    setHiddenText(els.licencia, manifest.licencia ? `Licencia: ${manifest.licencia}` : null);
    if (manifest.origen) {
      els.origen.hidden = false;
      els.origen.innerHTML = `Origen: <a href="${manifest.origen}" target="_blank" rel="noopener">${manifest.origen}</a>`;
    } else {
      els.origen.hidden = true;
      els.origen.innerHTML = '';
    }

    if (manifest.compatibleCon) {
      els.compatible.hidden = false;
      els.compatible.textContent = `Compatible con: Android ${manifest.compatibleCon.androidVersion.join('/')}`
        + ` · GPU ${manifest.compatibleCon.gpuMode.join('/')}`;
    } else {
      els.compatible.hidden = true;
    }

    els.quetoca.innerHTML = (manifest.queToca || []).map((item) => `<li>${item}</li>`).join('');
  }

  // Muestra el contrato de un manifest y devuelve una promesa que resuelve
  // en true solo si el usuario acepta Y el backend registra la aceptación.
  function ask(manifest) {
    return new Promise((resolve) => {
      render(manifest);
      dialog.showModal();

      function cleanup() {
        form.removeEventListener('submit', onSubmit);
        els.cancelBtn.removeEventListener('click', onCancel);
      }

      function onSubmit(e) {
        e.preventDefault();
        cleanup();
        fetch(`/api/modules/${manifest.id}/accept`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: manifest.version }),
        })
          .then((res) => {
            dialog.close();
            resolve(res.ok);
          })
          .catch(() => {
            dialog.close();
            resolve(false);
          });
      }

      function onCancel() {
        cleanup();
        dialog.close();
        resolve(false);
      }

      form.addEventListener('submit', onSubmit);
      els.cancelBtn.addEventListener('click', onCancel);
    });
  }

  // Pide aceptación para cada manifest pendiente, en orden. Devuelve true
  // solo si se aceptaron todos -- si cancela cualquiera, corta ahí (la
  // integración no arranca a medias).
  async function ensureAccepted(pendingManifests) {
    for (const manifest of pendingManifests) {
      // eslint-disable-next-line no-await-in-loop
      const accepted = await ask(manifest);
      if (!accepted) return false;
    }
    return true;
  }

  return { ensureAccepted };
})();

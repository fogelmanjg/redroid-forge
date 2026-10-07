// Generic contract modal (section 5 of docs/REQUIREMENTS.md): it reads a
// module manifest (JSON served by /api/modules) and always renders the
// same dialog -- title, description, disclaimer if it is non-free third
// party, what it touches/permissions, and the accept button -- without
// coding a special screen per module.
const Contracts = (() => {
  const { t, loc } = I18n;
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
    els.title.textContent = loc(manifest, 'nombre');
    els.descripcion.textContent = loc(manifest, 'descripcion');
    els.checkbox.checked = false;

    // Section 6: every non-free third-party module carries the mandatory
    // disclaimer that it is not part of redroid-forge, no exceptions.
    setHiddenText(
      els.disclaimer,
      manifest.esTerceroNoLibre
        ? t('contract.disclaimer')
        : null,
    );
    setHiddenText(els.licencia, manifest.licencia ? t('contract.license', { v: loc(manifest, 'licencia') }) : null);
    if (manifest.origen) {
      els.origen.hidden = false;
      els.origen.innerHTML = `${t('contract.origin')}<a href="${manifest.origen}" target="_blank" rel="noopener">${manifest.origen}</a>`;
    } else {
      els.origen.hidden = true;
      els.origen.innerHTML = '';
    }

    if (manifest.compatibleCon) {
      els.compatible.hidden = false;
      els.compatible.textContent = t('modules.compatible', {
        android: manifest.compatibleCon.androidVersion.join('/'),
        gpu: manifest.compatibleCon.gpuMode.join('/'),
      });
    } else {
      els.compatible.hidden = true;
    }

    els.quetoca.innerHTML = (loc(manifest, 'queToca') || []).map((item) => `<li>${item}</li>`).join('');
  }

  // Shows a manifest's contract and returns a promise that resolves to
  // true only if the user accepts AND the backend records the acceptance.
  function ask(manifest) {
    return new Promise((resolve, reject) => {
      render(manifest);
      dialog.showModal();

      function cleanup() {
        form.removeEventListener('submit', onSubmit);
        els.cancelBtn.removeEventListener('click', onCancel);
        dialog.removeEventListener('cancel', onDialogCancel);
      }

      function onSubmit(e) {
        e.preventDefault();
        cleanup();
        fetch(`/api/modules/${manifest.id}/accept`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: manifest.version }),
        })
          .then(async (res) => {
            dialog.close();
            if (!res.ok) {
              const body = await res.json().catch(() => null);
              throw new Error(body?.error || t('contract.rejected', { status: res.status }));
            }
            resolve(true);
          })
          .catch((err) => {
            dialog.close();
            reject(err instanceof Error ? err : new Error(t('contract.failed')));
          });
      }

      function onCancel() {
        cleanup();
        dialog.close();
        resolve(false);
      }

      // The native <dialog> fires 'cancel' (not 'submit') when closed with
      // Escape -- without this listener, that path never called resolve() and
      // ensureAccepted() was left hanging forever.
      function onDialogCancel(e) {
        e.preventDefault();
        onCancel();
      }

      form.addEventListener('submit', onSubmit);
      els.cancelBtn.addEventListener('click', onCancel);
      dialog.addEventListener('cancel', onDialogCancel);
    });
  }

  // Asks for acceptance of every pending manifest, in order. Returns true
  // only if all were accepted -- if any is cancelled, it stops there (the
  // integration does not start halfway).
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

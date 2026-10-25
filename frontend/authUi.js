// Auth gate + login UI (docs/ROADMAP.md Phase 7). Loaded before app.js -- app.js's own init
// sequence awaits `AuthUi.ready` before calling loadInstances()/loadHostCoreCount(), so nothing
// tries to hit the API while a login is still pending. `capabilities`/`canManageSettings` are
// computed server-side (GET /api/auth/me, see routes/auth.js) and just read here -- the role ->
// capability table lives in exactly one place, backend/src/lib/permissions.js, never
// re-implemented in this file.

const AuthUi = (() => {
  let state = { authMode: 'none', user: null, capabilities: [], canManageSettings: false };

  function can(capability) { return state.capabilities.includes(capability); }
  function isAdmin() { return !!state.user && state.user.role === 'admin'; }
  function currentUser() { return state.user; }
  function authMode() { return state.authMode; }
  function canManageSettingsFn() { return state.canManageSettings; }

  async function fetchMe() {
    const res = await fetch('/api/auth/me', { headers: { 'Content-Type': 'application/json' } });
    return res.json();
  }

  // Escape must not dismiss this one -- nothing behind it works yet (app.js's whole boot
  // sequence is still waiting on AuthUi.ready), so closing it would just leave a blank app.
  document.querySelector('#login-dialog').addEventListener('cancel', (e) => e.preventDefault());

  // Multi-provider (docs/ROADMAP.md Phase 7, redesigned 25/10/2026): one "Log in with X" link
  // per entry in GET /api/auth/oidc/providers (public, no login needed to see this list) --
  // there is no single fixed "SSO" link any more, the person picks which configured trust
  // source to use. Re-fetched every time the dialog opens rather than cached: this list can
  // only change via a restart anyway, but re-fetching costs nothing and avoids ever showing a
  // stale list from an earlier page load.
  async function renderOidcProviders() {
    const container = document.querySelector('#login-oidc-providers');
    container.innerHTML = '';
    let providers = [];
    try {
      const res = await fetch('/api/auth/oidc/providers');
      providers = await res.json();
    } catch {
      // leave the container empty -- the dialog still opens, just with nothing to click; a
      // network hiccup here is not worth a dedicated error state.
    }
    for (const p of providers) {
      const a = document.createElement('a');
      a.href = `/api/auth/oidc/${encodeURIComponent(p.id)}/login`;
      a.className = 'link-btn';
      a.textContent = I18n.t('auth.loginWithProvider', { provider: p.label });
      container.appendChild(a);
    }
  }

  function showLoginDialog() {
    const dialog = document.querySelector('#login-dialog');
    const localForm = document.querySelector('#login-form-local');
    const oidcBlock = document.querySelector('#login-oidc');
    const isLocal = state.authMode === 'local';
    localForm.hidden = !isLocal;
    oidcBlock.hidden = isLocal;
    if (!isLocal) renderOidcProviders();
    if (!dialog.open) dialog.showModal();
  }

  function hideLoginDialog() {
    const dialog = document.querySelector('#login-dialog');
    if (dialog.open) dialog.close();
  }

  // Resolves once there is either a logged-in user or auth is "none" -- the one thing app.js's
  // boot sequence waits on before touching the rest of the API.
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });

  async function refreshAndGate() {
    state = await fetchMe();
    if (state.authMode !== 'none' && !state.user) {
      showLoginDialog();
      return false;
    }
    hideLoginDialog();
    readyResolve(state);
    return true;
  }

  function wireLoginForm() {
    const form = document.querySelector('#login-form-local');
    const errorEl = document.querySelector('#login-error');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorEl.hidden = true;
      const fd = new FormData(form);
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: fd.get('username'), password: fd.get('password') }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        form.reset();
        const ok = await refreshAndGate();
        if (ok) window.location.reload(); // simplest way to re-run app.js's whole boot sequence fresh
      } catch (err) {
        errorEl.hidden = false;
        errorEl.textContent = err.message;
      }
    });
  }

  function wireLogoutButton() {
    document.querySelector('#btn-logout').addEventListener('click', async () => {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.reload();
    });
  }

  // Header chrome (username/role, logout button, Users/Identities nav tabs) -- only meaningful
  // once `ready` has resolved, called from app.js's own boot sequence rather than here, so it
  // runs after I18n.apply() (the labels need translated text already applied once).
  function renderHeaderChrome() {
    const info = document.querySelector('#current-user-info');
    const logoutBtn = document.querySelector('#btn-logout');
    const usersNavBtn = document.querySelector('#nav-users-btn');
    const identitiesNavBtn = document.querySelector('#nav-identities-btn');
    if (state.authMode === 'none') {
      info.hidden = true;
      logoutBtn.hidden = true;
    } else {
      info.hidden = false;
      info.textContent = `${state.user.username || state.user.id} (${state.user.role})`;
      logoutBtn.hidden = false;
    }
    usersNavBtn.hidden = !(state.authMode === 'local' && isAdmin());
    // "oidc" mode's role management (roleAssignments.js) -- see routes/auth.js's /identities
    // routes, admin only, separate from /users because OIDC identities are never created here,
    // only approved once they already exist from having logged in.
    identitiesNavBtn.hidden = !(state.authMode === 'oidc' && isAdmin());
  }

  wireLoginForm();
  wireLogoutButton();
  refreshAndGate();

  return {
    ready, can, isAdmin, currentUser, authMode, canManageSettings: canManageSettingsFn, renderHeaderChrome,
  };
})();

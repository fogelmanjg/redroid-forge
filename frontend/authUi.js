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
  function localEnabled() { return state.authMode === 'local' || state.authMode === 'both'; }
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
    // "both" (26/10/2026): show BOTH at once, not either/or -- a person picks whichever login
    // method applies to them, same screen.
    const showLocal = state.authMode === 'local' || state.authMode === 'both';
    const showOidc = state.authMode === 'oidc' || state.authMode === 'both';
    localForm.hidden = !showLocal;
    oidcBlock.hidden = !showOidc;
    if (showOidc) renderOidcProviders();
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

  // Header chrome (username/role, logout button, Identities nav tab) -- only meaningful once
  // `ready` has resolved, called from app.js's own boot sequence rather than here, so it runs
  // after I18n.apply() (the labels need translated text already applied once).
  function renderHeaderChrome() {
    const info = document.querySelector('#current-user-info');
    const logoutBtn = document.querySelector('#btn-logout');
    const identitiesNavBtn = document.querySelector('#nav-identities-btn');
    if (state.authMode === 'none') {
      info.hidden = true;
      logoutBtn.hidden = true;
    } else {
      info.hidden = false;
      info.textContent = `${state.user.username || state.user.id} (${state.user.role})`;
      logoutBtn.hidden = false;
    }
    // One unified "Identities" tab (26/10/2026) covers local accounts and OIDC identities alike
    // -- see routes/auth.js's GET /identities. Shown to any admin, in ANY mode including "none"
    // (26/10/2026, setup wizard): "none" mode synthesizes a role:'admin' user with no real
    // session (see GET /api/auth/me), so isAdmin() is already true there -- this is also exactly
    // the audience the setup wizard (app.js's loadIdentities, rendered here instead of an
    // identity list while authMode is "none") needs to reach, since nobody else can turn
    // security on in the first place.
    identitiesNavBtn.hidden = !isAdmin();
  }

  wireLoginForm();
  wireLogoutButton();
  refreshAndGate();

  return {
    ready, can, isAdmin, currentUser, authMode, localEnabled, canManageSettings: canManageSettingsFn, renderHeaderChrome,
  };
})();

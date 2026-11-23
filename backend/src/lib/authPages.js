'use strict';

// The pages the OIDC callback answers with when it cannot log someone in (1.0.0-beta.9). They used
// to be one line of plain English text with no way back: someone who logged in with a Google or
// Plenum account not linked to anything was left on "Login succeeded, but no role..." without
// knowing what to do next. Now a small page in the browser's language (es/en, same two as the
// frontend's i18n.js) says what happened and the two ways forward, with a link back to the login.
//
// Standalone on purpose (inline CSS, no script): it is served from /api/auth/oidc/.../callback,
// outside the app's own page, and must render even if the frontend's files change.

const STRINGS = {
  en: {
    title: 'No access yet',
    noRoleHead: 'You logged in with {provider} as {user}, but this account does not have access yet.',
    noRoleLocal: 'If you already have a redroid-forge user: log in with it, and link this account from your profile.',
    noRoleAdmin: 'If not: ask an administrator for access -- your account already shows up for them as pending.',
    failedTitle: 'Login failed',
    failedHead: 'The login with {provider} could not be completed.',
    failedRetry: 'Try again; if it keeps failing, tell an administrator what it says above.',
    back: 'Back to the login',
  },
  es: {
    title: 'Todavía sin acceso',
    noRoleHead: 'Entraste con {provider} como {user}, pero esta cuenta todavía no tiene acceso.',
    noRoleLocal: 'Si ya tenés un usuario en redroid-forge: entrá con él y vinculá esta cuenta desde tu perfil.',
    noRoleAdmin: 'Si no: pedile acceso a un administrador -- tu cuenta ya le aparece como pendiente.',
    failedTitle: 'No se pudo entrar',
    failedHead: 'No se pudo completar el ingreso con {provider}.',
    failedRetry: 'Probá de nuevo; si sigue fallando, pasale a un administrador lo que dice arriba.',
    back: 'Volver al login',
  },
};

function escapeHtml(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// First language in Accept-Language that we have, else English.
function pickLang(acceptLanguage) {
  for (const part of String(acceptLanguage || '').split(',')) {
    const code = part.split(';')[0].trim().toLowerCase().slice(0, 2);
    if (STRINGS[code]) return code;
  }
  return 'en';
}

// `{x}` placeholders get already-escaped HTML (bold values); the template itself is ours.
function fill(template, values) {
  return escapeHtml(template).replace(/\{(\w+)\}/g, (m, k) => (k in values ? `<strong>${escapeHtml(values[k])}</strong>` : m));
}

function page(lang, title, bodyHtml) {
  const s = STRINGS[lang];
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} - redroid-forge</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
  :root { --bg: #f5f6f8; --card: #fff; --fg: #1d2330; --muted: #5a6275; --border: #d9dde5; --accent: #3a6df0; }
  @media (prefers-color-scheme: dark) { :root { --bg: #14171d; --card: #1c2028; --fg: #e6e9ef; --muted: #9aa3b5; --border: #2d3340; --accent: #6b93ff; } }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; padding: 16px; box-sizing: border-box; }
  main { max-width: 32rem; width: 100%; background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 1.4rem 1.6rem; }
  h1 { font-size: 1.15rem; margin: 0 0 0.8rem; }
  p, li { margin: 0.5rem 0; }
  ul { padding-left: 1.2rem; color: var(--muted); }
  .detail { color: var(--muted); font-family: monospace; font-size: 0.85rem; word-break: break-word; }
  a.button { display: inline-block; margin-top: 0.8rem; background: var(--accent); color: #fff; text-decoration: none; padding: 0.45rem 1rem; border-radius: 6px; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
${bodyHtml}
<a class="button" href="/">${escapeHtml(s.back)}</a>
</main>
</body>
</html>`;
}

function noRolePage({ lang = 'en', username, providerLabel } = {}) {
  const s = STRINGS[lang] || STRINGS.en;
  const l = STRINGS[lang] ? lang : 'en';
  return page(l, s.title,
    `<p>${fill(s.noRoleHead, { provider: providerLabel || 'OIDC', user: username || '?' })}</p>
<ul><li>${escapeHtml(s.noRoleLocal)}</li><li>${escapeHtml(s.noRoleAdmin)}</li></ul>`);
}

function loginFailedPage({ lang = 'en', providerLabel, message } = {}) {
  const s = STRINGS[lang] || STRINGS.en;
  const l = STRINGS[lang] ? lang : 'en';
  return page(l, s.failedTitle,
    `<p>${fill(s.failedHead, { provider: providerLabel || 'OIDC' })}</p>
<p class="detail">${escapeHtml(message)}</p>
<p>${escapeHtml(s.failedRetry)}</p>`);
}

module.exports = { noRolePage, loginFailedPage, pickLang, escapeHtml };

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { noRolePage, loginFailedPage, pickLang } = require('../src/lib/authPages');

test('pickLang: first supported language from Accept-Language, else English', () => {
  assert.strictEqual(pickLang('es-AR,es;q=0.9,en;q=0.8'), 'es');
  assert.strictEqual(pickLang('de-DE,en;q=0.5'), 'en');
  assert.strictEqual(pickLang('fr'), 'en');
  assert.strictEqual(pickLang(undefined), 'en');
});

test('no-role page: says who logged in, the two ways forward and a link back to the login', () => {
  const html = noRolePage({ lang: 'es', username: 'romina@example.com', providerLabel: 'google' });
  assert.match(html, /<html lang="es">/);
  assert.match(html, /<strong>google<\/strong>/);
  assert.match(html, /<strong>romina@example\.com<\/strong>/);
  assert.match(html, /vinculá esta cuenta desde tu perfil/);
  assert.match(html, /aparece como pendiente/);
  assert.match(html, /<a class="button" href="\/">Volver al login<\/a>/);
  assert.match(noRolePage({ lang: 'en', username: 'x' }), /does not have access yet/);
});

test('what the provider says is escaped, never markup', () => {
  const html = noRolePage({ lang: 'en', username: '<img src=x onerror=alert(1)>', providerLabel: '"><script>' });
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  const failed = loginFailedPage({ lang: 'en', providerLabel: 'plenum', message: '"<b>evil</b>" already has its own role' });
  assert.ok(!failed.includes('<b>evil</b>'));
  assert.match(failed, /Login failed/);
});

test('an unknown language falls back to English', () => {
  assert.match(loginFailedPage({ lang: 'xx', message: 'm' }), /<html lang="en">/);
});

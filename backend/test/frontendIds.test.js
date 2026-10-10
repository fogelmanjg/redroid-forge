'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// The frontend has no build step and no browser test: this at least catches the typo that
// breaks a whole screen -- app.js looking up an element or form field that index.html does not have.
const dir = path.join(__dirname, '..', '..', 'frontend');
const app = fs.readFileSync(path.join(dir, 'app.js'), 'utf-8');
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf-8');

test('every #id that app.js looks up exists in index.html', () => {
  const ids = [...new Set([...app.matchAll(/\$\('#([\w-]+)'\)/g)].map((m) => m[1]))];
  assert.ok(ids.length > 10, 'the scan found the lookups');
  const missing = ids.filter((id) => !html.includes(`id="${id}"`));
  assert.deepStrictEqual(missing, []);
});

test('every field of the new-instance form that app.js reads exists with that name', () => {
  const form = html.slice(html.indexOf('id="new-instance-form"'), html.indexOf('</form>', html.indexOf('id="new-instance-form"')));
  const fields = [...new Set([...app.matchAll(/\bform\.(\w+)\.(?:value|checked)\b/g)].map((m) => m[1]))];
  assert.ok(fields.includes('width') && fields.includes('hwenc') && fields.includes('gapps'), 'the scan found the fields');
  const missing = fields.filter((f) => !new RegExp(`name="${f}"`).test(form));
  assert.deepStrictEqual(missing, []);
});

test('the display inputs carry the same limits and defaults as the backend', () => {
  const { LIMITS, DEFAULTS } = require('../src/lib/instanceParams');
  for (const key of Object.keys(LIMITS)) {
    const m = new RegExp(`name="${key}" value="(\\d+)" min="(\\d+)" max="(\\d+)"`).exec(html);
    assert.ok(m, `${key} input`);
    assert.deepStrictEqual([Number(m[1]), Number(m[2]), Number(m[3])], [DEFAULTS[key], ...LIMITS[key]], key);
  }
});

test('every data-i18n key used in index.html exists in both languages', () => {
  const src = fs.readFileSync(path.join(dir, 'i18n.js'), 'utf-8');
  const keys = [...new Set([...html.matchAll(/data-i18n(?:-placeholder)?="([\w.]+)"/g)].map((m) => m[1]))];
  const missing = keys.filter((k) => src.split(`'${k}'`).length - 1 < 2);
  assert.deepStrictEqual(missing, []);
});

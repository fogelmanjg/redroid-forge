'use strict';

// Locked instances (1.0.0-beta.4): the Doctor line; the routes are exercised live on the dev forge.
const test = require('node:test');
const assert = require('node:assert');
const doctor = require('../src/lib/doctor');

test('checkLockedInstances: none locked -> ok, says so', () => {
  const r = doctor.checkLockedInstances({ list: () => [{ name: 'a' }, { name: 'b', locked: null }] });
  assert.strictEqual(r.status, 'ok');
  assert.match(r.detail, /No instance is locked/);
});

test('checkLockedInstances: lists each locked instance with its reason', () => {
  const r = doctor.checkLockedInstances({ list: () => [
    { name: 'a' },
    { name: 'orig-5555', locked: { reason: 'migrated to retrato-foto', by: 'admin', at: '2026-11-21T22:00:00Z' } },
    { name: 'x', locked: { by: 'admin', at: 't' } },
  ] });
  assert.strictEqual(r.status, 'ok');
  assert.match(r.detail, /2 locked instance/);
  assert.match(r.detail, /orig-5555 -- migrated to retrato-foto \(by admin/);
  assert.match(r.detail, /x -- no reason given/);
});

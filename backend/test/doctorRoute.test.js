'use strict';

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

function appAs(user) {
  const app = express();
  app.use((req, res, next) => { req.user = user; next(); });
  app.use('/api/doctor', require('../src/routes/doctor'));
  app.use('/api/network', require('../src/routes/network'));
  return app;
}

async function get(app, path) {
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    server.close();
  }
}

const viewer = { id: 'v1', username: 'romina', role: 'viewer' };

test('the full interface list is admin only', async () => {
  assert.strictEqual((await get(appAs(viewer), '/api/network/interfaces/all')).status, 403);
});

test('a non-admin Doctor: own instances only, host problems as a yes/no without details', async () => {
  const { runForUser } = require('../src/lib/doctor');
  const host = [
    { id: 'fwknop', status: 'warn', detail: 'secret firewall detail' },
    { id: 'binderfs', status: 'ok', detail: 'host detail' },
    { id: 'android-id-otro', status: 'fail', detail: 'someone else\'s instance' },
  ];
  const r = await runForUser([], { all: async () => host });
  assert.strictEqual(r.scope, 'user');
  assert.strictEqual(r.hostProblem, false, 'a warn, or a fail on someone else\'s instance, is not a host problem');
  assert.ok(!JSON.stringify(r).includes('secret firewall detail'));
  assert.ok(!JSON.stringify(r).includes('someone else'));
  const failing = await runForUser([], { all: async () => [{ id: 'binderfs', status: 'fail', detail: 'x' }] });
  assert.strictEqual(failing.hostProblem, true);
});

test('the core count stays available to any logged-in user', async () => {
  const r = await get(appAs(viewer), '/api/doctor/cores');
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.cores > 0);
});

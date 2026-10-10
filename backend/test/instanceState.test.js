'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { describe } = require('../../frontend/instanceState');

// What the UI offers for an instance has to follow its state: never "Start" on a running one,
// never "Stop"/"Restart" on a stopped one.
test('running: stop, restart and delete -- never start', () => {
  const s = describe('running');
  assert.deepStrictEqual(s.actions, ['stop', 'restart', 'delete']);
  assert.strictEqual(s.tone, 'ok');
});

test('stopped (exited / created): start and delete -- never stop or restart', () => {
  for (const status of ['exited', 'created']) {
    const s = describe(status);
    assert.deepStrictEqual(s.actions, ['start', 'delete'], status);
    assert.strictEqual(s.tone, 'idle');
  }
});

test('restarting / paused: can be stopped, not started or restarted', () => {
  for (const status of ['restarting', 'paused']) {
    assert.deepStrictEqual(describe(status).actions, ['stop', 'delete'], status);
    assert.strictEqual(describe(status).tone, 'warn');
  }
});

test('missing / dead: only delete (nothing to start or stop)', () => {
  for (const status of ['missing', 'dead']) {
    assert.deepStrictEqual(describe(status).actions, ['delete'], status);
    assert.strictEqual(describe(status).tone, 'fail');
  }
});

test('removing: no actions while Docker is removing it', () => {
  assert.deepStrictEqual(describe('removing').actions, []);
});

test('an unknown status is shown as such and can only be deleted (no guessing)', () => {
  const s = describe('something-new');
  assert.strictEqual(s.key, 'unknown');
  assert.deepStrictEqual(s.actions, ['delete']);
  assert.strictEqual(describe(undefined).key, 'unknown');
});

test('describe returns a copy: callers cannot corrupt the table of states', () => {
  describe('running').actions.push('start');
  assert.deepStrictEqual(describe('running').actions, ['stop', 'restart', 'delete']);
});

test('every status the backend can report has a label in both languages', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../../frontend/i18n.js'), 'utf-8');
  for (const key of ['running', 'restarting', 'paused', 'created', 'exited', 'removing', 'dead', 'missing', 'unknown']) {
    const hits = src.split(`'instances.status.${key}'`).length - 1;
    assert.strictEqual(hits, 2, `instances.status.${key} must exist in en and es`);
  }
});

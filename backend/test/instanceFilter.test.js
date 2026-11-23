'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { apply, group, isProblem } = require('../../frontend/instanceFilter');

const I = (name, status, extra = {}) => ({ id: name, name, status, ...extra });
const names = (r) => r.visible.map((i) => i.name);

const fleet = [
  I('zeta', 'exited'),
  I('alfa', 'running'),
  I('inst-10', 'running'),
  I('inst-2', 'running'),
  I('beta', 'created'),
  I('caida', 'dead'),
  I('pausada', 'paused'),
  I('anti', 'exited', { locked: { reason: 'x' } }),
];

test('groups: running/restarting/paused are active, the rest stopped', () => {
  for (const s of ['running', 'restarting', 'paused']) assert.strictEqual(group(s), 'active', s);
  for (const s of ['exited', 'created', 'dead', 'missing', 'removing', 'weird']) assert.strictEqual(group(s), 'stopped', s);
  assert.ok(isProblem('dead') && isProblem('missing') && isProblem('weird'));
  assert.ok(!isProblem('exited') && !isProblem('running'));
});

test('all: active first, then the ones in trouble, then the rest; natural alphabetical order', () => {
  const r = apply(fleet);
  assert.deepStrictEqual(names(r), ['alfa', 'inst-2', 'inst-10', 'pausada', 'caida', 'anti', 'beta', 'zeta']);
  assert.deepStrictEqual(r.counts, { all: 8, active: 4, stopped: 4 });
});

test('active hides the stopped ones but never one in trouble', () => {
  assert.deepStrictEqual(names(apply(fleet, { filter: 'active' })), ['alfa', 'inst-2', 'inst-10', 'pausada', 'caida']);
});

test('stopped hides the active ones, except one with a backup/restore in progress', () => {
  assert.deepStrictEqual(names(apply(fleet, { filter: 'stopped' })), ['caida', 'anti', 'beta', 'zeta']);
  assert.deepStrictEqual(names(apply(fleet, { filter: 'stopped', busyIds: new Set(['alfa']) })), ['alfa', 'caida', 'anti', 'beta', 'zeta']);
});

test('search by name, case-insensitive; the counts follow it', () => {
  const r = apply(fleet, { query: '  INST ' });
  assert.deepStrictEqual(names(r), ['inst-2', 'inst-10']);
  assert.deepStrictEqual(r.counts, { all: 2, active: 2, stopped: 0 });
  // A search hides even a pinned one: typing a name is asking for that one.
  assert.deepStrictEqual(names(apply(fleet, { query: 'alfa' })), ['alfa']);
});

test('hideLocked leaves out the locked ones, unless they are in trouble', () => {
  assert.ok(!names(apply(fleet, { hideLocked: true })).includes('anti'));
  const dead = [I('anti', 'dead', { locked: {} })];
  assert.deepStrictEqual(names(apply(dead, { hideLocked: true })), ['anti']);
});

test('an unknown filter value falls back to all; empty input is fine', () => {
  assert.strictEqual(apply(fleet, { filter: 'bogus' }).visible.length, 8);
  assert.deepStrictEqual(apply(null), { visible: [], counts: { all: 0, active: 0, stopped: 0 } });
});

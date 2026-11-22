'use strict';

// lib/externalStartWatcher.js (1.0.0-beta.4): only starts this app did not ask for, of its own
// instances' containers, reach the reconcile callback.
const test = require('node:test');
const assert = require('node:assert');
const runtime = require('../src/lib/dockerRuntime');
const store = require('../src/lib/store');
const watcher = require('../src/lib/externalStartWatcher');

function withInstances(list, fn) {
  const orig = store.readAll;
  store.readAll = () => list;
  return Promise.resolve().then(fn).finally(() => { store.readAll = orig; });
}
const evt = (id) => ({ Type: 'container', Action: 'start', id });

test('a start this app asked for (runtime.expectStart) is ignored', () => withInstances(
  [{ id: 'i1', name: 'a', containerId: 'aaaa1111' }],
  async () => {
    const seen = [];
    runtime.expectStart('aaaa1111');
    await watcher.handleEvent(evt('aaaa1111ffff'), async (i) => seen.push(i.name));
    assert.deepStrictEqual(seen, []);
  },
));

test('an external start of an instance container is reconciled; a second one too (expectation consumed)', () => withInstances(
  [{ id: 'i1', name: 'a', containerId: 'bbbb2222' }],
  async () => {
    const seen = [];
    await watcher.handleEvent(evt('bbbb2222eeee'), async (i) => seen.push(i.name));
    assert.deepStrictEqual(seen, ['a']);
    runtime.expectStart('bbbb2222');
    await watcher.handleEvent(evt('bbbb2222eeee'), async (i) => seen.push(i.name)); // expected -> ignored
    await watcher.handleEvent(evt('bbbb2222eeee'), async (i) => seen.push(i.name)); // external again
    assert.deepStrictEqual(seen, ['a', 'a']);
  },
));

test('a container that is not one of the instances is ignored', () => withInstances(
  [{ id: 'i1', name: 'a', containerId: 'cccc3333' }],
  async () => {
    const seen = [];
    await watcher.handleEvent(evt('dddd4444'), async (i) => seen.push(i.name));
    assert.deepStrictEqual(seen, []);
  },
));

test('events that are not container starts are ignored', () => withInstances(
  [{ id: 'i1', name: 'a', containerId: 'eeee5555' }],
  async () => {
    const seen = [];
    await watcher.handleEvent({ Type: 'container', Action: 'die', id: 'eeee5555' }, async (i) => seen.push(i.name));
    await watcher.handleEvent({ Type: 'network', Action: 'start', id: 'eeee5555' }, async (i) => seen.push(i.name));
    assert.deepStrictEqual(seen, []);
  },
));

// 21/11/2026: a start that turned out to be a no-op (304, already running) must not leave an
// expectation behind that would swallow the next real external start.
test('runtime.start on an already-running container leaves no expectation behind', () => withInstances(
  [{ id: 'i1', name: 'a', containerId: 'ffff6666' }],
  async () => {
    const orig = runtime.docker.getContainer;
    runtime.docker.getContainer = () => ({ start: async () => { throw Object.assign(new Error('already started'), { statusCode: 304 }); } });
    try { await runtime.start('ffff6666'); } finally { runtime.docker.getContainer = orig; }
    const seen = [];
    await watcher.handleEvent(evt('ffff6666aaaa'), async (i) => seen.push(i.name));
    assert.deepStrictEqual(seen, ['a'], 'the next external start is still noticed');
  },
));

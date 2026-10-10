'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { PassThrough } = require('stream');
const { readLogs } = require('../src/lib/dockerRuntime');

// Regression (09/10/2026): the non-streaming container.logs() goes through docker-modem, which
// JSON-parses a body that looks like JSON. An Android ID printed by an ephemeral container
// (3607632867885909819) came back as the Number 3607632867885909500 and a JSON output as
// "[object Object]". readLogs must ask for a STREAM (follow: true) and return the exact text.
test('readLogs: asks for a stream and returns the output byte for byte', async () => {
  let asked;
  const stream = new PassThrough();
  const container = { logs: async (opts) => { asked = opts; return stream; } };
  const p = readLogs(container);
  stream.write(Buffer.from('360763')); // a number split across chunks stays intact
  stream.write('2867885909819');
  stream.end();
  assert.strictEqual(await p, '3607632867885909819');
  assert.strictEqual(asked.follow, true);
  assert.strictEqual(asked.stdout, true);
});

test('readLogs: JSON-looking output is returned as text, not parsed', async () => {
  const stream = new PassThrough();
  const p = readLogs({ logs: async () => stream });
  stream.end('{"checkin": "", "legacy": "123"}');
  assert.strictEqual(await p, '{"checkin": "", "legacy": "123"}');
});

test('readLogs: a stream error rejects', async () => {
  const stream = new PassThrough();
  const p = readLogs({ logs: async () => stream });
  stream.destroy(new Error('boom'));
  await assert.rejects(p, /boom/);
});

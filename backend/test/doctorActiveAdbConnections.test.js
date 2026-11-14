'use strict';

const test = require('node:test');
const assert = require('node:assert');

const doctor = require('../src/lib/doctor');

const SS_HEADER = 'Recv-Q Send-Q         Local Address:Port              Peer Address:Port Process';

test('no instances to check -> ok, does not even look at ss', async () => {
  const r = await doctor.checkActiveAdbConnections({
    exec: async () => { throw new Error('should not be called'); },
    list: () => [],
  });
  assert.strictEqual(r.status, 'ok');
});

test('an instance with no established connection on its adbPort -> ok', async () => {
  const r = await doctor.checkActiveAdbConnections({
    exec: async () => ({ stdout: `${SS_HEADER}\n0      0          127.0.0.1:9999        127.0.0.1:1111\n` }),
    list: () => [{ name: 'jg-instancia-1', adbPort: 5557 }],
  });
  assert.strictEqual(r.status, 'ok');
  assert.match(r.detail, /No instance currently has/);
});

test('an instance with an established connection on its adbPort -> warn, names it', async () => {
  const r = await doctor.checkActiveAdbConnections({
    exec: async () => ({ stdout: `${SS_HEADER}\n0      0          127.0.0.1:5557        127.0.0.1:47713\n` }),
    list: () => [{ name: 'jg-instancia-1', adbPort: 5557 }, { name: 'jg-instancia-2', adbPort: 5600 }],
  });
  assert.strictEqual(r.status, 'warn');
  assert.match(r.detail, /jg-instancia-1/);
  assert.doesNotMatch(r.detail, /jg-instancia-2/);
});

test('several instances connected at once are all named', async () => {
  const r = await doctor.checkActiveAdbConnections({
    exec: async () => ({
      stdout: `${SS_HEADER}\n`
        + '0      0          127.0.0.1:5557        127.0.0.1:47713\n'
        + '0      0          127.0.0.1:5558        127.0.0.1:47714\n',
    }),
    list: () => [{ name: 'jg-instancia-1', adbPort: 5557 }, { name: 'jg-instancia-2', adbPort: 5558 }],
  });
  assert.strictEqual(r.status, 'warn');
  assert.match(r.detail, /jg-instancia-1/);
  assert.match(r.detail, /jg-instancia-2/);
});

test('a connection to an unrelated port (not any instance\'s adbPort) is ignored', async () => {
  const r = await doctor.checkActiveAdbConnections({
    exec: async () => ({ stdout: `${SS_HEADER}\n0      0          172.17.0.1:52754      172.17.0.3:5555\n` }),
    list: () => [{ name: 'jg-instancia-1', adbPort: 5557 }],
  });
  assert.strictEqual(r.status, 'ok');
});

test('"ss" not available -> ok (never fails the whole check over a missing tool)', async () => {
  const r = await doctor.checkActiveAdbConnections({
    exec: async () => { throw new Error('ss: command not found'); },
    list: () => [{ name: 'jg-instancia-1', adbPort: 5557 }],
  });
  assert.strictEqual(r.status, 'ok');
  assert.match(r.detail, /ss: command not found/);
});

test('instances without an adbPort yet are skipped, not matched against port "undefined"', async () => {
  const r = await doctor.checkActiveAdbConnections({
    exec: async () => ({ stdout: `${SS_HEADER}\n0      0          127.0.0.1:5557        127.0.0.1:47713\n` }),
    list: () => [{ name: 'jg-sin-puerto' }],
  });
  assert.strictEqual(r.status, 'ok');
});

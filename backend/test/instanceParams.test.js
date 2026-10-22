// Coverage of instanceParams.parseResources (CPU/RAM limits, see dockerRuntime.create/
// updateResources and routes/instances.js). Pure, no Docker/child_process involved.
const test = require('node:test');
const assert = require('node:assert/strict');

const { parseResources, parseGpuMode } = require('../src/lib/instanceParams');

test('parseResources: empty body -> no limit at all, same behavior as before this existed', () => {
  assert.deepEqual(parseResources({}), {});
  assert.deepEqual(parseResources(), {});
});

test('parseResources: memoryMb accepts an integer or a digit-only string within bounds', () => {
  assert.deepEqual(parseResources({ memoryMb: 4096 }), { memoryMb: 4096 });
  assert.deepEqual(parseResources({ memoryMb: '2048' }), { memoryMb: 2048 });
});

test('parseResources: memoryMb rejects out-of-bounds, non-integer and non-numeric values', () => {
  assert.throws(() => parseResources({ memoryMb: 64 }), /memoryMb.*between/);
  assert.throws(() => parseResources({ memoryMb: 999999 }), /memoryMb.*between/);
  assert.throws(() => parseResources({ memoryMb: 4096.5 }), /memoryMb/);
  assert.throws(() => parseResources({ memoryMb: '4096 androidboot.x=1' }), /memoryMb/);
  assert.throws(() => parseResources({ memoryMb: 'not-a-number' }), /memoryMb/);
});

test('parseResources: cpusetCpus accepts digits/commas/hyphens, rejects anything else', () => {
  assert.deepEqual(parseResources({ cpusetCpus: '0,1,8,9' }), { cpusetCpus: '0,1,8,9' });
  assert.deepEqual(parseResources({ cpusetCpus: '0-3' }), { cpusetCpus: '0-3' });
  assert.throws(() => parseResources({ cpusetCpus: '0,1; rm -rf /' }), /cpusetCpus/);
  assert.throws(() => parseResources({ cpusetCpus: 5 }), /cpusetCpus/);
});

test('parseResources: both given at once', () => {
  assert.deepEqual(
    parseResources({ memoryMb: 4096, cpusetCpus: '0,1,8,9' }),
    { memoryMb: 4096, cpusetCpus: '0,1,8,9' },
  );
});

test('parseGpuMode: omitted/empty -> {} (the image\'s own default applies, same as before this existed)', () => {
  assert.deepEqual(parseGpuMode({}), {});
  assert.deepEqual(parseGpuMode(), {});
  assert.deepEqual(parseGpuMode({ gpuMode: '' }), {});
});

test('parseGpuMode: accepts exactly "host" or "guest"', () => {
  assert.deepEqual(parseGpuMode({ gpuMode: 'host' }), { gpuMode: 'host' });
  assert.deepEqual(parseGpuMode({ gpuMode: 'guest' }), { gpuMode: 'guest' });
});

test('parseGpuMode: rejects anything else (including a boot-cmdline injection attempt)', () => {
  assert.throws(() => parseGpuMode({ gpuMode: 'soft' }), /gpuMode/);
  assert.throws(() => parseGpuMode({ gpuMode: 'host androidboot.x=1' }), /gpuMode/);
  assert.throws(() => parseGpuMode({ gpuMode: 5 }), /gpuMode/);
});

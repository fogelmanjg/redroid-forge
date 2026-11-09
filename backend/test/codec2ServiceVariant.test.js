// codec2Service's AIDL (Android 15) vs HIDL (Android 11-13) branching, added 08/11/2026 --
// see codec2Service.js's own comments on variantFor/FILES_HIDL/installIonDmaHeapFix for the
// AOSP-source-level reasoning. These are the pure (no docker/child_process) parts of it.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const {
  variantFor, artifactsBaseDir, FILES_AIDL, FILES_HIDL, FILES, ARTIFACTS_DIR,
} = require('../src/lib/codec2Service');

test('variantFor: below 14 is hidl, 14 and up (and anything unknown) is aidl', () => {
  assert.strictEqual(variantFor(11), 'hidl');
  assert.strictEqual(variantFor(12), 'hidl');
  assert.strictEqual(variantFor(13), 'hidl');
  assert.strictEqual(variantFor(14), 'aidl');
  assert.strictEqual(variantFor(15), 'aidl');
  assert.strictEqual(variantFor(16), 'aidl');
});

test('variantFor: an unresolvable image (undefined/null androidVersion) falls back to aidl -- today\'s only behaviour, unchanged', () => {
  assert.strictEqual(variantFor(undefined), 'aidl');
  assert.strictEqual(variantFor(null), 'aidl');
});

test('FILES stays the AIDL list, for anything that only ever cared about Android 15', () => {
  assert.strictEqual(FILES, FILES_AIDL);
});

test('the HIDL closure does not repeat the AIDL-only dependencies (bufferpool@2.0/bufferqueue@2.0/libdmabufheap/libcap/libminijail) -- confirmed absent on a live, working Android 11 instance', () => {
  const aidlOnly = [
    'lib64/libdmabufheap.so', 'lib64/libcap.so', 'lib64/libminijail.so',
    'lib64/android.hardware.graphics.bufferqueue@2.0.so',
    'lib64/android.hardware.media.bufferpool@2.0.so',
    'lib64/android.hardware.media.bufferpool2-V2-ndk.so',
    'lib64/libstagefright_aidl_bufferpool2.so',
    'lib64/libcodec2_aidl.so', 'lib64/android.hardware.media.c2-V1-ndk.so',
  ];
  for (const f of aidlOnly) assert.ok(!FILES_HIDL.includes(f), `FILES_HIDL should not include ${f}`);
});

test('the HIDL closure brings its own HIDL-specific binary/libs, distinct from the AIDL ones', () => {
  assert.ok(FILES_HIDL.includes('bin/hw/android.hardware.media.c2@1.1-vaapi-service'));
  assert.ok(FILES_HIDL.includes('lib64/libcodec2_hidl@1.0.so'));
  assert.ok(FILES_HIDL.includes('lib64/libcodec2_hidl@1.1.so'));
  assert.ok(!FILES_AIDL.includes('bin/hw/android.hardware.media.c2@1.1-vaapi-service'));
});

test('both variants carry their own patched libion.so (the dma_heap/legacy-ion dependency closure)', () => {
  assert.ok(FILES_AIDL.includes('lib64/libion.so'));
  assert.ok(FILES_HIDL.includes('lib64/libion.so'));
});

test('artifactsBaseDir: aidl keeps the original flat layout (ARTIFACTS_DIR as-is, even unset)', () => {
  assert.strictEqual(artifactsBaseDir('aidl'), ARTIFACTS_DIR);
});

test('artifactsBaseDir: hidl gets its own subfolder, when ARTIFACTS_DIR is configured', { skip: !ARTIFACTS_DIR }, () => {
  assert.strictEqual(artifactsBaseDir('hidl'), path.join(ARTIFACTS_DIR, 'android11-hidl'));
});

// hidlIntelRisk itself was removed 09/11/2026 -- Intel on the HIDL path turned out to hit the
// exact same bug (and fix) as Intel+legacy on the AIDL/daemon.c path, which
// hwAccel.encodeBackendRisk already covered vendor+backend-generically. See codec2Service.js's
// comment where the function used to be, and redroid-hwenc's DEVLOG.md (2026-11-09).

'use strict';

// redroid-gralloc-fix module (stage 4 -- see manifest.json and lib/moduleRunner.js).
//
// THIS IS A WORKAROUND FOR A KNOWN BUG OF REDROID, not a feature of redroid-forge: it is what has to be
// done to redroid's own file until redroid fixes it (remove the module then). Reported upstream:
// https://github.com/remote-android/redroid-doc/issues/930
//
// The official redroid 15 image ships a gralloc.gbm.so whose gralloc_gbm_bo_create works out the
// bytes per pixel with a table that stops at HAL_PIXEL_FORMAT_FLEX_RGBA_8888 (0x2A) and only
// knows YV12 above it. Any other format -- RGBA_1010102 (0x2B), asked for by Unity 6, benchmarks,
// HDR content -- ends up with bpp = 0 and the stride computation divides by it: SIGFPE in
// android.hardware.graphics.allocator@2.0-service, which is critical, so zygote and
// system_server restart and the whole of Android restarts inside the container.
//
// Affects host GPU mode on AMD (reported there, with RGBA_1010102) and Intel (the same function dies with
// P010 on an Iris Xe). The binary workaround of the issue is the one used here: `xor ecx,ecx` ->
// `mov cl,4` at file offset 0x57d2.
//
// It runs between runtime.create() and runtime.start() (the instance is stopped), on the instance's
// OWN copy of the file: the image is not touched and nothing is redistributed.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const hwAccel = require('../../lib/hwAccel');
const execFileAsync = promisify(execFile);

const GPU_VENDORS = ['amd', 'intel'];

const TARGET = '/vendor/lib64/hw/gralloc.gbm.so';
const OFFSET = 0x57d2;
// What has to be around the two bytes for the file to be the one the workaround was written for:
// `cmpl $YV12 ...; jne ...; mov $1,%ecx; jmp` before, and `jmp; mov $3,%ecx; xor %edx,%edx; div %ecx` after.
const BEFORE = Buffer.from('7c24107507b901000000eb09', 'hex');
const BUGGY = Buffer.from('31c9', 'hex');   // xor %ecx,%ecx
const FIXED = Buffer.from('b104', 'hex');    // mov $4,%cl
const AFTER = Buffer.from('eb05b90300000031d2f7', 'hex');

function log(msg) { console.log(`[redroid-gralloc-fix] ${msg}`); }
function warn(msg) { console.warn(`[redroid-gralloc-fix] ${msg}`); }

// Pure. -> { status: 'patched'|'already'|'unknown', buffer }   (the input buffer is never modified)
function patchGralloc(input) {
  const data = Buffer.from(input);
  const at = (from, expected) => data.length >= from + expected.length && data.subarray(from, from + expected.length).equals(expected);
  if (!at(OFFSET - BEFORE.length, BEFORE) || !at(OFFSET + 2, AFTER)) return { status: 'unknown', buffer: data };
  if (at(OFFSET, FIXED)) return { status: 'already', buffer: data };
  if (!at(OFFSET, BUGGY)) return { status: 'unknown', buffer: data };
  FIXED.copy(data, OFFSET);
  return { status: 'patched', buffer: data };
}

async function integrate(containerId, ctx = {}, { copyOut, copyIn, gpuVendor } = {}) {
  const vendor = gpuVendor || await hwAccel.detectGpuVendor();
  if (!GPU_VENDORS.includes(vendor)) {
    log(`the host GPU is "${vendor}" (the bug is known on ${GPU_VENDORS.join('/')}): ${TARGET} of ${containerId} left as it is`);
    return;
  }
  const out = copyOut || ((src, dest) => execFileAsync('docker', ['cp', `${containerId}:${src}`, dest]));
  const put = copyIn || ((src, dest) => execFileAsync('docker', ['cp', src, `${containerId}:${dest}`]));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redroid-gralloc-fix-'));
  const file = path.join(dir, path.basename(TARGET));
  try {
    await out(TARGET, file);
    const mode = fs.statSync(file).mode & 0o777;
    const { status, buffer } = patchGralloc(fs.readFileSync(file));
    if (status === 'already') { log(`${TARGET} of ${containerId} already has the fix`); return; }
    if (status === 'unknown') {
      warn(`${TARGET} of ${containerId} is not the version this fix was written for: left as it is (an app asking for a 10-bit buffer can still restart Android)`);
      return;
    }
    fs.writeFileSync(file, buffer);
    fs.chmodSync(file, mode);
    await put(file, TARGET);
    log(`patched ${TARGET} of ${containerId} (2 bytes at 0x${OFFSET.toString(16)})`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = {
  integrate, patchGralloc, TARGET, OFFSET, GPU_VENDORS,
};

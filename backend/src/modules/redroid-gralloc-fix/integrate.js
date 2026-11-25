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
// Patching alone is NOT enough: an app that asks for a 10-bit config (3DMark does) then gets a buffer that
// the gralloc allocates as 8-bit XRGB8888, and renders into it as 10-bit: a garbled picture (found with 3DMark on
// 10/10/2026, the issue even shows "Angry Birds Worse Edition"). So the module does two things: the init script
// that makes Mesa's EGL stop offering 10-bit configurations (apps then use an 8-bit one, and the picture is right),
// and the 2-byte patch as the safety net for whatever asks for a 10-bit buffer by another way.
//
// It runs between runtime.create() and runtime.start() (the instance is stopped), on the instance's
// OWN copy of the files: the image is not touched and nothing is redistributed.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const hwAccel = require('../../lib/hwAccel');
const execFileAsync = promisify(execFile);

const GPU_VENDORS = ['amd', 'intel'];

const TARGET = '/vendor/lib64/hw/gralloc.gbm.so';
// The init script that keeps Mesa's EGL from offering 10-bit configurations (see the file and the README).
const RC_SOURCE = path.join(__dirname, 'redroid-no-rgb10.rc');
const RC_TARGET = '/vendor/etc/init/redroid-no-rgb10.rc';
const OFFSET = 0x57d2;
// What has to be around the two bytes for the file to be the one the workaround was written for:
// `cmpl $YV12 ...; jne ...; mov $1,%ecx; jmp` before, and `jmp; mov $3,%ecx; xor %edx,%edx; div %ecx` after.
const BEFORE = Buffer.from('7c24107507b901000000eb09', 'hex');
const BUGGY = Buffer.from('31c9', 'hex');   // xor %ecx,%ecx
const FIXED = Buffer.from('b104', 'hex');    // mov $4,%cl
const AFTER = Buffer.from('eb05b90300000031d2f7', 'hex');

// 1.0.0-rc.5: YV12 video buffers the GPU can import. The same file lays out a YV12 buffer with the
// image WIDTH as the luma row pitch and half of it (aligned to 16) for the chroma planes, in a GR88 bo
// only w/2 wide. AMD's driver (radeonsi) only imports a linear plane whose pitch is a multiple of 256
// bytes, so for nearly every video size (720x1280, 1280x720, 720x406, 1920x1080...) Mesa's
// eglCreateImage returns EGL_NO_IMAGE and surfaceflinger aborts ("Failed to create a valid texture"),
// which restarts the whole of Android -- seen on server01 with video ads, 25/11/2026. Two changes:
//  - gralloc_gbm_bo_create: the GR88 bo for YV12 is ALIGN(w, 512)/2 wide instead of w/2, so its real
//    pitch is a multiple of 512 (27 bytes, same length: add/shr/shl instead of the signed halving);
//  - gralloc_gbm_bo_lock_ycbcr: the luma pitch is the handle's real stride (offset 0x28) instead of its
//    width (0x18), so the chroma pitch, half of it, is a multiple of 256 (1 byte).
//  - gralloc_gbm_handle_register: the importing side rebuilds the bo with the same real width (16 bytes).
// All or none: one without the others is a layout that does not match the buffer.
const YV12_PATCHES = [
  {
    offset: 0x5673,
    before: Buffer.from('817c241859563132751b', 'hex'), // cmpl $YV12,0x18(%rsp); jne
    buggy: Buffer.from('4989f64489e0c1e81f4401e0d1f84489ead1ea4101d54189c4eb03', 'hex'),
    fixed: Buffer.from('4989f64181c4ff01000041c1ec0941c1e4084489ead1ea4101d590', 'hex'),
    after: Buffer.from('4989f6488b7c2420', 'hex'),
  },
  {
    // gralloc_gbm_handle_register: a process that IMPORTS the buffer (the decoder, surfaceflinger) rebuilt
    // the bo with the old w/2 width, and the driver clipped CPU writes to it -- every odd chroma row lost
    // its last bytes (seen 25/11/2026 as a striped right edge on the video). The width now comes from the
    // handle's real stride (stride/2 GR88 pixels); the height keeps h + h/2, added in place (16 bytes).
    offset: 0x54f0,
    before: Buffer.from('4181f8595631327510', 'hex'), // cmp $YV12,%r8d; jne
    buggy: Buffer.from('d1e9894c241089f9d1e901f9894c2414', 'hex'),
    fixed: Buffer.from('8b4828d1e9894c2410d1ef017c241490', 'hex'),
    after: Buffer.from('c744241c01000000', 'hex'),
  },
  {
    offset: 0x5b33,
    before: Buffer.from('31c04883c4105bc348634b', 'hex'), // ...ret; movslq 0x??(%rbx),%rcx
    buggy: Buffer.from('18', 'hex'),
    fixed: Buffer.from('28', 'hex'),
    after: Buffer.from('89cac1ea1f01cad1fa', 'hex'),
  },
];

function log(msg) { console.log(`[redroid-gralloc-fix] ${msg}`); }
function warn(msg) { console.warn(`[redroid-gralloc-fix] ${msg}`); }

// Pure. -> { status: 'patched'|'already'|'unknown', buffer, yv12: 'patched'|'already'|'unknown' }
// (the input buffer is never modified). `status` keeps its meaning (the 10-bit patch, which the doctor
// checks); `yv12` is the video patch, applied only when every one of its parts is recognised.
function patchGralloc(input) {
  const data = Buffer.from(input);
  const at = (from, expected) => data.length >= from + expected.length && data.subarray(from, from + expected.length).equals(expected);

  let yv12;
  const ctxOk = YV12_PATCHES.every((p) => at(p.offset - p.before.length, p.before) && at(p.offset + p.buggy.length, p.after));
  if (!ctxOk) yv12 = 'unknown';
  else if (YV12_PATCHES.every((p) => at(p.offset, p.fixed))) yv12 = 'already';
  else if (YV12_PATCHES.every((p) => at(p.offset, p.buggy) || at(p.offset, p.fixed))) {
    for (const p of YV12_PATCHES) p.fixed.copy(data, p.offset);
    yv12 = 'patched';
  } else yv12 = 'unknown';

  let status;
  if (!at(OFFSET - BEFORE.length, BEFORE) || !at(OFFSET + 2, AFTER)) status = 'unknown';
  else if (at(OFFSET, FIXED)) status = 'already';
  else if (!at(OFFSET, BUGGY)) status = 'unknown';
  else {
    FIXED.copy(data, OFFSET);
    status = 'patched';
  }
  if (status === 'unknown') return { status, buffer: Buffer.from(input), yv12: 'unknown' };
  if (status === 'already' && yv12 === 'patched') status = 'patched';
  return { status, buffer: data, yv12 };
}

async function integrate(containerId, ctx = {}, {
  copyOut, copyIn, gpuVendor, rcSource = RC_SOURCE,
} = {}) {
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
    // 1. Mesa's EGL does not offer 10-bit configurations (the init script).
    await put(rcSource, RC_TARGET);
    log(`installed ${RC_TARGET} in ${containerId} (Mesa's EGL will not offer 10-bit configurations)`);
    // 2. the safety net for 10-bit buffers, and the YV12 video layout (see patchGralloc).
    await out(TARGET, file);
    const mode = fs.statSync(file).mode & 0o777;
    const { status, buffer, yv12 } = patchGralloc(fs.readFileSync(file));
    if (status === 'already') { log(`${TARGET} of ${containerId} already has the fix`); return; }
    if (status === 'unknown') {
      warn(`${TARGET} of ${containerId} is not the version this fix was written for: left as it is (an app asking for a 10-bit buffer can still restart Android)`);
      return;
    }
    fs.writeFileSync(file, buffer);
    fs.chmodSync(file, mode);
    await put(file, TARGET);
    log(`patched ${TARGET} of ${containerId} (10-bit fix${yv12 === 'patched' || yv12 === 'already' ? ' + YV12 video layout' : '; YV12 video layout NOT recognised, left as it was'})`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 1.0.0-rc.5: before every start/restart too, not only at creation (stage 4), so an instance created
// before a fix was added to this file gets it on its next start. Idempotent (an already patched file
// is left alone) and it never fails the start: without it the instance runs as it did before.
async function ensure(instance, requiredModuleIds, deps = {}) {
  if (!instance || !instance.containerId || !(requiredModuleIds || []).includes('redroid-gralloc-fix')) return;
  try {
    await integrate(instance.containerId, {}, deps);
  } catch (e) {
    warn(`could not check ${TARGET} of "${instance.name}" before its start: ${e.message}`);
  }
}

module.exports = {
  integrate, ensure, patchGralloc, TARGET, OFFSET, YV12_PATCHES, GPU_VENDORS, RC_TARGET, RC_SOURCE,
};

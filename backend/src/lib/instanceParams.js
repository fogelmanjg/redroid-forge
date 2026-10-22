'use strict';

// Display parameters of an instance, validated on the server. They end up in the container's
// kernel command line (`androidboot.redroid_width=<value>` ...), so an unvalidated string such as
// "720 androidboot.redroid_gpu_mode=guest" would inject extra arguments: only plain integers
// within sane limits get through. Pure (no I/O).

const DEFAULTS = { width: 720, height: 1280, dpi: 160, fps: 60 };
const LIMITS = {
  width: [240, 7680], height: [240, 7680], dpi: [72, 640], fps: [1, 120],
};

function httpError(message, httpStatus) {
  return Object.assign(new Error(message), { httpStatus });
}

// `body`: the request body. A missing (undefined, null or empty) value takes the default.
// -> { width, height, dpi, fps } as integers. Throws Error with httpStatus 400.
function parseDisplay(body = {}) {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    const raw = body[key];
    if (raw === undefined || raw === null || raw === '') { out[key] = DEFAULTS[key]; continue; }
    // Numbers, or strings made only of digits: nothing else (no spaces, signs or decimals).
    const ok = (typeof raw === 'number' && Number.isInteger(raw))
      || (typeof raw === 'string' && /^\d{1,5}$/.test(raw));
    const n = ok ? Number(raw) : NaN;
    const [min, max] = LIMITS[key];
    if (!Number.isInteger(n) || n < min || n > max) {
      throw httpError(`"${key}" must be an integer between ${min} and ${max}`, 400);
    }
    out[key] = n;
  }
  return out;
}

// CPU/RAM limits -- unlike display, there is no default: omitting them keeps today's behavior
// exactly (no limit at all, Docker's own default). dockerRuntime.create() already accepted
// `memoryMb` since it was written, nothing ever called it with one -- this is what actually
// wires it through from a request. `cpusetCpus` goes straight into HostConfig.CpusetCpus, which
// Docker itself validates against the real host topology; the character-set check here is only
// defense in depth (same reasoning as parseDisplay: never let a request body smuggle something
// unexpected into a Docker HostConfig field), not a topology check.
const MEMORY_MB_LIMITS = [128, 65536];
const CPUSET_RE = /^[\d,-]{1,64}$/;

// -> { memoryMb?, cpusetCpus? } -- only the keys that were actually given, so the caller (e.g.
// dockerRuntime.create's `...(memoryMb ? {...} : {})`) keeps behaving exactly as it does for an
// instance that never asked for a limit. Throws Error with httpStatus 400.
function parseResources(body = {}) {
  const out = {};
  if (body.memoryMb !== undefined && body.memoryMb !== null && body.memoryMb !== '') {
    const raw = body.memoryMb;
    const ok = (typeof raw === 'number' && Number.isInteger(raw))
      || (typeof raw === 'string' && /^\d{1,6}$/.test(raw));
    const n = ok ? Number(raw) : NaN;
    const [min, max] = MEMORY_MB_LIMITS;
    if (!Number.isInteger(n) || n < min || n > max) {
      throw httpError(`"memoryMb" must be an integer between ${min} and ${max}`, 400);
    }
    out.memoryMb = n;
  }
  if (body.cpusetCpus !== undefined && body.cpusetCpus !== null && body.cpusetCpus !== '') {
    if (typeof body.cpusetCpus !== 'string' || !CPUSET_RE.test(body.cpusetCpus)) {
      throw httpError('"cpusetCpus" must look like "0,1,8,9" or "0-3" (digits, commas and hyphens only)', 400);
    }
    out.cpusetCpus = body.cpusetCpus;
  }
  return out;
}

// gpuMode override -- same family of boot-cmdline value as display (androidboot.redroid_gpu_mode),
// not a runtime toggle: changing it on an existing instance needs a real recreate, there is no
// live-update route for it (unlike resources/device-profile). Omitted = the image's own default
// (img.gpuMode), the only behavior there was before this existed.
const GPU_MODES = ['host', 'guest'];

// -> { gpuMode? } -- only set if the request actually asked for a specific one. Throws Error
// with httpStatus 400 for anything that is not exactly 'host' or 'guest'.
function parseGpuMode(body = {}) {
  const raw = body.gpuMode;
  if (raw === undefined || raw === null || raw === '') return {};
  if (!GPU_MODES.includes(raw)) {
    throw httpError(`"gpuMode" must be one of: ${GPU_MODES.join(', ')}`, 400);
  }
  return { gpuMode: raw };
}

module.exports = {
  parseDisplay, DEFAULTS, LIMITS, parseResources, MEMORY_MB_LIMITS, CPUSET_RE, parseGpuMode, GPU_MODES,
};

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

// `body`: the request body. A missing (undefined, null or empty) value takes `fallback[key]`
// (DEFAULTS at creation; an existing instance's own current `display` when editing one, see
// POST /:id/display -- so changing just `dpi` there does not reset width/height/fps back to
// the generic defaults).
// -> { width, height, dpi, fps } as integers. Throws Error with httpStatus 400.
function parseDisplay(body = {}, fallback = DEFAULTS) {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    const raw = body[key];
    if (raw === undefined || raw === null || raw === '') { out[key] = fallback[key] ?? DEFAULTS[key]; continue; }
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

// Which host interfaces an instance's ADB port binds to (dockerRuntime.create's `bindHosts` --
// see docs/ROADMAP.md Phase 6). `redroid` itself has no access control of its own, so the
// default has to be the safe one: localhost only, nobody else on the LAN/Internet can even see
// the port. Docker supports binding the same container port to several host interfaces at once
// (an array of {HostIp, HostPort}), so this is a list, not a single value. Only the shape of
// each address is checked here (IPv4/IPv6-looking), same "defense in depth, not a topology
// check" reasoning as cpusetCpus above -- Docker itself rejects an address that is not really
// one of the host's own.
const DEFAULT_BIND_HOSTS = ['127.0.0.1'];
const IP_SHAPE_RE = /^[0-9a-fA-F:.]{2,45}$/;

// -> string[]. `fallback`: DEFAULT_BIND_HOSTS at creation, an existing instance's own current
// `bindHosts` when editing one (so changing just the display settings does not silently reset
// network exposure back to localhost). Throws Error with httpStatus 400.
function parseBindHosts(body = {}, fallback = DEFAULT_BIND_HOSTS) {
  const raw = body.bindHosts;
  if (raw === undefined || raw === null) return fallback;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw httpError('"bindHosts" must be a non-empty array of IP addresses', 400);
  }
  const out = [];
  for (const h of raw) {
    if (typeof h !== 'string' || !IP_SHAPE_RE.test(h)) {
      throw httpError(`"bindHosts" contains an invalid address: ${JSON.stringify(h)}`, 400);
    }
    out.push(h);
  }
  // 0.0.0.0 (or IPv6's ::) already covers every other address on the list, including
  // 127.0.0.1 -- binding both at once is not "localhost + everything", it is the SAME port
  // claimed twice. Confirmed live (24/10/2026): Docker rejects this outright through the CLI
  // ("address already in use"), and through the Engine API (what dockerode uses) it is worse --
  // no error at all, the container starts with NO port published, silently. Collapsing to the
  // wildcard alone avoids ever sending Docker that combination.
  if (out.includes('0.0.0.0')) return ['0.0.0.0'];
  if (out.includes('::')) return ['::'];
  return out;
}

module.exports = {
  parseDisplay, DEFAULTS, LIMITS, parseResources, MEMORY_MB_LIMITS, CPUSET_RE, parseGpuMode, GPU_MODES,
  parseBindHosts, DEFAULT_BIND_HOSTS,
};

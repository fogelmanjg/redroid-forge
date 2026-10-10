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

module.exports = { parseDisplay, DEFAULTS, LIMITS };

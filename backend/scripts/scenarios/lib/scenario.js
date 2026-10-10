'use strict';

// A scenario is a JSON file that says WHAT to measure (see scenarios/*.json and docs/SCENARIOS.md):
//
//   { "id": "encode-solo",
//     "description": "...",
//     "durationS": 30,          seconds of load, measured
//     "warmupS": 5,             seconds after boot, before the measurement starts
//     "staggerS": 4,            seconds between one instance's creation and the next (many boots at once
//                               can make an Android restart: that is not what is being measured)
//     "instances": [ { "name": "a", "modules": ["hwenc"], "width": 1280, "height": 720, "dpi": 240, "fps": 30,
//                      "workloads": [ { "type": "encode", "bitrateMbps": 8 } ] } ],
//     "criteria": { ... see lib/criteria.js } }
//
// Pure validation: it either returns the scenario with its defaults filled in, or throws with every
// problem found (not just the first), so the file can be fixed in one pass.

const WORKLOAD_TYPES = ['idle', 'encode', 'decode'];
const OPTIONAL_MODULES = ['hwenc', 'gapps'];
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,19}$/;

function int(v) { return Number.isInteger(v); }

function validate(raw) {
  const errors = [];
  const sc = JSON.parse(JSON.stringify(raw)); // never mutate what the caller passed

  if (typeof sc.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(sc.id)) errors.push('"id" must be lowercase letters, digits and hyphens');
  if (!int(sc.durationS) || sc.durationS < 5 || sc.durationS > 600) errors.push('"durationS" must be an integer between 5 and 600');
  sc.warmupS = sc.warmupS === undefined ? 5 : sc.warmupS;
  if (!int(sc.warmupS) || sc.warmupS < 0 || sc.warmupS > 120) errors.push('"warmupS" must be an integer between 0 and 120');
  sc.staggerS = sc.staggerS === undefined ? 4 : sc.staggerS;
  if (!int(sc.staggerS) || sc.staggerS < 0 || sc.staggerS > 30) errors.push('"staggerS" must be an integer between 0 and 30');
  sc.criteria = sc.criteria || {};
  if (typeof sc.criteria !== 'object' || Array.isArray(sc.criteria)) errors.push('"criteria" must be an object');

  if (!Array.isArray(sc.instances) || sc.instances.length < 1 || sc.instances.length > 12) {
    errors.push('"instances" must be a list of 1 to 12');
  } else {
    const seen = new Set();
    sc.instances.forEach((inst, i) => {
      const where = `instances[${i}]`;
      if (typeof inst.name !== 'string' || !NAME_RE.test(inst.name)) errors.push(`${where}.name must be lowercase letters, digits and hyphens (1-20)`);
      else if (seen.has(inst.name)) errors.push(`${where}.name "${inst.name}" is repeated`);
      else seen.add(inst.name);
      inst.modules = inst.modules || [];
      if (!Array.isArray(inst.modules) || inst.modules.some((m) => !OPTIONAL_MODULES.includes(m))) {
        errors.push(`${where}.modules must be a list of: ${OPTIONAL_MODULES.join(', ')}`);
      }
      for (const k of ['width', 'height', 'dpi', 'fps']) {
        if (inst[k] !== undefined && !int(inst[k])) errors.push(`${where}.${k} must be an integer`);
      }
      inst.workloads = inst.workloads || [];
      if (!Array.isArray(inst.workloads)) errors.push(`${where}.workloads must be a list`);
      else {
        inst.workloads.forEach((w, j) => {
          if (!WORKLOAD_TYPES.includes(w.type)) errors.push(`${where}.workloads[${j}].type must be one of: ${WORKLOAD_TYPES.join(', ')}`);
          if (w.type === 'encode' && w.bitrateMbps !== undefined && !(typeof w.bitrateMbps === 'number' && w.bitrateMbps > 0 && w.bitrateMbps <= 100)) {
            errors.push(`${where}.workloads[${j}].bitrateMbps must be a number between 0 and 100`);
          }
          if (w.type === 'decode') {
            if (w.decoder !== undefined && !['hw', 'sw'].includes(w.decoder)) errors.push(`${where}.workloads[${j}].decoder must be "hw" or "sw"`);
            if (w.decoder !== 'sw' && !inst.modules.includes('hwenc')) {
              errors.push(`${where}.workloads[${j}]: the hardware decoder only exists in an instance with the "hwenc" module (ask for decoder "sw" or add the module)`);
            }
            if (w.clip !== undefined && w.file !== undefined) errors.push(`${where}.workloads[${j}]: "clip" and "file" are exclusive`);
          }
        });
      }
    });
  }
  if (errors.length) throw new Error(`Invalid scenario${sc.id ? ` "${sc.id}"` : ''}:\n  - ${errors.join('\n  - ')}`);
  return sc;
}

module.exports = { validate, WORKLOAD_TYPES, OPTIONAL_MODULES };

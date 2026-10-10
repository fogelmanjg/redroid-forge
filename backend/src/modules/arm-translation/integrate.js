'use strict';

// arm-translation module (stages 3 and 4 -- see manifest.json and lib/moduleRunner.js): it lets an
// x86_64 instance run apps that only carry ARM64 native code (most mobile games), through the
// ndk_translation native bridge that Google ships in the images of the Android SDK emulator.
//
// Like gapps this is NON-FREE third-party software: redroid-forge neither includes, hosts nor
// downloads it. The files come from a folder of the host that the USER provides
// (REDROID_FORGE_ARM_DIR, by default backend/data/arm-translation; backend/scripts/sdk-extract.js
// fills it from the system image of the SDK) and EVERY file is verified against its sha256 before
// anything is injected.
//
// What it does NOT do, on purpose: register ARM executables in binfmt_misc. That kernel facility is
// one for the whole host, shared by all the containers, and it is only needed to run ARM programs
// from a shell; apps go through the native bridge (ART loads libndk_translation.so).

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const bundle = require('../gapps/bundle');
const { RULES } = require('../../lib/fileBundle');
const execFileAsync = promisify(execFile);

const ARM_DIR = process.env.REDROID_FORGE_ARM_DIR
  || path.join(__dirname, '..', '..', '..', 'data', 'arm-translation');
const TIPO = 'arm-translation';

// Boot properties (redroid turns "ro.*" arguments of the container into properties): the native
// bridge itself, and the instruction sets Android has to map to x86 (without them ART compiles
// the app's code for the wrong ISA).
const BOOT_PROPS = [
  'ro.dalvik.vm.native.bridge=libndk_translation.so',
  'ro.dalvik.vm.isa.arm64=x86_64',
  'ro.dalvik.vm.isa.arm=x86',
];

// Only these names may be injected, whatever a package definition says: a database that is
// downloaded must never be able to replace another library of /system/lib64.
const ALLOWED_FILE = new RegExp('^system/('
  + 'lib64/(libndk_translation(_proxy_[A-Za-z0-9_]+)?\\.so|libberberis_exec_region\\.so|arm64/[A-Za-z0-9_.@+-]+\\.so)'
  + '|bin/arm64/(app_process64|linker64)'
  + '|etc/(cpuinfo|ld\\.config)\\.arm64\\.txt'
  + ')$');

function log(msg) { console.log(`[arm-translation] ${msg}`); }
function warn(msg) { console.warn(`[arm-translation] ${msg}`); }

function readLocalPackage(dir) {
  const file = path.join(dir, 'package.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new Error(`${file} is not valid JSON: ${e.message}`);
  }
}

function dbPackages() {
  try {
    return require('../../lib/knownDbStore').loadCurrent().db.paquetes;
  } catch (e) {
    warn(`the known-combinations database could not be read (${e.message}): only the local package.json is used`);
    return [];
  }
}

// -> { pkg, source: 'db'|'local' }, throws with a message that tells the user what to do.
async function resolveAndVerify(dir = ARM_DIR, packages = dbPackages()) {
  const local = readLocalPackage(dir);
  if (!local) {
    throw new Error(
      `ARM translation: there are no files in ${dir}. This project does not download Google software: `
      + 'put it there yourself (backend/scripts/sdk-extract.js arm-translation <system image zip> extracts it from the '
      + 'system image of the Android SDK) and try again.',
    );
  }
  const chosen = bundle.choosePackage(packages, local, TIPO);
  if (chosen.error) throw new Error(`ARM translation: ${chosen.error}`);

  const stray = chosen.pkg.archivos.map((f) => f.path).filter((p) => !ALLOWED_FILE.test(p));
  if (stray.length > 0) {
    throw new Error(`ARM translation: the package lists files this module never injects, nothing was injected: ${stray.slice(0, 4).join(', ')}`);
  }
  const verdict = await bundle.verifyBundle(dir, chosen.pkg.archivos, RULES[TIPO]);
  if (!verdict.ok) {
    const shown = verdict.problems.slice(0, 6).join('; ');
    const more = verdict.problems.length > 6 ? ` (+${verdict.problems.length - 6} more)` : '';
    throw new Error(`ARM translation: the files in ${dir} do not match the package definition, nothing was injected: ${shown}${more}`);
  }
  return chosen;
}

// Stage 3: before the container is created. It checks the files already (failing here is cheaper
// than failing after the container exists) and adds the boot properties.
async function prepareCreate({ dir = ARM_DIR, packages } = {}) {
  await resolveAndVerify(dir, packages);
  return { cmd: [...BOOT_PROPS] };
}

// Stage 4: between runtime.create() and runtime.start(), while /system of the instance can be
// written with `docker cp` (see gapps/integrate.js for why then).
async function integrate(containerId, ctx = {}, { dir = ARM_DIR, packages, copy } = {}) {
  const { pkg, source } = await resolveAndVerify(dir, packages);
  if (source === 'local') {
    warn(`package "${pkg.id || '(no id)'}" is not in the known-combinations database: it is injected, but this combination is UNSUPPORTED`);
  }
  const doCopy = copy || ((src, dest) => execFileAsync('docker', ['cp', `${src}/.`, `${containerId}:${dest}/`]));
  // The files live in <dir>/system/{lib64,bin,etc}/...; in the instance that is /system/{lib64,bin,etc}.
  for (const unit of ['lib64', 'bin', 'etc']) {
    // eslint-disable-next-line no-await-in-loop
    await doCopy(path.join(dir, 'system', unit), `/system/${unit}`);
  }
  log(`injected "${pkg.id || TIPO}" (${pkg.archivos.length} files, ${source}) into ${containerId}`);
}

module.exports = {
  prepareCreate, integrate, resolveAndVerify, ARM_DIR, BOOT_PROPS, ALLOWED_FILE,
};

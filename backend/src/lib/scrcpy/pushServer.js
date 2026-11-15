'use strict';

// Locates and pushes the real scrcpy-server.jar (Genymobile/scrcpy, Apache 2.0) into an
// instance's container, so our own protocol client (launchServer.js + the socket readers in
// this same directory) can drive it directly -- no desktop scrcpy binary, no third-party ADB/
// scrcpy npm library, per the project's own "armar algo nuestro" decision for the web viewer.
//
// Unlike gapps/arm-translation this is NOT treated as non-free third-party content needing a
// user-provided folder + sha256 registry: scrcpy is Apache 2.0, and this project already
// documents the desktop `scrcpy` binary as a plain host prerequisite (scripts/connect.sh: "None
// of them are bundled here -- install them with your distro's package manager"). The server jar
// that ships alongside that same install is just read from disk, same trust level as `adb`/
// `scrcpy` themselves already have in this project.

const fs = require('fs');
const dockerRuntime = require('../dockerRuntime');

const DEST_PATH = '/data/local/tmp/scrcpy-server.jar';

// Checked in this order: an explicit override, then the conventional install locations a distro
// package or `make install` puts it in (both of these are read back identical on this host --
// confirmed by hand, 733930 bytes, matching the installed `scrcpy --version` 5.0.1 -- vs. a
// stale unrelated 41650-byte file under /usr/share/scrcpy/ left by an old distro package that is
// NOT what the installed `scrcpy` binary actually uses, confirmed via `strings` on the binary
// itself: it looks for `SCRCPY_SERVER_PATH` first, then alongside its own binary).
function candidatePaths() {
  const paths = [];
  if (process.env.REDROID_FORGE_SCRCPY_SERVER) paths.push(process.env.REDROID_FORGE_SCRCPY_SERVER);
  if (process.env.SCRCPY_SERVER_PATH) paths.push(process.env.SCRCPY_SERVER_PATH);
  paths.push(
    '/usr/local/share/scrcpy/scrcpy-server',
    '/usr/local/bin/scrcpy-server',
    '/usr/share/scrcpy/scrcpy-server',
  );
  return paths;
}

let cached = null; // { buffer, sourcePath } -- read once per backend process, same reasoning as
// any other "whatever is installed on this host right now" dependency: a scrcpy package upgrade
// is picked up on the next backend restart, not live.

function locate() {
  if (cached) return cached;
  for (const p of candidatePaths()) {
    try {
      const buffer = fs.readFileSync(p);
      if (buffer.length > 0) { cached = { buffer, sourcePath: p }; return cached; }
    } catch (e) { /* try the next candidate */ }
  }
  throw new Error(
    'scrcpy-server.jar was not found on this host (checked REDROID_FORGE_SCRCPY_SERVER, '
    + 'SCRCPY_SERVER_PATH, and the usual install paths). Install scrcpy '
    + '(https://github.com/Genymobile/scrcpy) the same way scripts/connect.sh already requires '
    + 'it, or set REDROID_FORGE_SCRCPY_SERVER to the exact jar path.',
  );
}

// `adb push` would also need the device actually connected first; `docker cp` (via
// dockerRuntime.writeFile) reaches the container directly, no ADB round trip for this step --
// consistent with androidExec.js's own docker-exec-not-adb convention.
async function pushToContainer(containerId) {
  const { buffer } = locate();
  await dockerRuntime.writeFile(containerId, DEST_PATH, buffer, { mode: 0o644 });
}

module.exports = { DEST_PATH, locate, pushToContainer };

'use strict';

// The content of the first regular file of a tar archive (what `docker cp` / dockerode's getArchive returns
// for one file). Minimal on purpose: ustar headers of 512 bytes, the size in octal, no long-name extensions
// needed since only the first entry is read. Pure.
function firstFileFromTar(tar) {
  let off = 0;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) return null;
    const size = parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    off += 512;
    if (type === '0' || type === '\0') return tar.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
  }
  return null;
}

module.exports = { firstFileFromTar };

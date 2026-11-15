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

function writeOctal(buf, offset, value, len) {
  const octal = value.toString(8).padStart(len - 1, '0');
  buf.write(octal, offset, len - 1, 'ascii');
  buf[offset + len - 1] = 0;
}

function writeStr(buf, offset, str, len) {
  const b = Buffer.from(str, 'utf-8');
  b.copy(buf, offset, 0, Math.min(b.length, len));
}

// The inverse of firstFileFromTar: a single-entry ustar archive (what dockerode's putArchive /
// `docker cp` into a container expects), a regular file with one name/mode/content. Minimal on
// purpose, same spirit as firstFileFromTar -- no long-name (prefix) support, no directories,
// since every caller so far (scrcpy/pushServer.js) only ever pushes one short-named file.
function buildSingleFileTar(name, data, mode = 0o644) {
  if (Buffer.byteLength(name, 'utf-8') > 100) throw new Error(`tar entry name too long for ustar (no prefix support): ${name}`);
  const header = Buffer.alloc(512);
  writeStr(header, 0, name, 100);
  writeOctal(header, 100, mode, 8);
  writeOctal(header, 108, 0, 8); // uid
  writeOctal(header, 116, 0, 8); // gid
  writeOctal(header, 124, data.length, 12);
  writeOctal(header, 136, Math.floor(Date.now() / 1000), 12);
  header.write('        ', 148, 8, 'ascii'); // checksum placeholder (8 spaces) while summing below
  header[156] = 0x30; // typeflag '0' = regular file
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i];
  // Checksum field is 8 bytes but NOT the generic "digits+NUL" shape every other field uses: 6
  // octal digits, then NUL, then a trailing space (ustar quirk) -- writeOctal(..., 7) gives the
  // 6-digit+NUL part, the space is set separately right after.
  writeOctal(header, 148, sum, 7);
  header[155] = 0x20;
  const padding = (512 - (data.length % 512)) % 512;
  return Buffer.concat([header, data, Buffer.alloc(padding), Buffer.alloc(1024)]);
}

module.exports = { firstFileFromTar, buildSingleFileTar };

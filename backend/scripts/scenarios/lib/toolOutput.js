'use strict';

// What hwdec_mediacodec_test prints. The tool is built in an AOSP tree, so the binary in use can be OLDER than
// the source in this repository: until the project was translated to English the result line was
//   RESULTADO: <decoder> <mime> -> 300 frames en 3.10 s (96.7 fps)
// and now it is
//   RESULT: <decoder> <mime> -> 300 frames in 3.10 s (96.7 fps)
// Both are accepted, so a measurement does not depend on which build of the tool happens to be around.

const RESULT_RE = /RESULT(?:ADO)?: (\S+) (\S+) -> (\d+) frames (?:in|en) ([\d.]+) s \(([\d.]+) fps\)/;

// -> { decoder, mime, frames, seconds, fps } or null if the line is not there (the tool failed before it)
function parseDecodeResult(text) {
  const m = RESULT_RE.exec(String(text || ''));
  return m ? { decoder: m[1], mime: m[2], frames: Number(m[3]), seconds: Number(m[4]), fps: Number(m[5]) } : null;
}

module.exports = { parseDecodeResult };

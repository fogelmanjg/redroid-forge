const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const hwAccel = require('../src/lib/hwAccel');
const { addCodecsToXml } = require('../src/modules/hwenc/integrate');

// The daemon's response (HwDecCapsResponse of protocol.h, 176 bytes).
function capsResponse({ status = 0, mask = 0, mask10 = 0, driver = 'Mesa test' } = {}) {
  const b = Buffer.alloc(176);
  b.writeInt32LE(status, 0);
  b.writeUInt32LE(mask, 8);
  b.writeUInt32LE(mask10, 12);
  b.write(driver, 16, 'utf-8');
  return b;
}
const bit = (...idx) => idx.reduce((m, i) => m | (1 << i), 0);

test('parseHwdecCaps: it only returns the codecs that have a component in Android', () => {
  // h264(0) hevc(1) vp9(2) vp8(3) mpeg2(4) vc1(5) av1(6): vp8/mpeg2/vc1/av1 have no component yet
  const r = hwAccel.parseHwdecCaps(capsResponse({ mask: bit(0, 1, 2, 3, 4, 5, 6), mask10: bit(1, 2, 6) }));
  assert.deepStrictEqual(r.codecs.map((c) => c.id), ['h264', 'hevc', 'vp9']);
  assert.deepStrictEqual(r.codecs.map((c) => c.tenBit), [false, true, true]);
  assert.strictEqual(r.driver, 'Mesa test');
});

test('parseHwdecCaps: Polaris (h264 + hevc) does not offer vp9', () => {
  const r = hwAccel.parseHwdecCaps(capsResponse({ mask: bit(0, 1, 4, 5), mask10: bit(1) }));
  assert.deepStrictEqual(r.codecs.map((c) => c.id), ['h264', 'hevc']);
});

test('parseHwdecCaps: an error status or a short response = no codec', () => {
  assert.deepStrictEqual(hwAccel.parseHwdecCaps(capsResponse({ status: -1, mask: bit(0) })).codecs, []);
  assert.strictEqual(hwAccel.parseHwdecCaps(Buffer.alloc(10)), null);
});

async function withServer(handler, fn) {
  const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'caps-')), 's');
  const server = net.createServer(handler);
  await new Promise((r) => server.listen(sock, r));
  try { await fn(sock); } finally { server.close(); }
}

test('queryHwdecCaps: speaks the protocol (it sends tag 4) and understands the response', async () => {
  let tag;
  await withServer((c) => {
    c.once('data', (d) => { tag = d.readUInt32LE(0); c.end(capsResponse({ mask: bit(0, 2) })); });
  }, async (sock) => {
    const r = await hwAccel.queryHwdecCaps({ socketPath: sock });
    assert.deepStrictEqual(r.codecs.map((c) => c.id), ['h264', 'vp9']);
  });
  assert.strictEqual(tag, 4);
});

test('queryHwdecCaps: a daemon without HWDEC (it closes without answering), down or mute = no decoder', async () => {
  await withServer((c) => c.end(), async (sock) => {
    assert.deepStrictEqual((await hwAccel.queryHwdecCaps({ socketPath: sock })).codecs, []);
  });
  assert.deepStrictEqual((await hwAccel.queryHwdecCaps({ socketPath: '/tmp/no-existe-' + process.pid })).codecs, []);
  await withServer(() => { /* never answers */ }, async (sock) => {
    assert.deepStrictEqual((await hwAccel.queryHwdecCaps({ socketPath: sock, timeoutMs: 200 })).codecs, []);
  });
});

const XML = `<MediaCodecs>
    <Decoders>
        <MediaCodec name="c2.android.avc.decoder" type="video/avc" />
    </Decoders>
    <Encoders>
        <MediaCodec name="c2.android.avc.encoder" type="video/avc" />
    </Encoders>
</MediaCodecs>`;
const DEC = [
  { name: 'c2.hardware.decoder.h264', type: 'video/avc' },
  { name: 'c2.hardware.decoder.hevc', type: 'video/hevc' },
];

test('addCodecsToXml: adds the encoder and only the host\'s decoders', () => {
  const out = addCodecsToXml(XML, DEC);
  assert.match(out, /c2\.hardware\.encoder\.h264/);
  assert.match(out, /c2\.hardware\.decoder\.h264/);
  assert.match(out, /c2\.hardware\.decoder\.hevc/);
  assert.doesNotMatch(out, /decoder\.vp9/);
  assert.match(out, /<Decoders>[\s\S]*c2\.hardware\.decoder\.hevc[\s\S]*c2\.android\.avc\.decoder[\s\S]*<\/Decoders>/);
});

test('addCodecsToXml: it is idempotent and respects what was already there', () => {
  const once = addCodecsToXml(XML, DEC);
  assert.strictEqual(addCodecsToXml(once, DEC), once);
  assert.match(once, /c2\.android\.avc\.decoder/);
});

test('addCodecsToXml: without hardware decoders it only adds the encoder and does not touch <Decoders>', () => {
  const out = addCodecsToXml(XML, []);
  assert.match(out, /c2\.hardware\.encoder\.h264/);
  assert.doesNotMatch(out, /c2\.hardware\.decoder/);
});

// The REAL file of the official redroid image: only <Encoders> and several <Include>, without <Decoders>.
const XML_OFICIAL = `<?xml version="1.0" encoding="utf-8" ?>
<!-- <!ELEMENT Decoders (MediaCodec|Include)*> <!ELEMENT Encoders (MediaCodec|Include)*> -->
<MediaCodecs>
    <Encoders>
        <MediaCodec name="OMX.redroid.h264.encoder" type="video/avc" />
    </Encoders>
    <Include href="media_codecs_google_audio.xml" />
    <Include href="media_codecs_google_video.xml" />
</MediaCodecs>`;

test('addCodecsToXml: the official image has no <Decoders>: it is created at the end, after the <Include>s', () => {
  const out = addCodecsToXml(XML_OFICIAL, DEC);
  assert.match(out, /<Include href="media_codecs_google_video.xml" \/>\s*<Decoders>[\s\S]*c2\.hardware\.decoder\.h264[\s\S]*<\/Decoders>\s*<\/MediaCodecs>/);
  assert.match(out, /c2\.hardware\.encoder\.h264/);
  assert.strictEqual(addCodecsToXml(out, DEC), out); // idempotent here too
});

test('addCodecsToXml: an unexpected format fails loudly', () => {
  assert.throws(() => addCodecsToXml('<MediaCodecs></MediaCodecs>', []), /Encoders/);
  assert.throws(() => addCodecsToXml('<otra><Encoders></Encoders></otra>', DEC), /MediaCodecs/);
});

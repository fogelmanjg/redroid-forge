const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const hwAccel = require('../src/lib/hwAccel');
const { addCodecsToXml } = require('../src/modules/hwenc/integrate');

// Respuesta del daemon (HwDecCapsResponse de protocol.h, 176 bytes).
function capsResponse({ status = 0, mask = 0, mask10 = 0, driver = 'Mesa test' } = {}) {
  const b = Buffer.alloc(176);
  b.writeInt32LE(status, 0);
  b.writeUInt32LE(mask, 8);
  b.writeUInt32LE(mask10, 12);
  b.write(driver, 16, 'utf-8');
  return b;
}
const bit = (...idx) => idx.reduce((m, i) => m | (1 << i), 0);

test('parseHwdecCaps: solo devuelve los codecs que tienen componente en Android', () => {
  // h264(0) hevc(1) vp9(2) vp8(3) mpeg2(4) vc1(5) av1(6): vp8/mpeg2/vc1/av1 no tienen componente todavia
  const r = hwAccel.parseHwdecCaps(capsResponse({ mask: bit(0, 1, 2, 3, 4, 5, 6), mask10: bit(1, 2, 6) }));
  assert.deepStrictEqual(r.codecs.map((c) => c.id), ['h264', 'hevc', 'vp9']);
  assert.deepStrictEqual(r.codecs.map((c) => c.tenBit), [false, true, true]);
  assert.strictEqual(r.driver, 'Mesa test');
});

test('parseHwdecCaps: Polaris (h264 + hevc) no ofrece vp9', () => {
  const r = hwAccel.parseHwdecCaps(capsResponse({ mask: bit(0, 1, 4, 5), mask10: bit(1) }));
  assert.deepStrictEqual(r.codecs.map((c) => c.id), ['h264', 'hevc']);
});

test('parseHwdecCaps: status de error o respuesta corta = ningun codec', () => {
  assert.deepStrictEqual(hwAccel.parseHwdecCaps(capsResponse({ status: -1, mask: bit(0) })).codecs, []);
  assert.strictEqual(hwAccel.parseHwdecCaps(Buffer.alloc(10)), null);
});

async function withServer(handler, fn) {
  const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'caps-')), 's');
  const server = net.createServer(handler);
  await new Promise((r) => server.listen(sock, r));
  try { await fn(sock); } finally { server.close(); }
}

test('queryHwdecCaps: habla el protocolo (envia el tag 4) y entiende la respuesta', async () => {
  let tag;
  await withServer((c) => {
    c.once('data', (d) => { tag = d.readUInt32LE(0); c.end(capsResponse({ mask: bit(0, 2) })); });
  }, async (sock) => {
    const r = await hwAccel.queryHwdecCaps({ socketPath: sock });
    assert.deepStrictEqual(r.codecs.map((c) => c.id), ['h264', 'vp9']);
  });
  assert.strictEqual(tag, 4);
});

test('queryHwdecCaps: daemon sin HWDEC (cierra sin responder), caido o mudo = ningun decoder', async () => {
  await withServer((c) => c.end(), async (sock) => {
    assert.deepStrictEqual((await hwAccel.queryHwdecCaps({ socketPath: sock })).codecs, []);
  });
  assert.deepStrictEqual((await hwAccel.queryHwdecCaps({ socketPath: '/tmp/no-existe-' + process.pid })).codecs, []);
  await withServer(() => { /* nunca responde */ }, async (sock) => {
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

test('addCodecsToXml: agrega el encoder y solo los decoders del host', () => {
  const out = addCodecsToXml(XML, DEC);
  assert.match(out, /c2\.hardware\.encoder\.h264/);
  assert.match(out, /c2\.hardware\.decoder\.h264/);
  assert.match(out, /c2\.hardware\.decoder\.hevc/);
  assert.doesNotMatch(out, /decoder\.vp9/);
  assert.match(out, /<Decoders>[\s\S]*c2\.hardware\.decoder\.hevc[\s\S]*c2\.android\.avc\.decoder[\s\S]*<\/Decoders>/);
});

test('addCodecsToXml: es idempotente y respeta lo que ya estaba', () => {
  const once = addCodecsToXml(XML, DEC);
  assert.strictEqual(addCodecsToXml(once, DEC), once);
  assert.match(once, /c2\.android\.avc\.decoder/);
});

test('addCodecsToXml: sin decoders de hardware solo agrega el encoder y no toca <Decoders>', () => {
  const out = addCodecsToXml(XML, []);
  assert.match(out, /c2\.hardware\.encoder\.h264/);
  assert.doesNotMatch(out, /c2\.hardware\.decoder/);
});

test('addCodecsToXml: formato inesperado falla en voz alta', () => {
  assert.throws(() => addCodecsToXml('<MediaCodecs><Encoders></Encoders></MediaCodecs>', DEC), /Decoders/);
  assert.throws(() => addCodecsToXml('<MediaCodecs></MediaCodecs>', []), /Encoders/);
});

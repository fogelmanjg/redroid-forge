// Limite de resolucion que anuncian los decoders por hardware segun la pantalla de la instancia.
const test = require('node:test');
const assert = require('node:assert');
const { decodeSizeLimit, addCodecsToXml } = require('../src/modules/hwenc/integrate');

const label = (w, h) => decodeSizeLimit({ width: w, height: h }).label;

test('el limite es el escalon estandar mas grande que cabe en la pantalla', () => {
  assert.strictEqual(label(1280, 720), '720p');
  assert.strictEqual(label(1920, 1080), '1080p');
  assert.strictEqual(label(2560, 1440), '1440p');
  assert.strictEqual(label(3840, 2160), '2160p');
});

test('se redondea hacia abajo: 2000x1200 admite 1080p pero no 1440p', () => {
  assert.strictEqual(label(2000, 1200), '1080p');
  assert.strictEqual(label(1919, 1080), '720p'); // le falta 1 pixel de ancho para 1080p
});

test('piso en 720p aunque la pantalla sea mas chica', () => {
  assert.strictEqual(label(640, 360), '720p');
  assert.strictEqual(label(320, 240), '720p');
  assert.strictEqual(label(1366, 768), '720p');
});

test('una pantalla vertical se evalua igual que la horizontal', () => {
  assert.strictEqual(label(720, 1280), '720p');
  assert.strictEqual(label(1080, 1920), '1080p');
});

test('datos invalidos caen al piso de 720p', () => {
  assert.strictEqual(label(undefined, undefined), '720p');
  assert.strictEqual(label('abc', 1080), '720p');
  assert.strictEqual(decodeSizeLimit(null).label, '720p');
});

test('limite de area en bloques de 16x16', () => {
  assert.strictEqual(decodeSizeLimit({ width: 1280, height: 720 }).blocks, 80 * 45);
  assert.strictEqual(decodeSizeLimit({ width: 1920, height: 1080 }).blocks, 120 * 68);
});

const XML = '<MediaCodecs>\n    <Encoders>\n    </Encoders>\n    <Include href="x.xml" />\n</MediaCodecs>';
const DEC = [{ name: 'c2.hardware.decoder.h264', type: 'video/avc' }];

test('addCodecsToXml escribe el limite en cada decoder nuevo', () => {
  const xml = addCodecsToXml(XML, DEC, decodeSizeLimit({ width: 1280, height: 720 }));
  assert.match(xml, /<MediaCodec name="c2.hardware.decoder.h264" type="video\/avc">/);
  assert.match(xml, /<Limit name="size" max="1280x1280" \/>/);
  assert.match(xml, /<Limit name="block-count" range="1-3600" \/>/);
});

test('addCodecsToXml sin limite deja la entrada simple de siempre', () => {
  const xml = addCodecsToXml(XML, DEC);
  assert.match(xml, /<MediaCodec name="c2.hardware.decoder.h264" type="video\/avc" \/>/);
  assert.doesNotMatch(xml, /Limit/);
});

test('addCodecsToXml sigue siendo idempotente con limite', () => {
  const limit = decodeSizeLimit({ width: 1920, height: 1080 });
  const once = addCodecsToXml(XML, DEC, limit);
  assert.strictEqual(addCodecsToXml(once, DEC, limit), once);
});

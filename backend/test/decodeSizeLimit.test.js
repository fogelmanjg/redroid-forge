// Resolution limit that the hardware decoders advertise according to the instance's screen.
const test = require('node:test');
const assert = require('node:assert');
const { decodeSizeLimit, addCodecsToXml } = require('../src/modules/hwenc/integrate');

const label = (w, h) => decodeSizeLimit({ width: w, height: h }).label;

test('the limit is the largest standard step that fits the screen', () => {
  assert.strictEqual(label(1280, 720), '720p');
  assert.strictEqual(label(1920, 1080), '1080p');
  assert.strictEqual(label(2560, 1440), '1440p');
  assert.strictEqual(label(3840, 2160), '2160p');
});

test('it rounds down: 2000x1200 admits 1080p but not 1440p', () => {
  assert.strictEqual(label(2000, 1200), '1080p');
  assert.strictEqual(label(1919, 1080), '720p'); // it is 1 pixel short of the width for 1080p
});

test('a floor at 720p even if the screen is smaller', () => {
  assert.strictEqual(label(640, 360), '720p');
  assert.strictEqual(label(320, 240), '720p');
  assert.strictEqual(label(1366, 768), '720p');
});

test('a portrait screen is evaluated the same as a landscape one', () => {
  assert.strictEqual(label(720, 1280), '720p');
  assert.strictEqual(label(1080, 1920), '1080p');
});

test('invalid data falls to the 720p floor', () => {
  assert.strictEqual(label(undefined, undefined), '720p');
  assert.strictEqual(label('abc', 1080), '720p');
  assert.strictEqual(decodeSizeLimit(null).label, '720p');
});

test('area limit in 16x16 blocks', () => {
  assert.strictEqual(decodeSizeLimit({ width: 1280, height: 720 }).blocks, 80 * 45);
  assert.strictEqual(decodeSizeLimit({ width: 1920, height: 1080 }).blocks, 120 * 68);
});

const XML = '<MediaCodecs>\n    <Encoders>\n    </Encoders>\n    <Include href="x.xml" />\n</MediaCodecs>';
const DEC = [{ name: 'c2.hardware.decoder.h264', type: 'video/avc' }];

test('addCodecsToXml writes the limit on every new decoder', () => {
  const xml = addCodecsToXml(XML, DEC, decodeSizeLimit({ width: 1280, height: 720 }));
  assert.match(xml, /<MediaCodec name="c2.hardware.decoder.h264" type="video\/avc">/);
  assert.match(xml, /<Limit name="size" max="1280x1280" \/>/);
  assert.match(xml, /<Limit name="block-count" range="1-3600" \/>/);
});

test('addCodecsToXml without a limit leaves the plain entry as always', () => {
  const xml = addCodecsToXml(XML, DEC);
  assert.match(xml, /<MediaCodec name="c2.hardware.decoder.h264" type="video\/avc" \/>/);
  assert.doesNotMatch(xml, /Limit/);
});

test('addCodecsToXml is still idempotent with a limit', () => {
  const limit = decodeSizeLimit({ width: 1920, height: 1080 });
  const once = addCodecsToXml(XML, DEC, limit);
  assert.strictEqual(addCodecsToXml(once, DEC, limit), once);
});

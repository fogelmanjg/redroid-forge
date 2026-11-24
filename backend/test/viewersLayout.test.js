'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { dims, bands, fitScale, layout } = require('../../frontend/viewersLayout');

const retrato = { id: 'retrato', w: 600, h: 1000 };
const paisaje = { id: 'paisaje', w: 1000, h: 600 };

test('dims: the real resolution, a portrait 720x1280 when unknown', () => {
  assert.deepStrictEqual(dims({ width: 1000, height: 600 }), { w: 1000, h: 600 });
  assert.deepStrictEqual(dims(null), { w: 720, h: 1280 });
});

test('same scale: 600x1000 and 1000x600 take the same room, one standing and one lying down', () => {
  const { sizes } = layout([retrato, paisaje], { mode: 'free', scalePercent: 30 });
  assert.deepStrictEqual(sizes.retrato, { width: 180, height: 300, capture: 180 });
  assert.deepStrictEqual(sizes.paisaje, { width: 300, height: 180, capture: 180 });
});

test('two bands, order kept inside each; a square one is landscape', () => {
  const b = bands([paisaje, retrato, { id: 'cuadrada', w: 800, h: 800 }, { id: 'r2', w: 720, h: 1280 }]);
  assert.deepStrictEqual(b.portrait.map((i) => i.id), ['retrato', 'r2']);
  assert.deepStrictEqual(b.landscape.map((i) => i.id), ['paisaje', 'cuadrada']);
});

test('fit: each band in one row across the width, both bands at the same (smallest) scale', () => {
  // 1000 px: portraits 2x600 wide -> (1000-16-48)/1200; landscapes 1x1000 -> (1000-24)/1000.
  const items = [retrato, { id: 'r2', w: 600, h: 1000 }, paisaje];
  const s = fitScale(items, { gridWidth: 1000 });
  assert.strictEqual(s, (1000 - 16 - 48) / 1200);
  const { sizes } = layout(items, { mode: 'fit', gridWidth: 1000 });
  assert.strictEqual(sizes.retrato.height, sizes.paisaje.width);
});

test('captures stay inside the backend range', () => {
  assert.strictEqual(layout([paisaje], { scalePercent: 5 }).sizes.paisaje.capture, 60);
  assert.strictEqual(layout([{ id: 'big', w: 2160, h: 3840 }], { scalePercent: 100 }).sizes.big.capture, 1080);
});

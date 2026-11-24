'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { dims, bands, fitLongSide, layout } = require('../../frontend/viewersLayout');

const retrato = { id: 'retrato', w: 600, h: 1000 };
const paisaje = { id: 'paisaje', w: 1000, h: 600 };

test('dims: the configured resolution, a portrait 720x1280 when unknown', () => {
  assert.deepStrictEqual(dims({ width: 1000, height: 600 }), { w: 1000, h: 600 });
  assert.deepStrictEqual(dims(null), { w: 720, h: 1280 });
});

test('same long side: 600x1000 and 1000x600 take the same room, one standing and one lying down', () => {
  const { sizes } = layout([retrato, paisaje], { mode: 'free', longSide: 300 });
  assert.deepStrictEqual(sizes.retrato, { width: 180, height: 300, capture: 180 });
  assert.deepStrictEqual(sizes.paisaje, { width: 300, height: 180, capture: 180 });
});

test('the resolution does not matter: 800x600 and 3840x2160 come out the same size', () => {
  const { sizes } = layout([{ id: 'chica', w: 800, h: 600 }, { id: '4k', w: 3840, h: 2160 }], { longSide: 500 });
  assert.strictEqual(sizes.chica.width, 500);
  assert.strictEqual(sizes['4k'].width, 500);
});

test('the slider is the long side, kept between 200 and 600', () => {
  assert.strictEqual(layout([paisaje], { longSide: 20 }).long, 200);
  assert.strictEqual(layout([paisaje], { longSide: 5000 }).long, 600);
});

test('two bands, order kept inside each; a square one is landscape', () => {
  const b = bands([paisaje, retrato, { id: 'cuadrada', w: 800, h: 800 }, { id: 'r2', w: 720, h: 1280 }]);
  assert.deepStrictEqual(b.portrait.map((i) => i.id), ['retrato', 'r2']);
  assert.deepStrictEqual(b.landscape.map((i) => i.id), ['paisaje', 'cuadrada']);
});

test('fit: each band in one row across the width, both at the same long side, 600 at most', () => {
  // 1000 px, 3 landscape: (1000 - 2*16 - 3*24) / 3 = 298.67; 1 portrait alone would allow more.
  const items = [paisaje, { id: 'p2', w: 1000, h: 600 }, { id: 'p3', w: 1000, h: 600 }, retrato];
  assert.strictEqual(fitLongSide(items, { gridWidth: 1000 }), (1000 - 32 - 72) / 3);
  assert.strictEqual(fitLongSide([retrato], { gridWidth: 5000 }), 600);
});

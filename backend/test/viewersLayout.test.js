'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { aspect, rowsOf, fillerGrow, captureSizes } = require('../../frontend/viewersLayout');

const portrait = { id: 'retrato', ar: 600 / 1000 };
const landscape = { id: 'paisaje', ar: 1280 / 720 };

test('aspect: width/height of the display, portrait 9:16 when unknown', () => {
  assert.strictEqual(aspect({ width: 1000, height: 600 }), 1000 / 600);
  assert.strictEqual(aspect(null), 9 / 16);
  assert.strictEqual(aspect({ width: 0, height: 600 }), 9 / 16);
});

test('auto: the slider is the height -- capture short side = height for landscape, width for portrait', () => {
  const s = captureSizes([portrait, landscape], { columns: 'auto', size: 200 });
  assert.strictEqual(s.paisaje, 200);
  assert.strictEqual(s.retrato, 120); // 200 * 0.6: its width, its short side
});

test('N per row: every card in a row gets the same height, widths follow the shape', () => {
  // 2 per row, 1000px wide: free = 1000 - 16 gap - 2*24 pad = 936; sumAr = 0.6 + 1.778 = 2.378
  const s = captureSizes([portrait, landscape], { columns: '2', gridWidth: 1000 });
  const h = 936 / (0.6 + 1280 / 720);
  assert.strictEqual(s.paisaje, Math.round(h));        // landscape: short side = the height
  assert.strictEqual(s.retrato, Math.round(h * 0.6));  // portrait: short side = its width
});

test('a short last row gets a filler, so it is not blown up to the whole width', () => {
  const items = [portrait, landscape, { id: 'sola', ar: 0.6 }];
  assert.deepStrictEqual(rowsOf(items, 2).map((r) => r.length), [2, 1]);
  assert.ok(fillerGrow(items, [items[2]], 2) > 0);
  const s = captureSizes(items, { columns: '2', gridWidth: 1000 });
  // Without the filler the lone portrait would be 1000-24 wide; with it, close to the first row's size.
  assert.ok(s.sola < 400, `got ${s.sola}`);
});

test('sizes stay inside the backend range', () => {
  const s = captureSizes([landscape], { columns: '1', gridWidth: 5000 });
  assert.strictEqual(s.paisaje, 1080);
  assert.strictEqual(captureSizes([portrait], { columns: 'auto', size: 60 }).retrato, 60);
});

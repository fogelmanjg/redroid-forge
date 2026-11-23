// Layout of the "viewers" grid by each instance's own shape (1.0.0-beta.10) -- pure logic, no DOM,
// tested from node (backend/test/viewersLayout.test.js), used by app.js in the browser.
//
// Before, every preview got the same WIDTH: a portrait instance came out very tall next to a short
// landscape one, and in "N per row" each one got the same column. Now every preview in a row has
// the same HEIGHT and its width follows its own aspect ratio (the way photo galleries lay out
// mixed shapes): a landscape one takes about twice the width of a portrait one.
//   - "auto": the slider is the height; as many per row as fit.
//   - "N per row": rows of N that fill the whole width ("justified" rows); a last, shorter row
//     gets an empty filler so it keeps about the same height instead of blowing up.
// It also says, per instance, what capture size (short side, px) to ask the backend for, so each
// one is captured at the size it is really shown at -- never bigger.
(function (root) {
  const MIN = 60;
  const MAX = 1080; // same range the backend clamps to (screenshotCapture.js's clampSize)
  const clamp = (n) => Math.max(MIN, Math.min(MAX, Math.round(n)));

  // width / height of an instance's display; portrait 9:16 when unknown.
  function aspect(display) {
    const w = Number(display && display.width);
    const h = Number(display && display.height);
    return (w > 0 && h > 0) ? w / h : 9 / 16;
  }

  function rowsOf(items, n) {
    const rows = [];
    for (let i = 0; i < items.length; i += n) rows.push(items.slice(i, i + n));
    return rows;
  }

  // How much "flex-grow" the empty filler of a short last row gets: the average shape of the
  // whole grid times the missing slots.
  function fillerGrow(items, row, n) {
    if (row.length >= n || items.length === 0) return 0;
    const avg = items.reduce((s, it) => s + it.ar, 0) / items.length;
    return avg * (n - row.length);
  }

  // items: [{ id, ar }] in display order. -> { [id]: shortSidePx }
  // gap: space between cards; pad: each card's horizontal padding + borders (both px).
  function captureSizes(items, { columns = 'auto', size = 200, gridWidth = 0, gap = 16, pad = 24 } = {}) {
    const out = {};
    if (columns === 'auto') {
      for (const it of items) out[it.id] = clamp(size * Math.min(it.ar, 1));
      return out;
    }
    const n = Math.max(1, Number(columns) || 1);
    for (const row of rowsOf(items, n)) {
      const filler = fillerGrow(items, row, n);
      const sumAr = row.reduce((s, it) => s + it.ar, 0) + filler;
      const gaps = gap * (row.length - 1 + (filler > 0 ? 1 : 0));
      const free = Math.max(0, gridWidth - gaps - pad * row.length);
      const height = free / sumAr; // the same for every card in the row
      for (const it of row) out[it.id] = clamp(Math.min(height * it.ar, height));
    }
    return out;
  }

  const api = { aspect, rowsOf, fillerGrow, captureSizes };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ViewersLayout = api;
}(typeof window !== 'undefined' ? window : globalThis));

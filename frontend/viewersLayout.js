// Layout of the "viewers" view (1.0.0-beta.12) -- pure logic, no DOM, tested from node
// (backend/test/viewersLayout.test.js), used by app.js in the browser.
//
// Every preview is drawn at the SAME SCALE of its real resolution: a 600x1000 instance and a
// 1000x600 one take the same room, one standing and one lying down. Before (1.0.0-beta.10) every
// preview in a row had the same height, which made a landscape one almost three times the area
// of a portrait one. Portrait and landscape instances go in two separate bands, so the shapes do
// not leave gaps among each other and one of either shape is quick to find.
//   - "free": the slider is the scale (percent of the real resolution); each band wraps.
//   - "fit": the scale that puts each band in a single row across the whole width (the smaller
//     of the two, so both bands keep the same scale).
// It also says, per instance, what capture size (short side, px) to ask the backend for, so each
// one is captured at the size it is really shown at -- never bigger.
(function (root) {
  const MIN = 60;
  const MAX = 1080; // same range the backend clamps to (screenshotCapture.js's clampSize)
  const clamp = (n) => Math.max(MIN, Math.min(MAX, Math.round(n)));
  const DEFAULT = { width: 720, height: 1280 };

  // The display's real size; a portrait 720x1280 when unknown.
  function dims(display) {
    const w = Number(display && display.width);
    const h = Number(display && display.height);
    return (w > 0 && h > 0) ? { w, h } : { w: DEFAULT.width, h: DEFAULT.height };
  }

  // width / height; kept for callers that only need the shape.
  function aspect(display) {
    const { w, h } = dims(display);
    return w / h;
  }

  // A square one counts as landscape.
  function isPortrait(item) { return item.h > item.w; }

  // items: [{ id, w, h }] in display order -> { portrait: [...], landscape: [...] }, order kept.
  function bands(items) {
    return { portrait: items.filter(isPortrait), landscape: items.filter((it) => !isPortrait(it)) };
  }

  // The scale that fits every band in one row of `gridWidth` (gap between cards, pad = each
  // card's horizontal padding + borders, all px). The smallest band scale wins, so both bands
  // share it. 1 (real size) at most.
  function fitScale(items, { gridWidth = 0, gap = 16, pad = 24 } = {}) {
    let scale = 1;
    for (const band of Object.values(bands(items))) {
      if (band.length === 0) continue;
      const free = gridWidth - gap * (band.length - 1) - pad * band.length;
      const sumW = band.reduce((s, it) => s + it.w, 0);
      scale = Math.min(scale, Math.max(0, free) / sumW);
    }
    return scale;
  }

  // -> { scale, sizes: { [id]: { width, height, capture } } }
  function layout(items, { mode = 'free', scalePercent = 30, gridWidth = 0, gap = 16, pad = 24 } = {}) {
    const scale = mode === 'fit' ? fitScale(items, { gridWidth, gap, pad }) : Math.max(0.01, scalePercent / 100);
    const sizes = {};
    for (const it of items) {
      sizes[it.id] = {
        width: Math.round(it.w * scale),
        height: Math.round(it.h * scale),
        capture: clamp(Math.min(it.w, it.h) * scale),
      };
    }
    return { scale, sizes };
  }

  const api = { dims, aspect, isPortrait, bands, fitScale, layout };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ViewersLayout = api;
}(typeof window !== 'undefined' ? window : globalThis));

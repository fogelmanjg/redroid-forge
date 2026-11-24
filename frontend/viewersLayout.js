// Layout of the "viewers" view -- pure logic, no DOM, tested from node
// (backend/test/viewersLayout.test.js), used by app.js in the browser.
//
// Every preview gets the SAME LONG SIDE (1.0.0-rc.2), whatever the instance's resolution: an
// 800x600 and a 3840x2160 one come out the same size, and a 600x1000 and a 1000x600 take the same
// room, one standing and one lying down. (rc.1 used one scale of the real resolution, which made
// a 4K instance tower over an 800x600 one.) The shape is the one on screen right now -- the live
// frames' own size when known (viewer.js frameSize: a game can turn an instance configured
// portrait into landscape) -- else the configured display.
// Portrait and landscape previews go in two separate bands, so the shapes do not leave gaps among
// each other and one of either shape is quick to find.
//   - "free": the slider is the long side, 200-600 px; each band wraps.
//   - "fit": the long side that puts each band in a single row across the whole width (the
//     smaller of the two, so both bands keep it), never above 600.
// It also says, per instance, what capture size (short side, px) to ask the backend for, so each
// one is captured at the size it is really shown at -- never bigger.
(function (root) {
  const MIN = 60;
  const MAX = 1080; // same range the backend clamps to (screenshotCapture.js's clampSize)
  const clamp = (n) => Math.max(MIN, Math.min(MAX, Math.round(n)));
  const LONG_MIN = 200;
  const LONG_MAX = 600;
  const DEFAULT = { width: 720, height: 1280 };

  // The configured display's size; a portrait 720x1280 when unknown.
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

  // Width of a preview whose long side is 1.
  const unitWidth = (it) => (it.w >= it.h ? 1 : it.w / it.h);

  // The long side that fits every band in one row of `gridWidth` (gap between cards, pad = each
  // card's horizontal padding + borders, all px). The smallest band value wins, so both bands
  // share it; LONG_MAX at most.
  function fitLongSide(items, { gridWidth = 0, gap = 16, pad = 24 } = {}) {
    let long = LONG_MAX;
    for (const band of Object.values(bands(items))) {
      if (band.length === 0) continue;
      const free = gridWidth - gap * (band.length - 1) - pad * band.length;
      long = Math.min(long, Math.max(0, free) / band.reduce((s, it) => s + unitWidth(it), 0));
    }
    return long;
  }

  // -> { long, sizes: { [id]: { width, height, capture } } }
  function layout(items, { mode = 'free', longSide = 300, gridWidth = 0, gap = 16, pad = 24 } = {}) {
    const long = mode === 'fit'
      ? fitLongSide(items, { gridWidth, gap, pad })
      : Math.max(LONG_MIN, Math.min(LONG_MAX, longSide));
    const sizes = {};
    for (const it of items) {
      const width = Math.round(long * unitWidth(it));
      const height = Math.round(it.w >= it.h ? long * (it.h / it.w) : long);
      sizes[it.id] = { width, height, capture: clamp(Math.min(width, height)) };
    }
    return { long, sizes };
  }

  const api = { dims, aspect, isPortrait, bands, fitLongSide, layout, LONG_MIN, LONG_MAX };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ViewersLayout = api;
}(typeof window !== 'undefined' ? window : globalThis));

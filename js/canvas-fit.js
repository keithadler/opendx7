// OpenDX7 — FM Synthesizer (MIT License)
// Copyright (c) 2026 Keith Adler
// Sizing a canvas backing store to its box, once the box is real.
//
// The canvases are laid out with `width: 100%`, so their CSS height used to
// come from the backing store's own aspect ratio, while the backing store was
// sized from the CSS box. That is circular, and a circular definition settles
// on whichever measurement happened first. On a cold load, that measurement
// happens before the stylesheet applies: the element is a couple of pixels
// tall, the algorithm diagram gets drawn into a 4x4 buffer and stretched over
// 272 pixels, and it stays that way for the rest of the session because
// nothing redraws it.
//
// The loop is broken in the stylesheet, where each canvas now declares the
// aspect ratio its markup always implied. Its box no longer depends on its
// buffer, so measuring it here is safe.

export function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();

  // No layout yet. Drawing now would bake in a wrong size, so decline and let
  // the observer call again when the element has a box.
  if (rect.width < 8 || rect.height < 8) return null;

  // An aspect ratio gives fractional heights, so round the backing store from
  // the true box rather than from an already-rounded copy of it.
  const bw = Math.round(rect.width * dpr);
  const bh = Math.round(rect.height * dpr);
  const w = bw / dpr;
  const h = bh / dpr;
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, bw, bh);
  ctx.scale(dpr, dpr);
  return { ctx, w, h };
}

// Redraw whenever the element's box changes, and once more after the fonts
// land, since a font swap can reflow the panel around it.
export function watchCanvas(canvas, redraw) {
  if (!canvas) return;

  // A canvas with no CSS height takes its box from its backing store. Sizing
  // the store from the box would then grow the box, which grows the store, and
  // the canvas doubles on every notification. The stylesheet breaks that by
  // declaring each canvas's aspect ratio, which is the right layer for it.
  // The counter below is a backstop, so a canvas can never run away if some
  // future rule stops pinning the ratio.
  let ticks = 0, windowStart = 0;

  const onResize = () => {
    const now = Date.now();
    if (now - windowStart > 500) { windowStart = now; ticks = 0; }
    if (++ticks > 4) return;    // something is feeding back; stop growing
    redraw();
  };

  if (typeof ResizeObserver === 'function') {
    let last = '';
    new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      const key = Math.round(r.width) + 'x' + Math.round(r.height);
      if (key === last) return;
      last = key;
      onResize();
    }).observe(canvas);
  } else {
    window.addEventListener('resize', onResize);
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(redraw);
}

// The visualizer draws in device pixels and scales nothing, so it wants its
// backing store matched to the box without a transform. Returns true when the
// size changed, which is the caller's cue to redraw.
export function sizeCanvasOnly(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8) return false;
  const bw = Math.round(rect.width * dpr);
  const bh = Math.round(rect.height * dpr);
  if (canvas.width === bw && canvas.height === bh) return false;
  canvas.width = bw;
  canvas.height = bh;
  return true;
}

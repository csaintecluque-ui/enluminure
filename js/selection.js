// Enluminure — sélections : une sélection est un masque { canvas, x, y } en coordonnées du document.
// Seul le canal alpha compte (255 = sélectionné, valeurs intermédiaires = contour progressif).
import { newCanvas, ctxOf, freeCanvas } from './util.js';
import { unionRect, interRect } from './render.js';

const mk = (w, h) => newCanvas(Math.max(1, Math.ceil(w)), Math.max(1, Math.ceil(h)));

/** Flou du canal alpha (trois passes de flou « boîte » ≈ flou gaussien). Renvoie une nouvelle sélection, élargie. */
export function featherSel(sel, radius) {
  if (!sel || radius < 0.5) return sel;
  const pad = Math.ceil(radius * 2);
  const w = sel.canvas.width + pad * 2, h = sel.canvas.height + pad * 2;
  const c = mk(w, h);
  const ctx = ctxOf(c);
  ctx.drawImage(sel.canvas, pad, pad);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  let a = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) a[i] = d[i * 4 + 3];
  const r = Math.max(1, Math.round(radius / 2));
  let tmp = new Float32Array(w * h);
  for (let pass = 0; pass < 3; pass++) {
    boxH(a, tmp, w, h, r);
    boxV(tmp, a, w, h, r);
  }
  for (let i = 0; i < w * h; i++) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 0; d[i * 4 + 3] = a[i]; }
  ctx.putImageData(img, 0, 0);
  return trimSel({ canvas: c, x: sel.x - pad, y: sel.y - pad });
}
function boxH(src, dst, w, h, r) {
  const k = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[o + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      dst[o + x] = acc * k;
      acc += src[o + Math.min(w - 1, x + r + 1)] - src[o + Math.max(0, x - r)];
    }
  }
}
function boxV(src, dst, w, h, r) {
  const k = 1 / (2 * r + 1);
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += src[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = acc * k;
      acc += src[Math.min(h - 1, y + r + 1) * w + x] - src[Math.max(0, y - r) * w + x];
    }
  }
}

/** Réduit le masque à sa zone utile ; null si plus rien n'est sélectionné. */
export function trimSel(sel) {
  if (!sel) return null;
  const { canvas } = sel;
  const w = canvas.width, h = canvas.height;
  const d = ctxOf(canvas).getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    let row = y * w * 4 + 3;
    for (let x = 0; x < w; x++, row += 4) {
      if (d[row] > 2) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; y1 = y; }
    }
  }
  if (x1 < 0) { freeCanvas(canvas); return null; }
  if (x0 === 0 && y0 === 0 && x1 === w - 1 && y1 === h - 1) return sel;
  const c = mk(x1 - x0 + 1, y1 - y0 + 1);
  ctxOf(c).drawImage(canvas, -x0, -y0);
  freeCanvas(canvas);
  return { canvas: c, x: sel.x + x0, y: sel.y + y0 };
}

export function selRect(r, ellipse = false) {
  const x = Math.round(Math.min(r.x0, r.x1)), y = Math.round(Math.min(r.y0, r.y1));
  const w = Math.round(Math.abs(r.x1 - r.x0)), h = Math.round(Math.abs(r.y1 - r.y0));
  if (w < 1 || h < 1) return null;
  const c = mk(w, h);
  const ctx = ctxOf(c);
  if (ellipse) { ctx.beginPath(); ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); ctx.fill(); }
  else ctx.fillRect(0, 0, w, h);
  return { canvas: c, x, y };
}

export function selPolygon(pts) {
  if (pts.length < 3) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  x0 = Math.floor(x0); y0 = Math.floor(y0);
  const c = mk(Math.ceil(x1) - x0 + 1, Math.ceil(y1) - y0 + 1);
  const ctx = ctxOf(c);
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x - x0, p.y - y0) : ctx.moveTo(p.x - x0, p.y - y0)));
  ctx.closePath();
  ctx.fill();
  return trimSel({ canvas: c, x: x0, y: y0 });
}

/** Sélection à partir d'une zone de remplissage (baguette magique). */
export function selFromRegion(region, ox = 0, oy = 0) {
  const { mask, W, rect } = region;
  const c = mk(rect.w, rect.h);
  const ctx = ctxOf(c);
  const img = ctx.createImageData(rect.w, rect.h);
  const d = img.data;
  for (let y = 0; y < rect.h; y++) {
    let p = (rect.y + y) * W + rect.x, i = y * rect.w * 4 + 3;
    for (let x = 0; x < rect.w; x++, p++, i += 4) if (mask[p]) d[i] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: c, x: rect.x + ox, y: rect.y + oy };
}

export function selAll(W, H) {
  const c = mk(W, H);
  ctxOf(c).fillRect(0, 0, W, H);
  return { canvas: c, x: 0, y: 0 };
}

/** À partir des pixels d'un calque ou d'un masque (canal alpha). */
export function selFromAlpha(canvas, x, y) {
  const c = mk(canvas.width, canvas.height);
  const ctx = ctxOf(c);
  ctx.drawImage(canvas, 0, 0);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillRect(0, 0, c.width, c.height);
  return trimSel({ canvas: c, x, y });
}

/** Combine une nouvelle sélection avec l'ancienne : 'new' | 'add' | 'sub' | 'inter'. */
export function combineSel(old, neu, mode) {
  if (mode === 'new' || !old) return mode === 'sub' || mode === 'inter' ? (mode === 'inter' ? null : old) : neu;
  if (!neu) return mode === 'add' || mode === 'sub' ? old : null;
  const ra = { x: old.x, y: old.y, w: old.canvas.width, h: old.canvas.height };
  const rb = { x: neu.x, y: neu.y, w: neu.canvas.width, h: neu.canvas.height };
  let r;
  if (mode === 'add') r = unionRect(ra, rb);
  else if (mode === 'sub') r = ra;
  else { r = interRect(ra, rb); if (!r) return null; }
  const c = mk(r.w, r.h);
  const ctx = ctxOf(c);
  ctx.drawImage(old.canvas, old.x - r.x, old.y - r.y);
  ctx.globalCompositeOperation = mode === 'add' ? 'source-over' : mode === 'sub' ? 'destination-out' : 'destination-in';
  ctx.drawImage(neu.canvas, neu.x - r.x, neu.y - r.y);
  return trimSel({ canvas: c, x: r.x, y: r.y });
}

export function invertSel(sel, W, H) {
  const c = mk(W, H);
  const ctx = ctxOf(c);
  ctx.fillRect(0, 0, W, H);
  if (sel) { ctx.globalCompositeOperation = 'destination-out'; ctx.drawImage(sel.canvas, sel.x, sel.y); }
  return trimSel({ canvas: c, x: 0, y: 0 });
}

/** Dilater (grow > 0) ou contracter (grow < 0) la sélection de |grow| pixels. */
export function growSel(sel, grow) {
  if (!sel || !grow) return sel;
  const r = Math.abs(grow);
  const pad = grow > 0 ? r + 2 : 2;
  const w = sel.canvas.width + pad * 2, h = sel.canvas.height + pad * 2;
  const c = mk(w, h);
  const ctx = ctxOf(c);
  ctx.drawImage(sel.canvas, pad, pad);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  // distance de Chebyshev par deux passes de max/min glissant (horizontal puis vertical)
  const n = w * h;
  let a = new Uint8Array(n), b = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = d[i * 4 + 3] >= 128 ? 1 : 0;
  const want = grow > 0 ? 1 : 0;
  const pass = (src, dst, horiz) => {
    const len = horiz ? w : h, lines = horiz ? h : w;
    for (let L = 0; L < lines; L++) {
      let last = -1e9;
      const idx = (k) => (horiz ? L * w + k : k * w + L);
      const dist = new Int32Array(len);
      for (let k = 0; k < len; k++) { if (src[idx(k)] === want) last = k; dist[k] = k - last; }
      last = 1e9;
      for (let k = len - 1; k >= 0; k--) { if (src[idx(k)] === want) last = k; dist[k] = Math.min(dist[k], last - k); }
      for (let k = 0; k < len; k++) dst[idx(k)] = dist[k] <= r ? want : 1 - want;
    }
  };
  pass(a, b, true); pass(b, a, false);
  for (let i = 0; i < n; i++) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 0; d[i * 4 + 3] = a[i] ? 255 : 0; }
  ctx.putImageData(img, 0, 0);
  return trimSel({ canvas: c, x: sel.x - pad, y: sel.y - pad });
}

export function moveSel(sel, dx, dy) { return sel ? { ...sel, x: sel.x + dx, y: sel.y + dy } : sel; }
export const selBounds = (sel) => sel && { x: sel.x, y: sel.y, w: sel.canvas.width, h: sel.canvas.height };

/** Test : le point (doc) est-il sélectionné ? */
export function selContains(sel, px, py) {
  if (!sel) return false;
  const x = Math.floor(px - sel.x), y = Math.floor(py - sel.y);
  if (x < 0 || y < 0 || x >= sel.canvas.width || y >= sel.canvas.height) return false;
  return ctxOf(sel.canvas).getImageData(x, y, 1, 1).data[3] >= 128;
}

// ——— Pointillés : contour du masque (coordonnées de la toile de sélection), calculé une fois ———
const pathCache = new WeakMap();
export function selPath(sel) {
  const hit = pathCache.get(sel.canvas);
  if (hit) return hit;
  const src = sel.canvas;
  const area = src.width * src.height;
  const f = Math.max(1, Math.ceil(Math.sqrt(area / 4_000_000))); // sur les très grandes sélections, on simplifie
  const w = Math.ceil(src.width / f), h = Math.ceil(src.height / f);
  let data;
  if (f === 1) data = ctxOf(src).getImageData(0, 0, w, h).data;
  else {
    const c = mk(w, h);
    const ctx = ctxOf(c);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src, 0, 0, w, h);
    data = ctx.getImageData(0, 0, w, h).data;
    freeCanvas(c);
  }
  const on = (x, y) => x >= 0 && y >= 0 && x < w && y < h && data[(y * w + x) * 4 + 3] >= 128;
  const p = new Path2D();
  for (let y = 0; y <= h; y++) { // bords horizontaux
    let start = -1;
    for (let x = 0; x <= w; x++) {
      const edge = x < w && on(x, y - 1) !== on(x, y);
      if (edge && start < 0) start = x;
      if (!edge && start >= 0) { p.moveTo(start * f, y * f); p.lineTo(x * f, y * f); start = -1; }
    }
  }
  for (let x = 0; x <= w; x++) { // bords verticaux
    let start = -1;
    for (let y = 0; y <= h; y++) {
      const edge = y < h && on(x - 1, y) !== on(x, y);
      if (edge && start < 0) start = y;
      if (!edge && start >= 0) { p.moveTo(x * f, start * f); p.lineTo(x * f, y * f); start = -1; }
    }
  }
  pathCache.set(sel.canvas, p);
  return p;
}

/** Copie des pixels d'une toile à travers la sélection (rect = zone en coordonnées de la toile). */
export function cutOut(canvas, cx, cy, sel) {
  // cx, cy : position du document de la toile ; renvoie { canvas, x, y } en coordonnées du document
  const r = interRect({ x: cx, y: cy, w: canvas.width, h: canvas.height }, { x: sel.x, y: sel.y, w: sel.canvas.width, h: sel.canvas.height });
  if (!r) return null;
  const c = mk(r.w, r.h);
  const ctx = ctxOf(c);
  ctx.drawImage(canvas, cx - r.x, cy - r.y);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(sel.canvas, sel.x - r.x, sel.y - r.y);
  return { canvas: c, x: r.x, y: r.y };
}

/** Limite la sélection à l'image. */
export function clipSelToDoc(sel, W, H) {
  if (!sel) return null;
  const r = interRect({ x: sel.x, y: sel.y, w: sel.canvas.width, h: sel.canvas.height }, { x: 0, y: 0, w: W, h: H });
  if (!r) return null;
  if (r.x === sel.x && r.y === sel.y && r.w === sel.canvas.width && r.h === sel.canvas.height) return sel;
  const c = mk(r.w, r.h);
  ctxOf(c).drawImage(sel.canvas, sel.x - r.x, sel.y - r.y);
  return trimSel({ canvas: c, x: r.x, y: r.y });
}

/** Rectangle utile (pixels non transparents) d'une toile, en coordonnées de la toile ; null si vide. */
export function alphaBounds(canvas) {
  const t = trimSel({ canvas: (() => { const c = mk(canvas.width, canvas.height); ctxOf(c).drawImage(canvas, 0, 0); return c; })(), x: 0, y: 0 });
  if (!t) return null;
  const r = { x: t.x, y: t.y, w: t.canvas.width, h: t.canvas.height };
  freeCanvas(t.canvas);
  return r;
}

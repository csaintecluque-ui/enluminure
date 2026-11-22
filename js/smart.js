// Enluminure — objets dynamiques : l'image d'origine est gardée intacte ; transformations et
// filtres dynamiques sont recalculés à partir d'elle, et restent modifiables.
import { newCanvas, ctxOf, freeCanvas } from './util.js';
import { updateLayer } from './ops.js';
import { FILTERS } from './filters.js';
import { applyAdjust, ADJ, LUT_SHADER } from './adjust.js';
import { glRun } from './gl.js';
import { contentBounds } from './styles.js';

/** Matrice source → document pour une transformation T = { cx, cy, w, h, a }. */
export const tMatrix = (T, sw, sh) => new DOMMatrix().translate(T.cx, T.cy).rotate(T.a * 180 / Math.PI).scale(T.w / sw, T.h / sh).translate(-sw / 2, -sh / 2);

/** Transformation actuelle (le calque a pu être déplacé depuis le dernier rendu). */
export function smartT(L) {
  const sm = L.smart;
  return { ...sm.T, cx: sm.T.cx + (L.x - sm.at.x), cy: sm.T.cy + (L.y - sm.at.y) };
}

export function smartFilterLabel(f) {
  if (f.kind === 'filter') return FILTERS[f.id]?.label || 'Filtre';
  if (f.kind === 'adjust') return ADJ[f.params.type]?.label || 'Réglage';
  return f.label || 'Réglage';
}

function filterPad(list) {
  let p = 0;
  for (const f of list || []) {
    if (!f.on || f.kind !== 'filter') continue;
    const q = f.params;
    if (f.id === 'gaussian') p += Math.ceil(q.radius * 3);
    else if (f.id === 'motion') p += Math.ceil(q.distance);
    else if (f.id === 'unsharp') p += Math.ceil(q.radius * 3);
  }
  return p;
}

function runFilter(src, f) {
  const r = { x: 0, y: 0, w: src.width, h: src.height };
  if (f.kind === 'filter') return FILTERS[f.id].run(src, r, f.params);
  if (f.kind === 'adjust') return applyAdjust(src, f.params, r);
  if (f.kind === 'lut') return glRun(src, r, [{ frag: LUT_SHADER, lut: f.params.lut }]);
  return src;
}

/** Calcule l'image de l'objet dynamique : { canvas, x, y }. */
export function renderSmart(sm, T = sm.T, withFilters = true) {
  const src = sm.source, sw = src.width, sh = src.height;
  const m = tMatrix(T, sw, sh);
  const pts = [[0, 0], [sw, 0], [sw, sh], [0, sh]].map(([x, y]) => m.transformPoint({ x, y }));
  const pad = withFilters ? filterPad(sm.filters) : 0;
  const x0 = Math.floor(Math.min(...pts.map(p => p.x))) - pad, y0 = Math.floor(Math.min(...pts.map(p => p.y))) - pad;
  const x1 = Math.ceil(Math.max(...pts.map(p => p.x))) + pad, y1 = Math.ceil(Math.max(...pts.map(p => p.y))) + pad;
  const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
  let c = newCanvas(w, h);
  const ctx = ctxOf(c);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  const exact = Math.abs(T.w) === sw && Math.abs(T.h) === sh && !(T.a % (Math.PI * 2)) && T.w > 0 && T.h > 0;
  if (exact) ctx.drawImage(src, Math.round(T.cx - sw / 2) - x0, Math.round(T.cy - sh / 2) - y0); // sans rééchantillonnage
  else { ctx.setTransform(new DOMMatrix().translate(-x0, -y0).multiply(m)); ctx.drawImage(src, 0, 0); ctx.setTransform(1, 0, 0, 1, 0, 0); }
  if (withFilters) {
    for (const f of sm.filters || []) {
      if (!f.on) continue;
      let res;
      try { res = runFilter(c, f); } catch (err) { console.warn(err); continue; }
      const out = newCanvas(w, h);
      ctxOf(out).drawImage(res, 0, 0);
      freeCanvas(c);
      c = out;
    }
  }
  return { canvas: c, x: x0, y: y0 };
}

/** Nouvel état où l'objet dynamique `id` est modifié (`patch`) puis recalculé. */
export function updateSmart(st, id, patch = {}) {
  const L = st.layers.find(l => l.id === id);
  if (!L?.smart) return st;
  const T = patch.T || smartT(L);
  const sm = { ...L.smart, ...patch, T };
  const r = renderSmart(sm, T);
  return updateLayer(st, id, { canvas: r.canvas, x: r.x, y: r.y, text: null, smart: { ...sm, at: { x: r.x, y: r.y } } });
}

/** Convertit un calque de pixels en objet dynamique (aucun changement visible). */
export function toSmart(st, id) {
  const L = st.layers.find(l => l.id === id);
  if (!L?.canvas || L.smart) return null;
  const b = contentBounds(L.canvas);
  if (!b) return null;
  const source = newCanvas(b.w, b.h);
  ctxOf(source).drawImage(L.canvas, -b.x, -b.y);
  const x = L.x + b.x, y = L.y + b.y;
  const smart = { source, T: { cx: x + b.w / 2, cy: y + b.h / 2, w: b.w, h: b.h, a: 0 }, at: { x, y }, filters: [] };
  return updateLayer(st, id, { canvas: source, x, y, text: null, smart });
}

/** Rotation 90° / symétrie du calque (autour de son centre). */
export function smartFlip(L, kind) {
  const T = smartT(L);
  if (kind === 'cw') return { ...T, a: T.a + Math.PI / 2 };
  if (kind === 'ccw') return { ...T, a: T.a - Math.PI / 2 };
  if (kind === '180') return { ...T, a: T.a + Math.PI };
  if (kind === 'fh') return { ...T, a: -T.a, w: -T.w };
  if (kind === 'fv') return { ...T, a: -T.a, h: -T.h };
  return T;
}

/** Rotation / symétrie / redimensionnement de toute l'image (W × H avant l'opération). */
export function smartImageT(L, kind, W, H, sx = 1, sy = 1) {
  const T = smartT(L);
  switch (kind) {
    case 'cw': return { ...T, cx: H - T.cy, cy: T.cx, a: T.a + Math.PI / 2 };
    case 'ccw': return { ...T, cx: T.cy, cy: W - T.cx, a: T.a - Math.PI / 2 };
    case '180': return { ...T, cx: W - T.cx, cy: H - T.cy, a: T.a + Math.PI };
    case 'fh': return { ...T, cx: W - T.cx, a: -T.a, w: -T.w };
    case 'fv': return { ...T, cy: H - T.cy, a: -T.a, h: -T.h };
    case 'scale': return { ...T, cx: T.cx * sx, cy: T.cy * sy, w: T.w * sx, h: T.h * sy };
  }
  return T;
}

/** Recalcule les objets dynamiques après une opération sur toute l'image. */
export function resmartAll(before, after, kind, sx, sy) {
  let st = after;
  for (const L of before.layers) {
    if (!L.smart) continue;
    st = updateSmart(st, L.id, { T: smartImageT(L, kind, before.width, before.height, sx, sy) });
  }
  return st;
}

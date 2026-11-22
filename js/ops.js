// Enluminure — opérations sur les états (chaque fonction renvoie un NOUVEL état)
import { newCanvas, ctxOf, mkLayer } from './util.js';
import { drawStack, flattenState, layerRect, unionRect } from './render.js';
import { stylePad, hasStyles } from './styles.js';
import { isGroup, isAdjust, insertAbove, removeItems, duplicateItem, siblingsOf, descendants, effectiveVisible, normalize } from './tree.js';

const withLayers = (st, layers) => ({ ...st, layers: normalize(layers) });

export function updateLayer(st, id, patch) {
  return withLayers(st, st.layers.map(l => (l.id === id ? { ...l, ...patch } : l)));
}

export const insertLayer = (st, layer, aboveId) => insertAbove(st, layer, aboveId);
export const removeLayer = (st, id) => removeItems(st, [id]);

export function nextLayerName(st, base = 'Calque') {
  let n = 1;
  const names = new Set(st.layers.map(l => l.name));
  while (names.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

export function blankLayer(st, name) {
  return mkLayer({ name: name || nextLayerName(st), canvas: newCanvas(st.width, st.height) });
}

/** Les toiles étant immuables, un calque dupliqué peut partager la même toile. */
export const duplicateLayer = (st, id) => duplicateItem(st, id);

/** Le voisin du dessous dans le même groupe. */
export function lowerSibling(st, id) {
  const l = st.layers.find(x => x.id === id);
  const sibs = siblingsOf(st.layers, l);
  return sibs[sibs.indexOf(l) - 1] || null;
}

export function mergeDown(st, id) {
  const up = st.layers.find(x => x.id === id);
  const low = lowerSibling(st, id);
  if (!up || !low || isGroup(up) || isGroup(low) || isAdjust(low) || !low.canvas) return null;
  const fxRect = (l) => { const r = layerRect(l), p = hasStyles(l) ? stylePad(l.styles) : 0; return { x: r.x - p, y: r.y - p, w: r.w + 2 * p, h: r.h + 2 * p }; };
  const r = isAdjust(up) ? fxRect(low) : unionRect(fxRect(low), fxRect(up));
  const c = newCanvas(r.w, r.h);
  // Le calque du dessous est dessiné « à plat », celui du dessus avec son mode et son opacité (masques appliqués)
  const lowFlat = { ...low, opacity: 1, blend: 'normal', clipping: false, visible: true, parent: null };
  const upFix = { ...up, visible: true, parent: null };
  drawStack(c, [lowFlat, upFix], r.x, r.y);
  const merged = { ...low, canvas: c, x: r.x, y: r.y, text: null, mask: null, styles: null, smart: null };
  const layers = st.layers.filter(l => l !== up).map(l => (l === low ? merged : l));
  return { state: withLayers(st, layers), activeId: merged.id };
}

/** Fusionne le contenu d'un groupe en un seul calque (qui garde l'opacité, le mode et le masque du groupe). */
export function mergeGroup(st, gid) {
  const g = st.layers.find(x => x.id === gid);
  if (!isGroup(g)) return null;
  const d = descendants(st.layers, gid);
  const kids = st.layers.filter(l => d.has(l.id)).map(l => (l.parent === gid ? { ...l, parent: null } : l));
  const c = newCanvas(st.width, st.height);
  drawStack(c, kids);
  const merged = mkLayer({ name: g.name, canvas: c, opacity: g.opacity, blend: g.blend === 'pass through' ? 'normal' : g.blend, visible: g.visible, clipping: g.clipping, mask: g.mask, parent: g.parent || null });
  const layers = st.layers.filter(l => !d.has(l.id)).map(l => (l === g ? merged : l));
  return { state: withLayers(st, layers), activeId: merged.id };
}

export function mergeVisible(st) {
  const vis = st.layers.filter(l => !isGroup(l) && effectiveVisible(st.layers, l));
  if (vis.length < 2) return null;
  const c = flattenState(st);
  const merged = mkLayer({ name: vis[0].name, canvas: c });
  const kept = st.layers.filter(l => !effectiveVisible(st.layers, l));
  return { state: withLayers(st, [merged, ...kept]), activeId: merged.id };
}

export function flatten(st) {
  const c = flattenState(st, '#ffffff');
  const bg = mkLayer({ name: 'Arrière-plan', canvas: c });
  return { state: { ...st, layers: [bg], selection: null }, activeId: bg.id };
}

// ——— Transformations d'une toile ———

function transformCanvas(src, kind) {
  const w = src.width, h = src.height;
  const swap = kind === 'cw' || kind === 'ccw';
  const c = newCanvas(swap ? h : w, swap ? w : h);
  const ctx = ctxOf(c);
  switch (kind) {
    case 'cw': ctx.translate(h, 0); ctx.rotate(Math.PI / 2); break;
    case 'ccw': ctx.translate(0, w); ctx.rotate(-Math.PI / 2); break;
    case '180': ctx.translate(w, h); ctx.rotate(Math.PI); break;
    case 'fh': ctx.translate(w, 0); ctx.scale(-1, 1); break;
    case 'fv': ctx.translate(0, h); ctx.scale(1, -1); break;
  }
  ctx.drawImage(src, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0); // la toile sert ensuite de calque : on ne laisse pas la rotation en place
  return c;
}

function xformPos(kind, x, y, w, h, W, H) {
  if (kind === 'cw') return [H - (y + h), x];
  if (kind === 'ccw') return [y, W - (x + w)];
  if (kind === '180') return [W - (x + w), H - (y + h)];
  if (kind === 'fh') return [W - (x + w), y];
  if (kind === 'fv') return [x, H - (y + h)];
  return [x, y];
}
const xformItem = (it, kind, W, H) => {
  if (!it?.canvas) return it;
  const [x, y] = xformPos(kind, it.x, it.y, it.canvas.width, it.canvas.height, W, H);
  return { ...it, canvas: transformCanvas(it.canvas, kind), x, y };
};

/** Rotation / symétrie de toute l'image (tous les calques, masques et sélection). */
export function transformImage(st, kind) {
  const W = st.width, H = st.height;
  const swap = kind === 'cw' || kind === 'ccw';
  const layers = st.layers.map(l => {
    const m = l.mask ? xformItem(l.mask, kind, W, H) : l.mask;
    if (!l.canvas) return { ...l, mask: m };
    return { ...xformItem(l, kind, W, H), text: null, mask: m };
  });
  return { ...st, width: swap ? H : W, height: swap ? W : H, layers, selection: xformItem(st.selection, kind, W, H) || null };
}

/** Rotation / symétrie du calque actif, autour de son centre. */
export function transformLayer(st, id, kind) {
  const l = st.layers.find(x => x.id === id);
  if (!l || !l.canvas || isGroup(l)) return st;
  const { x, y, w, h } = layerRect(l);
  const canvas = transformCanvas(l.canvas, kind);
  const cx = x + w / 2, cy = y + h / 2;
  let mask = l.mask;
  if (mask?.canvas) { // le masque tourne avec le calque
    const mc = transformCanvas(mask.canvas, kind);
    const px = mask.x + mask.canvas.width / 2, py = mask.y + mask.canvas.height / 2;
    const [nx, ny] = kind === 'cw' ? [cx - (py - cy), cy + (px - cx)] : kind === 'ccw' ? [cx + (py - cy), cy - (px - cx)]
      : kind === '180' ? [2 * cx - px, 2 * cy - py] : kind === 'fh' ? [2 * cx - px, py] : [px, 2 * cy - py];
    mask = { ...mask, canvas: mc, x: Math.round(nx - mc.width / 2), y: Math.round(ny - mc.height / 2) };
  }
  return updateLayer(st, id, {
    canvas,
    text: null,
    mask,
    x: Math.round(cx - canvas.width / 2),
    y: Math.round(cy - canvas.height / 2),
  });
}

// ——— Taille de l'image (rééchantillonnage) ———

export function scaleCanvas(src, nw, nh, method = 'auto') {
  nw = Math.max(1, Math.round(nw)); nh = Math.max(1, Math.round(nh));
  if (method === 'nearest') {
    const c = newCanvas(nw, nh);
    const ctx = ctxOf(c);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src, 0, 0, nw, nh);
    return c;
  }
  // Réduction par paliers de moitié : bien plus net qu'une réduction d'un coup
  let cur = src, cw = src.width, ch = src.height;
  const tmp = [];
  if (method === 'auto') {
    while (cw / 2 >= nw && ch / 2 >= nh) {
      const half = newCanvas(Math.round(cw / 2), Math.round(ch / 2));
      const hctx = ctxOf(half);
      hctx.imageSmoothingQuality = 'high';
      hctx.drawImage(cur, 0, 0, half.width, half.height);
      if (cur !== src) tmp.push(cur);
      cur = half; cw = half.width; ch = half.height;
    }
  }
  const c = newCanvas(nw, nh);
  const ctx = ctxOf(c);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = method === 'auto' ? 'high' : 'low';
  ctx.drawImage(cur, 0, 0, nw, nh);
  if (cur !== src) tmp.push(cur);
  for (const t of tmp) { t.width = 0; t.height = 0; }
  return c;
}

export function resizeImage(st, nw, nh, method) {
  const sx = nw / st.width, sy = nh / st.height;
  const scale = (it) => {
    if (!it?.canvas) return it;
    const x0 = Math.round(it.x * sx), y0 = Math.round(it.y * sy);
    const x1 = Math.round((it.x + it.canvas.width) * sx), y1 = Math.round((it.y + it.canvas.height) * sy);
    return { ...it, canvas: scaleCanvas(it.canvas, Math.max(1, x1 - x0), Math.max(1, y1 - y0), method), x: x0, y: y0 };
  };
  const layers = st.layers.map(l => {
    const m = l.mask ? scale(l.mask) : l.mask;
    if (!l.canvas) return { ...l, mask: m };
    return { ...scale(l), text: null, mask: m };
  });
  return { ...st, width: nw, height: nh, layers, selection: scale(st.selection) || null };
}

/** Taille de la zone de travail : on déplace les calques selon le point d'ancrage. */
export function resizeCanvasArea(st, nw, nh, anchor, fill) {
  const ax = anchor % 3, ay = Math.floor(anchor / 3);
  const dx = Math.round((nw - st.width) * ax / 2);
  const dy = Math.round((nh - st.height) * ay / 2);
  let layers = st.layers.map(l => ({ ...l, x: l.x + dx, y: l.y + dy, mask: l.mask ? { ...l.mask, x: l.mask.x + dx, y: l.mask.y + dy } : l.mask }));
  const bi = layers.findIndex(l => !isGroup(l));
  if (fill && bi >= 0) {
    const bottom = layers[bi];
    const c = newCanvas(nw, nh);
    const ctx = ctxOf(c);
    ctx.fillStyle = fill; ctx.fillRect(0, 0, nw, nh);
    if (bottom.canvas) ctx.drawImage(bottom.canvas, bottom.x, bottom.y);
    layers = layers.map((l, k) => (k === bi ? { ...bottom, canvas: c, x: 0, y: 0, text: null, smart: null } : l));
  }
  const sel = st.selection ? { ...st.selection, x: st.selection.x + dx, y: st.selection.y + dy } : null;
  return { ...st, width: nw, height: nh, layers, selection: sel };
}

/** Calque le plus haut qui a un pixel visible au point (px, py) du document. */
export function pickLayerAt(st, px, py) {
  for (let i = st.layers.length - 1; i >= 0; i--) {
    const l = st.layers[i];
    if (isGroup(l) || !l.canvas || !effectiveVisible(st.layers, l)) continue;
    const lx = Math.floor(px - l.x), ly = Math.floor(py - l.y);
    if (lx < 0 || ly < 0 || lx >= l.canvas.width || ly >= l.canvas.height) continue;
    try {
      const a = ctxOf(l.canvas).getImageData(lx, ly, 1, 1).data[3];
      if (a > 8) return l.id;
    } catch { return l.id; }
  }
  return null;
}

/** Recadrage : le document devient le rectangle r (coordonnées du document). */
export function cropState(st, r, deletePixels) {
  const W = Math.max(1, Math.round(r.w)), H = Math.max(1, Math.round(r.h));
  const rx = Math.round(r.x), ry = Math.round(r.y);
  const layers = st.layers.map(l0 => {
    const l = l0.mask ? { ...l0, mask: { ...l0.mask, x: l0.mask.x - rx, y: l0.mask.y - ry } } : l0;
    const x = l.x - rx, y = l.y - ry;
    if (!deletePixels || !l.canvas) return { ...l, x, y };
    const cw = l.canvas.width, ch = l.canvas.height;
    const ix = Math.max(0, x), iy = Math.max(0, y), ix2 = Math.min(W, x + cw), iy2 = Math.min(H, y + ch);
    if (ix === x && iy === y && ix2 === x + cw && iy2 === y + ch) return { ...l, x, y }; // déjà dedans
    if (ix2 <= ix || iy2 <= iy) return { ...l, canvas: newCanvas(1, 1), x: 0, y: 0, text: null };
    const c = newCanvas(ix2 - ix, iy2 - iy);
    ctxOf(c).drawImage(l.canvas, x - ix, y - iy);
    return { ...l, canvas: c, x: ix, y: iy, text: null };
  });
  return { ...st, width: W, height: H, layers, selection: null };
}

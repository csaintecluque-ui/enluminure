// Enluminure — opérations sur les états (chaque fonction renvoie un NOUVEL état)
import { newCanvas, ctxOf, mkLayer, uid } from './util.js';
import { drawStack, flattenState, layerRect, unionRect } from './render.js';

const withLayers = (st, layers) => ({ ...st, layers });
const idx = (st, id) => st.layers.findIndex(l => l.id === id);

export function updateLayer(st, id, patch) {
  return withLayers(st, st.layers.map(l => (l.id === id ? { ...l, ...patch } : l)));
}

export function insertLayer(st, layer, aboveId) {
  const layers = [...st.layers];
  const i = aboveId ? idx(st, aboveId) + 1 : layers.length;
  layers.splice(i <= 0 ? layers.length : i, 0, layer);
  return withLayers(st, layers);
}

export function removeLayer(st, id) {
  return withLayers(st, st.layers.filter(l => l.id !== id));
}

export function moveLayerTo(st, id, to) {
  const layers = [...st.layers];
  const from = idx(st, id);
  if (from < 0) return st;
  const [l] = layers.splice(from, 1);
  layers.splice(Math.max(0, Math.min(layers.length, to)), 0, l);
  return withLayers(st, layers);
}

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
export function duplicateLayer(st, id) {
  const l = st.layers.find(x => x.id === id);
  const copy = { ...l, id: uid(), name: `${l.name} copie` };
  return { state: insertLayer(st, copy, id), activeId: copy.id };
}

export function mergeDown(st, id) {
  const i = idx(st, id);
  if (i <= 0) return null;
  const up = st.layers[i], low = st.layers[i - 1];
  const r = unionRect(layerRect(low), layerRect(up));
  const c = newCanvas(r.w, r.h);
  // Le calque du dessous est dessiné « à plat », celui du dessus avec son mode et son opacité
  const lowFlat = { ...low, opacity: 1, blend: 'normal', clipping: false, visible: true };
  const upFix = { ...up, clipping: up.clipping, visible: true };
  drawStack(c, [lowFlat, upFix], r.x, r.y);
  const merged = { ...low, canvas: c, x: r.x, y: r.y };
  const layers = [...st.layers];
  layers.splice(i - 1, 2, merged);
  return { state: withLayers(st, layers), activeId: merged.id };
}

export function mergeVisible(st) {
  const vis = st.layers.filter(l => l.visible);
  if (vis.length < 2) return null;
  const c = flattenState({ ...st, layers: vis });
  const lowest = st.layers.findIndex(l => l.visible);
  const merged = mkLayer({ name: vis[0].name, canvas: c });
  const layers = [];
  st.layers.forEach((l, k) => {
    if (k === lowest) layers.push(merged);
    else if (!l.visible) layers.push(l);
  });
  return { state: withLayers(st, layers), activeId: merged.id };
}

export function flatten(st) {
  const c = flattenState(st, '#ffffff');
  const bg = mkLayer({ name: 'Arrière-plan', canvas: c });
  return { state: withLayers(st, [bg]), activeId: bg.id };
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
  return c;
}

/** Rotation / symétrie de toute l'image (tous les calques). */
export function transformImage(st, kind) {
  const W = st.width, H = st.height;
  const swap = kind === 'cw' || kind === 'ccw';
  const layers = st.layers.map(l => {
    if (!l.canvas) return l;
    const { x, y, w, h } = layerRect(l);
    let nx = x, ny = y;
    if (kind === 'cw') { nx = H - (y + h); ny = x; }
    else if (kind === 'ccw') { nx = y; ny = W - (x + w); }
    else if (kind === '180') { nx = W - (x + w); ny = H - (y + h); }
    else if (kind === 'fh') { nx = W - (x + w); }
    else if (kind === 'fv') { ny = H - (y + h); }
    return { ...l, canvas: transformCanvas(l.canvas, kind), x: nx, y: ny };
  });
  return { ...st, width: swap ? H : W, height: swap ? W : H, layers };
}

/** Rotation / symétrie du calque actif, autour de son centre. */
export function transformLayer(st, id, kind) {
  const l = st.layers.find(x => x.id === id);
  if (!l || !l.canvas) return st;
  const { x, y, w, h } = layerRect(l);
  const canvas = transformCanvas(l.canvas, kind);
  const cx = x + w / 2, cy = y + h / 2;
  return updateLayer(st, id, {
    canvas,
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
  const layers = st.layers.map(l => {
    if (!l.canvas) return l;
    const x0 = Math.round(l.x * sx), y0 = Math.round(l.y * sy);
    const x1 = Math.round((l.x + l.canvas.width) * sx), y1 = Math.round((l.y + l.canvas.height) * sy);
    return { ...l, canvas: scaleCanvas(l.canvas, Math.max(1, x1 - x0), Math.max(1, y1 - y0), method), x: x0, y: y0 };
  });
  return { ...st, width: nw, height: nh, layers };
}

/** Taille de la zone de travail : on déplace les calques selon le point d'ancrage. */
export function resizeCanvasArea(st, nw, nh, anchor, fill) {
  const ax = anchor % 3, ay = Math.floor(anchor / 3);
  const dx = Math.round((nw - st.width) * ax / 2);
  const dy = Math.round((nh - st.height) * ay / 2);
  let layers = st.layers.map(l => ({ ...l, x: l.x + dx, y: l.y + dy }));
  if (fill && layers.length) {
    const bottom = layers[0];
    const c = newCanvas(nw, nh);
    const ctx = ctxOf(c);
    ctx.fillStyle = fill; ctx.fillRect(0, 0, nw, nh);
    if (bottom.canvas) ctx.drawImage(bottom.canvas, bottom.x, bottom.y);
    layers = [{ ...bottom, canvas: c, x: 0, y: 0 }, ...layers.slice(1)];
  }
  return { ...st, width: nw, height: nh, layers };
}

/** Calque le plus haut qui a un pixel visible au point (px, py) du document. */
export function pickLayerAt(st, px, py) {
  for (let i = st.layers.length - 1; i >= 0; i--) {
    const l = st.layers[i];
    if (!l.visible || !l.canvas) continue;
    const lx = Math.floor(px - l.x), ly = Math.floor(py - l.y);
    if (lx < 0 || ly < 0 || lx >= l.canvas.width || ly >= l.canvas.height) continue;
    try {
      const a = ctxOf(l.canvas).getImageData(lx, ly, 1, 1).data[3];
      if (a > 8) return l.id;
    } catch { return l.id; }
  }
  return null;
}

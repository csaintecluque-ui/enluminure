// Enluminure — composition des calques : groupes, masques, modes de fusion, masques d'écrêtage
import { blendOp, newCanvas, ctxOf, freeCanvas } from './util.js';
import { buildTree, isGroup, isAdjust } from './tree.js';
import { applyAdjust } from './adjust.js';
import { hasStyles, renderStyles, styledMerged, freeStyled, contentBounds } from './styles.js';

/** Réserve de toiles de travail de la taille de la cible (réutilisées d'une image à l'autre). */
export class ScratchPool {
  constructor() { this.free = []; }
  get(w, h) {
    let c = this.free.pop();
    if (!c || c.width !== w || c.height !== h) { freeCanvas(c); c = newCanvas(w, h); }
    return c;
  }
  put(c) { this.free.push(c); }
  dispose() { for (const c of this.free) freeCanvas(c); this.free = []; }
}

// Calque + masque déjà combinés, gardés en cache tant que rien ne change
const maskedCache = new WeakMap();

/** Toile du calque une fois son masque appliqué (coordonnées du calque). */
export function maskedCanvas(L, content, maskCanvas, live = false) {
  const m = L.mask;
  if (!m || m.disabled || !maskCanvas) return content;
  const key = live ? null : `${content._v || 0}|${maskCanvas._v || 0}|${L.x},${L.y}|${m.x},${m.y}|${m.def}|${content.width}x${content.height}`;
  const hit = maskedCache.get(content);
  if (!live && hit && hit.key === key && hit.mask === maskCanvas) return hit.canvas;
  const w = content.width, h = content.height;
  const out = hit && hit.canvas.width === w && hit.canvas.height === h ? hit.canvas : newCanvas(w, h);
  const ctx = ctxOf(out);
  ctx.save();
  ctx.globalCompositeOperation = 'copy';
  ctx.drawImage(content, 0, 0);
  ctx.globalCompositeOperation = 'destination-in';
  const mx = m.x - L.x, my = m.y - L.y;
  const covers = mx <= 0 && my <= 0 && mx + maskCanvas.width >= w && my + maskCanvas.height >= h;
  if (covers || !m.def) {
    ctx.drawImage(maskCanvas, mx, my);
  } else { // en dehors du masque : visible (couleur par défaut blanche)
    const a = newCanvas(w, h);
    const actx = ctxOf(a);
    actx.fillRect(0, 0, w, h);
    actx.clearRect(mx, my, maskCanvas.width, maskCanvas.height);
    actx.drawImage(maskCanvas, mx, my);
    ctx.drawImage(a, 0, 0);
    freeCanvas(a);
  }
  ctx.restore();
  if (hit && hit.canvas !== out) freeCanvas(hit.canvas);
  maskedCache.set(content, { key, canvas: out, mask: maskCanvas });
  return out;
}

/**
 * Dessine une pile de calques (liste à plat, du bas vers le haut) dans `target`.
 * (ox, oy) = coordonnées du document du coin haut-gauche de `target`.
 * `env` : { pool, override (Map id → toile, 'mask:'+id → masque), clip (rectangle à recalculer) }.
 */
export function drawStack(target, layers, ox = 0, oy = 0, env = {}) {
  const pool = env.pool || new ScratchPool();
  const e = { pool, override: env.override || null, clip: env.clip || null, ox, oy };
  renderLevel(target, buildTree(layers), e);
  if (!env.pool) pool.dispose();
}

function contentOf(L, e) {
  const ov = e.override;
  const c = (ov && ov.get(L.id)) || L.canvas;
  if (!c || !c.width) return null;
  const mc = L.mask ? ((ov && ov.get(`mask:${L.id}`)) || L.mask.canvas) : null;
  const live = !!(ov && (ov.has(L.id) || ov.has(`mask:${L.id}`)));
  return maskedCanvas(L, c, mc, live);
}

// ——— Styles de calque (effets), gardés en cache tant que rien ne change ———
const styleCache = new WeakMap(); // toile du calque → [{ key, res }]
const EMPTY = { empty: true };
let liveStyled = null;

/** Effets du calque (ou null s'il n'en a pas). */
export function styledOf(L, e = {}) {
  if (!hasStyles(L)) return null;
  const ov = e.override;
  const raw = (ov && ov.get(L.id)) || L.canvas;
  if (!raw || !raw.width) return null;
  const mc = L.mask ? ((ov && ov.get(`mask:${L.id}`)) || L.mask.canvas) : null;
  const live = !!(ov && (ov.has(L.id) || ov.has(`mask:${L.id}`)));
  const content = maskedCanvas(L, raw, mc, live);
  if (live) { // pendant un geste : on recalcule à chaque image (sauf très grand calque : effets au lâcher)
    if (content.width * content.height > 2500000) return null;
    freeStyled(liveStyled);
    liveStyled = renderStyles(L.styles, content, { x: 0, y: 0, w: content.width, h: content.height });
    return liveStyled;
  }
  const m = L.mask;
  const key = `${raw._v || 0}|${raw.width}x${raw.height}|${m ? `${mc?._v || 0},${m.x - L.x},${m.y - L.y},${m.def},${m.disabled}` : ''}|${JSON.stringify(L.styles)}`;
  let list = styleCache.get(raw);
  if (!list) styleCache.set(raw, list = []);
  let hit = list.find(h => h.key === key);
  if (!hit) {
    const b = contentBounds(content);
    hit = { key, res: b ? renderStyles(L.styles, content, b) : EMPTY };
    list.unshift(hit);
    while (list.length > 3) freeStyled(list.pop().res);
  } else if (list[0] !== hit) { list.splice(list.indexOf(hit), 1); list.unshift(hit); }
  return hit.res;
}

function drawStyled(ctx, L, st, e) {
  if (st.empty) return;
  const x = L.x + st.x - e.ox, y = L.y + st.y - e.oy;
  ctx.save();
  for (const b of st.behind) {
    ctx.globalAlpha = L.opacity * b.opacity;
    ctx.globalCompositeOperation = blendOp(b.blend);
    ctx.drawImage(b.canvas, x, y);
  }
  ctx.globalAlpha = L.opacity;
  ctx.globalCompositeOperation = blendOp(L.blend);
  ctx.drawImage(st.body, x, y);
  ctx.restore();
}

function scratch(target, e) {
  const t = e.pool.get(target.width, target.height);
  const ctx = ctxOf(t);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  if (e.clip) { ctx.clearRect(e.clip.x - e.ox, e.clip.y - e.oy, e.clip.w, e.clip.h); }
  else ctx.clearRect(0, 0, t.width, t.height);
  ctx.restore();
  return t;
}

/** Rend un groupe isolé (ou un calque) dans une toile de travail de la taille de la cible. */
function renderIsolated(target, node, e) {
  const t = scratch(target, e);
  const L = node.layer;
  if (node.children) {
    renderLevel(t, node.children, e);
    if (L.mask && !L.mask.disabled) {
      const mc = (e.override && e.override.get(`mask:${L.id}`)) || L.mask.canvas;
      const ctx = ctxOf(t);
      ctx.save();
      ctx.globalCompositeOperation = 'destination-in';
      if (L.mask.def) {
        const a = newCanvas(t.width, t.height);
        const actx = ctxOf(a);
        actx.fillRect(0, 0, a.width, a.height);
        actx.clearRect(L.mask.x - e.ox, L.mask.y - e.oy, mc.width, mc.height);
        actx.drawImage(mc, L.mask.x - e.ox, L.mask.y - e.oy);
        ctx.drawImage(a, 0, 0);
        freeCanvas(a);
      } else ctx.drawImage(mc, L.mask.x - e.ox, L.mask.y - e.oy);
      ctx.restore();
    }
  } else {
    const st = styledOf(L, e);
    if (st) { if (!st.empty) ctxOf(t).drawImage(styledMerged(st), L.x + st.x - e.ox, L.y + st.y - e.oy); }
    else {
      const c = contentOf(L, e);
      if (c) ctxOf(t).drawImage(c, L.x - e.ox, L.y - e.oy);
    }
  }
  return t;
}

/** Calque de réglage : modifie ce qui est déjà dessiné dans `target` (zone à recalculer seulement). */
function applyAdjustLayer(target, L, e, atop = false) {
  let r = { x: 0, y: 0, w: target.width, h: target.height };
  if (e.clip) {
    const x = Math.max(0, e.clip.x - e.ox), y = Math.max(0, e.clip.y - e.oy);
    r = { x, y, w: Math.min(target.width, e.clip.x - e.ox + e.clip.w) - x, h: Math.min(target.height, e.clip.y - e.oy + e.clip.h) - y };
    if (r.w <= 0 || r.h <= 0) return;
  }
  let out;
  try { out = applyAdjust(target, L.adjust, r); } catch (err) { console.warn(err); return; }
  const ctx = ctxOf(target);
  ctx.save();
  const m = L.mask && !L.mask.disabled ? L.mask : null;
  if (!m && L.opacity >= 1 && (L.blend === 'normal' || !L.blend) && !atop) {
    ctx.clearRect(r.x, r.y, r.w, r.h);
    ctx.drawImage(out, r.x, r.y);
  } else {
    let src = out;
    if (m) {
      const mc = (e.override && e.override.get(`mask:${L.id}`)) || m.canvas;
      src = maskedCanvas({ mask: m, x: r.x + e.ox, y: r.y + e.oy }, out, mc, true);
    }
    ctx.globalAlpha = L.opacity;
    ctx.globalCompositeOperation = L.blend && L.blend !== 'normal' ? blendOp(L.blend) : 'source-atop';
    ctx.drawImage(src, r.x, r.y);
  }
  ctx.restore();
}

function renderLevel(target, nodes, e) {
  const ctx = ctxOf(target);
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i], L = node.layer;
    if (L.clipping && i > 0) continue; // dessiné avec son calque de base
    const clipped = [];
    for (let j = i + 1; j < nodes.length && nodes[j].layer.clipping; j++) clipped.push(nodes[j]);
    if (!L.visible) continue;
    if (isAdjust(L)) { applyAdjustLayer(target, L, e); continue; }
    const vis = clipped.filter(c => c.layer.visible);
    const group = isGroup(L);
    const passThrough = group && L.blend === 'pass through' && L.opacity >= 1 && !(L.mask && !L.mask.disabled);

    if (!vis.length && !group) {
      const st = styledOf(L, e);
      if (st) { drawStyled(ctx, L, st, e); continue; }
      const c = contentOf(L, e);
      if (!c) continue;
      ctx.save();
      ctx.globalAlpha = L.opacity;
      ctx.globalCompositeOperation = blendOp(L.blend);
      ctx.drawImage(c, L.x - e.ox, L.y - e.oy);
      ctx.restore();
      continue;
    }
    if (!vis.length && passThrough) { renderLevel(target, node.children, e); continue; }

    // Rendu isolé : groupe avec opacité / mode / masque, ou calque de base d'un masque d'écrêtage
    const t = renderIsolated(target, node, e);
    if (vis.length) {
      const tctx = ctxOf(t);
      for (const c of vis) {
        if (isAdjust(c.layer)) { applyAdjustLayer(t, c.layer, e, true); continue; }
        const ct = c.children ? renderIsolated(target, c, e) : null;
        const sty = ct ? null : styledOf(c.layer, e);
        if (sty?.empty) continue;
        const src = ct || (sty ? styledMerged(sty) : contentOf(c.layer, e));
        if (!src) continue;
        tctx.save();
        tctx.globalAlpha = c.layer.opacity;
        tctx.globalCompositeOperation = 'source-atop';
        if (ct) tctx.drawImage(ct, 0, 0);
        else if (sty) tctx.drawImage(src, c.layer.x + sty.x - e.ox, c.layer.y + sty.y - e.oy);
        else tctx.drawImage(src, c.layer.x - e.ox, c.layer.y - e.oy);
        tctx.restore();
        if (ct) e.pool.put(ct);
      }
    }
    ctx.save();
    ctx.globalAlpha = L.opacity;
    ctx.globalCompositeOperation = blendOp(L.blend === 'pass through' ? 'normal' : L.blend);
    ctx.drawImage(t, 0, 0);
    ctx.restore();
    e.pool.put(t);
  }
}

/** Image finale du document (taille du document), fond transparent ou coloré. */
export function flattenState(state, background = null) {
  const c = newCanvas(state.width, state.height);
  const ctx = ctxOf(c);
  if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, c.width, c.height); }
  drawStack(c, state.layers);
  return c;
}

export function layerRect(L) {
  return { x: L.x, y: L.y, w: L.canvas ? L.canvas.width : 0, h: L.canvas ? L.canvas.height : 0 };
}

export function unionRect(a, b) {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export function interRect(a, b) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x, h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

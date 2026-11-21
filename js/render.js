// Enluminure — composition des calques (fusion, opacité, masques d'écrêtage)
import { blendOp, newCanvas, ctxOf } from './util.js';

/**
 * Dessine une pile de calques (du bas vers le haut) dans la toile `target`.
 * (ox, oy) = coordonnées du document qui correspondent au coin haut-gauche de `target`.
 * `scratch` = toile de travail réutilisable (pour les masques d'écrêtage). Retourne la toile de travail.
 */
export function drawStack(target, layers, ox = 0, oy = 0, scratch = null, override = null) {
  const cv = (L) => (override && override.get(L.id)) || L.canvas;
  const ctx = ctxOf(target);
  let tmp = scratch;
  for (let i = 0; i < layers.length; i++) {
    const L = layers[i];
    if (L.clipping && i > 0) continue; // dessiné avec son calque de base
    const clipped = [];
    for (let j = i + 1; j < layers.length && layers[j].clipping; j++) clipped.push(layers[j]);
    if (!L.visible || !L.canvas || !L.canvas.width) continue;
    const vis = clipped.filter(c => c.visible && c.canvas && c.canvas.width);
    ctx.save();
    if (!vis.length) {
      ctx.globalAlpha = L.opacity;
      ctx.globalCompositeOperation = blendOp(L.blend);
      ctx.drawImage(cv(L), L.x - ox, L.y - oy);
    } else {
      if (!tmp || tmp.width !== target.width || tmp.height !== target.height) tmp = newCanvas(target.width, target.height);
      const t = ctxOf(tmp);
      t.save();
      t.clearRect(0, 0, tmp.width, tmp.height);
      t.drawImage(cv(L), L.x - ox, L.y - oy);
      for (const c of vis) {
        t.globalAlpha = c.opacity;
        t.globalCompositeOperation = 'source-atop';
        t.drawImage(cv(c), c.x - ox, c.y - oy);
      }
      t.restore();
      ctx.globalAlpha = L.opacity;
      ctx.globalCompositeOperation = blendOp(L.blend);
      ctx.drawImage(tmp, 0, 0);
    }
    ctx.restore();
  }
  return tmp;
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

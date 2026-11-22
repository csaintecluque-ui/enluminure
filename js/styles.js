// Enluminure — styles de calque : ombre portée, ombre interne, lueurs, biseau, contour, incrustations
// Tout est calculé à partir de la forme du calque (sa transparence), puis gardé en cache.
import { newCanvas, ctxOf, freeCanvas, clamp, blendOp } from './util.js';

const rgbOf = (hex) => {
  const h = String(hex || '#000000').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** Les effets, dans l'ordre de la fenêtre de Photoshop, avec leurs réglages par défaut. */
export const FX = {
  bevel: { label: 'Biseautage et estampage', def: { style: 'inner', depth: 100, up: true, size: 5, soften: 0, angle: 120, altitude: 30, hiBlend: 'screen', hiColor: '#ffffff', hiOpacity: 0.75, shBlend: 'multiply', shColor: '#000000', shOpacity: 0.75 } },
  stroke: { label: 'Contour', def: { size: 3, position: 'outside', blend: 'normal', opacity: 1, color: '#000000' } },
  innerShadow: { label: 'Ombre interne', def: { blend: 'multiply', color: '#000000', opacity: 0.75, angle: 120, distance: 5, choke: 0, size: 5 } },
  innerGlow: { label: 'Lueur interne', def: { blend: 'screen', color: '#ffffbe', opacity: 0.75, source: 'edge', choke: 0, size: 10 } },
  colorOverlay: { label: 'Incrustation couleur', def: { blend: 'normal', color: '#c8743a', opacity: 1 } },
  gradientOverlay: { label: 'Incrustation de dégradé', def: { blend: 'normal', opacity: 1, type: 'linear', angle: 90, scale: 100, reverse: false, c1: '#000000', c2: '#ffffff' } },
  outerGlow: { label: 'Lueur externe', def: { blend: 'screen', color: '#ffffbe', opacity: 0.75, spread: 0, size: 10 } },
  dropShadow: { label: 'Ombre portée', def: { blend: 'multiply', color: '#000000', opacity: 0.75, angle: 120, distance: 10, spread: 0, size: 10 } },
};
export const FX_ORDER = Object.keys(FX);

export const newFx = (k) => ({ on: true, ...structuredClone(FX[k].def) });

/** Le calque a-t-il des effets visibles ? */
export function hasStyles(L) {
  const s = L && L.styles;
  if (!s || s.hidden) return false;
  if ((s.fill ?? 1) < 1) return true;
  for (const k of FX_ORDER) if (s[k]?.on) return true;
  return false;
}
/** Des effets existent (même masqués) : pour le badge « fx ». */
export const anyStyles = (s) => !!s && ((s.fill ?? 1) < 1 || FX_ORDER.some(k => s[k]?.on));

/** Débord (px) des effets autour du contenu du calque. */
export function stylePad(s) {
  if (!s || s.hidden) return 0;
  let p = 0, f;
  const on = (k) => (s[k]?.on ? s[k] : null);
  if ((f = on('dropShadow'))) p = Math.max(p, f.distance + f.size * 1.5);
  if ((f = on('outerGlow'))) p = Math.max(p, f.size * 1.5);
  if ((f = on('stroke')) && f.position !== 'inside') p = Math.max(p, f.position === 'center' ? f.size / 2 : f.size);
  if ((f = on('bevel')) && f.style !== 'inner') p = Math.max(p, f.size * 1.2);
  return Math.ceil(p) + 2;
}

// ——— Champs de valeurs (Float32, une valeur par pixel) ———
const INF = 1e20;
function edt1d(f, d, v, z, n) {
  let k = 0;
  v[0] = 0; z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; const r = q - v[k]; d[q] = r * r + f[v[k]]; }
}
/** Distance (px) de chaque pixel au plus proche pixel « source » (transformée exacte, Felzenszwalb). */
function distanceTo(isSource, W, H) {
  const g = new Float32Array(W * H);
  for (let i = 0; i < g.length; i++) g[i] = isSource(i) ? 0 : INF;
  const m = Math.max(W, H);
  const f = new Float64Array(m), d = new Float64Array(m), v = new Int32Array(m), z = new Float64Array(m + 1);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) f[y] = g[y * W + x];
    edt1d(f, d, v, z, H);
    for (let y = 0; y < H; y++) g[y * W + x] = d[y];
  }
  for (let y = 0; y < H; y++) {
    const o = y * W;
    for (let x = 0; x < W; x++) f[x] = g[o + x];
    edt1d(f, d, v, z, W);
    for (let x = 0; x < W; x++) g[o + x] = Math.sqrt(d[x]);
  }
  return g;
}

function boxes(sigma) {
  const n = 3, wIdeal = Math.sqrt((12 * sigma * sigma / n) + 1);
  let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  return [0, 1, 2].map(i => ((i < m ? wl : wl + 2) - 1) / 2);
}
function boxH(s, t, W, H, r) {
  const k = 1 / (2 * r + 1);
  for (let y = 0; y < H; y++) {
    const o = y * W;
    let acc = 0;
    for (let x = 0; x <= Math.min(r, W - 1); x++) acc += s[o + x];
    for (let x = 0; x < W; x++) {
      t[o + x] = acc * k;
      if (x + r + 1 < W) acc += s[o + x + r + 1];
      if (x - r >= 0) acc -= s[o + x - r];
    }
  }
}
function boxV(s, t, W, H, r) {
  const k = 1 / (2 * r + 1);
  for (let x = 0; x < W; x++) {
    let acc = 0;
    for (let y = 0; y <= Math.min(r, H - 1); y++) acc += s[y * W + x];
    for (let y = 0; y < H; y++) {
      t[y * W + x] = acc * k;
      if (y + r + 1 < H) acc += s[(y + r + 1) * W + x];
      if (y - r >= 0) acc -= s[(y - r) * W + x];
    }
  }
}
/** Flou gaussien approché (3 flous en boîte), l'extérieur valant 0. */
function blur(a, W, H, sigma) {
  const out = Float32Array.from(a);
  if (sigma < 0.35) return out;
  const tmp = new Float32Array(a.length);
  for (const r of boxes(sigma)) { if (r < 1) continue; boxH(out, tmp, W, H, r); boxV(tmp, out, W, H, r); }
  return out;
}
/** Décale un champ : out(x) = a(x − dx, y − dy) (0 en dehors). */
function shift(a, W, H, dx, dy) {
  dx = Math.round(dx); dy = Math.round(dy);
  if (!dx && !dy) return a;
  const out = new Float32Array(a.length);
  for (let y = 0; y < H; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= H) continue;
    for (let x = 0; x < W; x++) {
      const sx = x - dx;
      if (sx >= 0 && sx < W) out[y * W + x] = a[sy * W + sx];
    }
  }
  return out;
}

function fieldCanvas(a, W, H, color) {
  const [r, g, b] = rgbOf(color);
  const c = newCanvas(W, H), ctx = ctxOf(c);
  const img = ctx.createImageData(W, H), d = img.data;
  for (let i = 0, k = 0; i < a.length; i++, k += 4) { d[k] = r; d[k + 1] = g; d[k + 2] = b; d[k + 3] = a[i] * 255; }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Rectangle utile (pixels non transparents) d'une toile, ou null. */
export function contentBounds(c) {
  const W = c.width, H = c.height;
  if (!W || !H) return null;
  const d = ctxOf(c).getImageData(0, 0, W, H).data;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    const o = y * W * 4;
    let first = -1, last = -1;
    for (let x = 0; x < W; x++) if (d[o + x * 4 + 3]) { first = x; break; }
    if (first < 0) continue;
    for (let x = W - 1; x >= first; x--) if (d[o + x * 4 + 3]) { last = x; break; }
    if (first < x0) x0 = first;
    if (last > x1) x1 = last;
    if (y < y0) y0 = y;
    y1 = y;
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * Calcule les effets d'un calque. `content` = pixels du calque (masque appliqué), `b` = zone utile.
 * Renvoie { x, y (coin, coordonnées du calque), behind: [{ canvas, blend, opacity }], body } :
 * « behind » se dessine sous le calque avec son propre mode, « body » = contenu + effets internes.
 */
export function renderStyles(s, content, b) {
  const P = stylePad(s), W = b.w + 2 * P, H = b.h + 2 * P, n = W * H;
  const base = newCanvas(W, H), bctx = ctxOf(base);
  bctx.drawImage(content, b.x, b.y, b.w, b.h, P, P, b.w, b.h);
  const px = bctx.getImageData(0, 0, W, H).data;
  const A = new Float32Array(n);
  for (let i = 0; i < n; i++) A[i] = px[i * 4 + 3] / 255;
  let dOut = null, dIn = null;
  const outside = () => dOut || (dOut = distanceTo(i => A[i] >= 0.5, W, H));  // distance à la forme (dehors)
  const inside = () => dIn || (dIn = distanceTo(i => A[i] < 0.5, W, H));     // distance au bord (dedans)
  const dilate = (r) => { if (r <= 0) return A; const d = outside(), o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = Math.max(A[i], clamp(r + 0.5 - d[i], 0, 1)); return o; };
  const erode = (r) => { if (r <= 0) return A; const d = inside(), o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = Math.min(A[i], clamp(d[i] - r - 0.5 + 1, 0, 1)); return o; };
  const offset = (f) => { const a = f.angle * Math.PI / 180; return [-Math.cos(a) * f.distance, Math.sin(a) * f.distance]; };
  const on = (k) => (s[k]?.on ? s[k] : null);
  let f;

  // ——— Sous le calque ———
  const behind = [];
  if ((f = on('dropShadow'))) {
    const sp = f.size * clamp(f.spread, 0, 100) / 100;
    const [dx, dy] = offset(f);
    const g = shift(blur(dilate(sp), W, H, (f.size - sp) / 2), W, H, dx, dy);
    for (let i = 0; i < n; i++) g[i] *= 1 - A[i]; // le calque masque son ombre
    behind.push({ canvas: fieldCanvas(g, W, H, f.color), blend: f.blend, opacity: f.opacity });
  }
  if ((f = on('outerGlow'))) {
    const sp = f.size * clamp(f.spread, 0, 100) / 100;
    const g = blur(dilate(sp), W, H, (f.size - sp) / 2);
    behind.push({ canvas: fieldCanvas(g, W, H, f.color), blend: f.blend, opacity: f.opacity });
  }

  // ——— Le calque et ses effets internes ———
  const body = newCanvas(W, H), ctx = ctxOf(body);
  ctx.globalAlpha = clamp(s.fill ?? 1, 0, 1);
  ctx.drawImage(base, 0, 0);
  const put = (c, blend, opacity) => {
    ctx.globalCompositeOperation = blendOp(blend);
    ctx.globalAlpha = clamp(opacity, 0, 1);
    ctx.drawImage(c, 0, 0);
    freeCanvas(c);
  };
  const clipped = (paint) => { // remplissage limité à la forme du calque
    const c = newCanvas(W, H), cx = ctxOf(c);
    paint(cx);
    cx.globalCompositeOperation = 'destination-in';
    cx.drawImage(base, 0, 0);
    return c;
  };
  if ((f = on('gradientOverlay'))) {
    const g = f;
    put(clipped(cx => {
      const a = g.angle * Math.PI / 180, ux = Math.cos(a), uy = -Math.sin(a);
      const cxm = P + b.w / 2, cym = P + b.h / 2, k = (g.scale || 100) / 100;
      const half = (Math.abs(b.w * ux) + Math.abs(b.h * uy)) / 2 * k;
      const gr = g.type === 'radial'
        ? cx.createRadialGradient(cxm, cym, 0, cxm, cym, Math.max(b.w, b.h) / 2 * k)
        : cx.createLinearGradient(cxm - ux * half, cym - uy * half, cxm + ux * half, cym + uy * half);
      gr.addColorStop(0, g.reverse ? g.c2 : g.c1);
      gr.addColorStop(1, g.reverse ? g.c1 : g.c2);
      cx.fillStyle = gr; cx.fillRect(0, 0, W, H);
    }), g.blend, g.opacity);
  }
  if ((f = on('colorOverlay'))) { const col = f.color; put(clipped(cx => { cx.fillStyle = col; cx.fillRect(0, 0, W, H); }), f.blend, f.opacity); }
  if ((f = on('innerGlow'))) {
    const ch = f.size * clamp(f.choke, 0, 100) / 100;
    const bl = blur(erode(ch), W, H, Math.max(0, f.size - ch) / 2);
    const g = new Float32Array(n);
    for (let i = 0; i < n; i++) g[i] = (f.source === 'center' ? bl[i] : 1 - bl[i]) * A[i];
    put(fieldCanvas(g, W, H, f.color), f.blend, f.opacity);
  }
  if ((f = on('innerShadow'))) {
    const ch = f.size * clamp(f.choke, 0, 100) / 100;
    const [dx, dy] = offset(f);
    const bl = shift(blur(erode(ch), W, H, Math.max(0, f.size - ch) / 2), W, H, dx, dy);
    const g = new Float32Array(n);
    for (let i = 0; i < n; i++) g[i] = (1 - bl[i]) * A[i];
    put(fieldCanvas(g, W, H, f.color), f.blend, f.opacity);
  }
  if ((f = on('stroke'))) {
    const sz = Math.max(0.5, f.size), g = new Float32Array(n);
    const outW = f.position === 'outside' ? sz : f.position === 'center' ? sz / 2 : 0;
    const inW = f.position === 'inside' ? sz : f.position === 'center' ? sz / 2 : 0;
    const dO = outW > 0 ? outside() : null, dI = inW > 0 ? inside() : null;
    for (let i = 0; i < n; i++) {
      let v = 0;
      if (dO) v = clamp(outW + 0.5 - dO[i], 0, 1) * (1 - A[i]);
      if (dI) v += A[i] * clamp(inW + 0.5 - dI[i], 0, 1);
      g[i] = Math.min(1, v);
    }
    put(fieldCanvas(g, W, H, f.color), f.blend, f.opacity);
  }
  if ((f = on('bevel'))) {
    const { hi, sh } = bevelFields(f, A, inside, outside, W, H);
    put(fieldCanvas(sh, W, H, f.shColor), f.shBlend, f.shOpacity);
    put(fieldCanvas(hi, W, H, f.hiColor), f.hiBlend, f.hiOpacity);
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  freeCanvas(base);
  return { x: b.x - P, y: b.y - P, w: W, h: H, behind, body };
}

function bevelFields(f, A, inside, outside, W, H) {
  const n = W * H, size = Math.max(1, f.size), h = new Float32Array(n);
  const prof = (t) => { t = clamp(t, 0, 1); return 1 - (1 - t) * (1 - t); }; // bord arrondi
  const style = f.style || 'inner';
  const dI = style !== 'outer' ? inside() : null, dO = style !== 'inner' ? outside() : null;
  for (let i = 0; i < n; i++) {
    const inS = A[i] >= 0.5;
    if (style === 'inner') h[i] = inS ? prof((dI[i] - 0.5) / size) : 0;
    else if (style === 'outer') h[i] = inS ? 1 : prof(1 - (dO[i] - 0.5) / size);
    else h[i] = inS ? 0.5 + 0.5 * prof((dI[i] - 0.5) / size) : 0.5 * prof(1 - (dO[i] - 0.5) / size);
  }
  const hs = blur(h, W, H, Math.max(0.8, (f.soften || 0) / 2 + 0.5));
  const Z = size * clamp(f.depth, 1, 1000) / 100 * (f.up === false ? -1 : 1);
  const a = f.angle * Math.PI / 180, e = clamp(f.altitude, 0, 90) * Math.PI / 180;
  const Lx = Math.cos(e) * Math.cos(a), Ly = -Math.cos(e) * Math.sin(a), Lz = Math.sin(e);
  const hi = new Float32Array(n), sh = new Float32Array(n);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    const gx = (hs[i + 1] - hs[i - 1]) / 2 * Z, gy = (hs[i + W] - hs[i - W]) / 2 * Z;
    if (!gx && !gy) continue;
    const len = Math.sqrt(gx * gx + gy * gy + 1);
    const shade = (-gx * Lx - gy * Ly + Lz) / len;
    const reg = style === 'inner' ? A[i] : style === 'outer' ? 1 - A[i] : 1;
    if (shade > Lz) hi[i] = Math.min(1, (shade - Lz) / Math.max(0.05, 1 - Lz) * 1.6) * reg;
    else sh[i] = Math.min(1, (Lz - shade) / Math.max(0.05, Lz) * 1.6) * reg;
  }
  return { hi, sh };
}

/** Toile unique (effets + calque), pour les cas où le calque est rendu à part (écrêtage, fusion…). */
export function styledMerged(res) {
  if (res.merged) return res.merged;
  const c = newCanvas(res.w, res.h), ctx = ctxOf(c);
  for (const b of res.behind) { ctx.globalAlpha = b.opacity; ctx.drawImage(b.canvas, 0, 0); }
  ctx.globalAlpha = 1;
  ctx.drawImage(res.body, 0, 0);
  res.merged = c;
  return c;
}

export function freeStyled(res) {
  if (!res || res.empty) return;
  for (const b of res.behind) freeCanvas(b.canvas);
  freeCanvas(res.body);
  freeCanvas(res.merged);
}

// ——— Photoshop (ag-psd) ———
const U = (v) => ({ units: 'Pixels', value: v });
const uv = (u, d = 0) => (u == null ? d : typeof u === 'number' ? u : u.value ?? d);
const col = (h) => { const [r, g, b] = rgbOf(h); return { r, g, b }; };
const hexOf = (c, d) => {
  if (!c) return d;
  const v = (x) => clamp(Math.round(x ?? 0), 0, 255).toString(16).padStart(2, '0');
  if ('r' in c) return `#${v(c.r)}${v(c.g)}${v(c.b)}`;
  if ('fr' in c) return `#${v(c.fr * 255)}${v(c.fg * 255)}${v(c.fb * 255)}`;
  return d;
};
const BEVEL_STYLE = { inner: 'inner bevel', outer: 'outer bevel', emboss: 'emboss' };

export function stylesToPsd(s) {
  if (!anyStyles(s)) return undefined;
  const fx = {};
  const base = (f) => ({ present: true, showInDialog: true, enabled: !!f.on });
  let f;
  if ((f = s.dropShadow)) fx.dropShadow = [{ ...base(f), size: U(f.size), angle: f.angle, distance: U(f.distance), color: col(f.color), blendMode: f.blend, opacity: f.opacity, choke: U(f.spread), useGlobalLight: false, layerConceals: true }];
  if ((f = s.innerShadow)) fx.innerShadow = [{ ...base(f), size: U(f.size), angle: f.angle, distance: U(f.distance), color: col(f.color), blendMode: f.blend, opacity: f.opacity, choke: U(f.choke), useGlobalLight: false }];
  if ((f = s.outerGlow)) fx.outerGlow = { ...base(f), size: U(f.size), color: col(f.color), blendMode: f.blend, opacity: f.opacity, choke: U(f.spread), source: 'edge' };
  if ((f = s.innerGlow)) fx.innerGlow = { ...base(f), size: U(f.size), color: col(f.color), blendMode: f.blend, opacity: f.opacity, choke: U(f.choke), source: f.source === 'center' ? 'center' : 'edge' };
  if ((f = s.bevel)) fx.bevel = { ...base(f), size: U(f.size), angle: f.angle, strength: f.depth, style: BEVEL_STYLE[f.style] || 'inner bevel', direction: f.up === false ? 'down' : 'up', soften: U(f.soften), altitude: f.altitude, useGlobalLight: false, highlightBlendMode: f.hiBlend, highlightColor: col(f.hiColor), highlightOpacity: f.hiOpacity, shadowBlendMode: f.shBlend, shadowColor: col(f.shColor), shadowOpacity: f.shOpacity, technique: 'smooth' };
  if ((f = s.stroke)) fx.stroke = [{ ...base(f), size: U(f.size), position: f.position, fillType: 'color', blendMode: f.blend, opacity: f.opacity, color: col(f.color) }];
  if ((f = s.colorOverlay)) fx.solidFill = [{ ...base(f), blendMode: f.blend, color: col(f.color), opacity: f.opacity }];
  if ((f = s.gradientOverlay)) fx.gradientOverlay = [{
    ...base(f), blendMode: f.blend, opacity: f.opacity, angle: f.angle, type: f.type === 'radial' ? 'radial' : 'linear', reverse: !!f.reverse, scale: f.scale, align: true,
    gradient: { name: 'Personnalisé', type: 'solid', colorStops: [{ color: col(f.c1), location: 0, midpoint: 0.5 }, { color: col(f.c2), location: 1, midpoint: 0.5 }], opacityStops: [{ opacity: 1, location: 0, midpoint: 0.5 }, { opacity: 1, location: 1, midpoint: 0.5 }] },
  }];
  if (s.hidden) fx.disabled = true;
  return fx;
}

export function stylesFromPsd(fx, fillOpacity) {
  const s = {};
  if (fillOpacity != null && fillOpacity < 1) s.fill = fillOpacity;
  if (!fx) return Object.keys(s).length ? s : null;
  const D = (k) => FX[k].def;
  const one = (x) => (Array.isArray(x) ? x[0] : x);
  let f;
  if ((f = one(fx.dropShadow))) s.dropShadow = { on: f.enabled !== false, blend: f.blendMode || D('dropShadow').blend, color: hexOf(f.color, '#000000'), opacity: f.opacity ?? 0.75, angle: f.angle ?? 120, distance: uv(f.distance, 5), spread: uv(f.choke, 0), size: uv(f.size, 5) };
  if ((f = one(fx.innerShadow))) s.innerShadow = { on: f.enabled !== false, blend: f.blendMode || 'multiply', color: hexOf(f.color, '#000000'), opacity: f.opacity ?? 0.75, angle: f.angle ?? 120, distance: uv(f.distance, 5), choke: uv(f.choke, 0), size: uv(f.size, 5) };
  if ((f = fx.outerGlow)) s.outerGlow = { on: f.enabled !== false, blend: f.blendMode || 'screen', color: hexOf(f.color, '#ffffbe'), opacity: f.opacity ?? 0.75, spread: uv(f.choke, 0), size: uv(f.size, 5) };
  if ((f = fx.innerGlow)) s.innerGlow = { on: f.enabled !== false, blend: f.blendMode || 'screen', color: hexOf(f.color, '#ffffbe'), opacity: f.opacity ?? 0.75, source: f.source === 'center' ? 'center' : 'edge', choke: uv(f.choke, 0), size: uv(f.size, 5) };
  if ((f = fx.bevel)) {
    const st = Object.entries(BEVEL_STYLE).find(([, v]) => v === f.style)?.[0] || 'inner';
    s.bevel = { on: f.enabled !== false, style: st, depth: f.strength ?? 100, up: f.direction !== 'down', size: uv(f.size, 5), soften: uv(f.soften, 0), angle: f.angle ?? 120, altitude: f.altitude ?? 30, hiBlend: f.highlightBlendMode || 'screen', hiColor: hexOf(f.highlightColor, '#ffffff'), hiOpacity: f.highlightOpacity ?? 0.75, shBlend: f.shadowBlendMode || 'multiply', shColor: hexOf(f.shadowColor, '#000000'), shOpacity: f.shadowOpacity ?? 0.75 };
  }
  if ((f = one(fx.stroke))) s.stroke = { on: f.enabled !== false, size: uv(f.size, 3), position: f.position || 'outside', blend: f.blendMode || 'normal', opacity: f.opacity ?? 1, color: hexOf(f.color, '#000000') };
  if ((f = one(fx.solidFill))) s.colorOverlay = { on: f.enabled !== false, blend: f.blendMode || 'normal', color: hexOf(f.color, '#c8743a'), opacity: f.opacity ?? 1 };
  if ((f = one(fx.gradientOverlay))) {
    const cs = f.gradient?.colorStops || [];
    s.gradientOverlay = { on: f.enabled !== false, blend: f.blendMode || 'normal', opacity: f.opacity ?? 1, type: f.type === 'radial' ? 'radial' : 'linear', angle: f.angle ?? 90, scale: f.scale ?? 100, reverse: !!f.reverse, c1: hexOf(cs[0]?.color, '#000000'), c2: hexOf(cs[cs.length - 1]?.color, '#ffffff') };
  }
  if (fx.disabled) s.hidden = true;
  return Object.keys(s).length ? s : null;
}

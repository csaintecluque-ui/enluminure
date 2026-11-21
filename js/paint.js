// Enluminure — peinture : pinceau, gomme, remplissage, dégradé, texte, formes, pipette
import { newCanvas, ctxOf, bump, clamp, freeCanvas } from './util.js';
import { layerRect, unionRect } from './render.js';
import { updateLayer } from './ops.js';

// ——— Couleurs ———
export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const rgbToHex = (r, g, b) => `#${[r, g, b].map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('')}`;
export const rgba = (hex, a) => { const [r, g, b] = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; };

export function copyRect(src, x, y, w, h) {
  const c = newCanvas(w, h);
  ctxOf(c).drawImage(src, x, y, w, h, 0, 0, w, h);
  return c;
}

/**
 * Prépare un calque à être peint : sa toile doit lui appartenir (pas partagée avec
 * un calque dupliqué) et couvrir toute l'image. Renvoie l'état (éventuellement nouveau).
 */
export function ensurePaintable(doc, layerId) {
  const st = doc.committed;
  const L = st.layers.find(l => l.id === layerId);
  let shared = false;
  for (const e of doc.entries) for (const l of e.state.layers) if (l.canvas === L.canvas && l.id !== L.id) shared = true;
  const r = layerRect(L);
  const covers = r.x <= 0 && r.y <= 0 && r.x + r.w >= st.width && r.y + r.h >= st.height;
  let state = st, layer = L;
  if (shared || !covers) {
    const u = covers ? r : unionRect(r, { x: 0, y: 0, w: st.width, h: st.height });
    const c = newCanvas(u.w, u.h);
    if (L.canvas && L.canvas.width) ctxOf(c).drawImage(L.canvas, r.x - u.x, r.y - u.y);
    layer = { ...L, canvas: c, x: u.x, y: u.y };
    state = updateLayer(st, L.id, { canvas: c, x: u.x, y: u.y });
  }
  if (layer.text) { // un calque de texte peint devient une image
    layer = { ...layer, text: null };
    state = updateLayer(state, L.id, { text: null });
  }
  return { state, layer };
}

/** Modifie les pixels d'un calque et enregistre l'étape avec une rustine (zone avant / après). */
export function commitPixels(app, label, layerId, docRect, draw, prepared) {
  const doc = app.doc;
  const { state, layer } = prepared || ensurePaintable(doc, layerId);
  const c = layer.canvas;
  const x = clamp(Math.floor(docRect.x - layer.x), 0, c.width), y = clamp(Math.floor(docRect.y - layer.y), 0, c.height);
  const x2 = clamp(Math.ceil(docRect.x + docRect.w - layer.x), 0, c.width), y2 = clamp(Math.ceil(docRect.y + docRect.h - layer.y), 0, c.height);
  const w = x2 - x, h = y2 - y;
  if (w <= 0 || h <= 0) { doc.cancelPreview(); app.refresh({ history: false }); return false; }
  const before = copyRect(c, x, y, w, h);
  const ctx = ctxOf(c);
  ctx.save();
  draw(ctx, layer, { x, y, w, h });
  ctx.restore();
  const after = copyRect(c, x, y, w, h);
  bump(c);
  app.commit(label, state, { patches: [{ canvas: c, x, y, before, after }] });
  return true;
}

// ——— Pinceau ———
const stampCache = new Map();
export function makeStamp(size, hardness, color) {
  const d = Math.max(1, Math.ceil(size));
  const key = `${d}|${hardness}|${color}`;
  if (stampCache.has(key)) return stampCache.get(key);
  const c = newCanvas(d, d);
  const ctx = ctxOf(c);
  const r = d / 2;
  const [R, G, B] = hexToRgb(color);
  if (hardness >= 0.99 || d <= 2) {
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(r, r, r, 0, Math.PI * 2); ctx.fill();
  } else {
    const g = ctx.createRadialGradient(r, r, 0, r, r, r);
    const h = clamp(hardness, 0, 0.98);
    g.addColorStop(0, `rgba(${R},${G},${B},1)`);
    if (h > 0) g.addColorStop(h, `rgba(${R},${G},${B},1)`);
    for (let k = 1; k <= 8; k++) {
      const t = k / 8, s = t * t * (3 - 2 * t);
      g.addColorStop(h + (1 - h) * t, `rgba(${R},${G},${B},${(1 - s).toFixed(3)})`);
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, d, d);
  }
  if (stampCache.size > 24) { const k0 = stampCache.keys().next().value; freeCanvas(stampCache.get(k0)); stampCache.delete(k0); }
  stampCache.set(key, c);
  return c;
}

/**
 * Un trait de pinceau ou de gomme. On peint dans une toile tampon (le « flux »
 * s'y accumule), affichée par-dessus le calque avec l'« opacité » du trait,
 * puis fusionnée dans le calque au lâcher.
 */
export class Stroke {
  constructor(app, prepared, o) {
    this.app = app;
    this.doc = app.doc;
    this.state = prepared.state;
    this.L = prepared.layer;
    this.o = o;
    const c = this.L.canvas;
    this.buf = newCanvas(c.width, c.height);
    this.bctx = ctxOf(this.buf);
    this.stamp = makeStamp(o.size, o.hardness, o.erase ? '#000000' : o.color);
    this.last = null;
    this.carry = 0;
    this.bounds = null;
    this.frame = null;
    if (this.state !== this.doc.committed) this.doc.setPreview(this.state);
    this.live = { layerId: this.L.id, buf: this.buf, op: o.erase ? 'destination-out' : 'source-over', alpha: o.opacity, dirty: null };
    this.doc.setLive(this.live);
  }

  _grow(r) {
    const u = (a, b) => a ? unionRect(a, b) : { ...b };
    this.bounds = u(this.bounds, r);
    this.frame = u(this.frame, r);
  }

  dab(x, y, p) {
    const o = this.o;
    const s = Math.max(0.5, o.size * (o.pSize ? clamp(p, 0.04, 1) : 1));
    const a = o.flow * (o.pOpacity ? clamp(p, 0.02, 1) : 1);
    this.bctx.globalAlpha = a;
    this.bctx.drawImage(this.stamp, x - s / 2, y - s / 2, s, s);
    this._grow({ x: Math.floor(x - s / 2) - 1, y: Math.floor(y - s / 2) - 1, w: Math.ceil(s) + 3, h: Math.ceil(s) + 3 });
  }

  /** Ajoute un point (coordonnées du document, pression 0..1). */
  point(px, py, pressure = 1) {
    const x = px - this.L.x, y = py - this.L.y;
    const p = pressure;
    if (!this.last) { this.dab(x, y, p); this.last = { x, y, p }; this.carry = 0; return; }
    const L = this.last;
    const dx = x - L.x, dy = y - L.y, d = Math.hypot(dx, dy);
    const spacing = Math.max(0.5, this.o.size * (this.o.pSize ? clamp(Math.min(p, L.p), 0.04, 1) : 1) * 0.1);
    let t = spacing - this.carry;
    while (t <= d) {
      const k = d ? t / d : 0;
      this.dab(L.x + dx * k, L.y + dy * k, L.p + (p - L.p) * k);
      t += spacing;
    }
    this.carry = d - (t - spacing);
    this.last = { x, y, p };
  }

  /** Signale au document la zone à redessiner depuis la dernière image. */
  flush() {
    const f = this.frame;
    if (!f) return;
    this.frame = null;
    const lv = this.live;
    lv.dirty = lv.dirty ? unionRect(lv.dirty, f) : f;
    this.doc.invalidateRect({ x: f.x + this.L.x, y: f.y + this.L.y, w: f.w, h: f.h });
  }

  end(label) {
    const doc = this.doc;
    if (doc.live !== this.live) { freeCanvas(this.buf); return; } // annulé entre-temps
    const b = this.bounds;
    const buf = this.buf, o = this.o;
    if (!b) { doc.cancelPreview(); freeCanvas(buf); return; }
    commitPixels(this.app, label, this.L.id, { x: b.x + this.L.x, y: b.y + this.L.y, w: b.w, h: b.h }, (ctx, layer, r) => {
      ctx.globalAlpha = o.opacity;
      ctx.globalCompositeOperation = o.erase ? 'destination-out' : 'source-over';
      ctx.drawImage(buf, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
    }, { state: this.state, layer: this.L });
    freeCanvas(buf);
  }

  cancel() { this.doc.cancelPreview(); freeCanvas(this.buf); }
}

// ——— Pipette ———
export function sampleColor(canvas, x, y, size = 1) {
  const k = Math.floor(size / 2);
  const sx = Math.floor(x) - k, sy = Math.floor(y) - k;
  if (sx + size <= 0 || sy + size <= 0 || sx >= canvas.width || sy >= canvas.height) return null;
  const x0 = Math.max(0, sx), y0 = Math.max(0, sy);
  const w = Math.min(canvas.width, sx + size) - x0, h = Math.min(canvas.height, sy + size) - y0;
  const d = ctxOf(canvas).getImageData(x0, y0, w, h).data;
  let r = 0, g = 0, b = 0, a = 0;
  for (let i = 0; i < d.length; i += 4) { const al = d[i + 3]; r += d[i] * al; g += d[i + 1] * al; b += d[i + 2] * al; a += al; }
  if (!a) return null;
  return rgbToHex(r / a, g / a, b / a);
}

// ——— Pot de peinture ———
/** Zone à remplir à partir du point (sx, sy) : masque + rectangle englobant. */
export function floodRegion(img, sx, sy, tol, contiguous) {
  const { width: W, height: H, data } = img;
  const mask = new Uint8Array(W * H);
  const i0 = (sy * W + sx) * 4;
  const tr = data[i0], tg = data[i0 + 1], tb = data[i0 + 2], ta = data[i0 + 3];
  const match = (p) => {
    const i = p * 4;
    if (ta === 0 && data[i + 3] <= tol) return true;
    return Math.abs(data[i] - tr) <= tol && Math.abs(data[i + 1] - tg) <= tol && Math.abs(data[i + 2] - tb) <= tol && Math.abs(data[i + 3] - ta) <= tol;
  };
  let minX = W, minY = H, maxX = -1, maxY = -1;
  const mark = (p) => {
    mask[p] = 1;
    const x = p % W, y = (p / W) | 0;
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  };
  if (!contiguous) {
    for (let p = 0; p < W * H; p++) if (match(p)) mark(p);
  } else {
    const stack = [sx, sy];
    while (stack.length) {
      const y = stack.pop(), x0 = stack.pop();
      let x = x0;
      let p = y * W + x;
      while (x >= 0 && !mask[p] && match(p)) { x--; p--; }
      x++; p++;
      let up = false, down = false;
      while (x < W && !mask[p] && match(p)) {
        mark(p);
        if (y > 0) {
          const q = p - W;
          if (!mask[q] && match(q)) { if (!up) { stack.push(x, y - 1); up = true; } } else up = false;
        }
        if (y < H - 1) {
          const q = p + W;
          if (!mask[q] && match(q)) { if (!down) { stack.push(x, y + 1); down = true; } } else down = false;
        }
        x++; p++;
      }
    }
  }
  if (maxX < 0) return null;
  return { mask, W, H, rect: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } };
}

export function maskToCanvas(region, color) {
  const { mask, W, rect } = region;
  const c = newCanvas(rect.w, rect.h);
  const ctx = ctxOf(c);
  const img = ctx.createImageData(rect.w, rect.h);
  const d = img.data;
  const [R, G, B] = hexToRgb(color);
  for (let y = 0; y < rect.h; y++) {
    let p = (rect.y + y) * W + rect.x, i = y * rect.w * 4;
    for (let x = 0; x < rect.w; x++, p++, i += 4) {
      if (mask[p]) { d[i] = R; d[i + 1] = G; d[i + 2] = B; d[i + 3] = 255; }
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// ——— Dégradé ———
export function drawGradient(ctx, w, h, a, b, o) {
  const c0 = o.reverse ? o.c1 : o.c0, c1 = o.reverse ? o.c0 : o.c1;
  let g;
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  if (o.type === 'radial') {
    g = ctx.createRadialGradient(a.x, a.y, 0, a.x, a.y, len);
    g.addColorStop(0, c0); g.addColorStop(1, c1);
  } else if (o.type === 'reflected') {
    g = ctx.createLinearGradient(2 * a.x - b.x, 2 * a.y - b.y, b.x, b.y);
    g.addColorStop(0, c1); g.addColorStop(0.5, c0); g.addColorStop(1, c1);
  } else {
    g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
    g.addColorStop(0, c0); g.addColorStop(1, c1);
  }
  ctx.save();
  ctx.globalAlpha = o.opacity;
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

// ——— Texte ———
export const FONTS = [
  { id: 'system', label: 'Sans empattement (système)', css: 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif' },
  { id: 'serif', label: 'Avec empattement (système)', css: 'Georgia, "Times New Roman", serif' },
  { id: 'mono', label: 'Machine à écrire', css: 'ui-monospace, Menlo, Consolas, "Courier New", monospace' },
  { id: 'Cormorant Garamond', label: 'Cormorant Garamond', google: true },
  { id: 'Playfair Display', label: 'Playfair Display', google: true },
  { id: 'Cinzel', label: 'Cinzel', google: true },
  { id: 'UnifrakturMaguntia', label: 'Gothique (Unifraktur)', google: true, noBold: true },
  { id: 'Montserrat', label: 'Montserrat', google: true },
  { id: 'Roboto', label: 'Roboto', google: true },
  { id: 'Oswald', label: 'Oswald', google: true },
  { id: 'Bebas Neue', label: 'Bebas Neue', google: true, noBold: true },
  { id: 'Lobster', label: 'Lobster', google: true, noBold: true },
  { id: 'Pacifico', label: 'Pacifico', google: true, noBold: true },
  { id: 'Caveat', label: 'Caveat (manuscrit)', google: true },
  { id: 'Permanent Marker', label: 'Feutre', google: true, noBold: true },
];
const fontById = (id) => FONTS.find(f => f.id === id) || FONTS[0];
const fontCss = (f) => f.css || `"${f.id}", system-ui, sans-serif`;

let fontsLinked = false;
function linkGoogleFonts() {
  if (fontsLinked) return;
  fontsLinked = true;
  const fam = FONTS.filter(f => f.google).map(f => `family=${encodeURIComponent(f.id).replace(/%20/g, '+')}${f.noBold ? '' : ':ital,wght@0,400;0,700;1,400;1,700'}`).join('&');
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = `https://fonts.googleapis.com/css2?${fam}&display=swap`;
  document.head.append(l);
}

export const fontString = (t, size = t.size) => `${t.italic ? 'italic ' : ''}${t.bold ? 700 : 400} ${size}px ${fontCss(fontById(t.font))}`;

/** Charge la police si besoin (sans connexion : police de secours). */
export async function ensureFont(t) {
  const f = fontById(t.font);
  if (!f.google) return;
  linkGoogleFonts();
  try {
    await Promise.race([document.fonts.load(fontString(t, 32), t.content || 'Aa'), new Promise(r => setTimeout(r, 2500))]);
  } catch {}
}

/** Fabrique l'image d'un calque de texte. t.x, t.y = point d'ancrage (haut de la première ligne). */
export function renderText(t) {
  const lines = (t.content || '').split('\n');
  const probe = ctxOf(newCanvas(1, 1));
  probe.font = fontString(t);
  const widths = lines.map(l => probe.measureText(l).width);
  const maxW = Math.max(1, ...widths);
  const lh = t.size * (t.lineHeight || 1.2);
  const pad = Math.ceil(t.size * 0.35);
  const W = Math.ceil(maxW + pad * 2), H = Math.ceil(lh * lines.length + pad * 2);
  const c = newCanvas(W, H);
  const ctx = ctxOf(c);
  ctx.font = fontString(t);
  ctx.fillStyle = t.color;
  ctx.textBaseline = 'middle';
  ctx.textAlign = t.align;
  const ax = t.align === 'center' ? pad + maxW / 2 : t.align === 'right' ? pad + maxW : pad;
  lines.forEach((l, i) => ctx.fillText(l, ax, pad + lh * i + lh / 2));
  const ox = t.align === 'center' ? maxW / 2 : t.align === 'right' ? maxW : 0;
  return { canvas: c, x: Math.round(t.x - ox - pad), y: Math.round(t.y - pad) };
}

// ——— Formes ———
/** s = { type, x0, y0, x1, y1, fill, fillColor, stroke, strokeColor, strokeWidth, radius } en coordonnées du document. */
export function renderShape(s) {
  const sw = s.stroke || s.type === 'line' ? Math.max(1, s.strokeWidth) : 0;
  const pad = Math.ceil(sw / 2) + 2;
  const minX = Math.min(s.x0, s.x1), minY = Math.min(s.y0, s.y1);
  const w = Math.abs(s.x1 - s.x0), h = Math.abs(s.y1 - s.y0);
  const c = newCanvas(Math.ceil(w) + pad * 2, Math.ceil(h) + pad * 2);
  const ctx = ctxOf(c);
  ctx.translate(pad - minX, pad - minY);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  if (s.type === 'line') {
    ctx.moveTo(s.x0, s.y0); ctx.lineTo(s.x1, s.y1);
    ctx.strokeStyle = s.fillColor; ctx.lineWidth = sw; ctx.stroke();
  } else {
    if (s.type === 'ellipse') ctx.ellipse(minX + w / 2, minY + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    else if (s.type === 'rounded') ctx.roundRect(minX, minY, w, h, Math.min(s.radius, w / 2, h / 2));
    else ctx.rect(minX, minY, w, h);
    if (s.fill) { ctx.fillStyle = s.fillColor; ctx.fill(); }
    if (s.stroke && sw) { ctx.strokeStyle = s.strokeColor; ctx.lineWidth = sw; ctx.stroke(); }
  }
  return { canvas: c, x: Math.floor(minX) - pad, y: Math.floor(minY) - pad };
}

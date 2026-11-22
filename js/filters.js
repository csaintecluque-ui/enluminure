// Enluminure — filtres : flous, accentuation, bruit, réduction du bruit, mosaïque, vignettage
import { el, clamp, newCanvas, ctxOf } from './util.js';
import { glRun } from './gl.js';

const GAUSS = `uniform vec2 u_dir; uniform float u_sigma; uniform float u_n;
void main() {
  vec4 acc = vec4(0.0); float ws = 0.0;
  for (int i = -72; i <= 72; i++) {
    float fi = float(i);
    if (abs(fi) > u_n) continue;
    float w = exp(-0.5 * fi * fi / (u_sigma * u_sigma));
    vec4 c = texture2D(u_tex, v + u_dir * fi / u_size);
    acc += vec4(c.rgb * c.a, c.a) * w; ws += w;
  }
  acc /= ws;
  gl_FragColor = acc.a > 0.0001 ? vec4(acc.rgb / acc.a, acc.a) : vec4(0.0);
}`;
const gaussPasses = (sigma) => {
  const n = Math.min(72, Math.ceil(sigma * 3));
  return { passes: [{ frag: GAUSS, uniforms: { u_dir: [1, 0], u_sigma: sigma, u_n: n } }, { frag: GAUSS, uniforms: { u_dir: [0, 1], u_sigma: sigma, u_n: n } }], pad: n };
};

/** Flou gaussien d'une zone ; au-delà d'un rayon de 24 px on travaille sur une version réduite (même rendu, bien plus rapide). */
export function gaussian(src, rect, sigma) {
  if (sigma < 0.3) return glRun(src, rect, [{ frag: 'void main(){ gl_FragColor = texture2D(u_tex, v); }' }]);
  if (sigma <= 24) { const g = gaussPasses(sigma); return glRun(src, rect, g.passes, g.pad); }
  const f = sigma / 24;
  const pad = Math.ceil(sigma * 3);
  const x0 = Math.max(0, rect.x - pad), y0 = Math.max(0, rect.y - pad);
  const x1 = Math.min(src.width, rect.x + rect.w + pad), y1 = Math.min(src.height, rect.y + rect.h + pad);
  const sw = Math.max(1, Math.round((x1 - x0) / f)), sh = Math.max(1, Math.round((y1 - y0) / f));
  const small = newCanvas(sw, sh);
  const sctx = ctxOf(small);
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(src, x0, y0, x1 - x0, y1 - y0, 0, 0, sw, sh);
  const g = gaussPasses(24);
  const b = glRun(small, null, g.passes, g.pad);
  const out = newCanvas(rect.w, rect.h);
  const o = ctxOf(out);
  o.imageSmoothingQuality = 'high';
  o.drawImage(b, 0, 0, sw, sh, x0 - rect.x, y0 - rect.y, x1 - x0, y1 - y0);
  small.width = 0;
  return out;
}

function sl(label, value, min, max, step, onChange, unit = '') {
  const r = el('input', { type: 'range', min, max, step, value });
  const n = el('input', { type: 'number', min, max, step, value, class: 'adj-num', inputmode: 'decimal' });
  const set = (v, src) => { v = clamp(+v, min, max); if (Number.isNaN(v)) return; if (src !== 'n') n.value = v; if (src !== 'r') r.value = v; onChange(v); };
  r.addEventListener('input', () => set(r.value, 'r'));
  n.addEventListener('change', () => set(String(n.value).replace(',', '.'), 'n'));
  n.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); n.blur(); } });
  return el('div', { class: 'adj-row' }, el('span', { class: 'adj-label' }, label), r, n, unit ? el('span', { class: 'adj-unit' }, unit) : null);
}
const ck = (label, value, onChange) => { const i = el('input', { type: 'checkbox', checked: value }); i.addEventListener('change', () => onChange(i.checked)); return el('label', { class: 'opt adj-check' }, i, label); };

export const FILTERS = {
  gaussian: {
    label: 'Flou gaussien', group: 'Flou', defaults: () => ({ radius: 4 }),
    run: (src, r, p) => gaussian(src, r, p.radius),
    ui: (p, set) => el('div', { class: 'form' }, sl('Rayon', p.radius, 0.1, 250, 0.1, v => { p.radius = v; set(); }, 'px')),
  },
  motion: {
    label: 'Flou directionnel', group: 'Flou', defaults: () => ({ angle: 0, distance: 20 }),
    run: (src, r, p) => {
      const a = p.angle * Math.PI / 180;
      return glRun(src, r, [{ frag: `uniform vec2 u_d;
void main() {
  vec4 acc = vec4(0.0);
  for (int i = 0; i <= 64; i++) { float t = float(i) / 64.0 - 0.5; vec4 c = texture2D(u_tex, v + u_d * t / u_size); acc += vec4(c.rgb * c.a, c.a); }
  acc /= 65.0;
  gl_FragColor = acc.a > 0.0001 ? vec4(acc.rgb / acc.a, acc.a) : vec4(0.0);
}`, uniforms: { u_d: [Math.cos(a) * p.distance, Math.sin(a) * p.distance] } }], Math.ceil(p.distance / 2) + 1);
    },
    ui: (p, set) => el('div', { class: 'form' }, sl('Angle', p.angle, -180, 180, 1, v => { p.angle = v; set(); }, '°'), sl('Distance', p.distance, 1, 400, 1, v => { p.distance = v; set(); }, 'px')),
  },
  unsharp: {
    label: 'Accentuation', group: 'Renforcement', defaults: () => ({ amount: 100, radius: 1.5, threshold: 0 }),
    run: (src, r, p) => {
      const g = gaussPasses(Math.min(24, Math.max(0.3, p.radius)));
      return glRun(src, r, [...g.passes, { frag: `uniform float u_amount; uniform float u_threshold;
void main() {
  vec4 o = texture2D(u_orig, v); vec4 b = texture2D(u_tex, v);
  vec3 d = o.rgb - b.rgb; float m = max(abs(d.r), max(abs(d.g), abs(d.b))) * 255.0;
  gl_FragColor = vec4(clamp(m < u_threshold ? o.rgb : o.rgb + d * u_amount, 0.0, 1.0), o.a);
}`, uniforms: { u_amount: p.amount / 100, u_threshold: p.threshold } }], g.pad);
    },
    ui: (p, set) => el('div', { class: 'form' },
      sl('Gain', p.amount, 1, 500, 1, v => { p.amount = v; set(); }, '%'),
      sl('Rayon', p.radius, 0.1, 24, 0.1, v => { p.radius = v; set(); }, 'px'),
      sl('Seuil', p.threshold, 0, 255, 1, v => { p.threshold = v; set(); })),
  },
  noise: {
    label: 'Ajout de bruit', group: 'Bruit', defaults: () => ({ amount: 10, gauss: true, mono: true, seed: Math.random() * 100 }),
    run: (src, r, p) => glRun(src, r, [{ frag: `uniform float u_amount; uniform float u_gauss; uniform float u_mono; uniform float u_seed;
float hash(vec2 q) { q = fract(q * vec2(0.1031, 0.1030) + u_seed); q += dot(q, q.yx + 33.33); return fract((q.x + q.y) * q.x); }
float rnd(vec2 q, float k) { float a = max(hash(q + k), 1e-6), b = hash(q + k + 71.7); return u_gauss > 0.5 ? sqrt(-2.0 * log(a)) * cos(6.2831853 * b) * 0.35 : a - 0.5; }
void main() {
  vec4 c = texture2D(u_tex, v); vec2 q = pixelPos();
  vec3 n = u_mono > 0.5 ? vec3(rnd(q, 0.0)) : vec3(rnd(q, 0.0), rnd(q, 13.1), rnd(q, 27.7));
  gl_FragColor = vec4(clamp(c.rgb + n * u_amount, 0.0, 1.0), c.a);
}`, uniforms: { u_amount: p.amount / 100, u_gauss: p.gauss, u_mono: p.mono, u_seed: p.seed } }]),
    ui: (p, set) => el('div', { class: 'form' },
      sl('Quantité', p.amount, 0, 100, 0.5, v => { p.amount = v; set(); }, '%'),
      ck('Gaussienne (sinon uniforme)', p.gauss, v => { p.gauss = v; set(); }),
      ck('Monochromatique', p.mono, v => { p.mono = v; set(); })),
  },
  denoise: {
    label: 'Réduction du bruit', group: 'Bruit', defaults: () => ({ strength: 40, radius: 3 }),
    run: (src, r, p) => glRun(src, r, [{ frag: `uniform float u_sr; uniform float u_ss; uniform float u_r;
void main() {
  vec4 c0 = texture2D(u_tex, v); vec3 acc = vec3(0.0); float ws = 0.0;
  for (int y = -6; y <= 6; y++) for (int x = -6; x <= 6; x++) {
    if (abs(float(x)) > u_r || abs(float(y)) > u_r) continue;
    vec4 c = texture2D(u_tex, v + vec2(float(x), float(y)) / u_size);
    vec3 dc = c.rgb - c0.rgb;
    float w = exp(-float(x * x + y * y) / (2.0 * u_ss * u_ss) - dot(dc, dc) / (2.0 * u_sr * u_sr)) * c.a;
    acc += c.rgb * w; ws += w;
  }
  gl_FragColor = vec4(ws > 0.0 ? acc / ws : c0.rgb, c0.a);
}`, uniforms: { u_sr: 0.02 + p.strength / 100 * 0.25, u_ss: Math.max(0.5, p.radius / 1.5), u_r: p.radius } }], 7),
    ui: (p, set) => el('div', { class: 'form' },
      sl('Intensité', p.strength, 0, 100, 1, v => { p.strength = v; set(); }),
      sl('Rayon', p.radius, 1, 6, 1, v => { p.radius = v; set(); }, 'px')),
  },
  pixelate: {
    label: 'Mosaïque', group: 'Pixellisation', defaults: () => ({ cell: 16 }),
    run: (src, r, p) => glRun(src, r, [{ frag: `uniform float u_cell;
void main() {
  vec2 pp = pixelPos();
  vec2 cc = (floor(pp / u_cell) + 0.5) * u_cell - u_origin;
  gl_FragColor = texture2D(u_tex, clamp(vec2(cc.x, u_size.y - cc.y) / u_size, 0.0, 1.0));
}`, uniforms: { u_cell: p.cell } }], Math.ceil(p.cell)),
    ui: (p, set) => el('div', { class: 'form' }, sl('Taille des cellules', p.cell, 2, 200, 1, v => { p.cell = v; set(); }, 'px')),
  },
  vignette: {
    label: 'Vignettage', group: 'Rendu', defaults: () => ({ amount: -50, size: 40, softness: 60 }),
    run: (src, r, p) => glRun(src, r, [{ frag: `uniform float u_amount; uniform float u_in; uniform float u_soft;
void main() {
  vec4 c = texture2D(u_tex, v);
  vec2 q = (pixelPos() / u_full - 0.5) * 2.0;
  float t = smoothstep(u_in, u_in + u_soft, length(q));
  vec3 col = u_amount < 0.0 ? c.rgb * (1.0 + u_amount * t) : mix(c.rgb, vec3(1.0), u_amount * t);
  gl_FragColor = vec4(col, c.a);
}`, uniforms: { u_amount: p.amount / 100, u_in: 0.2 + p.size / 100, u_soft: 0.05 + p.softness / 100 * 1.2 } }]),
    ui: (p, set) => el('div', { class: 'form' },
      sl('Intensité', p.amount, -100, 100, 1, v => { p.amount = v; set(); }),
      sl('Taille', p.size, 0, 100, 1, v => { p.size = v; set(); }),
      sl('Douceur', p.softness, 0, 100, 1, v => { p.softness = v; set(); })),
  },
};
export const FILTER_ORDER = ['gaussian', 'motion', 'unsharp', 'noise', 'denoise', 'pixelate', 'vignette'];

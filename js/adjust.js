// Enluminure — réglages (niveaux, courbes, teinte/saturation…) : calculs (carte graphique) et fenêtres
import { el, clamp, newCanvas, ctxOf } from './util.js';
import { glRun } from './gl.js';

const hexToRgb = (hex) => { const h = hex.replace('#', ''); const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const rgbToHex = (r, g, b) => `#${[r, g, b].map(x => clamp(Math.round(x), 0, 255).toString(16).padStart(2, '0')).join('')}`;

// ——— Tables de correspondance (LUT) ———
const ident = () => Array.from({ length: 256 }, (_, i) => i);
function lutTex(r, g = r, b = r) {
  const t = new Uint8Array(1024);
  for (let i = 0; i < 256; i++) { t[i * 4] = clamp(Math.round(r[i]), 0, 255); t[i * 4 + 1] = clamp(Math.round(g[i]), 0, 255); t[i * 4 + 2] = clamp(Math.round(b[i]), 0, 255); t[i * 4 + 3] = 255; }
  return t;
}
const LUT_FRAG = `void main() {
  vec4 c = texture2D(u_tex, v);
  float k = 255.0 / 256.0, o = 0.5 / 256.0;
  gl_FragColor = vec4(texture2D(u_lut, vec2(c.r * k + o, 0.5)).r, texture2D(u_lut, vec2(c.g * k + o, 0.5)).g, texture2D(u_lut, vec2(c.b * k + o, 0.5)).b, c.a);
}`;

export const defLevel = () => ({ inLo: 0, inHi: 255, gamma: 1, outLo: 0, outHi: 255 });
export function levelLUT(l) {
  const out = new Array(256);
  const span = Math.max(1, l.inHi - l.inLo);
  for (let i = 0; i < 256; i++) {
    let x = clamp((i - l.inLo) / span, 0, 1);
    x = Math.pow(x, 1 / Math.max(0.01, l.gamma));
    out[i] = l.outLo + x * (l.outHi - l.outLo);
  }
  return out;
}
const compose = (outer, inner) => inner.map(v => outer[clamp(Math.round(v), 0, 255)]);

/** Courbe monotone (sans dépassement) passant par les points [[entrée, sortie], …]. */
export function curveLUT(pts) {
  const p = [...pts].sort((a, b) => a[0] - b[0]);
  const n = p.length;
  if (n < 2) return ident();
  const xs = p.map(q => q[0]), ys = p.map(q => q[1]);
  const d = [], m = new Array(n);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-6, xs[i + 1] - xs[i]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  const out = new Array(256);
  let k = 0;
  for (let x = 0; x < 256; x++) {
    if (x <= xs[0]) { out[x] = ys[0]; continue; }
    if (x >= xs[n - 1]) { out[x] = ys[n - 1]; continue; }
    while (k < n - 2 && x > xs[k + 1]) k++;
    const h = xs[k + 1] - xs[k], t = (x - xs[k]) / h, t2 = t * t, t3 = t2 * t;
    out[x] = (2 * t3 - 3 * t2 + 1) * ys[k] + (t3 - 2 * t2 + t) * h * m[k] + (-2 * t3 + 3 * t2) * ys[k + 1] + (t3 - t2) * h * m[k + 1];
  }
  return out;
}
const s2l = (x) => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
const l2s = (x) => (x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);

// ——— Couleurs PSD ———
function lab2rgb(L, a, b) {
  let y = (L + 16) / 116, x = a / 500 + y, z = y - b / 200;
  const f = (t) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  x = 0.95047 * f(x); y = f(y); z = 1.08883 * f(z);
  const r = 3.2406 * x - 1.5372 * y - 0.4986 * z, g = -0.9689 * x + 1.8758 * y + 0.0415 * z, bl = 0.0557 * x - 0.204 * y + 1.057 * z;
  return [r, g, bl].map(c => clamp(l2s(c), 0, 1) * 255);
}
export function colorToHex(c) {
  if (!c) return '#808080';
  if ('r' in c) return rgbToHex(c.r, c.g, c.b);
  if ('fr' in c) return rgbToHex(c.fr * 255, c.fg * 255, c.fb * 255);
  if ('l' in c && 'a' in c) return rgbToHex(...lab2rgb(c.l, c.a, c.b));
  if ('h' in c) { const h = c.h / 360, s = c.s / 100, v = c.b / 100; const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s); const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6]; return rgbToHex(r * 255, g * 255, b * 255); }
  if ('k' in c && !('c' in c)) return rgbToHex(255 - c.k * 2.55, 255 - c.k * 2.55, 255 - c.k * 2.55);
  return '#808080';
}
const hexToPsd = (h) => { const [r, g, b] = hexToRgb(h); return { r, g, b }; };
const vec3 = (h) => hexToRgb(h).map(x => x / 255);

// ——— Petits contrôles des fenêtres ———
function slider(label, value, min, max, step, onChange, unit = '') {
  const r = el('input', { type: 'range', min, max, step, value });
  const n = el('input', { type: 'number', min, max, step, value, class: 'adj-num', inputmode: 'decimal' });
  const set = (v, src) => { v = clamp(+v, min, max); if (Number.isNaN(v)) return; if (src !== 'n') n.value = v; if (src !== 'r') r.value = v; onChange(v); };
  r.addEventListener('input', () => set(r.value, 'r'));
  n.addEventListener('change', () => set(String(n.value).replace(',', '.'), 'n'));
  n.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); n.blur(); } });
  const w = el('div', { class: 'adj-row' }, el('span', { class: 'adj-label' }, label), r, n, unit ? el('span', { class: 'adj-unit' }, unit) : null);
  w.set = (v) => { n.value = v; r.value = v; };
  return w;
}
const check = (label, value, onChange) => { const i = el('input', { type: 'checkbox', checked: value }); i.addEventListener('change', () => onChange(i.checked)); return el('label', { class: 'opt adj-check' }, i, label); };
const colorIn = (label, value, onChange) => { const i = el('input', { type: 'color', value }); i.addEventListener('input', () => onChange(i.value)); return el('label', { class: 'adj-row' }, el('span', { class: 'adj-label' }, label), i); };
function select(label, value, options, onChange) {
  const s = el('select', {}, options.map(([v, l]) => el('option', { value: v }, l)));
  s.value = value; s.addEventListener('change', () => onChange(s.value));
  return el('label', { class: 'adj-row' }, label ? el('span', { class: 'adj-label' }, label) : null, s);
}

// ——— Histogramme ———
export function histogram(canvas) {
  const w = canvas.width, h = canvas.height;
  const step = Math.max(1, Math.ceil(Math.sqrt((w * h) / 1_000_000)));
  let src = canvas, sw = w, sh = h;
  if (step > 1) { sw = Math.max(1, Math.round(w / step)); sh = Math.max(1, Math.round(h / step)); src = newCanvas(sw, sh); ctxOf(src).drawImage(canvas, 0, 0, sw, sh); }
  const d = ctxOf(src).getImageData(0, 0, sw, sh).data;
  const H = { r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256), l: new Uint32Array(256), n: 0 };
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 8) continue;
    H.r[d[i]]++; H.g[d[i + 1]]++; H.b[d[i + 2]]++; H.l[Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2])]++; H.n++;
  }
  if (src !== canvas) src.width = 0;
  return H;
}
function drawHisto(ctx, arr, w, h, color) {
  let mx = 0;
  for (let i = 1; i < 255; i++) mx = Math.max(mx, arr[i]);
  if (!mx) return;
  ctx.fillStyle = color;
  for (let i = 0; i < 256; i++) {
    const v = Math.min(1, arr[i] / mx);
    ctx.fillRect(i * w / 256, h - v * h, w / 256 + 0.5, v * h);
  }
}
/** Bornes à 0,1 % pour les réglages automatiques. */
export function autoBounds(arr, n, clip = 0.001) {
  let lo = 0, hi = 255, acc = 0;
  for (; lo < 255; lo++) { acc += arr[lo]; if (acc > n * clip) break; }
  acc = 0;
  for (; hi > 0; hi--) { acc += arr[hi]; if (acc > n * clip) break; }
  if (hi <= lo) { lo = 0; hi = 255; }
  return [lo, hi];
}
const CH = [['rgb', 'RVB'], ['r', 'Rouge'], ['g', 'Vert'], ['b', 'Bleu']];
const CH_COLOR = { rgb: 'rgba(234,217,184,.45)', r: 'rgba(230,80,70,.55)', g: 'rgba(90,200,110,.55)', b: 'rgba(90,130,240,.6)' };
const histOf = (H, ch) => (H ? (ch === 'rgb' ? H.l : H[ch]) : null);

// ——— Éditeur de courbes ———
function curvesEditor(p, set, ctx) {
  let ch = 'rgb';
  const size = 256;
  const cv = el('canvas', { class: 'curves', width: size * 2, height: size * 2 });
  const info = el('span', { class: 'muted small' }, 'Cliquez pour ajouter un point, glissez-le hors du cadre pour le retirer.');
  const draw = () => {
    const g = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#161110'; g.fillRect(0, 0, W, H);
    const hist = histOf(ctx.histo, ch);
    if (hist) drawHisto(g, hist, W, H, 'rgba(234,217,184,.18)');
    g.strokeStyle = 'rgba(234,217,184,.12)'; g.lineWidth = 1;
    for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo(i * W / 4, 0); g.lineTo(i * W / 4, H); g.moveTo(0, i * H / 4); g.lineTo(W, i * H / 4); g.stroke(); }
    g.beginPath(); g.moveTo(0, H); g.lineTo(W, 0); g.stroke();
    // autres canaux en léger
    for (const [c] of CH) {
      if (c === ch) continue;
      const pts = p.channels[c];
      if (pts.length === 2 && pts[0][0] === 0 && pts[0][1] === 0 && pts[1][0] === 255 && pts[1][1] === 255) continue;
      const L = curveLUT(pts);
      g.strokeStyle = CH_COLOR[c]; g.lineWidth = 1.5; g.beginPath();
      L.forEach((y, x) => (x ? g.lineTo(x * W / 255, H - y * H / 255) : g.moveTo(0, H - y * H / 255)));
      g.stroke();
    }
    const L = curveLUT(p.channels[ch]);
    g.strokeStyle = ch === 'rgb' ? '#EAD9B8' : CH_COLOR[ch].replace(/[\d.]+\)$/, '1)'); g.lineWidth = 3; g.beginPath();
    L.forEach((y, x) => (x ? g.lineTo(x * W / 255, H - clamp(y, 0, 255) * H / 255) : g.moveTo(0, H - y * H / 255)));
    g.stroke();
    for (const [x, y] of p.channels[ch]) {
      g.beginPath(); g.arc(x * W / 255, H - y * H / 255, 9, 0, Math.PI * 2);
      g.fillStyle = '#C9804F'; g.fill(); g.strokeStyle = '#1B1512'; g.lineWidth = 2; g.stroke();
    }
  };
  const toVal = (e) => { const r = cv.getBoundingClientRect(); return [clamp(Math.round((e.clientX - r.left) / r.width * 255), 0, 255), clamp(Math.round((1 - (e.clientY - r.top) / r.height) * 255), 0, 255), (e.clientY - r.top) / r.height]; };
  let drag = -1;
  cv.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    cv.setPointerCapture(e.pointerId);
    const pts = p.channels[ch];
    const r = cv.getBoundingClientRect();
    const [x, y] = toVal(e);
    const tol = (e.pointerType === 'touch' ? 22 : 12) / r.width * 255;
    drag = pts.findIndex(q => Math.hypot(q[0] - x, q[1] - y) <= tol);
    if (drag < 0) { pts.push([x, y]); pts.sort((a, b) => a[0] - b[0]); drag = pts.findIndex(q => q[0] === x && q[1] === y); set(); }
    draw();
  });
  cv.addEventListener('pointermove', (e) => {
    if (drag < 0) return;
    const pts = p.channels[ch];
    let [x, y, fy] = toVal(e);
    const out = (fy < -0.08 || fy > 1.08) && pts.length > 2 && drag > 0 && drag < pts.length - 1;
    if (out) { pts.splice(drag, 1); drag = -1; set(); draw(); return; }
    const lo = drag > 0 ? pts[drag - 1][0] + 1 : 0, hi = drag < pts.length - 1 ? pts[drag + 1][0] - 1 : 255;
    pts[drag] = [clamp(x, lo, hi), y];
    info.textContent = `Entrée ${pts[drag][0]} → sortie ${pts[drag][1]}`;
    set(); draw();
  });
  cv.addEventListener('pointerup', () => { drag = -1; });
  const reset = el('button', { type: 'button', class: 'btn small' }, 'Réinitialiser le canal');
  reset.addEventListener('click', () => { p.channels[ch] = [[0, 0], [255, 255]]; set(); draw(); });
  const box = el('div', { class: 'form' },
    select('Canal', ch, CH, v => { ch = v; draw(); }),
    cv, info, reset);
  box.refresh = draw;
  draw();
  return box;
}

// ——— Niveaux ———
function levelsEditor(p, set, ctx) {
  let ch = 'rgb';
  const cv = el('canvas', { class: 'histo', width: 512, height: 180 });
  const drawH = () => {
    const g = cv.getContext('2d');
    g.fillStyle = '#161110'; g.fillRect(0, 0, cv.width, cv.height);
    const h = histOf(ctx.histo, ch);
    if (h) drawHisto(g, h, cv.width, cv.height, CH_COLOR[ch]);
    const l = p.channels[ch];
    g.fillStyle = '#C9804F';
    for (const x of [l.inLo, l.inHi]) g.fillRect(x / 255 * cv.width - 1.5, 0, 3, cv.height);
  };
  const rows = {};
  const make = () => {
    const l = p.channels[ch];
    rows.inLo = slider('Entrée : noirs', l.inLo, 0, 253, 1, v => { l.inLo = Math.min(v, l.inHi - 2); set(); drawH(); });
    rows.gamma = slider('Tons moyens', l.gamma, 0.1, 9.99, 0.01, v => { l.gamma = v; set(); });
    rows.inHi = slider('Entrée : blancs', l.inHi, 2, 255, 1, v => { l.inHi = Math.max(v, l.inLo + 2); set(); drawH(); });
    rows.outLo = slider('Sortie : noirs', l.outLo, 0, 255, 1, v => { l.outLo = v; set(); });
    rows.outHi = slider('Sortie : blancs', l.outHi, 0, 255, 1, v => { l.outHi = v; set(); });
    return Object.values(rows);
  };
  const holder = el('div', { class: 'form' }, make());
  const auto = el('button', { type: 'button', class: 'btn small' }, 'Auto');
  auto.addEventListener('click', () => {
    if (!ctx.histo) return;
    for (const c of ['r', 'g', 'b']) { const [lo, hi] = autoBounds(ctx.histo[c], ctx.histo.n); Object.assign(p.channels[c], { inLo: lo, inHi: hi }); }
    p.channels.rgb = defLevel();
    holder.replaceChildren(...make()); set(); drawH();
  });
  const box = el('div', { class: 'form' },
    el('div', { class: 'row tight' }, select('Canal', ch, CH, v => { ch = v; holder.replaceChildren(...make()); drawH(); }), auto),
    cv, holder);
  drawH();
  return box;
}

// ——— Registre des réglages ———
const BW_PRESETS = {
  def: [40, 60, 40, 60, 20, 80], red: [120, 110, -10, -50, -50, 120], yellow: [120, 110, 40, -30, 0, 70], green: [-20, 40, 120, 60, -20, -30], blue: [-30, 10, 10, 120, 110, 40],
};
const PHOTO_FILTERS = [['#ec8a00', 'Réchauffant (85)'], ['#fa9600', 'Réchauffant (LBA)'], ['#ebb113', 'Réchauffant (81)'], ['#006dff', 'Refroidissant (80)'], ['#005dff', 'Refroidissant (LBB)'], ['#00b5ff', 'Refroidissant (82)'], ['#ac7a33', 'Sépia'], ['#ea1a1a', 'Rouge'], ['#19c919', 'Vert'], ['#1d35ea', 'Bleu']];

export const ADJ = {
  brightness: {
    label: 'Luminosité/Contraste', defaults: () => ({ brightness: 0, contrast: 0 }),
    passes: (p) => {
      const g = Math.pow(2, -p.brightness / 100), k = Math.tan((Math.min(p.contrast, 99) / 100 + 1) * Math.PI / 4);
      const L = ident().map(i => clamp(((Math.pow(i / 255, g) - 0.5) * k + 0.5) * 255, 0, 255));
      return [{ frag: LUT_FRAG, lut: lutTex(L) }];
    },
    ui: (p, set) => el('div', { class: 'form' }, slider('Luminosité', p.brightness, -150, 150, 1, v => { p.brightness = v; set(); }), slider('Contraste', p.contrast, -50, 100, 1, v => { p.contrast = v; set(); })),
    fromPsd: (a) => ({ brightness: a.brightness || 0, contrast: a.contrast || 0 }),
    toPsd: (p) => ({ type: 'brightness/contrast', brightness: p.brightness, contrast: p.contrast, useLegacy: false }),
  },
  levels: {
    label: 'Niveaux', defaults: () => ({ channels: { rgb: defLevel(), r: defLevel(), g: defLevel(), b: defLevel() } }),
    passes: (p) => {
      const m = levelLUT(p.channels.rgb);
      return [{ frag: LUT_FRAG, lut: lutTex(compose(m, levelLUT(p.channels.r)), compose(m, levelLUT(p.channels.g)), compose(m, levelLUT(p.channels.b))) }];
    },
    ui: levelsEditor, histo: true,
    fromPsd: (a) => {
      const p = ADJ.levels.defaults();
      ['rgb', 'r', 'g', 'b'].forEach((k, i) => { const c = a.channels?.[i]; if (c) p.channels[k] = { inLo: c.shadowInput, inHi: c.highlightInput, gamma: c.midtoneInput || 1, outLo: c.shadowOutput, outHi: c.highlightOutput }; });
      return p;
    },
    toPsd: (p) => ({ type: 'levels', channels: ['rgb', 'r', 'g', 'b'].map(k => { const c = p.channels[k]; return { shadowInput: c.inLo, highlightInput: c.inHi, shadowOutput: c.outLo, highlightOutput: c.outHi, midtoneInput: c.gamma }; }) }),
  },
  curves: {
    label: 'Courbes', defaults: () => ({ channels: { rgb: [[0, 0], [255, 255]], r: [[0, 0], [255, 255]], g: [[0, 0], [255, 255]], b: [[0, 0], [255, 255]] } }),
    passes: (p) => {
      const m = curveLUT(p.channels.rgb);
      return [{ frag: LUT_FRAG, lut: lutTex(compose(m, curveLUT(p.channels.r)), compose(m, curveLUT(p.channels.g)), compose(m, curveLUT(p.channels.b))) }];
    },
    ui: curvesEditor, histo: true,
    fromPsd: (a) => {
      const p = ADJ.curves.defaults();
      ['rgb', 'r', 'g', 'b'].forEach((k, i) => {
        const c = a.channels?.[i];
        if (!c || !c.length) return;
        if (typeof c[0] === 'number') { // courbe dessinée au crayon : 256 valeurs
          const pts = []; for (let x = 0; x < 256; x += 16) pts.push([x, c[x]]); pts.push([255, c[255]]);
          p.channels[k] = pts;
        } else p.channels[k] = c.map(q => [q.input, q.output]);
      });
      return p;
    },
    toPsd: (p) => ({ type: 'curves', channels: ['rgb', 'r', 'g', 'b'].map(k => p.channels[k].map(([input, output]) => ({ input, output }))) }),
  },
  exposure: {
    label: 'Exposition', defaults: () => ({ exposure: 0, offset: 0, gamma: 1 }),
    passes: (p) => {
      const L = ident().map(i => { let x = s2l(i / 255) * Math.pow(2, p.exposure) + p.offset; x = Math.pow(Math.max(0, x), 1 / Math.max(0.01, p.gamma)); return clamp(l2s(x), 0, 1) * 255; });
      return [{ frag: LUT_FRAG, lut: lutTex(L) }];
    },
    ui: (p, set) => el('div', { class: 'form' },
      slider('Exposition', p.exposure, -5, 5, 0.01, v => { p.exposure = v; set(); }),
      slider('Décalage', p.offset, -0.5, 0.5, 0.001, v => { p.offset = v; set(); }),
      slider('Correction gamma', p.gamma, 0.1, 9.99, 0.01, v => { p.gamma = v; set(); })),
    fromPsd: (a) => ({ exposure: a.exposure || 0, offset: a.offset || 0, gamma: a.gamma || 1 }),
    toPsd: (p) => ({ type: 'exposure', exposure: p.exposure, offset: p.offset, gamma: p.gamma }),
  },
  vibrance: {
    label: 'Vibrance', defaults: () => ({ vibrance: 0, saturation: 0 }),
    passes: (p) => [{ frag: `uniform float u_vib; uniform float u_sat;
void main() {
  vec4 c = texture2D(u_tex, v); vec3 col = c.rgb;
  float s = max(col.r, max(col.g, col.b)) - min(col.r, min(col.g, col.b));
  col = mix(vec3(lum(col)), col, 1.0 + u_vib * (1.0 - s));
  col = mix(vec3(lum(col)), col, 1.0 + u_sat);
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), c.a);
}`, uniforms: { u_vib: p.vibrance / 100, u_sat: p.saturation / 100 } }],
    ui: (p, set) => el('div', { class: 'form' }, slider('Vibrance', p.vibrance, -100, 100, 1, v => { p.vibrance = v; set(); }), slider('Saturation', p.saturation, -100, 100, 1, v => { p.saturation = v; set(); })),
    fromPsd: (a) => ({ vibrance: a.vibrance || 0, saturation: a.saturation || 0 }),
    toPsd: (p) => ({ type: 'vibrance', vibrance: p.vibrance, saturation: p.saturation }),
  },
  huesat: {
    label: 'Teinte/Saturation', defaults: () => ({ hue: 0, saturation: 0, lightness: 0, colorize: false, cHue: 30, cSat: 25 }),
    passes: (p) => [{ frag: `uniform float u_hue; uniform float u_sat; uniform float u_light; uniform float u_colorize; uniform float u_chue; uniform float u_csat;
void main() {
  vec4 c = texture2D(u_tex, v); vec3 h = rgb2hsl(c.rgb);
  if (u_colorize > 0.5) { h.x = u_chue; h.y = u_csat; }
  else { h.x = fract(h.x + u_hue); h.y = clamp(h.y * (1.0 + u_sat), 0.0, 1.0); }
  vec3 col = hsl2rgb(clamp(h, 0.0, 1.0));
  col = u_light > 0.0 ? mix(col, vec3(1.0), u_light) : mix(col, vec3(0.0), -u_light);
  gl_FragColor = vec4(col, c.a);
}`, uniforms: { u_hue: p.hue / 360, u_sat: p.saturation / 100, u_light: p.lightness / 100, u_colorize: p.colorize, u_chue: p.cHue / 360, u_csat: p.cSat / 100 } }],
    ui: (p, set) => {
      const box = el('div', { class: 'form' });
      const build = () => box.replaceChildren(
        p.colorize ? slider('Teinte', p.cHue, 0, 360, 1, v => { p.cHue = v; set(); }, '°') : slider('Teinte', p.hue, -180, 180, 1, v => { p.hue = v; set(); }, '°'),
        p.colorize ? slider('Saturation', p.cSat, 0, 100, 1, v => { p.cSat = v; set(); }) : slider('Saturation', p.saturation, -100, 100, 1, v => { p.saturation = v; set(); }),
        slider('Luminosité', p.lightness, -100, 100, 1, v => { p.lightness = v; set(); }),
        check('Redéfinir (colorier)', p.colorize, v => { p.colorize = v; build(); set(); }));
      build();
      return box;
    },
    fromPsd: (a) => ({ hue: a.master?.hue || 0, saturation: a.master?.saturation || 0, lightness: a.master?.lightness || 0, colorize: !!a.colorize, cHue: a.colorization?.hue ?? 30, cSat: a.colorization?.saturation ?? 25 }),
    toPsd: (p) => ({ type: 'hue/saturation', colorize: p.colorize, colorization: { hue: p.cHue, saturation: p.cSat, lightness: p.lightness }, master: { hue: p.hue, saturation: p.saturation, lightness: p.lightness } }),
  },
  colorbalance: {
    label: 'Balance des couleurs', defaults: () => ({ shadows: [0, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, 0], preserve: true }),
    passes: (p) => [{ frag: `uniform vec3 u_sh; uniform vec3 u_mid; uniform vec3 u_hi; uniform float u_preserve;
float wS(float l) { return clamp((l - 0.333) / -0.25 + 0.5, 0.0, 1.0) * 0.7; }
float wM(float l) { return clamp((l - 0.333) / 0.25 + 0.5, 0.0, 1.0) * clamp((l + 0.333 - 1.0) / -0.25 + 0.5, 0.0, 1.0) * 0.7; }
float wH(float l) { return clamp((l + 0.333 - 1.0) / 0.25 + 0.5, 0.0, 1.0) * 0.7; }
void main() {
  vec4 c = texture2D(u_tex, v); vec3 o = c.rgb, col = o;
  col.r += u_sh.x * wS(o.r) + u_mid.x * wM(o.r) + u_hi.x * wH(o.r);
  col.g += u_sh.y * wS(o.g) + u_mid.y * wM(o.g) + u_hi.y * wH(o.g);
  col.b += u_sh.z * wS(o.b) + u_mid.z * wM(o.b) + u_hi.z * wH(o.b);
  col = clamp(col, 0.0, 1.0);
  if (u_preserve > 0.5) { vec3 h = rgb2hsl(col); h.z = rgb2hsl(o).z; col = hsl2rgb(h); }
  gl_FragColor = vec4(col, c.a);
}`, uniforms: { u_sh: p.shadows.map(x => x / 100), u_mid: p.midtones.map(x => x / 100), u_hi: p.highlights.map(x => x / 100), u_preserve: p.preserve } }],
    ui: (p, set) => {
      let tone = 'midtones';
      const holder = el('div', { class: 'form' });
      const build = () => holder.replaceChildren(
        slider('Cyan ↔ Rouge', p[tone][0], -100, 100, 1, v => { p[tone][0] = v; set(); }),
        slider('Magenta ↔ Vert', p[tone][1], -100, 100, 1, v => { p[tone][1] = v; set(); }),
        slider('Jaune ↔ Bleu', p[tone][2], -100, 100, 1, v => { p[tone][2] = v; set(); }));
      build();
      return el('div', { class: 'form' }, select('Tons', tone, [['shadows', 'Tons foncés'], ['midtones', 'Tons moyens'], ['highlights', 'Tons clairs']], v => { tone = v; build(); }), holder,
        check('Préserver la luminosité', p.preserve, v => { p.preserve = v; set(); }));
    },
    fromPsd: (a) => { const t = (x) => (x ? [x.cyanRed, x.magentaGreen, x.yellowBlue] : [0, 0, 0]); return { shadows: t(a.shadows), midtones: t(a.midtones), highlights: t(a.highlights), preserve: a.preserveLuminosity !== false }; },
    toPsd: (p) => { const t = (x) => ({ cyanRed: x[0], magentaGreen: x[1], yellowBlue: x[2] }); return { type: 'color balance', shadows: t(p.shadows), midtones: t(p.midtones), highlights: t(p.highlights), preserveLuminosity: p.preserve }; },
  },
  bw: {
    label: 'Noir et blanc', defaults: () => ({ w: [...BW_PRESETS.def], tint: false, tintColor: '#e1d3b3' }),
    passes: (p) => [{ frag: `uniform float u_r; uniform float u_y; uniform float u_g; uniform float u_c; uniform float u_b; uniform float u_m; uniform float u_tint; uniform vec3 u_tc;
void main() {
  vec4 c = texture2D(u_tex, v); float r = c.r, g = c.g, b = c.b;
  float mx, mid, mn, wp, ws;
  if (r >= g && r >= b) { mx = r; wp = u_r; if (g >= b) { mid = g; mn = b; ws = u_y; } else { mid = b; mn = g; ws = u_m; } }
  else if (g >= r && g >= b) { mx = g; wp = u_g; if (r >= b) { mid = r; mn = b; ws = u_y; } else { mid = b; mn = r; ws = u_c; } }
  else { mx = b; wp = u_b; if (g >= r) { mid = g; mn = r; ws = u_c; } else { mid = r; mn = g; ws = u_m; } }
  float gray = clamp(mn + (mid - mn) * ws + (mx - mid) * wp, 0.0, 1.0);
  vec3 col = vec3(gray);
  if (u_tint > 0.5) { vec3 th = rgb2hsl(u_tc); col = hsl2rgb(vec3(th.x, th.y, gray)); }
  gl_FragColor = vec4(col, c.a);
}`, uniforms: { u_r: p.w[0] / 100, u_y: p.w[1] / 100, u_g: p.w[2] / 100, u_c: p.w[3] / 100, u_b: p.w[4] / 100, u_m: p.w[5] / 100, u_tint: p.tint, u_tc: vec3(p.tintColor) } }],
    ui: (p, set) => {
      const names = ['Rouges', 'Jaunes', 'Verts', 'Cyans', 'Bleus', 'Magentas'];
      const rows = names.map((n, i) => slider(n, p.w[i], -200, 300, 1, v => { p.w[i] = v; set(); }, '%'));
      return el('div', { class: 'form' },
        select('Paramètre prédéfini', 'def', [['def', 'Par défaut'], ['red', 'Filtre rouge (ciel dramatique)'], ['yellow', 'Filtre jaune'], ['green', 'Filtre vert'], ['blue', 'Filtre bleu']], v => { p.w = [...BW_PRESETS[v]]; rows.forEach((r, i) => r.set(p.w[i])); set(); }),
        ...rows,
        check('Teinte', p.tint, v => { p.tint = v; set(); }), colorIn('Couleur de teinte', p.tintColor, v => { p.tintColor = v; set(); }));
    },
    fromPsd: (a) => ({ w: [a.reds ?? 40, a.yellows ?? 60, a.greens ?? 40, a.cyans ?? 60, a.blues ?? 20, a.magentas ?? 80], tint: !!a.useTint, tintColor: a.tintColor ? colorToHex(a.tintColor) : '#e1d3b3' }),
    toPsd: (p) => ({ type: 'black & white', reds: p.w[0], yellows: p.w[1], greens: p.w[2], cyans: p.w[3], blues: p.w[4], magentas: p.w[5], useTint: p.tint, tintColor: hexToPsd(p.tintColor) }),
  },
  photofilter: {
    label: 'Filtre photo', defaults: () => ({ color: '#ec8a00', density: 25, preserve: true }),
    passes: (p) => [{ frag: `uniform vec3 u_color; uniform float u_density; uniform float u_preserve;
void main() {
  vec4 c = texture2D(u_tex, v);
  vec3 col = mix(c.rgb, c.rgb * u_color * 1.6, u_density);
  if (u_preserve > 0.5) { float l0 = lum(c.rgb), l1 = lum(col); if (l1 > 0.0001) col *= l0 / l1; }
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), c.a);
}`, uniforms: { u_color: vec3(p.color), u_density: p.density / 100, u_preserve: p.preserve } }],
    ui: (p, set) => {
      const color = colorIn('Couleur', p.color, v => { p.color = v; set(); });
      return el('div', { class: 'form' },
        select('Filtre', PHOTO_FILTERS.some(f => f[0] === p.color) ? p.color : '', [['', 'Personnalisé'], ...PHOTO_FILTERS], v => { if (v) { p.color = v; color.querySelector('input').value = v; set(); } }),
        color, slider('Densité', p.density, 1, 100, 1, v => { p.density = v; set(); }, '%'),
        check('Préserver la luminosité', p.preserve, v => { p.preserve = v; set(); }));
    },
    fromPsd: (a) => ({ color: a.color ? colorToHex(a.color) : '#ec8a00', density: a.density ?? 25, preserve: a.preserveLuminosity !== false }),
    toPsd: (p) => ({ type: 'photo filter', color: hexToPsd(p.color), density: p.density, preserveLuminosity: p.preserve }),
  },
  invert: {
    label: 'Négatif', defaults: () => ({}),
    passes: () => [{ frag: LUT_FRAG, lut: lutTex(ident().map(i => 255 - i)) }],
    ui: () => el('p', { class: 'muted' }, 'Inverse les couleurs (aucun réglage).'),
    fromPsd: () => ({}), toPsd: () => ({ type: 'invert' }),
  },
  posterize: {
    label: 'Postérisation', defaults: () => ({ levels: 4 }),
    passes: (p) => { const n = Math.max(2, p.levels); return [{ frag: LUT_FRAG, lut: lutTex(ident().map(i => Math.round(Math.round(i / 255 * (n - 1)) / (n - 1) * 255))) }]; },
    ui: (p, set) => el('div', { class: 'form' }, slider('Niveaux', p.levels, 2, 255, 1, v => { p.levels = v; set(); })),
    fromPsd: (a) => ({ levels: a.levels || 4 }), toPsd: (p) => ({ type: 'posterize', levels: p.levels }),
  },
  threshold: {
    label: 'Seuil', defaults: () => ({ level: 128 }),
    passes: (p) => [{ frag: `uniform float u_level; void main() { vec4 c = texture2D(u_tex, v); gl_FragColor = vec4(vec3(lum(c.rgb) * 255.0 >= u_level ? 1.0 : 0.0), c.a); }`, uniforms: { u_level: p.level } }],
    ui: (p, set) => el('div', { class: 'form' }, slider('Seuil', p.level, 1, 255, 1, v => { p.level = v; set(); })),
    fromPsd: (a) => ({ level: a.level || 128 }), toPsd: (p) => ({ type: 'threshold', level: p.level }),
  },
  gradientmap: {
    label: 'Courbe de transfert de dégradé', defaults: (app) => ({ c0: app?.colors.fg || '#000000', c1: app?.colors.bg || '#ffffff', reverse: false }),
    passes: (p) => [{ frag: `uniform vec3 u_c0; uniform vec3 u_c1; void main() { vec4 c = texture2D(u_tex, v); gl_FragColor = vec4(mix(u_c0, u_c1, lum(c.rgb)), c.a); }`, uniforms: { u_c0: vec3(p.reverse ? p.c1 : p.c0), u_c1: vec3(p.reverse ? p.c0 : p.c1) } }],
    ui: (p, set) => el('div', { class: 'form' }, colorIn('Tons foncés', p.c0, v => { p.c0 = v; set(); }), colorIn('Tons clairs', p.c1, v => { p.c1 = v; set(); }), check('Inverser', p.reverse, v => { p.reverse = v; set(); })),
    fromPsd: (a) => {
      const st = a.colorStops || [];
      return { c0: st[0] ? colorToHex(st[0].color) : '#000000', c1: st.length ? colorToHex(st[st.length - 1].color) : '#ffffff', reverse: !!a.reverse };
    },
    toPsd: (p) => ({
      type: 'gradient map', gradientType: 'solid', name: 'Enluminure', reverse: p.reverse, dither: false, smoothness: 1,
      colorStops: [{ color: hexToPsd(p.c0), location: 0, midpoint: 0.5 }, { color: hexToPsd(p.c1), location: 1, midpoint: 0.5 }],
      opacityStops: [{ opacity: 1, location: 0, midpoint: 0.5 }, { opacity: 1, location: 1, midpoint: 0.5 }],
    }),
  },
};

export const ADJ_ORDER = ['brightness', 'levels', 'curves', 'exposure', '-', 'vibrance', 'huesat', 'colorbalance', 'bw', 'photofilter', '-', 'invert', 'posterize', 'threshold', 'gradientmap'];
export const PSD_TYPES = { 'brightness/contrast': 'brightness', levels: 'levels', curves: 'curves', exposure: 'exposure', vibrance: 'vibrance', 'hue/saturation': 'huesat', 'color balance': 'colorbalance', 'black & white': 'bw', 'photo filter': 'photofilter', invert: 'invert', posterize: 'posterize', threshold: 'threshold', 'gradient map': 'gradientmap' };

/** Applique un réglage { type, ...réglages } à la zone `rect` d'une toile. Résultat à consommer tout de suite. */
export function applyAdjust(src, adj, rect) {
  const def = ADJ[adj.type];
  return glRun(src, rect, def.passes(adj));
}

// Réglages automatiques (appliqués directement)
export function autoLUT(H, kind) {
  if (kind === 'contrast') {
    const all = new Uint32Array(256);
    for (let i = 0; i < 256; i++) all[i] = H.r[i] + H.g[i] + H.b[i];
    const [lo, hi] = autoBounds(all, H.n * 3);
    const L = levelLUT({ ...defLevel(), inLo: lo, inHi: hi });
    return lutTex(L);
  }
  const per = ['r', 'g', 'b'].map(c => autoBounds(H[c], H.n));
  const luts = per.map(([lo, hi]) => levelLUT({ ...defLevel(), inLo: lo, inHi: hi }));
  if (kind === 'color') { // neutralise la dominante : chaque canal ramené à la même moyenne
    const mean = (arr) => { let s = 0, n = 0; for (let i = 0; i < 256; i++) { s += i * arr[i]; n += arr[i]; } return n ? s / n : 128; };
    const ms = ['r', 'g', 'b'].map((c, k) => { const m = mean(H[c]); return luts[k][Math.round(m)] / 255; });
    const target = (ms[0] + ms[1] + ms[2]) / 3;
    ms.forEach((m, k) => {
      if (m <= 0.02 || m >= 0.98) return;
      const g = Math.log(target) / Math.log(m);
      luts[k] = luts[k].map(v => Math.pow(v / 255, g) * 255);
    });
  }
  return lutTex(luts[0], luts[1], luts[2]);
}
export const LUT_SHADER = LUT_FRAG;
export { slider, check, colorIn, select as selectRow };

// Enluminure — outils de l'étape 2 : pinceau, gomme, pipette, pot de peinture, dégradé, texte, formes, recadrage
import { el, clamp, mkLayer, newCanvas, ctxOf, freeCanvas } from './util.js';
import { updateLayer, insertLayer, nextLayerName, cropState } from './ops.js';
import { layerRect } from './render.js';
import {
  ensurePaintable, commitPixels, Stroke, sampleColor, floodRegion, maskToCanvas, drawGradient,
  renderText, ensureFont, renderShape, FONTS, rgba,
} from './paint.js';
import { openDialog, field, toast } from './ui.js';

export const DEFAULT_SETTINGS = {
  brush: { size: 30, hardness: 0.8, opacity: 1, flow: 1, pSize: true, pOpacity: false },
  eraser: { size: 50, hardness: 0.8, opacity: 1, flow: 1, pSize: true, pOpacity: false },
  eyedropper: { all: true, size: 1 },
  bucket: { tolerance: 32, contiguous: true, all: false, opacity: 1 },
  gradient: { type: 'linear', toTransparent: false, reverse: false, opacity: 1 },
  text: { font: 'system', size: 72, bold: false, italic: false, align: 'left', lineHeight: 1.2 },
  shapes: { type: 'rect', fill: true, stroke: false, strokeColor: '#1B1512', strokeWidth: 6, radius: 32 },
  crop: { ratio: 'free', deletePixels: true },
};

// ——— Petits contrôles de la barre d'options ———
function optRange(label, value, { min, max, step = 1, unit = '', log = false, pct = false }, onChange) {
  const toUi = (v) => pct ? Math.round(v * 100) : v;
  const fromUi = (v) => pct ? v / 100 : v;
  const lmin = Math.log(min), lmax = Math.log(max);
  const toRange = (v) => log ? Math.round(1000 * (Math.log(v) - lmin) / (lmax - lmin)) : v;
  const fromRange = (r) => log ? Math.round(Math.exp(lmin + (lmax - lmin) * r / 1000)) : +r;
  const uiv = toUi(value);
  const range = el('input', { type: 'range', min: log ? 0 : min, max: log ? 1000 : max, step: log ? 1 : step, value: toRange(uiv) });
  const num = el('input', { type: 'number', min, max, step, value: uiv, inputmode: 'numeric', class: 'opt-num' });
  const set = (v, from) => {
    v = clamp(+v, min, max);
    if (Number.isNaN(v)) return;
    if (from !== 'num') num.value = v;
    if (from !== 'range') range.value = toRange(v);
    onChange(fromUi(v));
  };
  range.addEventListener('input', () => set(fromRange(range.value), 'range'));
  num.addEventListener('change', () => set(num.value, 'num'));
  num.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') num.blur(); });
  const wrap = el('label', { class: 'opt opt-range' }, el('span', {}, label), range, num, unit ? el('span', { class: 'opt-unit' }, unit) : null);
  wrap.update = (v) => { const u = toUi(v); num.value = u; range.value = toRange(u); };
  return wrap;
}
function optCheck(label, value, onChange) {
  const i = el('input', { type: 'checkbox', checked: value });
  i.addEventListener('change', () => onChange(i.checked));
  return el('label', { class: 'opt' }, i, label);
}
function optSelect(label, value, options, onChange) {
  const s = el('select', {}, options.map(([v, l]) => el('option', { value: v }, l)));
  s.value = value;
  s.addEventListener('change', () => onChange(s.value));
  return el('label', { class: 'opt' }, label ? el('span', {}, label) : null, s);
}
function optColor(label, value, onChange) {
  const i = el('input', { type: 'color', value });
  i.addEventListener('input', () => onChange(i.value));
  return el('label', { class: 'opt' }, el('span', {}, label), i);
}
function optButton(label, onClick, cls = '') {
  const b = el('button', { type: 'button', class: `btn small ${cls}` }, label);
  b.addEventListener('click', onClick);
  return b;
}

const pressureOf = (e) => (e && e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 1);

class Tool {
  constructor(app, id) { this.app = app; this.id = id; }
  get doc() { return this.app.doc; }
  get s() { return this.app.settings[this.id]; }
  save() { this.app.saveOpts(); }
  /** Calque actif utilisable pour peindre, sinon message et null. */
  paintLayer() {
    const d = this.doc;
    const L = d?.committed.layers.find(l => l.id === d.activeId);
    if (!L) { toast('Choisissez d\'abord un calque.'); return null; }
    if (!L.visible) { toast('Ce calque est masqué : affichez-le pour le modifier.'); return null; }
    return L;
  }
  cursor() { return 'crosshair'; }
}

// ——— Pinceau et gomme ———
class BrushTool extends Tool {
  constructor(app, id, erase) { super(app, id); this.erase = erase; this.stroke = null; this.lastEnd = null; }
  cursor() { return 'none'; }
  down(p, e) {
    if (e.altKey && !this.erase) { this.app.tools.eyedropper.pick(p, false); return false; }
    const L = this.paintLayer(); if (!L) return false;
    const d = this.doc, s = this.s;
    const wasText = !!L.text;
    const prepared = ensurePaintable(d, L.id);
    this.stroke = new Stroke(this.app, prepared, { ...s, color: this.app.colors.fg, erase: this.erase });
    if (e.shiftKey && this.lastEnd && this.lastEnd.doc === d.id) this.stroke.point(this.lastEnd.x, this.lastEnd.y, 1);
    this.stroke.point(p.x, p.y, pressureOf(e));
    this.stroke.flush();
    if (wasText) toast('Le calque de texte devient une image.');
    return true;
  }
  move(p, e, pts) {
    if (!this.stroke) return;
    for (const q of pts) this.stroke.point(q.x, q.y, q.pressure);
    this.stroke.flush();
  }
  up(p) {
    if (!this.stroke) return;
    this.stroke.end(this.erase ? 'Gomme' : 'Pinceau');
    this.lastEnd = { x: p.x, y: p.y, doc: this.doc.id };
    this.stroke = null;
  }
  cancel() { this.stroke?.cancel(); this.stroke = null; }
  overlay(ctx, view) {
    const h = view.hover;
    if (!h || view.action) { if (!view.action || !view.lastPt) return; }
    const pt = view.action ? view.lastPt : h;
    if (!pt || pt.touch) return;
    const r = Math.max(1, this.s.size * view.doc.view.zoom / 2);
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,.65)';
    ctx.beginPath(); ctx.arc(pt.x, pt.y, r + 0.5, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,.9)';
    ctx.beginPath(); ctx.arc(pt.x, pt.y, r - 0.5 > 0 ? r - 0.5 : r, 0, Math.PI * 2); ctx.stroke();
    if (r < 6) {
      ctx.beginPath(); ctx.moveTo(pt.x - 7, pt.y); ctx.lineTo(pt.x + 7, pt.y); ctx.moveTo(pt.x, pt.y - 7); ctx.lineTo(pt.x, pt.y + 7); ctx.stroke();
    }
    ctx.restore();
  }
  options(bar) {
    const s = this.s;
    this.sizeCtl = optRange('Taille', s.size, { min: 1, max: 1000, log: true, unit: 'px' }, v => { s.size = v; this.save(); this.app.view.requestRender(); });
    bar.append(this.sizeCtl,
      optRange('Dureté', s.hardness, { min: 0, max: 100, pct: true, unit: '%' }, v => { s.hardness = v; this.save(); }),
      optRange('Opacité', s.opacity, { min: 1, max: 100, pct: true, unit: '%' }, v => { s.opacity = v; this.save(); }),
      optRange('Flux', s.flow, { min: 1, max: 100, pct: true, unit: '%' }, v => { s.flow = v; this.save(); }),
      el('span', { class: 'opt-label' }, 'Pression du stylet :'),
      optCheck('taille', s.pSize, v => { s.pSize = v; this.save(); }),
      optCheck('opacité', s.pOpacity, v => { s.pOpacity = v; this.save(); }));
  }
  key(e, k) {
    const s = this.s;
    if (k === '[' || k === ']') {
      if (e.shiftKey) s.hardness = clamp(s.hardness + (k === ']' ? 0.25 : -0.25), 0, 1);
      else {
        const step = s.size < 10 ? 1 : s.size < 50 ? 5 : s.size < 100 ? 10 : s.size < 300 ? 25 : 50;
        s.size = clamp(s.size + (k === ']' ? step : -step), 1, 1000);
      }
      this.save(); this.app.refreshOptions(); this.app.view.requestRender();
      return true;
    }
    if (/^[0-9]$/.test(k) && !e.ctrlKey && !e.metaKey) {
      s.opacity = k === '0' ? 1 : +k / 10;
      this.save(); this.app.refreshOptions();
      toast(`Opacité : ${Math.round(s.opacity * 100)} %`, 1200);
      return true;
    }
    return false;
  }
}

// ——— Pipette ———
class EyedropperTool extends Tool {
  pick(p, toBg) {
    const d = this.doc; if (!d) return;
    const s = this.s;
    let hex;
    if (s.all) hex = sampleColor(d.composite(), p.x, p.y, s.size);
    else {
      const L = d.active;
      if (L?.canvas) hex = sampleColor(L.canvas, p.x - L.x, p.y - L.y, s.size);
    }
    if (!hex) return;
    this.app.setColor(toBg ? 'bg' : 'fg', hex);
    this.picked = hex;
  }
  down(p, e) { this.pick(p, e.altKey); this.active = true; return true; }
  move(p, e) { this.pick(p, e.altKey); }
  up() { this.active = false; this.app.view.requestRender(); }
  overlay(ctx, view) {
    if (!this.active || !view.lastPt) return;
    const pt = view.lastPt;
    ctx.save();
    ctx.lineWidth = 10;
    ctx.strokeStyle = this.app.colors.fg;
    ctx.beginPath(); ctx.arc(pt.x, pt.y - 50, 26, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(0,0,0,.6)';
    ctx.beginPath(); ctx.arc(pt.x, pt.y - 50, 31, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }
  options(bar) {
    const s = this.s;
    bar.append(
      optSelect('Taille', String(s.size), [['1', 'Point'], ['3', 'Moyenne 3 × 3'], ['5', 'Moyenne 5 × 5'], ['11', 'Moyenne 11 × 11']], v => { s.size = +v; this.save(); }),
      optSelect('Prélever', s.all ? 'all' : 'layer', [['all', 'Tous les calques'], ['layer', 'Calque actif']], v => { s.all = v === 'all'; this.save(); }),
      el('span', { class: 'opt-hint' }, 'Alt : couleur d\'arrière-plan'));
  }
}

// ——— Pot de peinture ———
class BucketTool extends Tool {
  async down(p) {
    const L = this.paintLayer(); if (!L) return false;
    const d = this.doc, s = this.s;
    const px = Math.floor(p.x), py = Math.floor(p.y);
    if (px < 0 || py < 0 || px >= d.width || py >= d.height) return false;
    const color = this.app.colors.fg;
    await this.app.withBusy('Remplissage…', async () => {
      const prepared = ensurePaintable(d, L.id);
      const lay = prepared.layer;
      const W = d.width, H = d.height;
      const img = s.all
        ? ctxOf(d.composite()).getImageData(0, 0, W, H)
        : ctxOf(lay.canvas).getImageData(-lay.x, -lay.y, W, H);
      const region = floodRegion(img, px, py, s.tolerance, s.contiguous);
      if (!region) return;
      const fill = maskToCanvas(region, color);
      const r = region.rect;
      commitPixels(this.app, 'Pot de peinture', L.id, r, (ctx, layer) => {
        ctx.globalAlpha = s.opacity;
        ctx.drawImage(fill, r.x - layer.x, r.y - layer.y);
      }, prepared);
      freeCanvas(fill);
    });
    return false;
  }
  options(bar) {
    const s = this.s;
    bar.append(
      optRange('Tolérance', s.tolerance, { min: 0, max: 255 }, v => { s.tolerance = v; this.save(); }),
      optRange('Opacité', s.opacity, { min: 1, max: 100, pct: true, unit: '%' }, v => { s.opacity = v; this.save(); }),
      optCheck('Pixels contigus', s.contiguous, v => { s.contiguous = v; this.save(); }),
      optCheck('Tous les calques', s.all, v => { s.all = v; this.save(); }));
  }
}

// ——— Dégradé ———
class GradientTool extends Tool {
  down(p) {
    const L = this.paintLayer(); if (!L) return false;
    const d = this.doc;
    this.prepared = ensurePaintable(d, L.id);
    const base = this.prepared.layer;
    this.pc = newCanvas(base.canvas.width, base.canvas.height);
    ctxOf(this.pc).drawImage(base.canvas, 0, 0);
    this.a = { x: p.x, y: p.y }; this.b = null;
    if (this.prepared.state !== d.committed) d.setPreview(this.prepared.state);
    d.setLive({ layerId: L.id, canvas: this.pc });
    return true;
  }
  move(p, e) {
    if (!this.pc) return;
    let b = { x: p.x, y: p.y };
    if (e.shiftKey) { // angles de 45°
      const dx = b.x - this.a.x, dy = b.y - this.a.y;
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(dx, dy);
      b = { x: this.a.x + Math.cos(ang) * len, y: this.a.y + Math.sin(ang) * len };
    }
    this.b = b;
    const base = this.prepared.layer, s = this.s, { fg, bg } = this.app.colors;
    const ctx = ctxOf(this.pc);
    ctx.clearRect(0, 0, this.pc.width, this.pc.height);
    ctx.drawImage(base.canvas, 0, 0);
    drawGradient(ctx, this.pc.width, this.pc.height,
      { x: this.a.x - base.x, y: this.a.y - base.y }, { x: b.x - base.x, y: b.y - base.y },
      { type: s.type, c0: fg, c1: s.toTransparent ? rgba(fg, 0) : bg, reverse: s.reverse, opacity: s.opacity });
    this.doc.invalidate();
  }
  up() {
    const d = this.doc;
    if (!this.pc) return;
    const ok = this.b && Math.hypot(this.b.x - this.a.x, this.b.y - this.a.y) >= 2 && d.live?.canvas === this.pc;
    if (ok) {
      const base = this.prepared.layer;
      const st = updateLayer(this.prepared.state, base.id, { canvas: this.pc, text: null });
      if (base.canvas !== d.committed.layers.find(l => l.id === base.id)?.canvas) freeCanvas(base.canvas);
      this.app.commit('Dégradé', st);
    } else { d.cancelPreview(); freeCanvas(this.pc); }
    this.pc = null; this.prepared = null; this.b = null;
  }
  cancel() { this.doc?.cancelPreview(); freeCanvas(this.pc); this.pc = null; this.b = null; }
  overlay(ctx, view) {
    if (!this.pc || !this.b) return;
    const A = view.toScreen(this.a), B = view.toScreen(this.b);
    ctx.save();
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.55)';
    ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke();
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#fff';
    ctx.stroke();
    for (const P of [A, B]) { ctx.beginPath(); ctx.arc(P.x, P.y, 5, 0, Math.PI * 2); ctx.fillStyle = '#C9804F'; ctx.fill(); ctx.stroke(); }
    ctx.restore();
  }
  options(bar) {
    const s = this.s;
    bar.append(
      optSelect('Type', s.type, [['linear', 'Linéaire'], ['radial', 'Radial'], ['reflected', 'Réfléchi']], v => { s.type = v; this.save(); }),
      optSelect('', s.toTransparent ? 't' : 'bg', [['bg', 'Premier plan → arrière-plan'], ['t', 'Premier plan → transparent']], v => { s.toTransparent = v === 't'; this.save(); }),
      optCheck('Inverser', s.reverse, v => { s.reverse = v; this.save(); }),
      optRange('Opacité', s.opacity, { min: 1, max: 100, pct: true, unit: '%' }, v => { s.opacity = v; this.save(); }),
      el('span', { class: 'opt-hint' }, 'Glisser pour tracer · Maj : angles de 45°'));
  }
}

// ——— Formes ———
const SHAPE_NAMES = { rect: 'Rectangle', rounded: 'Rectangle arrondi', ellipse: 'Ellipse', line: 'Ligne' };
class ShapesTool extends Tool {
  down(p) {
    const d = this.doc; if (!d) return false;
    this.a = { x: Math.round(p.x), y: Math.round(p.y) };
    this.layer = null;
    return true;
  }
  spec(p, e) {
    const s = this.s, a = this.a;
    let x1 = Math.round(p.x), y1 = Math.round(p.y);
    let dx = x1 - a.x, dy = y1 - a.y;
    if (e.shiftKey) {
      if (s.type === 'line') {
        const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(dx, dy);
        dx = Math.round(Math.cos(ang) * len); dy = Math.round(Math.sin(ang) * len);
      } else { const m = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * m; dy = Math.sign(dy || 1) * m; }
    }
    let x0 = a.x, y0 = a.y;
    x1 = a.x + dx; y1 = a.y + dy;
    if (e.altKey && s.type !== 'line') { x0 = a.x - dx; y0 = a.y - dy; }
    return { type: s.type, x0, y0, x1, y1, fill: s.fill, fillColor: this.app.colors.fg, stroke: s.stroke, strokeColor: s.strokeColor, strokeWidth: s.strokeWidth, radius: s.radius };
  }
  move(p, e) {
    const d = this.doc; if (!this.a) return;
    const sp = this.spec(p, e);
    if (Math.abs(sp.x1 - sp.x0) < 1 && Math.abs(sp.y1 - sp.y0) < 1) return;
    if (sp.type !== 'line' && !sp.fill && !sp.stroke) { sp.stroke = true; }
    const r = renderShape(sp);
    if (!this.layer) this.layer = mkLayer({ name: nextLayerName(d.committed, SHAPE_NAMES[sp.type]) });
    else freeCanvas(this.layer.canvas);
    this.layer = { ...this.layer, canvas: r.canvas, x: r.x, y: r.y };
    d.setPreview(insertLayer(d.committed, this.layer, d.activeId));
  }
  up() {
    const d = this.doc;
    if (this.layer && d.preview) {
      this.app.commit(`Forme : ${SHAPE_NAMES[this.s.type].toLowerCase()}`, insertLayer(d.committed, this.layer, d.activeId), { activeId: this.layer.id });
    } else d.cancelPreview();
    this.a = null; this.layer = null;
  }
  cancel() { this.doc?.cancelPreview(); this.a = null; this.layer = null; }
  options(bar) {
    const s = this.s;
    bar.append(
      optSelect('Forme', s.type, Object.entries(SHAPE_NAMES), v => { s.type = v; this.save(); this.app.refreshOptions(); }),
      optCheck(s.type === 'line' ? 'Couleur de premier plan' : 'Remplissage (premier plan)', s.fill || s.type === 'line', v => { s.fill = v; this.save(); }));
    if (s.type !== 'line') bar.append(optCheck('Contour', s.stroke, v => { s.stroke = v; this.save(); }), optColor('', s.strokeColor, v => { s.strokeColor = v; this.save(); }));
    bar.append(optRange(s.type === 'line' ? 'Épaisseur' : 'Épaisseur du contour', s.strokeWidth, { min: 1, max: 200, unit: 'px' }, v => { s.strokeWidth = v; this.save(); }));
    if (s.type === 'rounded') bar.append(optRange('Rayon', s.radius, { min: 1, max: 500, unit: 'px' }, v => { s.radius = v; this.save(); }));
    bar.append(el('span', { class: 'opt-hint' }, 'Maj : carré / cercle · Alt : depuis le centre'));
  }
}

// ——— Texte ———
class TextTool extends Tool {
  cursor() { return 'text'; }
  down(p) {
    const d = this.doc; if (!d) return false;
    // clic sur un texte existant : on le modifie
    const st = d.committed;
    for (let i = st.layers.length - 1; i >= 0; i--) {
      const l = st.layers[i];
      if (!l.text || !l.visible) continue;
      const r = layerRect(l);
      if (p.x >= r.x && p.y >= r.y && p.x <= r.x + r.w && p.y <= r.y + r.h) { this.edit(l); return false; }
    }
    this.edit(null, { x: Math.round(p.x), y: Math.round(p.y) });
    return false;
  }

  /** Fenêtre de saisie, avec aperçu en direct sur l'image. */
  async edit(layer, at) {
    const d = this.doc, app = this.app;
    const s = this.s;
    const t0 = layer ? { ...layer.text } : { content: '', font: s.font, size: s.size, bold: s.bold, italic: s.italic, align: s.align, lineHeight: s.lineHeight, color: app.colors.fg, x: at.x, y: at.y };
    if (layer) { // le calque a pu être déplacé depuis : on recale le point d'ancrage
      await ensureFont(t0);
      const r0 = renderText(t0);
      t0.x += layer.x - r0.x; t0.y += layer.y - r0.y;
      freeCanvas(r0.canvas);
    }
    const t = { ...t0 };
    let lay = layer ? { ...layer } : mkLayer({ name: 'Texte' });
    const area = el('textarea', { rows: 3, placeholder: 'Votre texte…', class: 'text-input' });
    area.value = t.content;
    const font = el('select', {}, FONTS.map(f => el('option', { value: f.id }, f.label)));
    font.value = t.font;
    const size = el('input', { type: 'number', min: 4, max: 2000, value: t.size, inputmode: 'numeric' });
    const color = el('input', { type: 'color', value: t.color });
    const bold = el('input', { type: 'checkbox', checked: t.bold });
    const italic = el('input', { type: 'checkbox', checked: t.italic });
    const align = el('select', {}, el('option', { value: 'left' }, 'À gauche'), el('option', { value: 'center' }, 'Centré'), el('option', { value: 'right' }, 'À droite'));
    align.value = t.align;
    const lh = el('input', { type: 'number', min: 0.6, max: 4, step: 0.1, value: t.lineHeight, inputmode: 'decimal' });
    let seq = 0;
    const update = async () => {
      Object.assign(t, { content: area.value, font: font.value, size: clamp(+size.value || 12, 4, 2000), color: color.value, bold: bold.checked, italic: italic.checked, align: align.value, lineHeight: clamp(+lh.value || 1.2, 0.6, 4) });
      const my = ++seq;
      await ensureFont(t);
      if (my !== seq) return;
      if (!t.content.trim()) { d.cancelPreview(); app.view.requestRender(); return; }
      const r = renderText(t);
      lay = { ...lay, canvas: r.canvas, x: r.x, y: r.y, text: { ...t }, name: t.content.trim().split('\n')[0].slice(0, 40) };
      const base = d.committed;
      d.setPreview(layer ? updateLayer(base, layer.id, lay) : insertLayer(base, lay, d.activeId));
      app.view.requestRender();
    };
    for (const i of [area, size, lh]) i.addEventListener('input', update);
    for (const i of [font, color, bold, italic, align]) i.addEventListener('change', update);
    color.addEventListener('input', update);
    area.addEventListener('keydown', (e) => e.stopPropagation());
    const body = el('div', { class: 'form' },
      area,
      el('div', { class: 'row' }, field('Police', font), field('Taille (px)', size)),
      el('div', { class: 'row' }, field('Couleur', color), field('Alignement', align), field('Interligne', lh)),
      el('div', { class: 'row tight' }, el('label', { class: 'opt' }, bold, 'Gras'), el('label', { class: 'opt' }, italic, 'Italique')));
    if (layer) update();
    const ok = await openDialog({
      title: layer ? 'Modifier le texte' : 'Texte', body, floating: true,
      buttons: [{ label: 'Annuler', value: false }, { label: layer ? 'Appliquer' : 'Ajouter', primary: true, value: true }],
    });
    seq++;
    if (ok && t.content.trim()) {
      await ensureFont(t);
      const r = renderText(t);
      lay = { ...lay, canvas: r.canvas, x: r.x, y: r.y, text: { ...t }, name: t.content.trim().split('\n')[0].slice(0, 40) };
      const base = d.committed;
      if (layer) app.commit('Modifier le texte', updateLayer(base, layer.id, lay), { activeId: layer.id });
      else app.commit('Texte', insertLayer(base, lay, d.activeId), { activeId: lay.id });
      // mémorise les réglages pour le prochain texte
      Object.assign(s, { font: t.font, size: t.size, bold: t.bold, italic: t.italic, align: t.align, lineHeight: t.lineHeight });
      this.save();
    } else { d.cancelPreview(); app.refresh({ history: false }); }
  }
  options(bar) {
    const s = this.s;
    bar.append(
      optSelect('Police', s.font, FONTS.map(f => [f.id, f.label]), v => { s.font = v; this.save(); }),
      optRange('Taille', s.size, { min: 4, max: 2000, log: true, unit: 'px' }, v => { s.size = v; this.save(); }),
      optCheck('Gras', s.bold, v => { s.bold = v; this.save(); }),
      optCheck('Italique', s.italic, v => { s.italic = v; this.save(); }),
      optSelect('', s.align, [['left', 'À gauche'], ['center', 'Centré'], ['right', 'À droite']], v => { s.align = v; this.save(); }),
      el('span', { class: 'opt-hint' }, 'Cliquez sur l\'image pour écrire, sur un texte pour le modifier'));
  }
}

// ——— Recadrage ———
const RATIOS = [['free', 'Libre'], ['orig', 'Original'], ['1:1', '1:1 (carré)'], ['4:3', '4:3'], ['3:2', '3:2'], ['16:9', '16:9'], ['5:4', '5:4'], ['3:4', '3:4'], ['2:3', '2:3'], ['9:16', '9:16 (story)']];
class CropTool extends Tool {
  activate() { this.reset(); }
  deactivate() { this.rect = null; this.app.view.requestRender(); }
  reset() {
    const d = this.doc;
    this.rect = d ? { x: 0, y: 0, w: d.width, h: d.height } : null;
    this.rectDoc = d?.id; this.dims = d ? `${d.width}x${d.height}` : '';
    this.app.view.requestRender();
  }
  ratio() {
    const r = this.s.ratio, d = this.doc;
    if (r === 'free') return null;
    if (r === 'orig') return d.width / d.height;
    const [a, b] = r.split(':').map(Number);
    return a / b;
  }
  cursor() { return 'crosshair'; }
  _handles(view) {
    const r = this.rect;
    const A = view.toScreen({ x: r.x, y: r.y }), B = view.toScreen({ x: r.x + r.w, y: r.y + r.h });
    const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
    return { nw: [A.x, A.y], n: [mx, A.y], ne: [B.x, A.y], e: [B.x, my], se: [B.x, B.y], s: [mx, B.y], sw: [A.x, B.y], w: [A.x, my], A, B };
  }
  down(p, e, view) {
    if (!this.doc) return false;
    if (!this.rect || this.rectDoc !== this.doc.id) this.reset();
    const sp = view.toScreen(p);
    const H = this._handles(view);
    const tol = e.pointerType === 'touch' ? 26 : 12;
    let mode = null;
    for (const k of ['nw', 'ne', 'se', 'sw', 'n', 'e', 's', 'w']) {
      if (Math.hypot(sp.x - H[k][0], sp.y - H[k][1]) <= tol) { mode = k; break; }
    }
    const r = this.rect;
    const d = this.doc;
    const untouched = r.x === 0 && r.y === 0 && r.w === d.width && r.h === d.height;
    if (!mode && !untouched && p.x > r.x && p.y > r.y && p.x < r.x + r.w && p.y < r.y + r.h) mode = 'move';
    if (!mode) { mode = 'new'; this.anchor = { x: p.x, y: p.y }; }
    this.drag = { mode, p0: { ...p }, r0: { ...r } };
    return true;
  }
  move(p, e) {
    const g = this.drag; if (!g) return;
    const d = this.doc;
    const r0 = g.r0;
    let x1 = r0.x, y1 = r0.y, x2 = r0.x + r0.w, y2 = r0.y + r0.h;
    const dx = p.x - g.p0.x, dy = p.y - g.p0.y;
    if (g.mode === 'move') { this.rect = { ...r0, x: Math.round(r0.x + dx), y: Math.round(r0.y + dy) }; this.app.view.requestRender(); return; }
    if (g.mode === 'new') { x1 = this.anchor.x; y1 = this.anchor.y; x2 = p.x; y2 = p.y; }
    else {
      if (g.mode.includes('w')) x1 += dx;
      if (g.mode.includes('e')) x2 += dx;
      if (g.mode.includes('n')) y1 += dy;
      if (g.mode.includes('s')) y2 += dy;
    }
    let ratio = this.ratio();
    if (!ratio && e.shiftKey) ratio = r0.w / r0.h || 1;
    if (ratio) {
      let w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
      if (g.mode === 'n' || g.mode === 's') w = h * ratio;
      else if (g.mode === 'e' || g.mode === 'w') h = w / ratio;
      else if (w / h > ratio) h = w / ratio; else w = h * ratio;
      if (g.mode === 'n' || g.mode === 's') { const cx = (x1 + x2) / 2; x1 = cx - w / 2; x2 = cx + w / 2; }
      else if (g.mode === 'e' || g.mode === 'w') { const cy = (y1 + y2) / 2; y1 = cy - h / 2; y2 = cy + h / 2; }
      else {
        if (g.mode === 'new') { x2 = x1 + Math.sign(x2 - x1 || 1) * w; y2 = y1 + Math.sign(y2 - y1 || 1) * h; }
        else {
          if (g.mode.includes('w')) x1 = x2 - w; else x2 = x1 + w;
          if (g.mode.includes('n')) y1 = y2 - h; else y2 = y1 + h;
        }
      }
    }
    const nx = Math.round(Math.min(x1, x2)), ny = Math.round(Math.min(y1, y2));
    this.rect = { x: nx, y: ny, w: Math.max(1, Math.round(Math.max(x1, x2)) - nx), h: Math.max(1, Math.round(Math.max(y1, y2)) - ny) };
    void d;
    this.app.view.requestRender();
  }
  up() {
    if (this.drag?.mode === 'new' && (this.rect.w < 4 || this.rect.h < 4)) this.reset();
    this.drag = null;
    this.app.refreshOptions();
  }
  cancel() { if (this.drag) { this.rect = this.drag.r0; this.drag = null; } }
  apply() {
    const d = this.doc; if (!d || !this.rect) return;
    const r = this.rect;
    if (r.x === 0 && r.y === 0 && r.w === d.width && r.h === d.height) { toast('Tracez d\'abord le cadre à garder.'); return; }
    this.app.commit('Recadrage', cropState(d.committed, r, this.s.deletePixels));
    this.app.view.fit(true);
    this.reset();
    this.app.refreshOptions();
  }
  key(e, k) {
    if (k === 'enter') { this.apply(); return true; }
    if (k === 'escape') { this.reset(); this.app.refreshOptions(); return true; }
    return false;
  }
  overlay(ctx, view) {
    const d = this.doc; if (!d) return;
    if (!this.rect || this.rectDoc !== d.id || (this.dims !== `${d.width}x${d.height}` && !this.drag)) this.reset();
    const H = this._handles(view), A = H.A, B = H.B;
    ctx.save();
    ctx.fillStyle = 'rgba(12,8,6,.58)';
    ctx.beginPath();
    ctx.rect(0, 0, view.cssW, view.cssH);
    ctx.rect(A.x, A.y, B.x - A.x, B.y - A.y);
    ctx.fill('evenodd');
    ctx.strokeStyle = 'rgba(255,255,255,.45)'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (const k of [1, 2]) {
      const x = A.x + (B.x - A.x) * k / 3, y = A.y + (B.y - A.y) * k / 3;
      ctx.moveTo(x, A.y); ctx.lineTo(x, B.y); ctx.moveTo(A.x, y); ctx.lineTo(B.x, y);
    }
    ctx.stroke();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
    ctx.strokeRect(A.x, A.y, B.x - A.x, B.y - A.y);
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#C9804F';
    for (const k of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
      const [x, y] = H[k];
      ctx.beginPath(); ctx.rect(x - 5, y - 5, 10, 10); ctx.fill(); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(0,0,0,.6)';
    const label = `${this.rect.w} × ${this.rect.h}`;
    ctx.font = '12px system-ui, sans-serif';
    const tw = ctx.measureText(label).width;
    ctx.fillRect(A.x, B.y + 6, tw + 12, 20);
    ctx.fillStyle = '#fff'; ctx.fillText(label, A.x + 6, B.y + 20);
    ctx.restore();
  }
  options(bar) {
    const s = this.s;
    bar.append(
      optSelect('Proportions', s.ratio, RATIOS, v => { s.ratio = v; this.save(); this.reset(); }),
      optCheck('Supprimer les pixels recadrés', s.deletePixels, v => { s.deletePixels = v; this.save(); }),
      optButton('✓ Valider', () => this.apply(), 'primary'),
      optButton('Annuler', () => { this.reset(); }),
      el('span', { class: 'opt-hint' }, 'Entrée : valider · Échap : annuler · Maj : garder les proportions'));
  }
}

export function createTools(app) {
  return {
    brush: new BrushTool(app, 'brush', false),
    eraser: new BrushTool(app, 'eraser', true),
    eyedropper: new EyedropperTool(app, 'eyedropper'),
    bucket: new BucketTool(app, 'bucket'),
    gradient: new GradientTool(app, 'gradient'),
    shapes: new ShapesTool(app, 'shapes'),
    text: new TextTool(app, 'text'),
    crop: new CropTool(app, 'crop'),
  };
}

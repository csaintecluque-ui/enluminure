// Enluminure — outils de l'étape 2 : pinceau, gomme, pipette, pot de peinture, dégradé, texte, formes, recadrage
import { el, clamp, mkLayer, newCanvas, ctxOf, freeCanvas, cloneCanvas, isTouch } from './util.js';
import { updateLayer, insertLayer, nextLayerName, cropState, pickLayerAt } from './ops.js';
import { layerRect } from './render.js';
import {
  prepareTarget, ensurePaintable, commitPixels, Stroke, sampleColor, floodRegion, maskToCanvas, drawGradient,
  renderText, ensureFont, renderShape, FONTS, rgba, lumOf, selIn, healPixels, findHealOffset,
} from './paint.js';
import { applyBuf } from './document.js';
import { isGroup, isAdjust, moveItems, effectiveVisible } from './tree.js';
import { selRect, selPolygon, selFromRegion, combineSel, moveSel, selContains, cutOut, clipSelToDoc, featherSel, alphaBounds, trimSel } from './selection.js';
import { openDialog, field, toast } from './ui.js';
import { smartT, updateSmart } from './smart.js';
import * as AI from './ai.js';
import { aiRun, aiInpaint, selectSubject } from './aiui.js';

export const DEFAULT_SETTINGS = {
  move: { autoSelect: false },
  marquee: { shape: 'rect', mode: 'new', feather: 0, ratio: 'free' },
  lasso: { kind: 'free', mode: 'new', feather: 0 },
  wand: { mode: 'new', tolerance: 32, contiguous: true, all: false },
  transform: { keepRatio: true },
  brush: { size: 30, hardness: 0.8, opacity: 1, flow: 1, pSize: true, pOpacity: false },
  eraser: { size: 50, hardness: 0.8, opacity: 1, flow: 1, pSize: true, pOpacity: false },
  stamp: { size: 60, hardness: 0.5, opacity: 1, flow: 1, pSize: true, pOpacity: false, aligned: true, all: false },
  heal: { size: 40, hardness: 0.6, mode: 'spot', aligned: true, all: false, pSize: true },
  remove: { size: 60, hardness: 0.7, all: false, pSize: true },
  objsel: { mode: 'new', feather: 0 },
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
  let cur = uiv;
  const set = (v, from) => {
    if (v === '' || v == null || Number.isNaN(+v)) { num.value = cur; return; } // saisie vide ou invalide : on garde l'ancienne valeur
    v = clamp(+v, min, max);
    cur = v;
    if (from !== 'num' || +num.value !== v) num.value = v;
    if (from !== 'range') range.value = toRange(v);
    onChange(fromUi(v));
  };
  range.addEventListener('input', () => set(fromRange(range.value), 'range'));
  num.addEventListener('change', () => set(num.value, 'num'));
  num.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') num.blur(); });
  const wrap = el('label', { class: 'opt opt-range' }, el('span', {}, label), range, num, unit ? el('span', { class: 'opt-unit' }, unit) : null);
  wrap.update = (v) => { const u = toUi(v); cur = u; num.value = u; range.value = toRange(u); };
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
    if (!effectiveVisible(d.committed.layers, L)) { toast('Ce calque est masqué : affichez-le pour le modifier.'); return null; }
    if (L.smart && d.target !== 'mask') { this.app.smartBlocked(L); return null; }
    if ((isGroup(L) || isAdjust(L)) && !(d.target === 'mask' && L.mask)) { toast(isAdjust(L) ? 'Un calque de réglage n\'a pas de pixels : peignez sur son masque ou choisissez un autre calque.' : 'Choisissez un calque, pas un groupe.'); return null; }
    return L;
  }
  /** Cible préparée (pixels du calque ou masque), ou null. */
  target() {
    const L = this.paintLayer();
    if (!L) return null;
    return prepareTarget(this.doc, L.id);
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
    const wasText = !!L.text && d.target !== 'mask';
    const prepared = prepareTarget(d, L.id);
    if (!prepared) return false;
    this.stroke = new Stroke(this.app, prepared, { ...s, color: this.app.colors.fg, bg: this.app.colors.bg, erase: this.erase });
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

// ——— Tampon de duplication et correcteur : outils qui prélèvent une « source » ———
class SourceTool extends BrushTool {
  constructor(app, id) { super(app, id, false); this.source = null; this.offset = null; this.pickNext = false; }
  usesSource() { return true; }
  setSource(p) {
    this.source = { x: Math.round(p.x), y: Math.round(p.y), doc: this.doc.id };
    this.offset = null;
    this.pickNext = false;
    toast('Source choisie : peignez maintenant sur la zone à corriger.', 1800);
    this.app.refreshOptions();
    this.app.view.requestRender();
  }
  /** Décalage (document) vers la source pour un trait qui commence en p, ou null. */
  startOffset(p) {
    const src = this.source;
    if (!src || src.doc !== this.doc.id) {
      toast(isTouch ? 'Touchez « Choisir la source », puis la zone à recopier.' : 'Alt + clic sur la zone à recopier pour choisir la source.', 3500);
      return null;
    }
    if (!this.s.aligned || !this.offset) this.offset = { dx: Math.round(src.x - p.x), dy: Math.round(src.y - p.y) };
    return this.offset;
  }
  /** Calque dont on modifie les pixels (pas le masque). */
  pixelLayer() {
    const L = this.paintLayer(); if (!L) return null;
    if (this.doc.target === 'mask') { toast('Cet outil travaille sur les pixels : cliquez sur la vignette du calque (pas sur son masque).', 3500); return null; }
    return L.canvas ? L : null;
  }
  /** Où l'on prélève : le calque lui-même, ou une copie de toute l'image (calques visibles). */
  sampleSource(P) {
    if (this.s.all) return { src: cloneCanvas(this.doc.composite()), sx: P.ox, sy: P.oy, snap: true };
    return { src: P.canvas, sx: 0, sy: 0, snap: false };
  }
  overlay(ctx, view) {
    super.overlay(ctx, view);
    const src = this.source;
    if (!this.usesSource() || !src || src.doc !== this.doc?.id) return;
    const pt = view.action ? view.lastPt : view.hover;
    let q;
    if (pt && this.offset && (view.action || this.s.aligned)) {
      const d = view.toDoc(pt);
      q = view.toScreen({ x: d.x + this.offset.dx, y: d.y + this.offset.dy });
    } else q = view.toScreen(src);
    const r = Math.max(4, this.s.size * view.doc.view.zoom / 2);
    ctx.save();
    for (const [w, c] of [[3, 'rgba(0,0,0,.55)'], [1, 'rgba(255,255,255,.95)']]) {
      ctx.lineWidth = w; ctx.strokeStyle = c;
      ctx.beginPath();
      ctx.moveTo(q.x - 9, q.y); ctx.lineTo(q.x + 9, q.y); ctx.moveTo(q.x, q.y - 9); ctx.lineTo(q.x, q.y + 9);
      ctx.stroke();
      if (view.action || (pt && this.offset && this.s.aligned)) { ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, Math.PI * 2); ctx.stroke(); }
    }
    ctx.restore();
  }
  sourceOptions(bar) {
    const s = this.s;
    const has = this.source && this.source.doc === this.doc?.id;
    bar.append(
      optCheck('Aligné', s.aligned, v => { s.aligned = v; this.offset = null; this.save(); }),
      optSelect('Prélever', s.all ? 'all' : 'layer', [['layer', 'Calque actif'], ['all', 'Tous les calques']], v => { s.all = v === 'all'; this.save(); }),
      optButton(this.pickNext ? 'Touchez la source…' : 'Choisir la source', () => {
        this.pickNext = !this.pickNext; this.app.refreshOptions();
        if (this.pickNext) toast('Touchez la zone à recopier.', 2000);
      }, this.pickNext ? 'primary' : ''),
      el('span', { class: 'opt-hint' }, has ? 'Alt + clic : nouvelle source' : 'Alt + clic : choisir la source'));
  }
}

class StampTool extends SourceTool {
  down(p, e) {
    if (e.altKey || this.pickNext) { this.setSource(p); return false; }
    const L = this.pixelLayer(); if (!L) return false;
    const off = this.startOffset(p); if (!off) return false;
    const wasText = !!L.text;
    const P = prepareTarget(this.doc, L.id); if (!P) return false;
    const smp = this.sampleSource(P);
    this.snap = smp.snap ? smp.src : null;
    this.stroke = new Stroke(this.app, P, { ...this.s, color: '#000000', erase: false, clone: { src: smp.src, sx: smp.sx + off.dx, sy: smp.sy + off.dy } });
    this.stroke.point(p.x, p.y, pressureOf(e));
    this.stroke.flush();
    if (wasText) toast('Le calque de texte devient une image.');
    return true;
  }
  up() {
    if (!this.stroke) return;
    this.stroke.end('Tampon de duplication');
    this.stroke = null;
    freeCanvas(this.snap); this.snap = null;
  }
  cancel() { super.cancel(); freeCanvas(this.snap); this.snap = null; }
  options(bar) {
    const s = this.s;
    this.sizeCtl = optRange('Taille', s.size, { min: 1, max: 1000, log: true, unit: 'px' }, v => { s.size = v; this.save(); this.app.view.requestRender(); });
    bar.append(this.sizeCtl,
      optRange('Dureté', s.hardness, { min: 0, max: 100, pct: true, unit: '%' }, v => { s.hardness = v; this.save(); }),
      optRange('Opacité', s.opacity, { min: 1, max: 100, pct: true, unit: '%' }, v => { s.opacity = v; this.save(); }),
      optRange('Flux', s.flow, { min: 1, max: 100, pct: true, unit: '%' }, v => { s.flow = v; this.save(); }));
    this.sourceOptions(bar);
  }
}

class HealTool extends SourceTool {
  usesSource() { return this.s.mode === 'source'; }
  down(p, e) {
    const s = this.s;
    if (s.mode === 'source' && (e.altKey || this.pickNext)) { this.setSource(p); return false; }
    if (e.altKey) { toast('Passez en mode « Avec source » pour choisir vous-même la zone à recopier.'); return false; }
    const L = this.pixelLayer(); if (!L) return false;
    let off = null;
    if (s.mode === 'source') { off = this.startOffset(p); if (!off) return false; }
    const P = prepareTarget(this.doc, L.id); if (!P) return false;
    this.off = off ? { ...off } : null;
    this.smp = this.sampleSource(P);
    // Pendant le geste : un voile sombre montre la zone à corriger ; le calcul se fait au lâcher.
    this.stroke = new Stroke(this.app, P, { size: s.size, hardness: s.hardness, flow: 1, opacity: 0.45, pSize: s.pSize, pOpacity: false, color: '#2a2320', erase: false });
    this.stroke.point(p.x, p.y, pressureOf(e));
    this.stroke.flush();
    return true;
  }
  up() {
    const st = this.stroke, smp = this.smp;
    if (!st) return;
    this.stroke = null; this.smp = null;
    try { this.heal(st, smp, this.off); }
    catch (err) { console.error(err); toast('La correction a échoué.'); this.doc.cancelPreview(); this.app.refresh({ history: false }); }
    finally { freeCanvas(st.buf); freeCanvas(st.dabC); if (smp.snap) freeCanvas(smp.src); }
  }
  cancel() { super.cancel(); if (this.smp?.snap) freeCanvas(this.smp.src); this.smp = null; }
  key(e, k) {
    if (k === 'j' && e.shiftKey) { this.app.setTool('remove'); return true; }
    return (k === '[' || k === ']') ? super.key(e, k) : false;
  }
  heal(st, smp, off) {
    const doc = this.doc, P = st.P, c = P.canvas, s = this.s;
    const abort = () => { doc.cancelPreview(); this.app.refresh({ history: false }); };
    if (doc.live !== st.live || !st.bounds) return abort();
    const pad = Math.max(3, Math.round(s.size * 0.25)), b = st.bounds;
    const x0 = clamp(b.x - pad, 0, c.width), y0 = clamp(b.y - pad, 0, c.height);
    const x1 = clamp(b.x + b.w + pad, 0, c.width), y1 = clamp(b.y + b.h + pad, 0, c.height);
    const B = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, W = B.w, H = B.h;
    if (W < 2 || H < 2) return abort();
    // Masque de la retouche : le geste, limité à la sélection
    const tmp = newCanvas(W, H), tc = ctxOf(tmp);
    tc.drawImage(st.buf, B.x, B.y, W, H, 0, 0, W, H);
    const sel = st.live.sel;
    if (sel) { tc.globalCompositeOperation = 'destination-in'; tc.drawImage(sel.canvas, sel.ox - B.x, sel.oy - B.y); }
    const md = tc.getImageData(0, 0, W, H).data;
    freeCanvas(tmp);
    const M = new Float32Array(W * H);
    let any = false;
    for (let i = 0; i < M.length; i++) { const a = md[i * 4 + 3] / 255; M[i] = a; if (a > 0.001) any = true; }
    if (!any) return abort();
    const sctx = ctxOf(smp.src);
    const Bs = { x: B.x + smp.sx, y: B.y + smp.sy, w: W, h: H };
    if (!off) { // correcteur localisé : on cherche tout seul la meilleure source autour
      const big = Math.max(W, H);
      const R = Math.ceil(Math.max(3.2 * s.size, big <= s.size * 4 ? 1.3 * big : 0)) + 2;
      const ex = Math.max(0, Bs.x - R), ey = Math.max(0, Bs.y - R);
      const ex2 = Math.min(smp.src.width, Bs.x + W + R), ey2 = Math.min(smp.src.height, Bs.y + H + R);
      const f = findHealOffset(sctx.getImageData(ex, ey, ex2 - ex, ey2 - ey), ex, ey, Bs, M, s.size);
      if (!f) { toast('Pas de zone voisine utilisable : essayez le mode « Avec source ».', 3500); return abort(); }
      off = { dx: f.ox, dy: f.oy };
    }
    const T = smp.snap ? sctx.getImageData(Bs.x, Bs.y, W, H) : ctxOf(c).getImageData(B.x, B.y, W, H);
    const S = sctx.getImageData(Bs.x + off.dx, Bs.y + off.dy, W, H);
    const out = healPixels(T, S, M, smp.snap);
    commitPixels(this.app, s.mode === 'source' ? 'Correcteur' : 'Correcteur localisé', P.layer.id, { x: B.x + P.ox, y: B.y + P.oy, w: W, h: H }, (ctx, P2, r) => {
      if (smp.snap) { // prélèvement sur toute l'image : on pose la retouche par-dessus le calque
        const t = newCanvas(W, H);
        ctxOf(t).putImageData(out, 0, 0);
        ctx.drawImage(t, r.x, r.y);
        freeCanvas(t);
      } else ctx.putImageData(out, r.x, r.y);
    }, P);
  }
  options(bar) {
    const s = this.s;
    bar.append(optSelect('', s.mode, [['spot', 'Localisé (automatique)'], ['source', 'Avec source']], v => { s.mode = v; this.save(); this.app.refreshOptions(); this.app.view.requestRender(); }));
    this.sizeCtl = optRange('Taille', s.size, { min: 1, max: 1000, log: true, unit: 'px' }, v => { s.size = v; this.save(); this.app.view.requestRender(); });
    bar.append(this.sizeCtl,
      optRange('Dureté', s.hardness, { min: 0, max: 100, pct: true, unit: '%' }, v => { s.hardness = v; this.save(); }));
    if (s.mode === 'source') this.sourceOptions(bar);
    else bar.append(
      optSelect('Prélever', s.all ? 'all' : 'layer', [['layer', 'Calque actif'], ['all', 'Tous les calques']], v => { s.all = v === 'all'; this.save(); }),
      el('span', { class: 'opt-hint' }, 'Peignez sur le défaut : la correction se fait au lâcher'));
  }
}

// ——— Suppression (gomme magique IA) : on peint sur l'objet, l'IA le remplace par le décor ———
class RemoveTool extends SourceTool {
  usesSource() { return false; }
  down(p, e) {
    if (this.busy) return false;
    const L = this.pixelLayer(); if (!L) return false;
    const P = prepareTarget(this.doc, L.id); if (!P) return false;
    const s = this.s;
    this.stroke = new Stroke(this.app, P, { size: s.size, hardness: s.hardness, flow: 1, opacity: 0.5, pSize: s.pSize, pOpacity: false, color: '#d0503c', erase: false });
    this.stroke.point(p.x, p.y, pressureOf(e));
    this.stroke.flush();
    return true;
  }
  async up() {
    const st = this.stroke;
    if (!st) return;
    this.stroke = null;
    const d = this.doc, P = st.P;
    if (d.live !== st.live || !st.bounds) { st.cancel(); return; }
    this.busy = true;
    try {
      const sel = d.committed.selection;
      await aiInpaint(this.app, {
        layerId: P.layer.id, prepared: P, sampleAll: this.s.all, label: 'Suppression (IA)',
        mask: { canvas: st.buf, x: P.ox, y: P.oy }, limit: sel ? { canvas: sel.canvas, x: sel.x, y: sel.y } : null,
      });
    } finally {
      this.busy = false;
      freeCanvas(st.buf); freeCanvas(st.dabC);
    }
  }
  key(e, k) {
    if (k === 'j' && e.shiftKey) { this.app.setTool('heal'); return true; }
    return (k === '[' || k === ']') ? super.key(e, k) : false;
  }
  options(bar) {
    const s = this.s;
    this.sizeCtl = optRange('Taille', s.size, { min: 1, max: 1000, log: true, unit: 'px' }, v => { s.size = v; this.save(); this.app.view.requestRender(); });
    bar.append(this.sizeCtl,
      optSelect('Prélever', s.all ? 'all' : 'layer', [['layer', 'Calque actif'], ['all', 'Tous les calques']], v => { s.all = v === 'all'; this.save(); }),
      el('span', { class: 'opt-hint' }, "Peignez sur ce qu'il faut faire disparaître : l'IA le remplace au lâcher"));
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
    const sel = d.committed.selection;
    if (sel && !selContains(sel, px, py)) return false;
    const color = this.app.colors.fg;
    await this.app.withBusy('Remplissage…', async () => {
      const P = prepareTarget(d, L.id);
      if (!P) return;
      const W = d.width, H = d.height;
      const img = s.all && P.target === 'layer'
        ? ctxOf(d.composite()).getImageData(0, 0, W, H)
        : ctxOf(P.canvas).getImageData(-P.ox, -P.oy, W, H);
      const region = floodRegion(img, px, py, s.tolerance, s.contiguous);
      if (!region) return;
      const fill = maskToCanvas(region, P.target === 'mask' ? '#000000' : color);
      const r = region.rect;
      const si = selIn(P);
      if (si) { const fc = ctxOf(fill); fc.globalCompositeOperation = 'destination-in'; fc.drawImage(si.canvas, si.ox - (r.x - P.ox), si.oy - (r.y - P.oy)); }
      commitPixels(this.app, 'Pot de peinture', L.id, r, (ctx, T) => {
        applyBuf(ctx, fill, 0, 0, r.x - T.ox, r.y - T.oy, r.w, r.h, { alpha: s.opacity, op: 'source-over', lum: T.target === 'mask' ? lumOf(color) : null });
      }, P);
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
    this.prepared = prepareTarget(d, L.id);
    if (!this.prepared) return false;
    const base = this.prepared.canvas;
    this.pc = newCanvas(base.width, base.height);
    ctxOf(this.pc).drawImage(base, 0, 0);
    this.a = { x: p.x, y: p.y }; this.b = null;
    if (this.prepared.state !== d.committed) d.setPreview(this.prepared.state);
    d.setLive({ layerId: L.id, canvas: this.pc, target: this.prepared.target });
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
    const P = this.prepared, s = this.s, { fg, bg } = this.app.colors;
    const W = this.pc.width, H = this.pc.height;
    const onMask = P.target === 'mask';
    const ctx = ctxOf(this.pc);
    ctx.save();
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(P.canvas, 0, 0);
    ctx.restore();
    // le dégradé seul, limité à la sélection
    const g = newCanvas(W, H);
    const gctx = ctxOf(g);
    const c0 = onMask ? `rgba(0,0,0,${lumOf(fg)})` : fg;
    const c1 = onMask ? (s.toTransparent ? 'rgba(0,0,0,0)' : `rgba(0,0,0,${lumOf(bg)})`) : (s.toTransparent ? rgba(fg, 0) : bg);
    drawGradient(gctx, W, H, { x: this.a.x - P.ox, y: this.a.y - P.oy }, { x: b.x - P.ox, y: b.y - P.oy }, { type: s.type, c0, c1, reverse: s.reverse, opacity: 1 });
    const si = selIn(P);
    if (si) { gctx.globalCompositeOperation = 'destination-in'; gctx.drawImage(si.canvas, si.ox, si.oy); }
    if (onMask) { // masque : on remplace la valeur (pondérée par l'opacité) là où on applique le dégradé
      ctx.save();
      ctx.globalAlpha = s.opacity;
      ctx.globalCompositeOperation = 'destination-out';
      if (si) ctx.drawImage(si.canvas, si.ox, si.oy); else ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(g, 0, 0);
      ctx.restore();
    } else {
      ctx.save(); ctx.globalAlpha = s.opacity; ctx.drawImage(g, 0, 0); ctx.restore();
    }
    freeCanvas(g);
    this.doc.invalidate();
  }
  up() {
    const d = this.doc;
    if (!this.pc) return;
    const ok = this.b && Math.hypot(this.b.x - this.a.x, this.b.y - this.a.y) >= 2 && d.live?.canvas === this.pc;
    if (ok) {
      const P = this.prepared, base = P.layer;
      const st = P.target === 'mask'
        ? updateLayer(P.state, base.id, { mask: { ...base.mask, canvas: this.pc } })
        : updateLayer(P.state, base.id, { canvas: this.pc, text: null });
      const old = d.committed.layers.find(l => l.id === base.id);
      if (P.canvas !== (P.target === 'mask' ? old?.mask?.canvas : old?.canvas)) freeCanvas(P.canvas);
      this.app.commit(P.target === 'mask' ? 'Dégradé (masque)' : 'Dégradé', st);
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
      el('span', { class: 'opt-actions' }, optButton('✓ Valider', () => this.apply(), 'primary'), optButton('Annuler', () => { this.reset(); })),
      el('span', { class: 'opt-hint' }, 'Entrée : valider · Échap : annuler · Maj : garder les proportions'));
  }
}


// ——— Déplacer (calques, groupes, ou pixels sélectionnés) ———
class MoveTool extends Tool {
  cursor() { return 'move'; }
  down(p, e) {
    const d = this.doc; if (!d) return false;
    const st = d.committed;
    if (this.app.opts.autoSelect || e.ctrlKey || e.metaKey) {
      const hit = pickLayerAt(st, p.x, p.y);
      if (hit && hit !== d.activeId) { this.app.selectLayer(hit); }
    }
    const L = st.layers.find(l => l.id === d.activeId);
    if (!L) { toast('Aucun calque sélectionné'); return false; }
    if (!effectiveVisible(st.layers, L)) { toast('Ce calque est masqué : affichez-le pour le déplacer.'); return false; }
    if (st.selection && !isGroup(L) && !L.smart && d.target === 'layer') return this.startPixels(p, L);
    const ids = d.selIds.size > 1 && d.selIds.has(L.id) ? [...d.selIds] : [L.id];
    this.m = { type: 'items', ids, p0: p, dx: 0, dy: 0 };
    return true;
  }
  _cut(L) {
    const d = this.doc;
    const P = ensurePaintable(d, L.id);
    const sel = P.state.selection;
    const fl = cutOut(P.canvas, P.ox, P.oy, sel);
    if (!fl) { toast('Rien de sélectionné sur ce calque.'); return null; }
    const holed = newCanvas(P.canvas.width, P.canvas.height);
    const hctx = ctxOf(holed);
    hctx.drawImage(P.canvas, 0, 0);
    hctx.globalCompositeOperation = 'destination-out';
    hctx.drawImage(sel.canvas, sel.x - P.ox, sel.y - P.oy);
    return { P, sel, fl, holed };
  }
  startPixels(p, L) {
    const c = this._cut(L); if (!c) return false;
    this.m = { type: 'pixels', ...c, pc: newCanvas(c.P.canvas.width, c.P.canvas.height), p0: p, dx: 0, dy: 0 };
    this._renderPixels();
    return true;
  }
  _renderPixels() {
    const m = this.m, d = this.doc;
    const ctx = ctxOf(m.pc);
    ctx.save();
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(m.holed, 0, 0);
    ctx.restore();
    ctx.drawImage(m.fl.canvas, m.fl.x - m.P.ox + m.dx, m.fl.y - m.P.oy + m.dy);
    d.setPreview({ ...m.P.state, selection: moveSel(m.sel, m.dx, m.dy) });
    d.setLive({ layerId: m.P.layer.id, canvas: m.pc, target: 'layer' });
  }
  move(p, e) {
    const m = this.m; if (!m) return;
    let dx = Math.round(p.x - m.p0.x), dy = Math.round(p.y - m.p0.y);
    if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    if (dx === m.dx && dy === m.dy) return;
    m.dx = dx; m.dy = dy;
    if (m.type === 'items') this.doc.setPreview(moveItems(this.doc.committed, m.ids, dx, dy));
    else this._renderPixels();
  }
  _commitPixels(m) {
    const sel = m.sel, P = m.P;
    const r0 = { x: sel.x, y: sel.y, w: sel.canvas.width, h: sel.canvas.height };
    const r = { x: Math.min(r0.x, r0.x + m.dx), y: Math.min(r0.y, r0.y + m.dy), w: r0.w + Math.abs(m.dx), h: r0.h + Math.abs(m.dy) };
    commitPixels(this.app, 'Déplacer la sélection', P.layer.id, r, (ctx, T) => {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(sel.canvas, sel.x - T.ox, sel.y - T.oy);
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(m.fl.canvas, m.fl.x - T.ox + m.dx, m.fl.y - T.oy + m.dy);
    }, { ...P, state: { ...P.state, selection: moveSel(sel, m.dx, m.dy) } });
  }
  _free(m) { if (m?.type === 'pixels') { freeCanvas(m.pc); freeCanvas(m.holed); freeCanvas(m.fl.canvas); } }
  up() {
    const m = this.m; this.m = null;
    if (!m) return;
    const d = this.doc;
    if (!m.dx && !m.dy) { d.cancelPreview(); this._free(m); return; }
    if (m.type === 'items') this.app.commit('Déplacer', moveItems(d.committed, m.ids, m.dx, m.dy));
    else this._commitPixels(m);
    this._free(m);
  }
  cancel() { this.doc?.cancelPreview(); this._free(this.m); this.m = null; }
  /** Flèches du clavier. */
  nudge(dx, dy) {
    const d = this.doc, L = d?.active; if (!L) return;
    const st = d.committed;
    if (st.selection && !isGroup(L) && d.target === 'layer') {
      const c = this._cut(L); if (!c) return;
      const m = { type: 'pixels', ...c, dx, dy };
      this._commitPixels(m);
      freeCanvas(c.holed); freeCanvas(c.fl.canvas);
      return;
    }
    const ids = d.selIds.size > 1 && d.selIds.has(L.id) ? [...d.selIds] : [L.id];
    this.app.commit('Déplacer', moveItems(st, ids, dx, dy), { mergeKey: `nudge:${ids.join()}` });
  }
  overlay(ctx, view) {
    const d = this.doc;
    if (!this.app.opts.showBounds || !d) return;
    const st = d.state, L = st.layers.find(l => l.id === d.activeId);
    if (!L || (st.selection && !isGroup(L))) return;
    const leaves = isGroup(L) ? st.layers.filter(l => !isGroup(l) && l.canvas && isInside(st.layers, l, L.id)) : [L];
    let r = null;
    for (const l of leaves) { const b = layerRect(l); if (!b.w) continue; r = r ? { x: Math.min(r.x, b.x), y: Math.min(r.y, b.y), x2: Math.max(r.x2, b.x + b.w), y2: Math.max(r.y2, b.y + b.h) } : { x: b.x, y: b.y, x2: b.x + b.w, y2: b.y + b.h }; }
    if (!r) return;
    const A = view.toScreen({ x: r.x, y: r.y }), B = view.toScreen({ x: r.x2, y: r.y2 });
    ctx.save();
    // trait plein et coins marqués : on ne le confond pas avec les pointillés d'une sélection
    const x = Math.round(A.x) + 0.5, y = Math.round(A.y) + 0.5, w = Math.round(B.x - A.x), h = Math.round(B.y - A.y);
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(201,128,79,.9)';
    ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = '#C9804F';
    for (const [cx, cy] of [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]) ctx.fillRect(cx - 3, cy - 3, 6, 6);
    ctx.restore();
  }
  options(bar) {
    const o = this.app.opts;
    bar.append(
      optCheck('Sélection auto du calque', o.autoSelect, v => { o.autoSelect = v; this.save(); }),
      optCheck('Afficher les bords', o.showBounds, v => { o.showBounds = v; this.save(); this.app.view.requestRender(); }),
      optButton('Transformation (Ctrl+T)', () => this.app.run('freeTransform')),
      el('span', { class: 'opt-hint' }, 'Flèches : 1 px (Maj : 10 px) · Avec une sélection, déplace les pixels sélectionnés'));
  }
}
function isInside(layers, l, gid) {
  const map = new Map(layers.map(x => [x.id, x]));
  let p = l.parent;
  while (p) { if (p === gid) return true; p = map.get(p)?.parent; }
  return false;
}

// ——— Sélections ———
const MODES = [['new', '▢', 'Nouvelle sélection'], ['add', '+', 'Ajouter (Maj)'], ['sub', '−', 'Soustraire (Alt)'], ['inter', '∩', 'Intersection (Maj+Alt)']];
function modeButtons(tool) {
  const s = tool.s;
  const seg = el('div', { class: 'seg', title: 'Mode de sélection' });
  for (const [v, label, title] of MODES) {
    const b = el('button', { type: 'button', class: `btn small ${s.mode === v ? 'on' : ''}`, title, 'aria-label': title }, label);
    b.addEventListener('click', () => { s.mode = v; tool.save(); tool.app.refreshOptions(); });
    seg.append(b);
  }
  return seg;
}
class SelectTool extends Tool {
  cursor() { return 'crosshair'; }
  modeFor(e) { if (e.shiftKey && e.altKey) return 'inter'; if (e.shiftKey) return 'add'; if (e.altKey) return 'sub'; return this.s.mode; }
  /** Glisser dans la sélection existante : on déplace son contour. */
  tryMoveSel(p, e) {
    const sel = this.doc.committed.selection;
    if (this.modeFor(e) === 'new' && sel && selContains(sel, p.x, p.y)) { this.ms = { p0: p, sel, dx: 0, dy: 0 }; return true; }
    return false;
  }
  moveSelTo(p) {
    const m = this.ms;
    m.dx = Math.round(p.x - m.p0.x); m.dy = Math.round(p.y - m.p0.y);
    this.doc.setPreview({ ...this.doc.committed, selection: moveSel(m.sel, m.dx, m.dy) });
  }
  endMoveSel() {
    const m = this.ms; this.ms = null;
    if (m.dx || m.dy) this.app.commit('Déplacer la sélection', { ...this.doc.committed, selection: moveSel(m.sel, m.dx, m.dy) });
    else { this.doc.cancelPreview(); this.app.refresh({ history: false }); }
  }
  finish(neu, mode, label) {
    const d = this.doc;
    neu = clipSelToDoc(neu, d.width, d.height);
    if (neu && this.s.feather) neu = featherSel(neu, this.s.feather);
    this.app.setSelection(combineSel(d.committed.selection, neu, mode), label);
  }
  cancel() { if (this.ms) { this.doc.cancelPreview(); this.ms = null; } this.drag = null; }
  featherOpt() {
    return optRange('Contour progressif', this.s.feather, { min: 0, max: 250, unit: 'px' }, v => { this.s.feather = v; this.save(); });
  }
}

const SEL_RATIOS = [['free', 'Libre'], ['1:1', '1:1'], ['4:3', '4:3'], ['3:2', '3:2'], ['16:9', '16:9'], ['3:4', '3:4'], ['9:16', '9:16']];
class MarqueeTool extends SelectTool {
  down(p, e) {
    if (!this.doc) return false;
    if (this.tryMoveSel(p, e)) return true;
    this.drag = { a: { x: p.x, y: p.y }, b: { x: p.x, y: p.y }, mode: this.modeFor(e), mods: { shift: e.shiftKey, alt: e.altKey }, center: false };
    return true;
  }
  move(p, e) {
    if (this.ms) { this.moveSelTo(p); return; }
    const g = this.drag; if (!g) return;
    let dx = p.x - g.a.x, dy = p.y - g.a.y;
    let ratio = this.s.ratio !== 'free' ? (([a, b]) => a / b)(this.s.ratio.split(':').map(Number)) : null;
    if (!ratio && e.shiftKey && !g.mods.shift) ratio = 1;
    if (ratio) {
      const w = Math.max(Math.abs(dx), Math.abs(dy) * ratio);
      dx = Math.sign(dx || 1) * w; dy = Math.sign(dy || 1) * w / ratio;
    }
    g.center = e.altKey && !g.mods.alt;
    g.b = { x: g.a.x + dx, y: g.a.y + dy };
    this.app.view.requestRender();
  }
  rect(g) {
    const dx = g.b.x - g.a.x, dy = g.b.y - g.a.y;
    return g.center ? { x0: g.a.x - dx, y0: g.a.y - dy, x1: g.a.x + dx, y1: g.a.y + dy } : { x0: g.a.x, y0: g.a.y, x1: g.b.x, y1: g.b.y };
  }
  up() {
    if (this.ms) { this.endMoveSel(); return; }
    const g = this.drag; this.drag = null;
    if (!g) return;
    const r = this.rect(g);
    if (Math.abs(r.x1 - r.x0) < 2 && Math.abs(r.y1 - r.y0) < 2) {
      if (g.mode === 'new' && this.doc.committed.selection) this.app.run('deselect');
      this.app.view.requestRender();
      return;
    }
    const ell = this.s.shape === 'ellipse';
    this.finish(selRect(r, ell), g.mode, ell ? 'Ellipse de sélection' : 'Rectangle de sélection');
  }
  overlay(ctx, view) {
    const g = this.drag; if (!g) return;
    const r = this.rect(g);
    const A = view.toScreen({ x: Math.min(r.x0, r.x1), y: Math.min(r.y0, r.y1) }), B = view.toScreen({ x: Math.max(r.x0, r.x1), y: Math.max(r.y0, r.y1) });
    ctx.save();
    ctx.beginPath();
    if (this.s.shape === 'ellipse') ctx.ellipse((A.x + B.x) / 2, (A.y + B.y) / 2, Math.abs(B.x - A.x) / 2, Math.abs(B.y - A.y) / 2, 0, 0, Math.PI * 2);
    else ctx.rect(A.x + 0.5, A.y + 0.5, B.x - A.x, B.y - A.y);
    antsStroke(ctx, view);
    ctx.restore();
  }
  options(bar) {
    const s = this.s;
    bar.append(
      optSelect('', s.shape, [['rect', 'Rectangle'], ['ellipse', 'Ellipse']], v => { s.shape = v; this.save(); }),
      modeButtons(this), this.featherOpt(),
      optSelect('Proportions', s.ratio, SEL_RATIOS, v => { s.ratio = v; this.save(); }),
      el('span', { class: 'opt-hint' }, 'Maj : carré / cercle · Alt : depuis le centre · Glisser dans la sélection pour la déplacer'));
  }
  key(e, k) { if (k === 'm' && e.shiftKey) { this.s.shape = this.s.shape === 'rect' ? 'ellipse' : 'rect'; this.save(); this.app.refreshOptions(); return true; } return false; }
}

function antsStroke(ctx, view) {
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#fff'; ctx.setLineDash([]); ctx.stroke();
  ctx.strokeStyle = '#000'; ctx.setLineDash([4, 4]); ctx.lineDashOffset = -(view.antsPhase || 0); ctx.stroke();
}

class LassoTool extends SelectTool {
  down(p, e, view) {
    if (!this.doc) return false;
    if (this.s.kind === 'poly') {
      const now = Date.now();
      if (!this.poly) { if (this.tryMoveSel(p, e)) return true; this.poly = { pts: [{ x: p.x, y: p.y }], mode: this.modeFor(e) }; this.lastDown = now; this.app.view.requestRender(); return false; }
      const pts = this.poly.pts;
      const first = view.toScreen(pts[0]), sp = view.toScreen(p);
      const near = Math.hypot(sp.x - first.x, sp.y - first.y) < (e.pointerType === 'touch' ? 22 : 10);
      const dbl = now - this.lastDown < 350;
      this.lastDown = now;
      if ((near || dbl) && pts.length >= 3) { this.closePoly(); return false; }
      pts.push({ x: p.x, y: p.y });
      this.app.view.requestRender();
      return false;
    }
    if (this.tryMoveSel(p, e)) return true;
    this.drag = { pts: [{ x: p.x, y: p.y }], mode: this.modeFor(e) };
    return true;
  }
  closePoly() {
    const P = this.poly; this.poly = null;
    if (P && P.pts.length >= 3) this.finish(selPolygon(P.pts), P.mode, 'Lasso polygonal');
    this.app.view.requestRender();
  }
  move(p) {
    if (this.ms) { this.moveSelTo(p); return; }
    const g = this.drag; if (!g) return;
    const last = g.pts[g.pts.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) * this.doc.view.zoom >= 2) g.pts.push({ x: p.x, y: p.y });
    this.app.view.requestRender();
  }
  up() {
    if (this.ms) { this.endMoveSel(); return; }
    const g = this.drag; this.drag = null;
    if (!g) return;
    if (g.pts.length < 3) { if (g.mode === 'new' && this.doc.committed.selection) this.app.run('deselect'); return; }
    this.finish(selPolygon(g.pts), g.mode, 'Lasso');
  }
  deactivate() { this.poly = null; }
  overlay(ctx, view) {
    const pts = this.drag?.pts || this.poly?.pts;
    if (!pts || !pts.length) return;
    ctx.save();
    ctx.beginPath();
    pts.forEach((q, i) => { const s = view.toScreen(q); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); });
    if (this.poly && view.hover) ctx.lineTo(view.hover.x, view.hover.y);
    if (this.drag) ctx.closePath();
    antsStroke(ctx, view);
    if (this.poly) { const f = view.toScreen(pts[0]); ctx.setLineDash([]); ctx.fillStyle = '#C9804F'; ctx.beginPath(); ctx.arc(f.x, f.y, 5, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  }
  key(e, k) {
    if (k === 'l' && e.shiftKey) { this.s.kind = this.s.kind === 'free' ? 'poly' : 'free'; this.poly = null; this.save(); this.app.refreshOptions(); return true; }
    if (!this.poly) return false;
    if (k === 'enter') { this.closePoly(); return true; }
    if (k === 'escape') { this.poly = null; this.app.view.requestRender(); return true; }
    if (k === 'backspace' || k === 'delete') { this.poly.pts.pop(); if (!this.poly.pts.length) this.poly = null; this.app.view.requestRender(); return true; }
    return false;
  }
  options(bar) {
    const s = this.s;
    bar.append(
      optSelect('', s.kind, [['free', 'Lasso'], ['poly', 'Lasso polygonal']], v => { s.kind = v; this.poly = null; this.save(); this.app.refreshOptions(); }),
      modeButtons(this), this.featherOpt(),
      el('span', { class: 'opt-hint' }, s.kind === 'poly' ? 'Clic : ajouter un point · Clic sur le premier point ou double-clic : fermer · Échap : annuler' : 'Dessinez le contour à main levée'));
  }
}

class WandTool extends SelectTool {
  async down(p, e) {
    const d = this.doc; if (!d) return false;
    const px = Math.floor(p.x), py = Math.floor(p.y);
    if (px < 0 || py < 0 || px >= d.width || py >= d.height) return false;
    const s = this.s, mode = this.modeFor(e);
    const st = d.committed, L = st.layers.find(l => l.id === d.activeId);
    await this.app.withBusy('Sélection…', async () => {
      const W = d.width, H = d.height;
      let img;
      if (s.all || !L || isGroup(L) || !L.canvas) img = ctxOf(d.composite()).getImageData(0, 0, W, H);
      else img = ctxOf(L.canvas).getImageData(-L.x, -L.y, W, H);
      const region = floodRegion(img, px, py, s.tolerance, s.contiguous);
      if (!region) return;
      this.finish(selFromRegion(region), mode, 'Baguette magique');
    });
    return false;
  }
  options(bar) {
    const s = this.s;
    bar.append(modeButtons(this),
      optRange('Tolérance', s.tolerance, { min: 0, max: 255 }, v => { s.tolerance = v; this.save(); }),
      optCheck('Pixels contigus', s.contiguous, v => { s.contiguous = v; this.save(); }),
      optCheck('Tous les calques', s.all, v => { s.all = v; this.save(); }),
      el('span', { class: 'opt-hint' }, 'Maj : ajouter · Alt : soustraire'));
  }
  key(e, k) { if (k === 'w' && e.shiftKey) { this.app.setTool('objsel'); return true; } return false; }
}

// ——— Sélection d'objet (IA) : un clic sur l'objet, ou un cadre autour ———
/** Clé qui change dès que les pixels visibles changent (pas quand seule la sélection change). */
function pixelsKey(d) {
  const st = d.committed;
  const parts = st.layers.map(l => [l.id, l.canvas?._v || 0, l.canvas?.width, l.x, l.y, l.visible, l.opacity, l.blend, l.mask?.canvas?._v || 0, l.mask?.disabled, !!l.styles].join(','));
  return `${d.id}|${st.width}x${st.height}|${parts.join(';')}`;
}
class ObjectSelectTool extends SelectTool {
  down(p, e) {
    if (!this.doc || this.busy) return false;
    this.drag = { a: { x: p.x, y: p.y }, b: { x: p.x, y: p.y }, mode: this.modeFor(e) };
    return true;
  }
  move(p) {
    const g = this.drag; if (!g) return;
    g.b = { x: p.x, y: p.y };
    this.app.view.requestRender();
  }
  async up() {
    const g = this.drag; this.drag = null;
    if (!g) return;
    this.app.view.requestRender();
    const d = this.doc;
    const r = { x0: Math.min(g.a.x, g.b.x), y0: Math.min(g.a.y, g.b.y), x1: Math.max(g.a.x, g.b.x), y1: Math.max(g.a.y, g.b.y) };
    const isBox = r.x1 - r.x0 > 6 / d.view.zoom && r.y1 - r.y0 > 6 / d.view.zoom;
    if (!isBox && (g.a.x < 0 || g.a.y < 0 || g.a.x >= d.width || g.a.y >= d.height)) return;
    this.busy = true;
    try {
      await aiRun(async () => {
        await AI.samPrepare(pixelsKey(d), d.composite());
        AI.progress.show("Recherche de l'objet…");
        const res = await AI.samSegment(isBox ? { box: r } : { points: [{ x: g.a.x, y: g.a.y, label: 1 }] });
        if (!res) { toast("Aucun objet net ici : essayez un cadre autour de l'objet."); return; }
        const c = newCanvas(d.width, d.height), ctx = ctxOf(c);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(res.canvas, 0, 0, d.width, d.height);
        freeCanvas(res.canvas);
        const sel = trimSel({ canvas: c, x: 0, y: 0 });
        if (!sel) { toast('Aucun objet trouvé ici.'); return; }
        this.finish(sel, g.mode, "Sélection d'objet");
      });
    } finally { this.busy = false; }
  }
  overlay(ctx, view) {
    const g = this.drag; if (!g) return;
    const A = view.toScreen({ x: Math.min(g.a.x, g.b.x), y: Math.min(g.a.y, g.b.y) }), B = view.toScreen({ x: Math.max(g.a.x, g.b.x), y: Math.max(g.a.y, g.b.y) });
    if (B.x - A.x < 6 && B.y - A.y < 6) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(A.x + 0.5, A.y + 0.5, B.x - A.x, B.y - A.y);
    antsStroke(ctx, view);
    ctx.restore();
  }
  options(bar) {
    bar.append(modeButtons(this), this.featherOpt(),
      optButton('Sélectionner le sujet', () => selectSubject(this.app)),
      el('span', { class: 'opt-hint' }, "Cliquez sur un objet, ou tracez un cadre autour · Maj : ajouter · Alt : retirer"));
  }
  key(e, k) { if (k === 'w' && e.shiftKey) { this.app.setTool('wand'); return true; } return false; }
}

// ——— Transformation manuelle ———
const HANDLES = { nw: [-1, -1], n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0] };
const rot = (x, y, a) => ({ x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a) });
class TransformTool extends Tool {
  cursor() { return this.hoverCursor || 'default'; }
  begin() {
    const d = this.doc; if (!d) return false;
    const st = d.committed, L = st.layers.find(l => l.id === d.activeId);
    if (!L) { toast('Choisissez un calque.'); return false; }
    if (isGroup(L)) { toast('La transformation d\'un groupe arrivera plus tard : choisissez un calque.'); return false; }
    if (isAdjust(L) || !L.canvas) { toast('Choisissez un calque de pixels.'); return false; }
    if (!effectiveVisible(st.layers, L)) { toast('Ce calque est masqué.'); return false; }
    let src, rect;
    if (L.smart) { // objet dynamique : on repart toujours de l'image d'origine, sans perte
      src = L.smart.source;
      this.base = { state: st, layer: L, holed: null, smart: true };
      this.src = src; this.sw = src.width; this.sh = src.height;
      this.T = smartT(L);
      this.active = true;
      this.render();
      if (st.selection) toast('Objet dynamique : tout le calque est transformé.');
      return true;
    }
    if (st.selection) {
      const P = ensurePaintable(d, L.id);
      const sel = P.state.selection;
      const fl = cutOut(P.canvas, P.ox, P.oy, sel);
      if (!fl) { toast('Rien de sélectionné sur ce calque.'); return false; }
      const holed = newCanvas(P.canvas.width, P.canvas.height);
      const hctx = ctxOf(holed);
      hctx.drawImage(P.canvas, 0, 0);
      hctx.globalCompositeOperation = 'destination-out';
      hctx.drawImage(sel.canvas, sel.x - P.ox, sel.y - P.oy);
      src = fl.canvas; rect = { x: fl.x, y: fl.y, w: src.width, h: src.height };
      this.base = { state: P.state, layer: P.layer, holed, hx: P.ox, hy: P.oy, sel, fl };
    } else {
      const bb = alphaBounds(L.canvas);
      if (!bb) { toast('Ce calque est vide.'); return false; }
      if (bb.x === 0 && bb.y === 0 && bb.w === L.canvas.width && bb.h === L.canvas.height) src = L.canvas;
      else { src = newCanvas(bb.w, bb.h); ctxOf(src).drawImage(L.canvas, -bb.x, -bb.y); }
      rect = { x: L.x + bb.x, y: L.y + bb.y, w: bb.w, h: bb.h };
      this.base = { state: st, layer: L, holed: null };
    }
    this.src = src; this.sw = src.width; this.sh = src.height;
    this.T = { cx: rect.x + rect.w / 2, cy: rect.y + rect.h / 2, w: rect.w, h: rect.h, a: 0 };
    this.active = true;
    this.render();
    return true;
  }
  matrix(T = this.T) {
    return new DOMMatrix().translate(T.cx, T.cy).rotate(T.a * 180 / Math.PI).scale(T.w / this.sw, T.h / this.sh).translate(-this.sw / 2, -this.sh / 2);
  }
  corners(T = this.T) {
    const m = this.matrix(T);
    return [[0, 0], [this.sw, 0], [this.sw, this.sh], [0, this.sh]].map(([x, y]) => { const p = m.transformPoint({ x, y }); return { x: p.x, y: p.y }; });
  }
  /** Dessine le résultat ; `final` : toile neuve pour l'historique. */
  render(final = false) {
    const d = this.doc, B = this.base;
    const pts = this.corners();
    let x0 = Math.floor(Math.min(...pts.map(p => p.x))), y0 = Math.floor(Math.min(...pts.map(p => p.y)));
    let x1 = Math.ceil(Math.max(...pts.map(p => p.x))), y1 = Math.ceil(Math.max(...pts.map(p => p.y)));
    if (B.holed) { x0 = Math.min(x0, B.hx); y0 = Math.min(y0, B.hy); x1 = Math.max(x1, B.hx + B.holed.width); y1 = Math.max(y1, B.hy + B.holed.height); }
    const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
    if (w * h > 268_000_000 || w > 16384 || h > 16384) { toast('Trop grand pour le navigateur.'); return null; }
    let c = !final && this.pc && this.pc.width === w && this.pc.height === h ? this.pc : newCanvas(w, h);
    const ctx = ctxOf(c);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (B.holed) ctx.drawImage(B.holed, B.hx - x0, B.hy - y0);
    ctx.setTransform(new DOMMatrix().translate(-x0, -y0).multiply(this.matrix()));
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.src, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (final && B.smart) { freeCanvas(c); return updateSmart(B.state, B.layer.id, { T: { ...this.T } }); }
    const st = updateLayer(B.state, B.layer.id, { canvas: c, x: x0, y: y0, text: null });
    if (final) return st;
    if (this.pc && this.pc !== c) freeCanvas(this.pc);
    this.pc = c;
    d.setPreview({ ...st, selection: null });
    this.app.view.requestRender();
    return st;
  }
  /** La sélection suit la transformation. */
  _transformSel() {
    const B = this.base; if (!B.sel) return null;
    const sel = B.sel;
    const m = new DOMMatrix().multiply(this.matrix()).translate(sel.x - B.fl.x, sel.y - B.fl.y);
    const pts = [[0, 0], [sel.canvas.width, 0], [sel.canvas.width, sel.canvas.height], [0, sel.canvas.height]].map(([x, y]) => m.transformPoint({ x, y }));
    const x0 = Math.floor(Math.min(...pts.map(p => p.x))), y0 = Math.floor(Math.min(...pts.map(p => p.y)));
    const w = Math.max(1, Math.ceil(Math.max(...pts.map(p => p.x))) - x0), h = Math.max(1, Math.ceil(Math.max(...pts.map(p => p.y))) - y0);
    const c = newCanvas(w, h);
    const ctx = ctxOf(c);
    ctx.setTransform(new DOMMatrix().translate(-x0, -y0).multiply(m));
    ctx.drawImage(sel.canvas, 0, 0);
    return clipSelToDoc({ canvas: c, x: x0, y: y0 }, this.doc.width, this.doc.height);
  }
  apply() {
    if (!this.active) return;
    const st = this.render(true);
    if (st) this.app.commit('Transformation manuelle', this.base.smart ? st : { ...st, selection: this._transformSel() });
    this.end();
  }
  abort() { if (!this.active) return; this.doc?.cancelPreview(); this.end(); this.app.refresh({ history: false }); }
  end() {
    this.active = false;
    freeCanvas(this.pc); this.pc = null;
    if (this.base?.holed) freeCanvas(this.base.holed);
    if (this.src && this.src !== this.base?.layer?.canvas && !this.base?.smart) freeCanvas(this.src); // jamais la source d'un objet dynamique
    this.src = null; this.base = null; this.drag = null;
    this.app.endTransform();
  }
  hit(sp, view, touch) {
    const tol = touch ? 24 : 10;
    const T = this.T;
    for (const [k, [ux, uy]] of Object.entries(HANDLES)) {
      const p = rot(ux * T.w / 2, uy * T.h / 2, T.a);
      const s = view.toScreen({ x: T.cx + p.x, y: T.cy + p.y });
      if (Math.hypot(sp.x - s.x, sp.y - s.y) <= tol) return k;
    }
    const q = this.corners().map(p => view.toScreen(p));
    let inside = true, sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4];
      const cr = (b.x - a.x) * (sp.y - a.y) - (b.y - a.y) * (sp.x - a.x);
      if (cr !== 0) { if (!sign) sign = Math.sign(cr); else if (Math.sign(cr) !== sign) { inside = false; break; } }
    }
    return inside ? 'move' : 'rotate';
  }
  hover(sp, view) {
    if (!this.active) return;
    const k = this.hit(sp, view, false);
    const c = k === 'move' ? 'move' : k === 'rotate' ? 'grab' : (k === 'n' || k === 's') ? 'ns-resize' : (k === 'e' || k === 'w') ? 'ew-resize' : (k === 'nw' || k === 'se') ? 'nwse-resize' : 'nesw-resize';
    if (c !== this.hoverCursor) { this.hoverCursor = c; view.updateCursor(); }
  }
  down(p, e, view) {
    if (!this.active) return false;
    const mode = this.hit(view.toScreen(p), view, e.pointerType === 'touch');
    this.drag = { mode, p0: { x: p.x, y: p.y }, T0: { ...this.T }, alt: e.altKey };
    return true;
  }
  move(p, e) {
    const g = this.drag; if (!g) return;
    const T0 = g.T0, T = { ...T0 };
    if (g.mode === 'move') {
      let dx = p.x - g.p0.x, dy = p.y - g.p0.y;
      if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      T.cx = T0.cx + dx; T.cy = T0.cy + dy;
    } else if (g.mode === 'rotate') {
      let a = T0.a + Math.atan2(p.y - T0.cy, p.x - T0.cx) - Math.atan2(g.p0.y - T0.cy, g.p0.x - T0.cx);
      if (e.shiftKey) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
      T.a = a;
    } else {
      const [ux, uy] = HANDLES[g.mode];
      const alt = e.altKey;
      const aL = alt ? { x: 0, y: 0 } : { x: -ux * T0.w / 2, y: -uy * T0.h / 2 };
      const aW = rot(aL.x, aL.y, T0.a); aW.x += T0.cx; aW.y += T0.cy;
      const dL = rot(p.x - aW.x, p.y - aW.y, -T0.a);
      let w = ux ? (alt ? 2 : 1) * dL.x * ux : T0.w;
      let h = uy ? (alt ? 2 : 1) * dL.y * uy : T0.h;
      const keep = this.s.keepRatio !== e.shiftKey;
      if (keep) {
        let k;
        if (ux && uy) { const kx = w / T0.w, ky = h / T0.h; k = Math.abs(kx) > Math.abs(ky) ? kx : ky; }
        else k = ux ? w / T0.w : h / T0.h;
        w = T0.w * k; h = T0.h * k;
      }
      if (Math.abs(w) < 1) w = Math.sign(w || 1); if (Math.abs(h) < 1) h = Math.sign(h || 1);
      T.w = w; T.h = h;
      if (!alt) { const o = rot(-ux * w / 2, -uy * h / 2, T0.a); T.cx = aW.x - o.x; T.cy = aW.y - o.y; }
    }
    this.T = T;
    this.render();
  }
  up() { this.drag = null; this.app.refreshOptions(); }
  cancel() { if (this.drag) { this.T = this.drag.T0; this.drag = null; this.render(); } }
  key(e, k) {
    if (k === 'enter') { this.apply(); return true; }
    if (k === 'escape') { this.abort(); return true; }
    return false;
  }
  overlay(ctx, view) {
    if (!this.active) return;
    const q = this.corners().map(p => view.toScreen(p));
    ctx.save();
    ctx.beginPath(); q.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath();
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.stroke();
    ctx.lineWidth = 1.2; ctx.strokeStyle = '#C9804F'; ctx.stroke();
    const T = this.T;
    for (const [ux, uy] of Object.values(HANDLES)) {
      const p = rot(ux * T.w / 2, uy * T.h / 2, T.a);
      const s = view.toScreen({ x: T.cx + p.x, y: T.cy + p.y });
      ctx.beginPath(); ctx.rect(s.x - 5, s.y - 5, 10, 10); ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = '#C9804F'; ctx.stroke();
    }
    const c = view.toScreen({ x: T.cx, y: T.cy });
    ctx.beginPath(); ctx.arc(c.x, c.y, 4, 0, Math.PI * 2); ctx.strokeStyle = '#fff'; ctx.stroke();
    ctx.restore();
  }
  options(bar) {
    if (!this.active) return;
    const T = this.T, s = this.s;
    const pct = (v) => Math.round(v * 1000) / 10;
    const num = (label, value, onSet, unit) => {
      const i = el('input', { type: 'number', step: 'any', value, class: 'opt-num', inputmode: 'decimal' });
      i.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') i.blur(); });
      i.addEventListener('change', () => { const v = parseFloat(String(i.value).replace(',', '.')); if (!Number.isNaN(v)) { onSet(v); this.render(); } });
      return el('label', { class: 'opt' }, el('span', {}, label), i, el('span', { class: 'opt-unit' }, unit));
    };
    bar.append(
      num('L', pct(T.w / this.sw), v => { const k = v / 100 * this.sw / T.w; this.T.w = this.sw * v / 100; if (s.keepRatio) this.T.h *= k; this.app.refreshOptions(); }, '%'),
      num('H', pct(T.h / this.sh), v => { const k = v / 100 * this.sh / T.h; this.T.h = this.sh * v / 100; if (s.keepRatio) this.T.w *= k; this.app.refreshOptions(); }, '%'),
      num('Angle', Math.round(T.a * 1800 / Math.PI) / 10, v => { this.T.a = v * Math.PI / 180; }, '°'),
      optCheck('Conserver les proportions', s.keepRatio, v => { s.keepRatio = v; this.save(); }),
      optButton('⇋ Symétrie H', () => { this.T.w = -this.T.w; this.render(); }),
      optButton('⇵ Symétrie V', () => { this.T.h = -this.T.h; this.render(); }),
      el('span', { class: 'opt-actions' }, optButton('✓ Valider', () => this.apply(), 'primary'), optButton('Annuler', () => this.abort())),
      el('span', { class: 'opt-hint' }, 'Poignées : taille · Hors du cadre : rotation (Maj : 15°) · Alt : depuis le centre · Entrée / Échap'));
  }
}

export function createTools(app) {
  return {
    move: new MoveTool(app, 'move'),
    marquee: new MarqueeTool(app, 'marquee'),
    lasso: new LassoTool(app, 'lasso'),
    wand: new WandTool(app, 'wand'),
    transform: new TransformTool(app, 'transform'),
    brush: new BrushTool(app, 'brush', false),
    eraser: new BrushTool(app, 'eraser', true),
    stamp: new StampTool(app, 'stamp'),
    heal: new HealTool(app, 'heal'),
    remove: new RemoveTool(app, 'remove'),
    objsel: new ObjectSelectTool(app, 'objsel'),
    eyedropper: new EyedropperTool(app, 'eyedropper'),
    bucket: new BucketTool(app, 'bucket'),
    gradient: new GradientTool(app, 'gradient'),
    shapes: new ShapesTool(app, 'shapes'),
    text: new TextTool(app, 'text'),
    crop: new CropTool(app, 'crop'),
  };
}

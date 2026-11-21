// Enluminure — zone de travail : affichage, zoom, déplacement, outils
import { clamp } from './util.js';
import { updateLayer, pickLayerAt } from './ops.js';
import { selPath } from './selection.js';

const ZOOM_STEPS = [0.01, 0.02, 0.03, 0.05, 1 / 15, 1 / 12, 0.125, 1 / 6, 0.25, 1 / 3, 0.5, 2 / 3, 1, 2, 3, 4, 5, 6, 8, 12, 16, 24, 32, 64];
export const MIN_ZOOM = 0.01, MAX_ZOOM = 64;

export class Viewport {
  constructor(app, canvas) {
    this.app = app;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.pointers = new Map();
    this.action = null;
    this.pinch = null;
    this.suppress = false;
    this.spaceHeld = false;
    this.hover = null;   // position de la souris / du stylet (écran)
    this.lastPt = null;  // dernier point pendant une action
    this.cssW = 1; this.cssH = 1; this.dpr = 1;
    this._raf = 0;
    this.checker = this._makeChecker();

    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    canvas.addEventListener('pointerdown', e => this.onDown(e));
    canvas.addEventListener('pointermove', e => this.onMove(e));
    canvas.addEventListener('pointerup', e => this.onUp(e, false));
    canvas.addEventListener('pointercancel', e => this.onUp(e, true));
    canvas.addEventListener('pointerleave', () => { app.setCursorInfo(null); this.hover = null; this.requestRender(); });
    canvas.addEventListener('wheel', e => this.onWheel(e), { passive: false });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    for (const t of ['gesturestart', 'gesturechange', 'gestureend']) canvas.addEventListener(t, e => e.preventDefault());
    this.resize();
  }

  get doc() { return this.app.doc; }

  _makeChecker() {
    const c = document.createElement('canvas');
    c.width = c.height = 16;
    const x = c.getContext('2d');
    x.fillStyle = '#ece8e2'; x.fillRect(0, 0, 16, 16);
    x.fillStyle = '#cdc7bf'; x.fillRect(0, 0, 8, 8); x.fillRect(8, 8, 8, 8);
    return this.ctx.createPattern(c, 'repeat');
  }

  resize() {
    const p = this.canvas.parentElement;
    this.cssW = Math.max(1, p.clientWidth);
    this.cssH = Math.max(1, p.clientHeight);
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.cssW * this.dpr);
    this.canvas.height = Math.round(this.cssH * this.dpr);
    const d = this.doc;
    if (d && !d.view.ready) this.fit(true);
    this.draw();
  }

  // ——— Zoom ———
  fit(initial = false) {
    const d = this.doc; if (!d) return;
    const pad = this.cssW < 600 ? 12 : 36;
    let z = Math.min((this.cssW - pad * 2) / d.width, (this.cssH - pad * 2) / d.height);
    if (initial) z = Math.min(z, 1);
    z = clamp(z, MIN_ZOOM, MAX_ZOOM);
    d.view.zoom = z;
    d.view.panX = Math.round((this.cssW - d.width * z) / 2);
    d.view.panY = Math.round((this.cssH - d.height * z) / 2);
    d.view.ready = true;
    this.changed();
  }
  actualPixels() { this.zoomTo(1); }
  zoomTo(z, sx = this.cssW / 2, sy = this.cssH / 2) {
    const d = this.doc; if (!d) return;
    z = clamp(z, MIN_ZOOM, MAX_ZOOM);
    const v = d.view;
    const dx = (sx - v.panX) / v.zoom, dy = (sy - v.panY) / v.zoom;
    v.zoom = z;
    v.panX = sx - dx * z;
    v.panY = sy - dy * z;
    this.changed();
  }
  zoomStep(dir, sx, sy) {
    const d = this.doc; if (!d) return;
    const z = d.view.zoom;
    let next;
    if (dir > 0) next = ZOOM_STEPS.find(s => s > z * 1.001) ?? MAX_ZOOM;
    else next = [...ZOOM_STEPS].reverse().find(s => s < z / 1.001) ?? MIN_ZOOM;
    this.zoomTo(next, sx, sy);
  }
  changed() { this.requestRender(); this.app.updateZoomInfo(); }

  toDoc(p) {
    const v = this.doc.view;
    return { x: (p.x - v.panX) / v.zoom, y: (p.y - v.panY) / v.zoom };
  }
  toScreen(p) {
    const v = this.doc.view;
    return { x: p.x * v.zoom + v.panX, y: p.y * v.zoom + v.panY };
  }
  get toolImpl() { return this.spaceHeld ? null : this.app.tools[this.app.tool] || null; }

  // ——— Rendu ———
  requestRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.draw(); });
  }

  draw() {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    const d = this.doc;
    if (!d) return;
    const comp = d.composite();
    const { zoom, panX, panY } = d.view;
    const w = d.width * zoom, h = d.height * zoom;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 22; ctx.shadowOffsetY = 3;
    ctx.fillStyle = '#000'; ctx.fillRect(panX, panY, w, h);
    ctx.restore();
    ctx.fillStyle = this.checker;
    ctx.fillRect(panX, panY, w, h);
    ctx.imageSmoothingEnabled = zoom < 2;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(comp, panX, panY, w, h);

    // Grille des pixels à très fort zoom
    if (zoom >= 12) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(panX, panY, w, h); ctx.clip();
      ctx.strokeStyle = 'rgba(128,128,128,.35)'; ctx.lineWidth = 1 / this.dpr;
      const x0 = Math.max(0, Math.floor(-panX / zoom)), x1 = Math.min(d.width, Math.ceil((this.cssW - panX) / zoom));
      const y0 = Math.max(0, Math.floor(-panY / zoom)), y1 = Math.min(d.height, Math.ceil((this.cssH - panY) / zoom));
      ctx.beginPath();
      for (let x = x0; x <= x1; x++) { ctx.moveTo(panX + x * zoom, panY + y0 * zoom); ctx.lineTo(panX + x * zoom, panY + y1 * zoom); }
      for (let y = y0; y <= y1; y++) { ctx.moveTo(panX + x0 * zoom, panY + y * zoom); ctx.lineTo(panX + x1 * zoom, panY + y * zoom); }
      ctx.stroke();
      ctx.restore();
    }

    // Sélection : pointillés animés
    const sel = d.state.selection;
    if (sel && !(this.app.tool === 'transform')) {
      const path = selPath(sel);
      ctx.save();
      ctx.translate(panX + sel.x * zoom, panY + sel.y * zoom);
      ctx.scale(zoom, zoom);
      ctx.lineWidth = 1 / zoom;
      ctx.strokeStyle = '#fff';
      ctx.stroke(path);
      ctx.setLineDash([4 / zoom, 4 / zoom]);
      ctx.lineDashOffset = -(this.antsPhase || 0) / zoom;
      ctx.strokeStyle = '#000';
      ctx.stroke(path);
      ctx.restore();
    }
    // Repères de l'outil (cercle du pinceau, cadre de recadrage, ligne du dégradé…)
    const t = this.app.tools[this.app.tool];
    if (t?.overlay) t.overlay(ctx, this);
  }

  // ——— Souris, stylet, doigts ———
  updateCursor() {
    const a = this.action;
    let c = 'default';
    const tool = this.spaceHeld ? 'hand' : this.app.tool;
    if (a?.type === 'pan') c = 'grabbing';
    else if (tool === 'hand') c = 'grab';
    else if (tool === 'zoom') c = this.app.opts.zoomOut ? 'zoom-out' : 'zoom-in';
    else if (tool === 'move') c = 'move';
    else if (this.app.tools[tool]) c = this.app.tools[tool].cursor();
    this.canvas.style.cursor = this.doc ? c : 'default';
  }

  _pt(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  onDown(e) {
    const d = this.doc;
    if (!d) return;
    this.app.closeMenus?.();
    try { this.canvas.setPointerCapture(e.pointerId); } catch {}
    const p = this._pt(e);
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 2) { this._cancelAction(); this._startPinch(); return; }
    if (this.pointers.size > 2 || this.suppress) return;
    if (e.button === 2) return;
    const tool = (e.button === 1 || this.spaceHeld) ? 'hand' : this.app.tool;
    const v = d.view;
    this.lastPt = { ...p, touch: e.pointerType === 'touch' };
    const impl = tool === 'hand' ? null : this.app.tools[tool];
    if (impl) {
      const r = impl.down(this.toDoc(p), e, this);
      if (r === true) this.action = { type: 'tool', impl };
      this.requestRender();
    } else if (tool === 'hand') {
      this.action = { type: 'pan', sx: p.x, sy: p.y, px: v.panX, py: v.panY };
    } else if (tool === 'zoom') {
      this.action = { type: 'zoom', sx: p.x, sy: p.y, z0: v.zoom, out: e.altKey !== this.app.opts.zoomOut, moved: false };
    } else if (tool === 'move') {
      const dp = this.toDoc(p);
      let id = d.activeId;
      if (this.app.opts.autoSelect || e.ctrlKey || e.metaKey) {
        const hit = pickLayerAt(d.committed, dp.x, dp.y);
        if (hit && hit !== id) { d.setActive(hit); id = hit; this.app.refresh({ history: false }); }
      }
      const L = d.committed.layers.find(l => l.id === id);
      if (!L) { this.app.toast('Aucun calque sélectionné'); return; }
      if (!L.visible) { this.app.toast('Ce calque est masqué : affichez-le pour le déplacer'); return; }
      this.action = { type: 'move', id, sd: dp, x0: L.x, y0: L.y, dx: 0, dy: 0 };
    }
    this.updateCursor();
  }

  onMove(e) {
    const p = this._pt(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, p);
    const d = this.doc;
    if (!d) return;
    if (e.pointerType === 'mouse' || e.pointerType === 'pen') {
      this.app.setCursorInfo(this.toDoc(p));
      this.hover = p;
      if (!this.action) {
        const t = this.app.tools[this.app.tool];
        t?.hover?.(p, this);
        if (t?.overlay) this.requestRender();
      }
    }
    if (this.pinch) { this._updatePinch(); return; }
    const a = this.action;
    if (!a) return;
    this.lastPt = { ...p, touch: e.pointerType === 'touch' };
    if (a.type === 'tool') {
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      const r = this.canvas.getBoundingClientRect();
      const pts = (evs.length ? evs : [e]).map(ev => {
        const q = this.toDoc({ x: ev.clientX - r.left, y: ev.clientY - r.top });
        q.pressure = ev.pointerType === 'pen' && ev.pressure > 0 ? ev.pressure : 1;
        return q;
      });
      a.impl.move(this.toDoc(p), e, pts);
      this.requestRender();
    } else if (a.type === 'pan') {
      d.view.panX = a.px + p.x - a.sx;
      d.view.panY = a.py + p.y - a.sy;
      this.requestRender();
    } else if (a.type === 'zoom') {
      const dx = p.x - a.sx;
      if (Math.abs(dx) > 5) a.moved = true;
      if (a.moved) {
        const z = clamp(a.z0 * Math.exp(dx * 0.008), MIN_ZOOM, MAX_ZOOM);
        const v = d.view, k = z / v.zoom;
        v.panX = a.sx - (a.sx - v.panX) * k; v.panY = a.sy - (a.sy - v.panY) * k; v.zoom = z;
        this.changed();
      }
    } else if (a.type === 'move') {
      const dp = this.toDoc(p);
      let dx = Math.round(dp.x - a.sd.x), dy = Math.round(dp.y - a.sd.y);
      if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      if (dx === a.dx && dy === a.dy) return;
      a.dx = dx; a.dy = dy;
      d.setPreview(updateLayer(d.committed, a.id, { x: a.x0 + dx, y: a.y0 + dy }));
      this.requestRender();
    }
  }

  onUp(e, cancelled) {
    this.pointers.delete(e.pointerId);
    if (this.pinch) {
      if (this.pointers.size < 2) { this.pinch = null; this.suppress = this.pointers.size > 0; }
      return;
    }
    if (this.pointers.size === 0) this.suppress = false;
    const a = this.action;
    this.action = null;
    const d = this.doc;
    if (a && d) {
      if (a.type === 'tool') {
        a.impl.up(this.toDoc(this._pt(e)), e, cancelled);
        this.requestRender();
      } else if (a.type === 'move') {
        if (cancelled || (!a.dx && !a.dy)) d.cancelPreview();
        else this.app.commit('Déplacer', updateLayer(d.committed, a.id, { x: a.x0 + a.dx, y: a.y0 + a.dy }));
        this.requestRender();
      } else if (a.type === 'zoom' && !a.moved && !cancelled) {
        this.zoomStep(a.out ? -1 : 1, a.sx, a.sy);
      }
    }
    this.updateCursor();
  }

  _cancelAction() {
    if (this.action?.type === 'move') this.doc?.cancelPreview();
    if (this.action?.type === 'tool') this.action.impl.cancel?.();
    this.action = null;
    this.requestRender();
  }

  _startPinch() {
    const [a, b] = [...this.pointers.values()];
    const v = this.doc.view;
    this.pinch = {
      d0: Math.hypot(b.x - a.x, b.y - a.y) || 1,
      m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      z0: v.zoom, px: v.panX, py: v.panY,
    };
  }
  _updatePinch() {
    if (this.pointers.size < 2) return;
    const [a, b] = [...this.pointers.values()];
    const P = this.pinch, v = this.doc.view;
    const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const z = clamp(P.z0 * dist / P.d0, MIN_ZOOM, MAX_ZOOM);
    const docX = (P.m0.x - P.px) / P.z0, docY = (P.m0.y - P.py) / P.z0;
    v.zoom = z; v.panX = m.x - docX * z; v.panY = m.y - docY * z;
    this.changed();
  }

  onWheel(e) {
    e.preventDefault();
    const d = this.doc;
    if (!d) return;
    const p = this._pt(e);
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    if (e.shiftKey && !e.ctrlKey) {
      d.view.panX -= (e.deltaY || e.deltaX) * unit;
      this.requestRender();
      return;
    }
    const k = Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.0022));
    this.zoomTo(d.view.zoom * k, p.x, p.y);
  }
}

// Enluminure — document, historique (annuler / rétablir) et gestion mémoire
import { uid, freeCanvas, LIMITS, newCanvas, bump } from './util.js';
import { drawStack, ScratchPool } from './render.js';

/**
 * Un état = { width, height, layers: [calques du bas vers le haut] }.
 * Les états ne sont jamais modifiés : chaque action crée un nouvel état.
 * Les toiles inchangées sont partagées entre états, donc garder 500 étapes
 * ne coûte presque rien tant qu'on ne touche pas aux pixels.
 *
 * Pour la peinture (pinceau, gomme, pot de peinture…), on ne recopie pas
 * toute la toile : l'étape garde seulement la zone modifiée, « avant » et
 * « après » (une rustine). Annuler recolle l'« avant », rétablir l'« après ».
 */
export class Doc {
  constructor({ name, width, height, layers, label = 'Ouverture', activeId }) {
    this.id = uid();
    this.name = name || 'Sans titre';
    const state = { width, height, layers };
    this.entries = [{ id: uid(), label, state, time: Date.now(), activeId: activeId || layers.at(-1)?.id, patches: null }];
    this.index = 0;
    this.activeId = this.entries[0].activeId;
    this.preview = null;
    this.live = null;    // trait de pinceau en cours
    this.savedId = null; // pas encore enregistré
    this.trimmed = 0;    // étapes oubliées faute de mémoire
    this._comp = null;
    this._compDirty = true;
    this._dirtyRect = null;
    this._pool = new ScratchPool();
    this._liveScratch = null;
    this._liveTmp = null;
    this.target = 'layer'; // 'layer' ou 'mask' : ce que les outils de peinture modifient
    this.selIds = new Set(); // calques sélectionnés dans le panneau (sélection multiple)
    this.lastSelection = null;
    this.view = { zoom: 1, panX: 0, panY: 0, ready: false };
  }

  get state() { return this.preview || this.entries[this.index].state; }
  get committed() { return this.entries[this.index].state; }
  get width() { return this.state.width; }
  get height() { return this.state.height; }
  get layers() { return this.state.layers; }
  get active() { return this.state.layers.find(l => l.id === this.activeId) || null; }
  get activeIndex() { return this.state.layers.findIndex(l => l.id === this.activeId); }
  get dirty() { return this.entries[this.index].id !== this.savedId; }
  get canUndo() { return this.index > 0; }
  get canRedo() { return this.index < this.entries.length - 1; }

  markSaved() { this.savedId = this.entries[this.index].id; }

  invalidate() { this._compDirty = true; }
  /** Seule une zone (coordonnées du document) a changé : recomposition partielle. */
  invalidateRect(r) {
    if (!r || r.w <= 0 || r.h <= 0) return;
    if (!this._dirtyRect) { this._dirtyRect = { ...r }; return; }
    const d = this._dirtyRect;
    const x = Math.min(d.x, r.x), y = Math.min(d.y, r.y);
    this._dirtyRect = { x, y, w: Math.max(d.x + d.w, r.x + r.w) - x, h: Math.max(d.y + d.h, r.y + r.h) - y };
  }

  setPreview(state) { this.preview = state; this._compDirty = true; }
  cancelPreview() {
    if (this.preview || this.live) { this.preview = null; this.live = null; this._compDirty = true; }
  }
  setLive(live) { this.live = live; this._liveFresh = true; this._compDirty = true; }

  setActive(id) { if (this.state.layers.some(l => l.id === id)) this.activeId = id; }

  /** Enregistre une nouvelle étape dans l'historique. */
  commit(label, state, { activeId, mergeKey, patches } = {}) {
    this.preview = null;
    this.live = null;
    const now = Date.now();
    const candidates = [];
    const deadPatches = [];
    // On oublie les étapes « rétablir » qui ne servent plus
    for (const e of this.entries.splice(this.index + 1)) {
      candidates.push(e.state);
      if (e.patches) deadPatches.push(...e.patches);
    }
    const cur = this.entries[this.index];
    if (activeId) this.activeId = activeId;
    if (mergeKey && !patches && !cur.patches && cur.mergeKey === mergeKey && this.index > 0 && now - cur.time < 1500 && cur.id !== this.savedId) {
      candidates.push(cur.state);
      cur.state = state; cur.time = now; cur.activeId = this.activeId;
    } else {
      this.entries.push({ id: uid(), label, state, time: now, mergeKey, activeId: this.activeId, patches: patches || null });
      this.index++;
    }
    this._fixActive();
    this._enforceBudget(candidates, deadPatches);
    this._gc(candidates);
    this._freePatches(deadPatches);
    this._compDirty = true;
  }

  undo() { return this.goTo(this.index - 1); }
  redo() { return this.goTo(this.index + 1); }
  goTo(i) {
    if (i < 0 || i >= this.entries.length || i === this.index) return false;
    this.preview = null;
    this.live = null;
    while (this.index > i) { this._applyPatches(this.entries[this.index].patches, 'before'); this.index--; }
    while (this.index < i) { this.index++; this._applyPatches(this.entries[this.index].patches, 'after'); }
    const want = this.entries[i].activeId;
    if (want && this.state.layers.some(l => l.id === want)) this.activeId = want;
    this._fixActive();
    this._compDirty = true;
    return true;
  }

  _applyPatches(patches, which) {
    if (!patches) return;
    const list = which === 'before' ? [...patches].reverse() : patches;
    for (const p of list) {
      const src = p[which];
      const ctx = p.canvas.getContext('2d');
      ctx.clearRect(p.x, p.y, src.width, src.height);
      ctx.drawImage(src, p.x, p.y);
      bump(p.canvas);
    }
  }

  _fixActive() {
    const ls = this.state.layers;
    if (!ls.some(l => l.id === this.activeId)) this.activeId = ls.at(-1)?.id || null;
  }

  _canvasesOf(state, set = new Set()) {
    for (const l of state.layers) {
      if (l.canvas) set.add(l.canvas);
      if (l.mask?.canvas) set.add(l.mask.canvas);
      if (l.smart?.source) set.add(l.smart.source);
    }
    if (state.selection?.canvas) set.add(state.selection.canvas);
    return set;
  }
  get selection() { return this.state.selection || null; }

  /** Mémoire occupée par l'historique (pixels uniques + rustines). */
  memoryBytes() {
    const all = new Set();
    let n = 0;
    for (const e of this.entries) {
      this._canvasesOf(e.state, all);
      if (e.patches) for (const p of e.patches) n += (p.before.width * p.before.height + p.after.width * p.after.height) * 4;
    }
    for (const c of all) n += c.width * c.height * 4;
    return n;
  }

  /** Si l'historique devient trop gourmand, on oublie les plus anciennes étapes. */
  _enforceBudget(candidates, deadPatches) {
    while (this.index > 1 && this.memoryBytes() > LIMITS.historyBytes) {
      const e = this.entries.shift();
      this.index--;
      this.trimmed++;
      candidates.push(e.state);
      if (e.patches) deadPatches.push(...e.patches);
      // la nouvelle première étape n'a plus besoin de sa rustine (on ne peut plus revenir avant)
      const first = this.entries[0];
      if (first.patches) { deadPatches.push(...first.patches); first.patches = null; }
    }
  }

  /** Libère les toiles qui ne sont plus utilisées par aucune étape. */
  _gc(candidateStates) {
    if (!candidateStates.length) return;
    const keep = new Set();
    for (const e of this.entries) this._canvasesOf(e.state, keep);
    for (const st of candidateStates) for (const c of this._canvasesOf(st)) {
      if (!keep.has(c) && c !== this.lastSelection?.canvas) freeCanvas(c);
    }
  }
  _freePatches(list) { for (const p of list) { freeCanvas(p.before); freeCanvas(p.after); } }

  /** Calque (ou masque) actif + trait en cours, sur une toile de travail (seulement la zone qui a bougé). */
  _liveOverride() {
    const lv = this.live;
    const L = this.state.layers.find(l => l.id === lv.layerId);
    if (!L) return null;
    const key = lv.target === 'mask' ? `mask:${L.id}` : L.id;
    if (lv.canvas) return new Map([[key, lv.canvas]]); // toile complète fournie (dégradé, déplacement…)
    const c = lv.target === 'mask' ? L.mask.canvas : L.canvas;
    let s = this._liveScratch;
    let r = lv.dirty;
    if (!s || s.width !== c.width || s.height !== c.height || this._liveFresh) {
      if (!s || s.width !== c.width || s.height !== c.height) { freeCanvas(s); s = this._liveScratch = newCanvas(c.width, c.height); }
      r = { x: 0, y: 0, w: c.width, h: c.height };
      this._liveFresh = false;
    }
    if (r) {
      const x = Math.max(0, Math.floor(r.x)), y = Math.max(0, Math.floor(r.y));
      const w = Math.min(c.width, Math.ceil(r.x + r.w)) - x, h = Math.min(c.height, Math.ceil(r.y + r.h)) - y;
      if (w > 0 && h > 0) {
        const ctx = s.getContext('2d');
        ctx.save();
        ctx.clearRect(x, y, w, h);
        ctx.drawImage(c, x, y, w, h, x, y, w, h);
        const src = lv.sel ? this._maskedBuf(lv, x, y, w, h) : lv.buf;
        const sx = lv.sel ? 0 : x, sy = lv.sel ? 0 : y;
        applyBuf(ctx, src, sx, sy, x, y, w, h, lv);
        ctx.restore();
        bump(s);
      }
      lv.dirty = null;
    }
    return new Map([[key, s]]);
  }

  /** Zone du tampon limitée à la sélection (dans une petite toile de travail). */
  _maskedBuf(lv, x, y, w, h) {
    let t = this._liveTmp;
    if (!t || t.width < w || t.height < h) { freeCanvas(t); t = this._liveTmp = newCanvas(Math.max(w, t?.width || 0), Math.max(h, t?.height || 0)); }
    const ctx = t.getContext('2d');
    ctx.save();
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(lv.buf, x, y, w, h, 0, 0, w, h);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(lv.sel.canvas, lv.sel.ox - x, lv.sel.oy - y);
    ctx.restore();
    return t;
  }

  /** Image composée du document, recalculée seulement si nécessaire. */
  composite() {
    const st = this.state;
    if (!this._comp || this._comp.width !== st.width || this._comp.height !== st.height) {
      freeCanvas(this._comp);
      this._comp = newCanvas(st.width, st.height);
      this._compDirty = true;
    }
    const override = this.live ? this._liveOverride() : null;
    const ctx = this._comp.getContext('2d');
    if (this._compDirty) {
      ctx.clearRect(0, 0, st.width, st.height);
      drawStack(this._comp, st.layers, 0, 0, { pool: this._pool, override });
    } else if (this._dirtyRect) {
      const r = this._dirtyRect;
      const x = Math.max(0, Math.floor(r.x)), y = Math.max(0, Math.floor(r.y));
      const w = Math.min(st.width, Math.ceil(r.x + r.w)) - x, h = Math.min(st.height, Math.ceil(r.y + r.h)) - y;
      if (w > 0 && h > 0) {
        ctx.save();
        ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
        ctx.clearRect(x, y, w, h);
        drawStack(this._comp, st.layers, 0, 0, { pool: this._pool, override, clip: { x, y, w, h } });
        ctx.restore();
      }
    }
    this._compDirty = false;
    this._dirtyRect = null;
    if (!this.live && this._liveScratch) { freeCanvas(this._liveScratch); freeCanvas(this._liveTmp); this._liveScratch = this._liveTmp = null; }
    return this._comp;
  }

  dispose() {
    const all = new Set();
    for (const e of this.entries) { this._canvasesOf(e.state, all); if (e.patches) this._freePatches(e.patches); }
    if (this.preview) this._canvasesOf(this.preview, all);
    for (const c of all) freeCanvas(c);
    freeCanvas(this._comp); this._pool.dispose(); freeCanvas(this._liveScratch); freeCanvas(this._liveTmp);
    this.entries = []; this._comp = null; this._liveScratch = null;
  }
}

/** Applique le tampon d'un trait sur une toile (calque : peinture / gomme ; masque : niveau de gris). */
export function applyBuf(ctx, src, sx, sy, x, y, w, h, o) {
  ctx.globalAlpha = o.alpha;
  if (o.lum != null) { // masque : on rapproche la valeur du masque de la luminosité choisie
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(src, sx, sy, w, h, x, y, w, h);
    if (o.lum > 0) {
      ctx.globalAlpha = o.alpha * o.lum;
      ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(src, sx, sy, w, h, x, y, w, h);
    }
  } else {
    ctx.globalCompositeOperation = o.op;
    ctx.drawImage(src, sx, sy, w, h, x, y, w, h);
  }
}

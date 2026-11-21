// Enluminure — document, historique (annuler / rétablir) et gestion mémoire
import { uid, freeCanvas, LIMITS, newCanvas } from './util.js';
import { drawStack } from './render.js';

/**
 * Un état = { width, height, layers: [calques du bas vers le haut] }.
 * Les états ne sont jamais modifiés : chaque action crée un nouvel état.
 * Les toiles inchangées sont partagées entre états, donc garder 500 étapes
 * ne coûte presque rien tant qu'on ne touche pas aux pixels.
 */
export class Doc {
  constructor({ name, width, height, layers, label = 'Ouverture', activeId }) {
    this.id = uid();
    this.name = name || 'Sans titre';
    const state = { width, height, layers };
    this.entries = [{ id: uid(), label, state, time: Date.now(), activeId: activeId || layers.at(-1)?.id }];
    this.index = 0;
    this.activeId = this.entries[0].activeId;
    this.preview = null;
    this.savedId = null; // pas encore enregistré
    this.trimmed = 0;    // étapes oubliées faute de mémoire
    this._comp = null;
    this._compDirty = true;
    this._scratch = null;
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
  markClean() { this.markSaved(); }

  invalidate() { this._compDirty = true; }

  setPreview(state) { this.preview = state; this._compDirty = true; }
  cancelPreview() { if (this.preview) { this.preview = null; this._compDirty = true; } }

  setActive(id) { if (this.state.layers.some(l => l.id === id)) this.activeId = id; }

  /** Enregistre une nouvelle étape dans l'historique. */
  commit(label, state, { activeId, mergeKey } = {}) {
    this.preview = null;
    const now = Date.now();
    const candidates = [];
    // On oublie les étapes « rétablir » qui ne servent plus
    for (const e of this.entries.splice(this.index + 1)) candidates.push(e.state);
    const cur = this.entries[this.index];
    if (activeId) this.activeId = activeId;
    if (mergeKey && cur.mergeKey === mergeKey && this.index > 0 && now - cur.time < 1500 && cur.id !== this.savedId) {
      candidates.push(cur.state);
      cur.state = state; cur.time = now; cur.activeId = this.activeId;
    } else {
      this.entries.push({ id: uid(), label, state, time: now, mergeKey, activeId: this.activeId });
      this.index++;
    }
    this._fixActive();
    this._enforceBudget(candidates);
    this._gc(candidates);
    this._compDirty = true;
  }

  undo() { return this.goTo(this.index - 1); }
  redo() { return this.goTo(this.index + 1); }
  goTo(i) {
    if (i < 0 || i >= this.entries.length || i === this.index) return false;
    this.preview = null;
    this.index = i;
    const want = this.entries[i].activeId;
    if (want && this.state.layers.some(l => l.id === want)) this.activeId = want;
    this._fixActive();
    this._compDirty = true;
    return true;
  }

  _fixActive() {
    const ls = this.state.layers;
    if (!ls.some(l => l.id === this.activeId)) this.activeId = ls.at(-1)?.id || null;
  }

  _canvasesOf(state, set = new Set()) {
    for (const l of state.layers) if (l.canvas) set.add(l.canvas);
    return set;
  }

  /** Mémoire occupée par l'historique (pixels uniques). */
  memoryBytes() {
    const all = new Set();
    for (const e of this.entries) this._canvasesOf(e.state, all);
    let n = 0;
    for (const c of all) n += c.width * c.height * 4;
    return n;
  }

  /** Si l'historique devient trop gourmand, on oublie les plus anciennes étapes. */
  _enforceBudget(candidates) {
    while (this.index > 1 && this.memoryBytes() > LIMITS.historyBytes) {
      const e = this.entries.shift();
      this.index--;
      this.trimmed++;
      candidates.push(e.state);
    }
  }

  /** Libère les toiles qui ne sont plus utilisées par aucune étape. */
  _gc(candidateStates) {
    if (!candidateStates.length) return;
    const keep = new Set();
    for (const e of this.entries) this._canvasesOf(e.state, keep);
    for (const st of candidateStates) for (const l of st.layers) {
      if (l.canvas && !keep.has(l.canvas)) freeCanvas(l.canvas);
    }
  }

  /** Image composée du document, recalculée seulement si nécessaire. */
  composite() {
    const st = this.state;
    if (!this._comp || this._comp.width !== st.width || this._comp.height !== st.height) {
      freeCanvas(this._comp);
      this._comp = newCanvas(st.width, st.height);
      this._compDirty = true;
    }
    if (this._compDirty) {
      const ctx = this._comp.getContext('2d');
      ctx.clearRect(0, 0, st.width, st.height);
      this._scratch = drawStack(this._comp, st.layers, 0, 0, this._scratch);
      this._compDirty = false;
    }
    return this._comp;
  }

  dispose() {
    const all = new Set();
    for (const e of this.entries) this._canvasesOf(e.state, all);
    if (this.preview) this._canvasesOf(this.preview, all);
    for (const c of all) freeCanvas(c);
    freeCanvas(this._comp); freeCanvas(this._scratch);
    this.entries = []; this._comp = null; this._scratch = null;
  }
}

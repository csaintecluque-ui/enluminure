// Enluminure — application
import { VERSION, el, mkLayer, newCanvas, ctxOf, fitsLimits, LIMITS, isIOS, isMac, baseName, canvasToBlob, cloneCanvas, freeCanvas } from './util.js';
import { Doc } from './document.js';
import * as ops from './ops.js';
import { flattenState, maskedCanvas, styledOf } from './render.js';
import { styledMerged, anyStyles } from './styles.js';
import { styleDialog } from './fxdialog.js';
import { liquifyDialog } from './liquify.js';
import * as SM from './smart.js';
import * as AIUI from './aiui.js';
import { Viewport } from './view.js';
import { $, toast, openDialog, confirmDialog, field, MenuBar, modalOpen } from './ui.js';
import { initLayersPanel, renderLayers, renderHistory, renderTabs, initToolbar, renderToolbar, renderOptions, renderStatus, startRename, TOOLS } from './panels.js';
import { openFileAsDoc, fileToCanvas, isPsd, docToPsdBlob, exportBlob, saveBlob } from './io.js';
import { icon, LOGO_SMALL } from './icons.js';
import { createTools, DEFAULT_SETTINGS } from './tools.js';
import { commitPixels, prepareTarget, selIn, lumOf } from './paint.js';
import { applyBuf } from './document.js';
import * as tree from './tree.js';
import * as SEL from './selection.js';
import { ADJ, ADJ_ORDER, applyAdjust, histogram, autoLUT, LUT_SHADER } from './adjust.js';
import { FILTERS, FILTER_ORDER } from './filters.js';
import { glRun } from './gl.js';

const MOD = isMac || isIOS ? '⌘' : 'Ctrl';
const ADJ_KEYS = { levels: 'Ctrl+L', curves: 'Ctrl+M', huesat: 'Ctrl+U', colorbalance: 'Ctrl+B', bw: 'Ctrl+Alt+Maj+B' };
const K = (s) => s.replace(/Ctrl/g, MOD);

class App {
  constructor() {
    this.docs = [];
    this.doc = null;
    this.tool = 'move';
    this.panelOpen = null;
    this.opts = { autoSelect: false, showBounds: true, zoomOut: false };
    try { Object.assign(this.opts, JSON.parse(localStorage.getItem('enluminure.opts') || '{}')); } catch {}
    this.opts.zoomOut = false;
    this.settings = structuredClone(DEFAULT_SETTINGS);
    try {
      const saved = JSON.parse(localStorage.getItem('enluminure.settings') || '{}');
      for (const k of Object.keys(this.settings)) Object.assign(this.settings[k], saved[k] || {});
    } catch {}
    this.colors = { fg: '#000000', bg: '#ffffff' };
    try { Object.assign(this.colors, JSON.parse(localStorage.getItem('enluminure.colors') || '{}')); } catch {}
    this.tools = createTools(this);
    this.actions = this.buildActions();
    this.view = new Viewport(this, $('#view'));
    this.menubar = new MenuBar($('#menubar'), this.buildMenus(), this);
    this.closeMenus = () => this.menubar.close();
    initLayersPanel(this);
    initToolbar(this);
    this.bindChrome();
    this.bindKeyboard();
    this.bindFiles();
    this.refresh();
    // pointillés animés de la sélection
    setInterval(() => {
      const d = this.doc;
      if (d && (d.state.selection || this.tools[this.tool]?.drag || this.tools[this.tool]?.poly) && !document.hidden) {
        this.view.antsPhase = ((this.view.antsPhase || 0) + 1) % 8;
        this.view.requestRender();
      }
    }, 120);
  }

  saveOpts() {
    try {
      localStorage.setItem('enluminure.opts', JSON.stringify(this.opts));
      localStorage.setItem('enluminure.settings', JSON.stringify(this.settings));
      localStorage.setItem('enluminure.colors', JSON.stringify(this.colors));
    } catch {}
  }
  refreshOptions() { renderOptions(this); }

  // ——— Couleurs ———
  setColor(which, hex) { this.colors[which] = hex; this.saveOpts(); renderToolbar(this); this.view.requestRender(); }
  swapColors() { const { fg, bg } = this.colors; this.colors = { fg: bg, bg: fg }; this.saveOpts(); renderToolbar(this); }
  resetColors() { this.colors = { fg: '#000000', bg: '#ffffff' }; this.saveOpts(); renderToolbar(this); }
  pickColor(which) {
    const i = $('#color-input');
    i.value = this.colors[which];
    i.oninput = () => this.setColor(which, i.value);
    i.onchange = () => this.setColor(which, i.value);
    i.click();
  }
  toast(m, ms) { toast(m, ms); }

  // ——— Documents ———
  addDoc(doc, notes = []) {
    this.docs.push(doc);
    this.switchDoc(doc);
    if (notes.length) toast(notes.join(' '), 6000);
  }
  switchDoc(doc) {
    this.doc?.cancelPreview();
    this.doc = doc;
    doc?.invalidate();
    if (doc && !doc.view.ready) this.view.fit(true);
    else if (doc) this.view.adapt(doc);
    this.refresh();
  }
  async closeDoc(doc) {
    if (doc.dirty) {
      const ok = await confirmDialog('Fermer sans enregistrer ?', `« ${doc.name} » a des modifications non enregistrées en .psd.`, 'Fermer quand même', true);
      if (!ok) return;
    }
    const i = this.docs.indexOf(doc);
    this.docs.splice(i, 1);
    doc.dispose();
    if (this.doc === doc) this.switchDoc(this.docs[Math.min(i, this.docs.length - 1)] || null);
    else this.refresh();
  }

  commit(label, state, opts) {
    if (!this.doc || !state) return;
    this.doc.commit(label, state, opts);
    this.refresh();
  }

  refresh({ history = true } = {}) {
    renderTabs(this);
    renderLayers(this);
    if (history) renderHistory(this);
    renderToolbar(this);
    renderStatus(this);
    if (!$('#optionsbar').childElementCount) renderOptions(this);
    const d = this.doc;
    $('#btn-undo').disabled = !d?.canUndo;
    $('#btn-redo').disabled = !d?.canRedo;
    $('#welcome').hidden = !!d;
    document.title = d ? `${d.name}${d.dirty ? ' •' : ''} — Enluminure` : 'Enluminure';
    this.view.updateCursor();
    this.view.requestRender();
  }

  setTool(id) {
    const t = TOOLS.find(x => x.id === id);
    if (!t) return;
    if (t.step) { toast(`L'outil ${t.label} arrive à l'étape ${t.step}.`); return; }
    if (this.tool === 'transform') this.tools.transform.apply();
    if (this.tool !== id) {
      this.view._cancelAction?.();
      this.tools[this.tool]?.deactivate?.();
      this.tool = id;
      this.tools[id]?.activate?.();
    }
    renderOptions(this);
    renderToolbar(this);
    this.view.updateCursor();
    this.view.requestRender();
  }

  togglePanel(id) {
    this.panelOpen = this.panelOpen === id ? null : id;
    const p = $('#panels');
    p.classList.toggle('open', !!this.panelOpen);
    if (this.panelOpen) p.dataset.show = this.panelOpen;
    renderToolbar(this);
  }

  setCursorInfo(p) {
    const s = $('#st-cursor');
    if (!p || !this.doc) { s.textContent = ''; return; }
    s.textContent = `x ${Math.floor(p.x)} · y ${Math.floor(p.y)}`;
  }
  updateZoomInfo() {
    const z = $('#st-zoom');
    if (document.activeElement === z) return;
    z.value = this.doc ? `${+(this.doc.view.zoom * 100).toFixed(this.doc.view.zoom < 0.1 ? 1 : 0)} %` : '';
    z.disabled = !this.doc;
  }

  run(id) {
    const a = this.actions[id];
    if (!a) return;
    if (this.tool === 'transform' && this.tools.transform.active) {
      if (id === 'undo' || id === 'redo') { this.tools.transform.abort(); return; }
      if (!['freeTransform', 'fit', 'zoomIn', 'zoomOut', 'zoom100', 'shortcuts', 'about', 'fullscreen', 'bounds'].includes(id)) this.tools.transform.apply();
      if (id === 'freeTransform') return;
    }
    if (a.enabled && !a.enabled()) return;
    this.menubar.close();
    Promise.resolve(a.run()).catch(err => { console.error(err); toast(`Erreur : ${err.message || err}`, 6000); });
  }

  // ——— Actions (menus, raccourcis, boutons) ———
  buildActions() {
    const hasDoc = () => !!this.doc;
    const hasLayer = () => !!this.doc?.active;
    const D = () => this.doc;
    const layerOp = (label, fn) => ({ enabled: hasLayer, run: () => { const d = D(); this.commit(label, fn(d.committed, d.activeId)); } });
    const flipOp = (label, kind) => layerOp(label, (st, id) => {
      const L = st.layers.find(l => l.id === id);
      const st2 = ops.transformLayer(st, id, kind);
      return L?.smart ? SM.updateSmart(st2, id, { T: SM.smartFlip(L, kind) }) : st2;
    });
    const imgOp = (label, kind) => ({ enabled: hasDoc, run: () => {
      const st0 = D().committed;
      const st = SM.resmartAll(st0, ops.transformImage(st0, kind), kind);
      this.commit(label, st);
      if (kind === 'cw' || kind === 'ccw') this.view.fit(true);
    } });
    return {
      new: { run: () => this.dialogNew() },
      open: { run: () => $('#file-open').click() },
      import: { enabled: hasDoc, run: () => $('#file-import').click() },
      save: { enabled: hasDoc, run: () => this.savePsd() },
      export: { enabled: hasDoc, run: () => this.dialogExport() },
      close: { enabled: hasDoc, run: () => this.closeDoc(D()) },

      undo: { enabled: () => !!D()?.canUndo, run: () => { if (D().undo()) this.refresh(); } },
      redo: { enabled: () => !!D()?.canRedo, run: () => { if (D().redo()) this.refresh(); } },
      copy: { enabled: hasLayer, run: () => this.copy(false) },
      copyMerged: { enabled: hasDoc, run: () => this.copy(true) },
      paste: { run: () => this.pasteFromMenu() },
      layerCW: flipOp('Rotation du calque 90° horaire', 'cw'),
      layerCCW: flipOp('Rotation du calque 90° antihoraire', 'ccw'),
      layer180: flipOp('Rotation du calque 180°', '180'),
      layerFH: flipOp('Symétrie horizontale du calque', 'fh'),
      layerFV: flipOp('Symétrie verticale du calque', 'fv'),
      centerLayer: { enabled: () => !!D()?.active?.canvas, run: () => {
        const d = D(), st = d.committed, l = d.active;
        const b = SEL.alphaBounds(l.canvas) || { x: 0, y: 0, w: l.canvas.width, h: l.canvas.height }; // on centre ce qui est visible
        const dx = Math.round((st.width - b.w) / 2) - (l.x + b.x), dy = Math.round((st.height - b.h) / 2) - (l.y + b.y);
        if (!dx && !dy) { toast('Ce calque est déjà centré.'); return; }
        this.commit('Centrer le calque', l.smart ? SM.updateSmart(tree.moveItems(st, [l.id], dx, dy), l.id) : tree.moveItems(st, [l.id], dx, dy));
      } },

      fillFg: { enabled: hasLayer, run: () => this.fillLayer(this.colors.fg, 'Remplir (premier plan)') },
      fillBg: { enabled: hasLayer, run: () => this.fillLayer(this.colors.bg, 'Remplir (arrière-plan)') },
      clearLayer: { enabled: hasLayer, run: () => this.fillLayer(null, 'Effacer le calque') },
      editText: { enabled: () => !!D()?.active?.text, run: () => this.tools.text.edit(D().active) },
      // ——— IA locale ———
      selectSubject: { enabled: hasDoc, run: () => AIUI.selectSubject(this) },
      removeBackground: { enabled: () => !!D()?.active?.canvas && !D().active.kind, run: () => AIUI.removeBackground(this) },
      contentFill: { enabled: () => this.pixelReady() && !!D().committed.selection, run: () => AIUI.contentAwareFill(this) },
      aiUpscale: { enabled: hasDoc, run: () => AIUI.upscaleDialog(this) },
      aiModels: { run: () => AIUI.aiDialog(this) },
      objselTool: { enabled: hasDoc, run: () => this.setTool('objsel') },
      removeTool: { enabled: hasDoc, run: () => this.setTool('remove') },
      // ——— Objets dynamiques ———
      toSmart: { enabled: () => this.stylable() && !D().active.smart, run: () => {
        const d = D(), st = SM.toSmart(d.committed, d.activeId);
        if (!st) { toast('Ce calque est vide.'); return; }
        d.target = 'layer';
        this.commit('Convertir en objet dynamique', st);
        toast('Objet dynamique : transformations et filtres restent modifiables, sans perte.', 4000);
      } },
      rasterizeSmart: { enabled: () => !!D()?.active?.smart, run: () => {
        const d = D();
        this.commit("Pixelliser l'objet dynamique", ops.updateLayer(d.committed, d.activeId, { smart: null }));
      } },
      resetSmart: { enabled: () => !!D()?.active?.smart, run: () => {
        const d = D(), L = d.active, T = SM.smartT(L);
        this.commit('Annuler la transformation', SM.updateSmart(d.committed, L.id, { T: { cx: T.cx, cy: T.cy, w: L.smart.source.width, h: L.smart.source.height, a: 0 } }));
      } },
      // ——— Styles de calque ———
      layerStyle: { enabled: () => this.stylable(), run: () => styleDialog(this, D().activeId) },
      styleCopy: { enabled: () => anyStyles(D()?.active?.styles), run: () => { this.styleClip = structuredClone(D().active.styles); toast('Style copié.'); } },
      stylePaste: { enabled: () => !!this.styleClip && this.stylable(), run: () => {
        const d = D();
        const ids = (d.selIds.size > 1 ? [...d.selIds] : [d.activeId]).filter(id => this.stylable(d.committed.layers.find(l => l.id === id)));
        let st = d.committed;
        for (const id of ids) st = ops.updateLayer(st, id, { styles: structuredClone(this.styleClip) });
        this.commit('Coller le style de calque', st);
      } },
      styleClear: { enabled: () => anyStyles(D()?.active?.styles), run: () => { const d = D(); this.commit('Effacer le style de calque', ops.updateLayer(d.committed, d.activeId, { styles: null })); } },
      styleToggle: { enabled: () => anyStyles(D()?.active?.styles), checked: () => !!D()?.active?.styles?.hidden, run: () => {
        const d = D(), l = d.active;
        this.commit(l.styles.hidden ? 'Afficher les effets' : 'Masquer les effets', ops.updateLayer(d.committed, l.id, { styles: { ...l.styles, hidden: !l.styles.hidden } }));
      } },
      styleRasterize: { enabled: () => anyStyles(D()?.active?.styles) && !!D().active.canvas, run: () => {
        const d = D(), l = d.active;
        const r = styledOf(l);
        let patch = { styles: null };
        if (r && !r.empty) {
          const c = newCanvas(r.w, r.h);
          ctxOf(c).drawImage(styledMerged(r), 0, 0);
          patch = { canvas: c, x: l.x + r.x, y: l.y + r.y, styles: null, mask: null, text: null };
          d.target = 'layer';
        }
        this.commit('Pixelliser le style de calque', ops.updateLayer(d.committed, l.id, patch));
      } },
      cropTool: { enabled: hasDoc, run: () => this.setTool('crop') },
      imageSize: { enabled: hasDoc, run: () => this.dialogImageSize() },
      canvasSize: { enabled: hasDoc, run: () => this.dialogCanvasSize() },
      rotCW: imgOp("Rotation de l'image 90° horaire", 'cw'),
      rotCCW: imgOp("Rotation de l'image 90° antihoraire", 'ccw'),
      rot180: imgOp("Rotation de l'image 180°", '180'),
      flipH: imgOp('Symétrie horizontale de la zone de travail', 'fh'),
      flipV: imgOp('Symétrie verticale de la zone de travail', 'fv'),
      flatten: { enabled: hasDoc, run: () => { const r = ops.flatten(D().committed); this.commit("Aplatir l'image", r.state, { activeId: r.activeId }); } },

      newLayer: { enabled: hasDoc, run: () => {
        const d = D(); const l = ops.blankLayer(d.committed);
        this.commit('Nouveau calque', ops.insertLayer(d.committed, l, d.activeId), { activeId: l.id });
        this.selectLayer(l.id);
      } },
      newGroup: { enabled: hasDoc, run: () => {
        const d = D(), st = d.committed;
        const g = mkLayer({ kind: 'group', name: ops.nextLayerName(st, 'Groupe'), blend: 'pass through', canvas: null });
        const above = d.active && !tree.isGroup(d.active) ? d.activeId : d.activeId;
        this.commit('Nouveau groupe', ops.insertLayer(st, g, above), { activeId: g.id });
        this.selectLayer(g.id);
      } },
      groupLayers: { enabled: hasLayer, run: () => {
        const d = D();
        const ids = d.selIds.size ? [...d.selIds] : [d.activeId];
        const r = tree.groupItems(d.committed, ids, ops.nextLayerName(d.committed, 'Groupe'));
        if (r) { this.commit('Grouper les calques', r.state, { activeId: r.activeId }); this.selectLayer(r.activeId); }
      } },
      ungroupLayers: { enabled: () => tree.isGroup(D()?.active), run: () => {
        const r = tree.ungroup(D().committed, D().activeId);
        if (r) { this.commit('Dissocier les calques', r.state, { activeId: r.activeId }); this.selectLayer(r.activeId); }
      } },
      duplicateLayer: { enabled: hasLayer, run: () => {
        const d = D();
        if (d.committed.selection && !tree.isGroup(d.active)) { this.layerFromSelection(false); return; }
        const r = ops.duplicateLayer(d.committed, d.activeId);
        this.commit(tree.isGroup(d.active) ? 'Dupliquer le groupe' : 'Dupliquer le calque', r.state, { activeId: r.activeId });
        this.selectLayer(r.activeId);
      } },
      layerViaCopy: { enabled: () => hasLayer() && !!D().committed.selection, run: () => this.layerFromSelection(false) },
      layerViaCut: { enabled: () => hasLayer() && !!D().committed.selection, run: () => this.layerFromSelection(true) },
      deleteLayer: { enabled: () => !!D()?.active && D().layers.length > 1, run: () => {
        const d = D();
        const ids = d.selIds.size > 1 ? [...d.selIds] : [d.activeId];
        const st = tree.removeItems(d.committed, ids);
        if (!st.layers.length) { toast('Impossible de supprimer le dernier calque.'); return; }
        this.commit(ids.length > 1 ? 'Supprimer les calques' : tree.isGroup(d.active) ? 'Supprimer le groupe' : 'Supprimer le calque', st);
        this.selectLayer(d.activeId);
      } },
      renameLayer: { enabled: hasLayer, run: () => {
        if (window.matchMedia('(max-width: 760px)').matches && this.panelOpen !== 'layers') this.togglePanel('layers');
        const row = document.querySelector(`.layer-row[data-id="${D().activeId}"]`);
        if (row) startRename(this, row, D().active);
      } },
      layerUp: { enabled: () => this.canMove(1), run: () => { const d = D(); this.commit('Ordre des calques', tree.moveSibling(d.committed, d.activeId, 1)); } },
      layerDown: { enabled: () => this.canMove(-1), run: () => { const d = D(); this.commit('Ordre des calques', tree.moveSibling(d.committed, d.activeId, -1)); } },
      layerTop: { enabled: () => this.canMove(1), run: () => { const d = D(); this.commit('Ordre des calques', tree.moveSibling(d.committed, d.activeId, 1, true)); } },
      layerBottom: { enabled: () => this.canMove(-1), run: () => { const d = D(); this.commit('Ordre des calques', tree.moveSibling(d.committed, d.activeId, -1, true)); } },
      clipLayer: { enabled: () => this.canMove(-1), checked: () => !!D()?.active?.clipping, run: () => {
        const d = D(), l = d.active;
        this.commit(l.clipping ? "Annuler le masque d'écrêtage" : "Créer un masque d'écrêtage", ops.updateLayer(d.committed, l.id, { clipping: !l.clipping }));
      } },
      toggleVisible: { enabled: hasLayer, run: () => { const d = D(), l = d.active; this.commit(l.visible ? 'Masquer le calque' : 'Afficher le calque', ops.updateLayer(d.committed, l.id, { visible: !l.visible })); } },
      mergeDown: { enabled: () => hasLayer() && (tree.isGroup(D().active) || !!ops.lowerSibling(D().committed, D().activeId)?.canvas), run: () => {
        const d = D(), l = d.active;
        if (tree.isGroup(l)) { const r = ops.mergeGroup(d.committed, l.id); if (r) { this.commit('Fusionner le groupe', r.state, { activeId: r.activeId }); this.selectLayer(r.activeId); } return; }
        const low = ops.lowerSibling(d.committed, l.id);
        if (!l.visible || !low.visible) { toast('Impossible de fusionner un calque masqué.'); return; }
        const r = ops.mergeDown(d.committed, d.activeId);
        if (r) { this.commit('Fusionner avec le calque inférieur', r.state, { activeId: r.activeId }); this.selectLayer(r.activeId); }
      } },
      mergeVisible: { enabled: () => (D()?.layers.filter(l => !tree.isGroup(l) && l.visible).length || 0) > 1, run: () => {
        const r = ops.mergeVisible(D().committed);
        if (r) { this.commit('Fusionner les calques visibles', r.state, { activeId: r.activeId }); this.selectLayer(r.activeId); }
      } },

      // ——— Masques de fusion ———
      maskReveal: { enabled: () => hasLayer() && !D().active.mask, run: () => this.addMask(D().committed.selection ? 'revealSel' : 'reveal') },
      maskHide: { enabled: () => hasLayer() && !D().active.mask, run: () => this.addMask(D().committed.selection ? 'hideSel' : 'hide') },
      maskRevealAll: { enabled: () => hasLayer() && !D().active.mask, run: () => this.addMask('reveal') },
      maskHideAll: { enabled: () => hasLayer() && !D().active.mask, run: () => this.addMask('hide') },
      maskRevealSel: { enabled: () => hasLayer() && !D().active.mask && !!D().committed.selection, run: () => this.addMask('revealSel') },
      maskHideSel: { enabled: () => hasLayer() && !D().active.mask && !!D().committed.selection, run: () => this.addMask('hideSel') },
      maskToggle: { enabled: () => !!D()?.active?.mask, checked: () => !!D()?.active?.mask?.disabled, run: () => {
        const d = D(), l = d.active;
        this.commit(l.mask.disabled ? 'Activer le masque' : 'Désactiver le masque', ops.updateLayer(d.committed, l.id, { mask: { ...l.mask, disabled: !l.mask.disabled } }));
      } },
      maskDelete: { enabled: () => !!D()?.active?.mask, run: () => { const d = D(); d.target = 'layer'; this.commit('Supprimer le masque', ops.updateLayer(d.committed, d.activeId, { mask: null })); } },
      maskApply: { enabled: () => !!D()?.active?.mask && !!D().active.canvas, run: () => {
        const d = D(), l = d.active;
        const m = { ...l.mask, disabled: false };
        const c = newCanvas(l.canvas.width, l.canvas.height);
        ctxOf(c).drawImage(maskedCanvas({ ...l, mask: m }, l.canvas, m.canvas), 0, 0);
        d.target = 'layer';
        this.commit('Appliquer le masque', ops.updateLayer(d.committed, l.id, { canvas: c, mask: null, text: null }));
      } },
      editMask: { enabled: () => !!D()?.active?.mask, checked: () => D()?.target === 'mask', run: () => { const d = D(); d.target = d.target === 'mask' ? 'layer' : 'mask'; this.refresh({ history: false }); toast(d.target === 'mask' ? 'Vous peignez sur le masque : noir masque, blanc révèle.' : 'Vous peignez sur les pixels du calque.'); } },

      // ——— Sélection ———
      selectAll: { enabled: hasDoc, run: () => this.setSelection(SEL.selAll(D().width, D().height), 'Tout sélectionner') },
      deselect: { enabled: () => !!D()?.committed.selection, run: () => { const d = D(); d.lastSelection = d.committed.selection; this.setSelection(null, 'Désélectionner'); } },
      reselect: { enabled: () => !!D()?.lastSelection && !D().committed.selection, run: () => this.setSelection(D().lastSelection, 'Resélectionner') },
      invertSel: { enabled: hasDoc, run: () => this.setSelection(SEL.invertSel(D().committed.selection, D().width, D().height), 'Intervertir la sélection') },
      featherSel: { enabled: () => !!D()?.committed.selection, run: () => this.dialogSelAmount('Contour progressif', 'Rayon (px)', 10, (sel, v) => SEL.featherSel(sel, v)) },
      growSel: { enabled: () => !!D()?.committed.selection, run: () => this.dialogSelAmount('Dilater la sélection', 'Dilater de (px)', 5, (sel, v) => SEL.growSel(sel, Math.round(v))) },
      shrinkSel: { enabled: () => !!D()?.committed.selection, run: () => this.dialogSelAmount('Contracter la sélection', 'Contracter de (px)', 5, (sel, v) => SEL.growSel(sel, -Math.round(v))) },
      selectLayerPixels: { enabled: () => !!D()?.active?.canvas, run: () => { const l = D().active; this.setSelection(SEL.clipSelToDoc(SEL.selFromAlpha(l.canvas, l.x, l.y), D().width, D().height), 'Sélectionner les pixels du calque'); } },
      selectMask: { enabled: () => !!D()?.active?.mask, run: () => { const m = D().active.mask; this.setSelection(SEL.clipSelToDoc(SEL.selFromAlpha(m.canvas, m.x, m.y), D().width, D().height), 'Sélection depuis le masque'); } },
      cropToSel: { enabled: () => !!D()?.committed.selection, run: () => {
        const b = SEL.selBounds(D().committed.selection);
        this.commit('Recadrer sur la sélection', ops.cropState(D().committed, b, true));
        this.view.fit(true);
      } },
      clearSel: { enabled: () => hasLayer() && !!D().committed.selection, run: () => this.fillLayer(null, 'Effacer') },
      cut: { enabled: () => hasLayer() && !!D().committed.selection && !tree.isGroup(D().active), run: async () => { if (await this.copy(false)) this.fillLayer(null, 'Couper'); } },
      freeTransform: { enabled: hasLayer, run: () => this.startTransform() },

      // ——— Réglages et filtres ———
      newAdjustLayer: { enabled: hasDoc, run: () => this.pickAdjustLayer() },
      editAdjust: { enabled: () => tree.isAdjust(D()?.active), run: () => this.editAdjust(D().activeId) },
      autoLevels: { enabled: () => this.pixelReady(), run: () => this.autoAdjust('levels') },
      autoContrast: { enabled: () => this.pixelReady(), run: () => this.autoAdjust('contrast') },
      autoColor: { enabled: () => this.pixelReady(), run: () => this.autoAdjust('color') },
      desaturate: { enabled: () => this.pixelReady(), run: () => this.quickAdjust('Désaturation', { type: 'huesat', ...ADJ.huesat.defaults(), saturation: -100 }) },
      invertQuick: { enabled: () => this.pixelReady(true), run: () => (D().target === 'mask' ? this.invertMask() : this.quickAdjust('Négatif', { type: 'invert' })) },
      liquify: { enabled: () => this.pixelReady() && !D().active.smart, run: () => liquifyDialog(this) },
      lastFilter: { enabled: () => !!this.lastFilter && this.pixelReady(true), run: () => this.applyFilter(this.lastFilter.id, this.lastFilter.params, false) },
      ...Object.fromEntries(Object.keys(ADJ).map(k => [`adj_${k}`, { enabled: () => this.pixelReady(), run: () => this.adjustDialog(k) }])),
      ...Object.fromEntries(Object.keys(ADJ).map(k => [`adjLayer_${k}`, { enabled: hasDoc, run: () => this.adjustLayerDialog(k) }])),
      ...Object.fromEntries(Object.keys(FILTERS).map(k => [`filter_${k}`, { enabled: () => this.pixelReady(true), run: () => this.applyFilter(k, null, true) }])),

      zoomIn: { enabled: hasDoc, run: () => this.view.zoomStep(1) },
      zoomOut: { enabled: hasDoc, run: () => this.view.zoomStep(-1) },
      fit: { enabled: hasDoc, run: () => this.view.fit(false) },
      zoom100: { enabled: hasDoc, run: () => this.view.actualPixels() },
      bounds: { checked: () => this.opts.showBounds, run: () => { this.opts.showBounds = !this.opts.showBounds; this.saveOpts(); renderOptions(this); this.view.requestRender(); } },
      fullscreen: { enabled: () => !!document.documentElement.requestFullscreen, checked: () => !!document.fullscreenElement, run: () => {
        if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {});
      } },

      shortcuts: { run: () => this.dialogShortcuts() },
      about: { run: () => this.dialogAbout() },
    };
  }

  buildMenus() {
    return [
      { label: 'Fichier', items: [
        { label: 'Nouveau…', action: 'new', key: K('Ctrl+N') },
        { label: 'Ouvrir…', action: 'open', key: K('Ctrl+O') },
        { label: 'Importer une image comme calque…', action: 'import', key: K('Ctrl+Maj+O') },
        '-',
        { label: 'Enregistrer (.psd)', action: 'save', key: K('Ctrl+S') },
        { label: 'Exporter en JPG, PNG ou WebP…', action: 'export', key: K('Ctrl+Alt+Maj+W') },
        '-',
        { label: 'Fermer', action: 'close', key: K('Ctrl+W') },
      ] },
      { label: 'Édition', items: [
        { label: 'Annuler', action: 'undo', key: K('Ctrl+Z') },
        { label: 'Rétablir', action: 'redo', key: K('Ctrl+Maj+Z') },
        '-',
        { label: 'Couper', action: 'cut', key: K('Ctrl+X') },
        { label: 'Copier', action: 'copy', key: K('Ctrl+C') },
        { label: 'Copier avec fusion', action: 'copyMerged', key: K('Ctrl+Maj+C') },
        { label: 'Coller', action: 'paste', key: K('Ctrl+V') },
        '-',
        { label: "Remplissage d'après le contenu (IA)", action: 'contentFill', key: 'Maj+Retour' },
        { label: 'Remplir avec le premier plan', action: 'fillFg', key: 'Alt+Retour' },
        { label: "Remplir avec l'arrière-plan", action: 'fillBg', key: K('Ctrl+Retour') },
        { label: 'Effacer le contenu du calque', action: 'clearLayer' },
        '-',
        { label: 'Transformation manuelle', action: 'freeTransform', key: K('Ctrl+T') },
        { heading: 'Transformation du calque' },
        { label: 'Rotation 90° horaire', action: 'layerCW' },
        { label: 'Rotation 90° antihoraire', action: 'layerCCW' },
        { label: 'Rotation 180°', action: 'layer180' },
        { label: 'Symétrie horizontale', action: 'layerFH' },
        { label: 'Symétrie verticale', action: 'layerFV' },
        { label: 'Centrer dans l\'image', action: 'centerLayer' },
      ] },
      { label: 'Image', items: [
        { label: 'Recadrer…', action: 'cropTool', key: 'C' },
        { label: 'Recadrer sur la sélection', action: 'cropToSel' },
        { label: "Taille de l'image…", action: 'imageSize', key: K('Ctrl+Alt+I') },
        { label: 'Taille de la zone de travail…', action: 'canvasSize', key: K('Ctrl+Alt+C') },
        { label: "Agrandir avec l'IA (×2, ×4)…", action: 'aiUpscale' },
        '-',
        { heading: "Rotation de l'image" },
        { label: '90° horaire', action: 'rotCW' },
        { label: '90° antihoraire', action: 'rotCCW' },
        { label: '180°', action: 'rot180' },
        { label: 'Symétrie horizontale', action: 'flipH' },
        { label: 'Symétrie verticale', action: 'flipV' },
        '-',
        { heading: 'Réglages' },
        ...ADJ_ORDER.map(k => (k === '-' ? '-' : { label: `${ADJ[k].label}…`, action: `adj_${k}`, key: ADJ_KEYS[k] ? K(ADJ_KEYS[k]) : '' })),
        '-',
        { label: 'Niveaux automatiques', action: 'autoLevels', key: K('Ctrl+Maj+L') },
        { label: 'Contraste automatique', action: 'autoContrast', key: K('Ctrl+Alt+Maj+L') },
        { label: 'Couleur automatique', action: 'autoColor', key: K('Ctrl+Maj+B') },
        { label: 'Désaturation', action: 'desaturate', key: K('Ctrl+Maj+U') },
        { label: 'Négatif (inverser)', action: 'invertQuick', key: K('Ctrl+I') },
        '-',
        { label: "Aplatir l'image", action: 'flatten' },
      ] },
      { label: 'Calque', items: [
        { label: 'Nouveau calque', action: 'newLayer', key: K('Ctrl+Maj+N') },
        { label: 'Nouveau groupe', action: 'newGroup' },
        { label: 'Nouveau calque de réglage…', action: 'newAdjustLayer' },
        { label: 'Modifier le réglage…', action: 'editAdjust' },
        { label: 'Dupliquer le calque', action: 'duplicateLayer', key: K('Ctrl+J') },
        { label: 'Calque par copie (sélection)', action: 'layerViaCopy', key: K('Ctrl+J') },
        { label: 'Calque par coupe (sélection)', action: 'layerViaCut', key: K('Ctrl+Maj+J') },
        { label: 'Supprimer le calque', action: 'deleteLayer', key: 'Suppr' },
        { label: 'Renommer le calque…', action: 'renameLayer' },
        { label: 'Modifier le texte…', action: 'editText' },
        { label: 'Afficher / masquer', action: 'toggleVisible', key: K('Ctrl+,') },
        '-',
        { label: "Supprimer l'arrière-plan (IA)", action: 'removeBackground' },
        '-',
        { heading: 'Objet dynamique' },
        { label: 'Convertir en objet dynamique', action: 'toSmart' },
        { label: 'Annuler la transformation', action: 'resetSmart' },
        { label: "Pixelliser l'objet dynamique", action: 'rasterizeSmart' },
        '-',
        { heading: 'Style de calque' },
        { label: 'Effets (ombre, contour, lueur…)…', action: 'layerStyle' },
        { label: 'Copier le style', action: 'styleCopy' },
        { label: 'Coller le style', action: 'stylePaste' },
        { label: 'Masquer les effets', action: 'styleToggle' },
        { label: 'Pixelliser le style', action: 'styleRasterize' },
        { label: 'Effacer le style', action: 'styleClear' },
        '-',
        { label: "Masque d'écrêtage", action: 'clipLayer', key: K('Ctrl+Alt+G') },
        { label: 'Grouper les calques', action: 'groupLayers', key: K('Ctrl+G') },
        { label: 'Dissocier les calques', action: 'ungroupLayers', key: K('Ctrl+Maj+G') },
        '-',
        { heading: 'Masque de fusion' },
        { label: 'Tout faire apparaître', action: 'maskRevealAll' },
        { label: 'Tout masquer', action: 'maskHideAll' },
        { label: 'Faire apparaître la sélection', action: 'maskRevealSel' },
        { label: 'Masquer la sélection', action: 'maskHideSel' },
        { label: 'Peindre sur le masque', action: 'editMask' },
        { label: 'Désactiver le masque', action: 'maskToggle' },
        { label: 'Appliquer le masque', action: 'maskApply' },
        { label: 'Supprimer le masque', action: 'maskDelete' },
        '-',
        { heading: 'Disposition' },
        { label: 'Premier plan', action: 'layerTop', key: K('Ctrl+Maj+]') },
        { label: 'En avant', action: 'layerUp', key: K('Ctrl+]') },
        { label: 'En arrière', action: 'layerDown', key: K('Ctrl+[') },
        { label: 'Arrière-plan', action: 'layerBottom', key: K('Ctrl+Maj+[') },
        '-',
        { label: 'Fusionner avec le calque inférieur', action: 'mergeDown', key: K('Ctrl+E') },
        { label: 'Fusionner les calques visibles', action: 'mergeVisible', key: K('Ctrl+Maj+E') },
        { label: "Aplatir l'image", action: 'flatten' },
      ] },
      { label: 'Sélection', items: [
        { label: 'Tout sélectionner', action: 'selectAll', key: K('Ctrl+A') },
        { label: 'Désélectionner', action: 'deselect', key: K('Ctrl+D') },
        { label: 'Resélectionner', action: 'reselect', key: K('Ctrl+Maj+D') },
        { label: 'Intervertir', action: 'invertSel', key: K('Ctrl+Maj+I') },
        '-',
        { heading: 'Avec l\'IA' },
        { label: 'Sujet', action: 'selectSubject' },
        { label: "Sélection d'objet (outil)", action: 'objselTool', key: 'Maj+W' },
        '-',
        { label: 'Contour progressif…', action: 'featherSel', key: 'Maj+F6' },
        { label: 'Dilater…', action: 'growSel' },
        { label: 'Contracter…', action: 'shrinkSel' },
        '-',
        { label: 'Sélectionner les pixels du calque', action: 'selectLayerPixels' },
        { label: 'Sélection depuis le masque', action: 'selectMask' },
        '-',
        { label: 'Effacer le contenu sélectionné', action: 'clearSel', key: 'Suppr' },
      ] },
      { label: 'Filtre', items: [
        { label: 'Dernier filtre', action: 'lastFilter', key: K('Ctrl+F') },
        '-',
        { label: 'Fluidité…', action: 'liquify', key: K('Ctrl+Maj+X') },
        ...FILTER_ORDER.flatMap((k, i) => {
          const f = FILTERS[k], prev = FILTERS[FILTER_ORDER[i - 1]];
          const row = { label: `${f.label}…`, action: `filter_${k}` };
          return !prev || prev.group !== f.group ? [{ heading: f.group }, row] : [row];
        }),
      ] },
      { label: 'Affichage', items: [
        { label: 'Zoom avant', action: 'zoomIn', key: K('Ctrl++') },
        { label: 'Zoom arrière', action: 'zoomOut', key: K('Ctrl+-') },
        { label: "Taille de l'écran", action: 'fit', key: K('Ctrl+0') },
        { label: '100 % (pixels réels)', action: 'zoom100', key: K('Ctrl+1') },
        '-',
        { label: 'Bords du calque', action: 'bounds' },
        { label: 'Plein écran', action: 'fullscreen', key: 'F11' },
      ] },
      { label: 'Aide', items: [
        { label: 'IA locale (modèles)…', action: 'aiModels' },
        { label: 'Raccourcis clavier', action: 'shortcuts' },
        { label: 'À propos d\'Enluminure', action: 'about' },
      ] },
    ];
  }

  // ——— Interface fixe ———
  bindChrome() {
    $('#brand-logo').innerHTML = LOGO_SMALL;
    $('#btn-undo').innerHTML = icon('undo');
    $('#btn-redo').innerHTML = icon('redo');
    $('#btn-menu').addEventListener('click', (e) => { e.stopPropagation(); this.menubar.openAll($('#btn-menu')); });
    $('#btn-undo').addEventListener('click', () => this.run('undo'));
    $('#btn-redo').addEventListener('click', () => this.run('redo'));
    $('#w-new').addEventListener('click', () => this.run('new'));
    $('#w-open').addEventListener('click', () => this.run('open'));
    $('#w-new').insertAdjacentHTML('afterbegin', icon('file', 20));
    $('#w-open').insertAdjacentHTML('afterbegin', icon('open', 20));
    $('#panel-layers h3').insertAdjacentHTML('afterbegin', icon('layers', 15));
    $('#panel-history h3').insertAdjacentHTML('afterbegin', icon('history', 15));
    for (const b of document.querySelectorAll('.panel-close')) {
      b.innerHTML = icon('close', 16);
      b.addEventListener('click', () => this.togglePanel(this.panelOpen));
    }
    $('#version').textContent = `v${VERSION}`;
    const z = $('#st-zoom');
    z.addEventListener('focus', () => { z.value = z.value.replace(/\s*%/, ''); z.select(); });
    z.addEventListener('keydown', (e) => { if (e.key === 'Enter') z.blur(); if (e.key === 'Escape') { z.value = ''; z.blur(); } });
    z.addEventListener('blur', () => {
      const v = parseFloat(z.value.replace(',', '.'));
      if (this.doc && v > 0) this.view.zoomTo(v / 100);
      this.updateZoomInfo();
    });
    window.addEventListener('beforeunload', (e) => {
      if (this.docs.some(d => d.dirty)) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  bindKeyboard() {
    const map = {
      'ctrl+n': 'new', 'ctrl+o': 'open', 'ctrl+shift+o': 'import', 'ctrl+s': 'save', 'ctrl+shift+s': 'save',
      'ctrl+alt+shift+w': 'export', 'ctrl+alt+shift+s': 'export', 'ctrl+w': 'close',
      'ctrl+z': 'undo', 'ctrl+shift+z': 'redo', 'ctrl+y': 'redo', 'ctrl+alt+z': 'undo',
      'ctrl+c': 'copy', 'ctrl+shift+c': 'copyMerged',
      'ctrl+shift+x': 'liquify', 'ctrl+shift+n': 'newLayer', 'ctrl+j': 'duplicateLayer', 'ctrl+e': 'mergeDown', 'ctrl+shift+e': 'mergeVisible',
      'ctrl+alt+g': 'clipLayer', 'ctrl+alt+i': 'imageSize', 'ctrl+alt+c': 'canvasSize', 'ctrl+,': 'toggleVisible',
      'ctrl+]': 'layerUp', 'ctrl+[': 'layerDown', 'ctrl+shift+]': 'layerTop', 'ctrl+shift+[': 'layerBottom',
      'ctrl+0': 'fit', 'ctrl+1': 'zoom100', 'ctrl++': 'zoomIn', 'ctrl+-': 'zoomOut',
      'delete': 'deleteLayer', 'backspace': 'deleteLayer', 'f11': 'fullscreen',
      'shift+backspace': 'contentFill', 'alt+backspace': 'fillFg', 'alt+delete': 'fillFg', 'ctrl+backspace': 'fillBg', 'ctrl+delete': 'fillBg',
      'ctrl+a': 'selectAll', 'ctrl+d': 'deselect', 'ctrl+shift+d': 'reselect', 'ctrl+shift+i': 'invertSel', 'shift+f6': 'featherSel',
      'ctrl+t': 'freeTransform', 'ctrl+g': 'groupLayers', 'ctrl+shift+g': 'ungroupLayers', 'ctrl+x': 'cut', 'ctrl+shift+j': 'layerViaCut',
      'ctrl+l': 'adj_levels', 'ctrl+m': 'adj_curves', 'ctrl+u': 'adj_huesat', 'ctrl+b': 'adj_colorbalance', 'ctrl+alt+shift+b': 'adj_bw',
      'ctrl+i': 'invertQuick', 'ctrl+shift+u': 'desaturate', 'ctrl+shift+l': 'autoLevels', 'ctrl+alt+shift+l': 'autoContrast', 'ctrl+shift+b': 'autoColor',
      'ctrl+f': 'lastFilter',
    };
    // On « écrit » seulement dans une zone de texte ou de nombre : un curseur, une case à cocher ou une liste
    // qui garde le focus ne doit pas bloquer les raccourcis (Ctrl+Z, B, Espace…).
    const typing = (t) => t && (t.isContentEditable || t.tagName === 'TEXTAREA'
      || (t.tagName === 'INPUT' && !/^(range|checkbox|radio|color|button|file)$/.test(t.type)));
    // Après un clic sur un bouton, un curseur ou une liste, le clavier revient à l'image
    // (sinon Espace ou Entrée ré-actionnent le dernier bouton cliqué au lieu de l'outil).
    const release = (e) => {
      const t = e.target;
      if (!t || !t.closest || t.closest('.modal, .lq-overlay')) return;
      if (e.type === 'click' ? (e.detail > 0 && t.closest('button')) : /^(range|checkbox|radio|color)$/.test(t.type) || t.tagName === 'SELECT') {
        const a = document.activeElement;
        if (a && a !== document.body && !typing(a)) a.blur();
      }
    };
    document.addEventListener('click', release);
    document.addEventListener('change', release);
    // Windows : relâcher Alt (Alt+clic pour la pipette, la source du tampon…) ne doit pas activer le menu du navigateur
    for (const ev of ['keydown', 'keyup']) document.addEventListener(ev, (e) => { if (e.key === 'Alt' && this.doc && !typing(e.target)) e.preventDefault(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === ' ' && !typing(e.target) && !modalOpen()) {
        if (!this.view.spaceHeld) { this.view.spaceHeld = true; this.view.updateCursor(); }
        e.preventDefault();
        return;
      }
      if (typing(e.target) || modalOpen()) return;
      let k;
      if (/^Digit\d$/.test(e.code)) k = e.code.slice(5);
      else if (/^Numpad\d$/.test(e.code)) k = e.code.slice(6);
      else if (e.code === 'NumpadAdd' || e.key === '+' || e.key === '=') k = '+';
      else if (e.code === 'NumpadSubtract' || e.key === '-' || e.key === '_') k = '-';
      else if (e.code === 'BracketRight' || e.key === ']') k = ']';
      else if (e.code === 'BracketLeft' || e.key === '[') k = '[';
      else k = e.key.toLowerCase();
      const ctrl = e.ctrlKey || e.metaKey;
      const combo = `${ctrl ? 'ctrl+' : ''}${e.altKey ? 'alt+' : ''}${e.shiftKey && k !== '+' ? 'shift+' : ''}${k}`;
      // L'outil en cours d'abord (taille du pinceau, Entrée / Échap du recadrage, points du lasso…)
      const impl = this.tools[this.tool];
      if (impl?.key && !ctrl && impl.key(e, k)) { e.preventDefault(); return; }
      if ((combo === 'delete' || combo === 'backspace') && this.doc?.committed.selection) {
        e.preventDefault(); this.run('clearSel'); return;
      }
      if (map[combo]) {
        if (k === 'f11' && !document.documentElement.requestFullscreen) return;
        e.preventDefault();
        this.run(map[combo]);
        return;
      }
      if (ctrl || e.altKey) return;
      // Outils
      if (k === 'g' && e.shiftKey) { this.setTool(this.tool === 'bucket' ? 'gradient' : 'bucket'); return; }
      if (k === 'w' && e.shiftKey) { this.setTool(this.tool === 'objsel' ? 'wand' : 'objsel'); return; }
      if (k === 'j' && e.shiftKey) { this.setTool(this.tool === 'remove' ? 'heal' : 'remove'); return; }
      const tool = { v: 'move', h: 'hand', z: 'zoom', b: 'brush', e: 'eraser', g: 'gradient', i: 'eyedropper', t: 'text', u: 'shapes', c: 'crop', m: 'marquee', l: 'lasso', w: 'wand', s: 'stamp', j: 'heal' }[k];
      if (tool && !e.shiftKey) { this.setTool(tool); return; }
      if (k === 'x') { this.swapColors(); return; }
      if (k === 'd') { this.resetColors(); return; }
      // Décalage au clavier
      const arrows = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] };
      if (arrows[k] && this.tool === 'move' && this.doc?.active) {
        e.preventDefault();
        const [dx, dy] = arrows[k].map(v => v * (e.shiftKey ? 10 : 1));
        this.tools.move.nudge(dx, dy);
      }
    });
    document.addEventListener('keyup', (e) => {
      if (e.key === ' ') { this.view.spaceHeld = false; this.view.updateCursor(); }
    });
    window.addEventListener('blur', () => { this.view.spaceHeld = false; this.view.updateCursor(); });
  }

  // ——— Fichiers ———
  bindFiles() {
    $('#file-open').addEventListener('change', async (e) => {
      const files = [...e.target.files]; e.target.value = '';
      for (const f of files) await this.openFile(f);
    });
    $('#file-import').addEventListener('change', async (e) => {
      const files = [...e.target.files]; e.target.value = '';
      for (const f of files) await this.importAsLayer(f);
    });
    const ws = $('#workspace');
    let depth = 0;
    const isFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    ws.addEventListener('dragenter', (e) => { if (!isFiles(e)) return; e.preventDefault(); depth++; ws.classList.add('dropping'); });
    ws.addEventListener('dragover', (e) => { if (isFiles(e)) e.preventDefault(); });
    ws.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) ws.classList.remove('dropping'); });
    ws.addEventListener('drop', async (e) => {
      e.preventDefault(); depth = 0; ws.classList.remove('dropping');
      const files = [...(e.dataTransfer?.files || [])];
      for (const f of files) {
        if (this.doc && !isPsd(f) && !e.altKey) await this.importAsLayer(f);
        else await this.openFile(f);
      }
    });
    document.addEventListener('paste', async (e) => {
      if (/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
      const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
      if (!item) { if (this.clip && this.doc && !modalOpen()) { e.preventDefault(); this.pasteClip(); } return; }
      e.preventDefault();
      const f = item.getAsFile();
      if (f) await this.pasteImage(f);
    });
    // Ouverture depuis l'explorateur de fichiers (appli installée sur PC)
    if ('launchQueue' in window) {
      window.launchQueue.setConsumer(async (params) => {
        for (const h of params.files || []) await this.openFile(await h.getFile());
      });
    }
  }

  async withBusy(msg, fn) {
    const b = $('#busy');
    $('#busy-msg').textContent = msg;
    b.hidden = false;
    await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
    try { return await fn(); }
    finally { b.hidden = true; }
  }

  async openFile(file) {
    try {
      const { doc, notes } = await this.withBusy(`Ouverture de ${file.name || 'l\'image'}…`, () => openFileAsDoc(file));
      this.addDoc(doc, notes);
    } catch (err) {
      console.error(err);
      toast(err.message || `Impossible d'ouvrir ${file.name}`, 6000);
    }
  }

  async importAsLayer(file, label = 'Importer une image') {
    if (!this.doc) return this.openFile(file);
    if (isPsd(file)) return this.openFile(file);
    try {
      const { canvas, scaled } = await this.withBusy('Import…', () => fileToCanvas(file));
      const d = this.doc;
      const l = mkLayer({
        name: baseName(file.name) || ops.nextLayerName(d.committed),
        canvas,
        x: Math.round((d.width - canvas.width) / 2),
        y: Math.round((d.height - canvas.height) / 2),
      });
      this.commit(label, ops.insertLayer(d.committed, l, d.activeId), { activeId: l.id });
      if (scaled) toast('Image réduite à la taille maximale acceptée par le navigateur.');
    } catch (err) {
      toast(err.message || "Impossible d'importer l'image", 6000);
    }
  }

  async pasteImage(blob) {
    const file = blob instanceof File ? blob : new File([blob], 'Presse-papiers.png', { type: blob.type });
    if (this.doc && this.clipFresh()) { this.pasteClip(); return; }
    if (this.doc && this.clip) { // est-ce notre propre copie ? alors on la recolle au même endroit
      try {
        const bmp = await createImageBitmap(file);
        const mine = bmp.width === this.clip.canvas.width && bmp.height === this.clip.canvas.height;
        bmp.close();
        if (mine) { this.pasteClip(); return; }
      } catch {}
    }
    if (!this.doc) {
      const { doc } = await openFileAsDoc(new File([file], 'Presse-papiers.png', { type: file.type }));
      doc.name = 'Presse-papiers';
      this.addDoc(doc);
      return;
    }
    const { canvas } = await fileToCanvas(file);
    const d = this.doc;
    const l = mkLayer({ name: ops.nextLayerName(d.committed), canvas, x: Math.round((d.width - canvas.width) / 2), y: Math.round((d.height - canvas.height) / 2) });
    this.commit('Coller', ops.insertLayer(d.committed, l, d.activeId), { activeId: l.id });
  }

  async pasteFromMenu() {
    try {
      if (!navigator.clipboard?.read) throw new Error('indisponible');
      if (this.doc && this.clipFresh()) { this.pasteClip(); return; }
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const type = it.types.find(t => t.startsWith('image/'));
        if (type) { await this.pasteImage(await it.getType(type)); return; }
      }
      if (!this.pasteClip()) toast('Le presse-papiers ne contient pas d\'image.');
    } catch {
      if (!this.pasteClip()) toast(`Rien à coller pour l'instant : copiez d'abord un calque ou une sélection (ou utilisez ${MOD}+V pour une image venue d'ailleurs).`, 5000);
    }
  }

  async copy(merged) {
    const d = this.doc;
    let c;
    const sel = d.committed.selection;
    if (merged) c = flattenState(d.committed);
    else if (tree.isGroup(d.active)) { const r = ops.mergeGroup(d.committed, d.activeId); c = r.state.layers.find(l => l.id === r.activeId).canvas; }
    else c = d.active.canvas;
    if (!c) { toast('Ce calque n\'a pas de pixels à copier.'); return; }
    if (sel) {
      const ox = merged || tree.isGroup(d.active) ? 0 : d.active.x, oy = merged || tree.isGroup(d.active) ? 0 : d.active.y;
      const cut = SEL.cutOut(c, ox, oy, sel);
      if (!cut) { toast('Rien de sélectionné à copier.'); return; }
      c = cut.canvas;
    }
    // Copie gardée dans l'appli (coller marche toujours, au même endroit), et dans le presse-papiers du système si possible
    freeCanvas(this.clip?.canvas);
    const pos = sel ? SEL.selBounds(sel) : (merged || tree.isGroup(d.active) ? { x: 0, y: 0 } : { x: d.active.x, y: d.active.y });
    const clip = this.clip = { canvas: cloneCanvas(c), x: pos.x, y: pos.y, w: d.width, h: d.height, t: Date.now(), sync: 'pending' };
    const what = merged ? 'Image fusionnée copiée.' : sel ? 'Sélection copiée.' : 'Calque copié.';
    // Le message s'affiche tout de suite : le presse-papiers du système peut être lent (grande image) ou refusé
    toast(what);
    const only = () => { clip.sync = 'failed'; if (this.clip === clip) toast(`${what} (Collez-la dans Enluminure avec ${MOD}+V ou Édition › Coller.)`, 4000); };
    try {
      if (!navigator.clipboard?.write || !window.ClipboardItem) throw new Error('indisponible');
      navigator.clipboard.write([new ClipboardItem({ 'image/png': canvasToBlob(clip.canvas, 'image/png') })]).then(() => { clip.sync = 'ok'; }, only);
    } catch { only(); }
    return true;
  }

  /** Vrai si notre copie est plus récente que ce que contient le presse-papiers du système (envoi en cours, ou refusé il y a peu). */
  clipFresh() {
    const k = this.clip;
    return !!k && (k.sync === 'pending' || (k.sync === 'failed' && Date.now() - k.t < 60000));
  }

  /** Colle la copie gardée dans l'appli, au même endroit si le document a la même taille. */
  pasteClip() {
    const k = this.clip;
    if (!k || !this.doc) return false;
    const d = this.doc, same = d.width === k.w && d.height === k.h;
    const canvas = cloneCanvas(k.canvas);
    const l = mkLayer({ name: ops.nextLayerName(d.committed), canvas, x: same ? k.x : Math.round((d.width - canvas.width) / 2), y: same ? k.y : Math.round((d.height - canvas.height) / 2) });
    this.commit('Coller', ops.insertLayer(d.committed, l, d.activeId), { activeId: l.id });
    return true;
  }

  /** Remplit (ou efface, color = null) le calque ou son masque, limité à la sélection. */
  fillLayer(color, label) {
    const d = this.doc, L = d.active;
    if (!L.visible) { toast('Ce calque est masqué.'); return; }
    if (this.smartBlocked(L)) return;
    const P = prepareTarget(d, L.id);
    if (!P) { toast('Choisissez un calque, pas un groupe.'); return; }
    const sel = d.committed.selection;
    const area = sel ? SEL.selBounds(sel) : { x: 0, y: 0, w: d.width, h: d.height };
    commitPixels(this, label, L.id, area, (ctx, T, r) => {
      const si = selIn(T);
      const cov = newCanvas(r.w, r.h); // zone couverte
      const cctx = ctxOf(cov);
      cctx.fillRect(0, 0, r.w, r.h);
      if (si) { cctx.globalCompositeOperation = 'destination-in'; cctx.drawImage(si.canvas, si.ox - r.x, si.oy - r.y); }
      if (T.target === 'mask') applyBuf(ctx, cov, 0, 0, r.x, r.y, r.w, r.h, { alpha: 1, lum: color ? lumOf(color) : 1 });
      else if (!color) applyBuf(ctx, cov, 0, 0, r.x, r.y, r.w, r.h, { alpha: 1, op: 'destination-out' });
      else { cctx.globalCompositeOperation = 'source-in'; cctx.fillStyle = color; cctx.fillRect(0, 0, r.w, r.h); applyBuf(ctx, cov, 0, 0, r.x, r.y, r.w, r.h, { alpha: 1, op: 'source-over' }); }
      cov.width = 0;
    }, P);
  }

  canMove(dir) {
    const d = this.doc, l = d?.active;
    if (!l) return false;
    const sibs = tree.siblingsOf(d.layers, l);
    const i = sibs.indexOf(l);
    return dir > 0 ? i < sibs.length - 1 : i > 0;
  }

  /** Sélection d'un calque dans le panneau ('single', 'toggle', 'range'). */
  selectLayer(id, how = 'single') {
    const d = this.doc; if (!d || !id) return;
    if (how === 'single' && d.activeId === id && d.selIds.size === 1 && d.selIds.has(id)) return; // déjà choisi
    if (how === 'toggle') {
      if (d.selIds.has(id) && d.selIds.size > 1) { d.selIds.delete(id); if (d.activeId === id) d.activeId = [...d.selIds].at(-1); }
      else { d.selIds.add(id); d.activeId = id; }
    } else if (how === 'range' && d.activeId) {
      const order = [...document.querySelectorAll('#layers-list .layer-row')].map(r => r.dataset.id);
      const a = order.indexOf(d.activeId), b = order.indexOf(id);
      if (a >= 0 && b >= 0) { d.selIds = new Set(order.slice(Math.min(a, b), Math.max(a, b) + 1)); d.activeId = id; }
    } else { d.selIds = new Set([id]); d.activeId = id; }
    const L = d.active;
    if (!L?.mask) d.target = 'layer';
    this.refresh({ history: false });
  }

  setSelection(sel, label) {
    const d = this.doc;
    if (!sel && !d.committed.selection) return;
    this.commit(label, { ...d.committed, selection: sel || null });
  }

  /** Nouveau calque à partir de la sélection (copie ou coupe). */
  layerFromSelection(cutToo) {
    const d = this.doc, L = d.active, sel = d.committed.selection;
    if (!L?.canvas || tree.isGroup(L)) { toast('Choisissez un calque.'); return; }
    const piece = SEL.cutOut(L.canvas, L.x, L.y, sel);
    if (!piece) { toast('Rien de sélectionné sur ce calque.'); return; }
    const nl = mkLayer({ name: cutToo ? `${L.name} (coupé)` : `${L.name} (copie)`, canvas: piece.canvas, x: piece.x, y: piece.y });
    if (cutToo) {
      this.fillLayer(null, 'Couper');
      this.commit('Calque par coupe', ops.insertLayer(d.committed, nl, L.id), { activeId: nl.id });
    } else this.commit('Calque par copie', ops.insertLayer(d.committed, nl, L.id), { activeId: nl.id });
    this.selectLayer(nl.id);
  }

  addMask(kind) {
    const d = this.doc, L = d.active, st = d.committed;
    const W = st.width, H = st.height;
    const c = newCanvas(W, H);
    const ctx = ctxOf(c);
    const sel = st.selection;
    let def = 255;
    if (kind === 'reveal') ctx.fillRect(0, 0, W, H);
    else if (kind === 'hide') def = 0;
    else if (kind === 'revealSel') { ctx.drawImage(sel.canvas, sel.x, sel.y); def = 0; }
    else if (kind === 'hideSel') { ctx.fillRect(0, 0, W, H); ctx.globalCompositeOperation = 'destination-out'; ctx.drawImage(sel.canvas, sel.x, sel.y); }
    const label = { reveal: 'Masque : tout faire apparaître', hide: 'Masque : tout masquer', revealSel: 'Masque : faire apparaître la sélection', hideSel: 'Masque : masquer la sélection' }[kind];
    d.target = 'mask';
    this.commit(label, { ...ops.updateLayer(st, L.id, { mask: { canvas: c, x: 0, y: 0, def, disabled: false } }), selection: kind.endsWith('Sel') ? null : st.selection });
    toast('Masque ajouté : peignez en noir pour masquer, en blanc pour révéler.');
  }

  async dialogSelAmount(title, label, def, fn) {
    const input = el('input', { type: 'number', min: 1, max: 500, value: def, inputmode: 'numeric' });
    const v = await openDialog({ title, body: el('div', { class: 'form' }, field(label, input)), onSubmit: () => +input.value });
    if (!v || v <= 0) return;
    const d = this.doc;
    const sel = await this.withBusy('Calcul…', () => fn(d.committed.selection, v));
    this.setSelection(SEL.clipSelToDoc(sel, d.width, d.height), title);
  }

  // ——— Transformation manuelle ———
  startTransform() {
    if (!this.doc || this.tool === 'transform') return;
    if (!this.tools.transform.begin()) return;
    this.prevTool = this.tool;
    this.tools[this.tool]?.deactivate?.();
    this.tool = 'transform';
    renderOptions(this); renderToolbar(this); this.view.updateCursor();
  }
  endTransform() {
    this.tool = this.prevTool && this.prevTool !== 'transform' ? this.prevTool : 'move';
    renderOptions(this); renderToolbar(this); this.view.updateCursor();
  }

  // ——— Réglages et filtres ———
  /** Calque de pixels prêt à être modifié (ou son masque si `maskOk`). */
  pixelReady(maskOk = false) {
    const d = this.doc, L = d?.active;
    if (!L) return false;
    if (d.target === 'mask' && L.mask) return maskOk;
    return !!L.canvas;
  }

  /**
   * Fenêtre avec aperçu en direct, puis modification des pixels du calque (ou du masque),
   * limitée à la sélection. `run(source, zone, réglages)` renvoie la zone modifiée.
   */
  /** Message (et refus) quand on veut peindre directement sur un objet dynamique. */
  smartBlocked(L = this.doc?.active) {
    if (!L?.smart || this.doc.target === 'mask') return false;
    toast("C'est un objet dynamique : pixellisez-le d'abord (Calque › Pixelliser l'objet dynamique), ou peignez sur un nouveau calque.", 5000);
    return true;
  }

  async pixelDialog({ title, label, params, ui, run, histo = false, skipDialog = false, smart = null }) {
    const d = this.doc, L = d.active;
    if (!effectiveVisibleL(d, L)) { toast('Ce calque est masqué.'); return; }
    if (L?.smart && d.target !== 'mask') {
      if (!smart) { this.smartBlocked(L); return; }
      return this.smartFilterDialog({ title, ui, histo, skipDialog, entry: { ...smart, params, on: true } });
    }
    const P = prepareTarget(d, L.id);
    if (!P) { toast('Choisissez un calque de pixels.'); return; }
    const si = selIn(P);
    const full = { x: 0, y: 0, w: P.canvas.width, h: P.canvas.height };
    let r = full;
    if (si) {
      const x = Math.max(0, si.ox), y = Math.max(0, si.oy);
      r = { x, y, w: Math.min(full.w, si.ox + si.canvas.width) - x, h: Math.min(full.h, si.oy + si.canvas.height) - y };
      if (r.w <= 0 || r.h <= 0) { toast('La sélection est en dehors du calque.'); return; }
    }
    const pv = newCanvas(full.w, full.h);
    const pctx = ctxOf(pv);
    pctx.drawImage(P.canvas, 0, 0);
    const render = () => {
      let res;
      try { res = run(P.canvas, r, params); } catch (err) { console.error(err); toast(err.message, 5000); return false; }
      pctx.save();
      pctx.clearRect(r.x, r.y, r.w, r.h);
      pctx.drawImage(P.canvas, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
      if (si) {
        const t = newCanvas(r.w, r.h);
        const tctx = ctxOf(t);
        tctx.drawImage(res, 0, 0);
        tctx.globalCompositeOperation = 'destination-in';
        tctx.drawImage(si.canvas, si.ox - r.x, si.oy - r.y);
        pctx.globalCompositeOperation = P.target === 'mask' ? 'source-over' : 'source-atop';
        if (P.target === 'mask') { // masque : on remplace la valeur dans la sélection
          pctx.globalCompositeOperation = 'destination-out';
          pctx.drawImage(si.canvas, si.ox, si.oy);
          pctx.globalCompositeOperation = 'lighter';
        }
        pctx.drawImage(t, r.x, r.y);
        t.width = 0;
      } else {
        pctx.clearRect(r.x, r.y, r.w, r.h);
        pctx.drawImage(res, r.x, r.y);
      }
      pctx.restore();
      return true;
    };
    let showPreview = true, raf = 0;
    const update = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (!showPreview) { d.cancelPreview(); this.view.requestRender(); return; }
        if (!render()) return;
        if (P.state !== d.committed && d.preview !== P.state) d.setPreview(P.state);
        d.setLive({ layerId: L.id, canvas: pv, target: P.target });
        this.view.requestRender();
      });
    };
    let ok = true;
    if (!skipDialog) {
      const ctx = { histo: histo ? histogram(P.canvas) : null };
      const prevBox = el('input', { type: 'checkbox', checked: true });
      prevBox.addEventListener('change', () => { showPreview = prevBox.checked; update(); });
      const body = el('div', { class: 'form' }, ui(params, update, ctx), el('label', { class: 'opt adj-check' }, prevBox, 'Aperçu'));
      update();
      ok = await openDialog({ title, body, floating: true, className: 'adj-dialog', buttons: [{ label: 'Annuler', value: false }, { label: 'OK', primary: true, value: true }] });
      cancelAnimationFrame(raf); raf = 0;
    }
    if (!ok) { d.cancelPreview(); pv.width = 0; this.refresh({ history: false }); return; }
    await this.withBusy('Application…', async () => {
      if (!render()) return;
      commitPixels(this, label, L.id, { x: r.x + P.ox, y: r.y + P.oy, w: r.w, h: r.h }, (ctx, T, rr) => {
        ctx.clearRect(rr.x, rr.y, rr.w, rr.h);
        ctx.drawImage(pv, rr.x, rr.y, rr.w, rr.h, rr.x, rr.y, rr.w, rr.h);
      }, P);
    });
    pv.width = 0;
  }

  /** Ajoute (index = null) ou modifie un filtre dynamique, avec aperçu en direct. */
  async smartFilterDialog({ title, ui, histo = false, skipDialog = false, entry, index = null }) {
    const d = this.doc, L = d.active, st0 = d.committed;
    const base = L.smart.filters || [];
    const label = SM.smartFilterLabel(entry);
    const stateWith = () => {
      const list = base.slice();
      const e = { ...entry, params: structuredClone(entry.params) };
      if (index == null) list.push(e); else list[index] = e;
      return SM.updateSmart(st0, L.id, { filters: list });
    };
    let ok = true;
    if (!skipDialog && ui) {
      let raf = 0;
      const update = () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; d.setPreview(stateWith()); this.view.requestRender(); }); };
      const ctx = { histo: histo ? histogram(L.canvas) : null };
      update();
      ok = await openDialog({ title: `${title} (filtre dynamique)`, body: el('div', { class: 'form' }, ui(entry.params, update, ctx)), floating: true, className: 'adj-dialog', buttons: [{ label: 'Annuler', value: false }, { label: 'OK', primary: true, value: true }] });
      cancelAnimationFrame(raf);
    }
    if (!ok) { d.cancelPreview(); this.refresh({ history: false }); return; }
    const st = await this.withBusy('Application…', () => stateWith());
    this.commit(index == null ? `Filtre dynamique : ${label}` : `Modifier : ${label}`, st);
  }

  editSmartFilter(layerId, i) {
    this.selectLayer(layerId);
    const L = this.doc.active, f = L?.smart?.filters?.[i];
    if (!f) return;
    const entry = structuredClone(f);
    if (f.kind === 'filter') return this.smartFilterDialog({ title: FILTERS[f.id].label, ui: FILTERS[f.id].ui, entry, index: i });
    if (f.kind === 'adjust') { const def = ADJ[f.params.type]; return this.smartFilterDialog({ title: def.label, ui: def.ui, histo: def.histo, entry, index: i }); }
    toast("Ce réglage automatique n'a pas d'options : vous pouvez le masquer ou le supprimer.");
  }

  setSmartFilters(layerId, filters, label) {
    const d = this.doc;
    this.commit(label, SM.updateSmart(d.committed, layerId, { filters }));
  }

  adjustDialog(type) {
    const def = ADJ[type];
    const params = { type, ...def.defaults(this) };
    return this.pixelDialog({ title: def.label, label: def.label, params, ui: def.ui, histo: def.histo, run: (src, r, p) => applyAdjust(src, p, r), smart: { kind: 'adjust' } });
  }

  quickAdjust(label, adj) {
    return this.pixelDialog({ title: label, label, params: adj, skipDialog: true, run: (src, r, p) => applyAdjust(src, p, r), smart: { kind: 'adjust' } });
  }

  autoAdjust(kind) {
    const d = this.doc, L = d.active;
    if (!L?.canvas) return;
    const H = histogram(L.canvas);
    const lut = autoLUT(H, kind);
    const label = { levels: 'Niveaux automatiques', contrast: 'Contraste automatique', color: 'Couleur automatique' }[kind];
    return this.pixelDialog({ title: label, label, params: { lut }, skipDialog: true, run: (src, r) => glRun(src, r, [{ frag: LUT_SHADER, lut }]), smart: { kind: 'lut', label } });
  }

  /** Négatif d'un masque : ce qui était masqué devient visible et inversement. */
  invertMask() {
    const d = this.doc;
    return this.pixelDialog({
      title: 'Négatif', label: 'Négatif (masque)', params: {}, skipDialog: true,
      run: (src, r) => {
        const t = newCanvas(r.w, r.h);
        const c = ctxOf(t);
        c.fillRect(0, 0, r.w, r.h);
        c.globalCompositeOperation = 'destination-out';
        c.drawImage(src, -r.x, -r.y);
        return t;
      },
    }).then(() => void d);
  }

  async applyFilter(id, params, withDialog) {
    const f = FILTERS[id];
    const p = params ? structuredClone(params) : (this.filterParams?.[id] ? structuredClone(this.filterParams[id]) : f.defaults());
    if (id === 'noise') p.seed = Math.random() * 100;
    await this.pixelDialog({ title: f.label, label: f.label, params: p, ui: f.ui, run: (src, r, pp) => f.run(src, r, pp), skipDialog: !withDialog, smart: { kind: 'filter', id } });
    this.lastFilter = { id, params: p };
    this.filterParams = { ...(this.filterParams || {}), [id]: p };
  }

  /** Nouveau calque de réglage : choix du type. */
  async pickAdjustLayer() {
    const grid = el('div', { class: 'adj-pick' });
    let chosen = null;
    for (const k of ADJ_ORDER) {
      if (k === '-') continue;
      const b = el('button', { type: 'button', class: 'btn' }, ADJ[k].label);
      b.addEventListener('click', () => { chosen = k; b.closest('form').requestSubmit(); });
      grid.append(b);
    }
    const type = await openDialog({ title: 'Nouveau calque de réglage', body: grid, buttons: [{ label: 'Annuler', value: null }], onSubmit: () => chosen || false });
    if (type) this.adjustLayerDialog(type);
  }

  /** Crée (ou modifie) un calque de réglage, avec aperçu en direct sur toute l'image. */
  async adjustLayerDialog(type, existingId = null) {
    const d = this.doc;
    const st0 = d.committed;
    const existing = existingId ? st0.layers.find(l => l.id === existingId) : null;
    const def = ADJ[type];
    const params = existing ? structuredClone(existing.adjust) : { type, ...def.defaults(this) };
    let layer = existing;
    if (!layer) {
      const sel = st0.selection;
      let mask = null;
      if (sel) { const c = newCanvas(st0.width, st0.height); ctxOf(c).drawImage(sel.canvas, sel.x, sel.y); mask = { canvas: c, x: 0, y: 0, def: 0, disabled: false }; }
      layer = mkLayer({ kind: 'adjust', name: def.label, canvas: null, adjust: params, mask });
    }
    let raf = 0;
    const stateWith = () => (existing
      ? ops.updateLayer(st0, existing.id, { adjust: structuredClone(params) })
      : ops.insertLayer(st0, { ...layer, adjust: structuredClone(params) }, d.activeId));
    const update = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; d.setPreview(stateWith()); this.view.requestRender(); });
    };
    const ctx = { histo: def.histo ? histogram(d.composite()) : null };
    update();
    const ok = await openDialog({ title: `${existing ? 'Modifier' : 'Calque de réglage'} : ${def.label}`, body: def.ui(params, update, ctx), floating: true, className: 'adj-dialog', buttons: [{ label: 'Annuler', value: false }, { label: 'OK', primary: true, value: true }] });
    cancelAnimationFrame(raf);
    if (!ok) { d.cancelPreview(); this.refresh({ history: false }); return; }
    const st = stateWith();
    this.commit(existing ? `Modifier : ${def.label}` : `Calque de réglage : ${def.label}`, { ...st, selection: existing ? st.selection : null }, { activeId: layer.id });
    if (!existing) { d.target = layer.mask ? 'mask' : 'layer'; this.selectLayer(layer.id); }
  }

  /** Calque qui peut recevoir des effets (pixels ou texte, pas un groupe ni un réglage). */
  stylable(l = this.doc?.active) { return !!l && !tree.isGroup(l) && !tree.isAdjust(l) && !!l.canvas; }

  editStyle(id, focus) { this.selectLayer(id); if (this.stylable()) styleDialog(this, id, focus); }

  editAdjust(id) {
    const l = this.doc?.committed.layers.find(x => x.id === id);
    if (tree.isAdjust(l)) this.adjustLayerDialog(l.adjust.type, id);
  }

  async savePsd() {
    const d = this.doc;
    const blob = await this.withBusy('Préparation du fichier .psd…', () => docToPsdBlob(d));
    const ok = await saveBlob(blob, `${d.name}.psd`, 'Document Photoshop');
    if (ok) {
      d.markSaved(); this.refresh({ history: false });
      toast(d.committed.layers.some(l => l.smart) ? 'Document enregistré. Les objets dynamiques y sont enregistrés comme calques normaux.' : 'Document enregistré.', 4500);
    }
  }

  // ——— Fenêtres ———
  async dialogNew() {
    const presets = [
      ['Personnalisé', 0, 0],
      ['Écran Full HD — 1920 × 1080', 1920, 1080],
      ['Écran 4K — 3840 × 2160', 3840, 2160],
      ['Carré réseaux sociaux — 1080 × 1080', 1080, 1080],
      ['Story / téléphone — 1080 × 1920', 1080, 1920],
      ['A4 portrait 300 ppp — 2480 × 3508', 2480, 3508],
      ['A4 paysage 300 ppp — 3508 × 2480', 3508, 2480],
      ['Photo 10 × 15 300 ppp — 1800 × 1200', 1800, 1200],
      ['Photo GoPro 4:3 — 4000 × 3000', 4000, 3000],
    ];
    const last = (() => { try { return JSON.parse(localStorage.getItem('enluminure.new') || 'null'); } catch { return null; } })() || { w: 1920, h: 1080, bg: 'white', color: '#C9804F' };
    const name = el('input', { type: 'text', value: 'Sans titre' });
    const preset = el('select', {}, presets.map(([l], i) => el('option', { value: i }, l)));
    const w = el('input', { type: 'number', min: 1, max: LIMITS.side, value: last.w, inputmode: 'numeric' });
    const h = el('input', { type: 'number', min: 1, max: LIMITS.side, value: last.h, inputmode: 'numeric' });
    const bg = el('select', {},
      el('option', { value: 'white' }, 'Blanc'), el('option', { value: 'black' }, 'Noir'),
      el('option', { value: 'transparent' }, 'Transparent'), el('option', { value: 'color' }, 'Couleur…'));
    bg.value = last.bg;
    const color = el('input', { type: 'color', value: last.color });
    const colorWrap = field('Couleur du fond', color);
    const syncColor = () => { colorWrap.hidden = bg.value !== 'color'; };
    bg.addEventListener('change', syncColor); syncColor();
    const match = () => { const i = presets.findIndex(p => p[1] === +w.value && p[2] === +h.value); preset.value = i > 0 ? i : 0; };
    preset.addEventListener('change', () => { const p = presets[+preset.value]; if (p[1]) { w.value = p[1]; h.value = p[2]; } });
    w.addEventListener('input', match); h.addEventListener('input', match); match();
    const swap = el('button', { type: 'button', class: 'btn small', title: 'Inverser largeur et hauteur' }, '⇄');
    swap.addEventListener('click', () => { [w.value, h.value] = [h.value, w.value]; match(); });
    const body = el('div', { class: 'form' },
      field('Nom', name),
      field('Modèle', preset),
      el('div', { class: 'row' }, field('Largeur (px)', w), swap, field('Hauteur (px)', h)),
      field('Fond', bg), colorWrap);
    await openDialog({
      title: 'Nouveau document', body, buttons: [{ label: 'Annuler' }, { label: 'Créer', primary: true }],
      onSubmit: () => {
        const W = Math.round(+w.value), H = Math.round(+h.value);
        if (!fitsLimits(W, H)) { toast(`Taille impossible : maximum ${LIMITS.side} px de côté et ${Math.round(LIMITS.area / 1e6)} millions de pixels.`, 5000); return false; }
        try { localStorage.setItem('enluminure.new', JSON.stringify({ w: W, h: H, bg: bg.value, color: color.value })); } catch {}
        const c = newCanvas(W, H);
        if (bg.value !== 'transparent') {
          const ctx = ctxOf(c);
          ctx.fillStyle = bg.value === 'white' ? '#ffffff' : bg.value === 'black' ? '#000000' : color.value;
          ctx.fillRect(0, 0, W, H);
        }
        const layer = mkLayer({ name: bg.value === 'transparent' ? 'Calque 1' : 'Arrière-plan', canvas: c });
        const doc = new Doc({ name: name.value.trim() || 'Sans titre', width: W, height: H, layers: [layer], label: 'Nouveau document' });
        doc.markSaved(); // un document vide n'a rien à perdre
        this.addDoc(doc);
      },
    });
  }

  async dialogImageSize() {
    const d = this.doc;
    const W0 = d.width, H0 = d.height;
    const unit = el('select', {}, el('option', { value: 'px' }, 'pixels'), el('option', { value: 'pc' }, 'pour cent'));
    const w = el('input', { type: 'number', min: 1, step: 'any', value: W0, inputmode: 'decimal' });
    const h = el('input', { type: 'number', min: 1, step: 'any', value: H0, inputmode: 'decimal' });
    const lock = el('input', { type: 'checkbox', checked: true });
    const method = el('select', {},
      el('option', { value: 'auto' }, 'Automatique (meilleure qualité)'),
      el('option', { value: 'bilinear' }, 'Bilinéaire (plus rapide)'),
      el('option', { value: 'nearest' }, 'Au plus proche (pixels nets)'));
    const info = el('p', { class: 'muted' });
    const toPx = () => unit.value === 'px' ? [Math.round(+w.value), Math.round(+h.value)] : [Math.round(W0 * +w.value / 100), Math.round(H0 * +h.value / 100)];
    const upd = () => { const [a, b] = toPx(); info.textContent = `Nouvelle taille : ${a || '?'} × ${b || '?'} px (actuelle : ${W0} × ${H0} px)`; };
    w.addEventListener('input', () => { if (lock.checked && +w.value > 0) h.value = unit.value === 'px' ? Math.round(+w.value * H0 / W0) : w.value; upd(); });
    h.addEventListener('input', () => { if (lock.checked && +h.value > 0) w.value = unit.value === 'px' ? Math.round(+h.value * W0 / H0) : h.value; upd(); });
    unit.addEventListener('change', () => {
      if (unit.value === 'pc') { w.value = +(100 * +w.value / W0).toFixed(2); h.value = +(100 * +h.value / H0).toFixed(2); }
      else { w.value = Math.round(W0 * +w.value / 100); h.value = Math.round(H0 * +h.value / 100); }
      upd();
    });
    upd();
    const body = el('div', { class: 'form' },
      el('div', { class: 'row' }, field('Largeur', w), field('Hauteur', h), field('Unité', unit)),
      el('label', { class: 'opt' }, lock, 'Conserver les proportions'),
      field('Rééchantillonnage', method), info);
    await openDialog({
      title: "Taille de l'image", body,
      onSubmit: async () => {
        const [W, H] = toPx();
        if (!fitsLimits(W, H)) { toast('Taille impossible pour ce navigateur.', 4000); return false; }
        if (W === W0 && H === H0) return;
        const st0 = d.committed;
        const st = await this.withBusy('Redimensionnement…', () => SM.resmartAll(st0, ops.resizeImage(st0, W, H, method.value), 'scale', W / st0.width, H / st0.height));
        this.commit("Taille de l'image", st);
        this.view.fit(true);
      },
    });
  }

  async dialogCanvasSize() {
    const d = this.doc;
    const W0 = d.width, H0 = d.height;
    const w = el('input', { type: 'number', min: 1, value: W0, inputmode: 'numeric' });
    const h = el('input', { type: 'number', min: 1, value: H0, inputmode: 'numeric' });
    let anchor = 4;
    const grid = el('div', { class: 'anchor-grid' });
    const arrows = ['↖', '↑', '↗', '←', '•', '→', '↙', '↓', '↘'];
    const paint = () => [...grid.children].forEach((b, i) => { b.classList.toggle('on', i === anchor); b.textContent = i === anchor ? '●' : arrows[i]; });
    for (let i = 0; i < 9; i++) {
      const b = el('button', { type: 'button' });
      b.addEventListener('click', () => { anchor = i; paint(); });
      grid.append(b);
    }
    paint();
    const fill = el('select', {},
      el('option', { value: '' }, 'Transparent'), el('option', { value: '#ffffff' }, 'Blanc'),
      el('option', { value: '#000000' }, 'Noir'), el('option', { value: 'color' }, 'Couleur…'));
    const color = el('input', { type: 'color', value: '#C9804F' });
    const cw = field('Couleur', color);
    const sync = () => { cw.hidden = fill.value !== 'color'; };
    fill.addEventListener('change', sync); sync();
    const body = el('div', { class: 'form' },
      el('p', { class: 'muted' }, `Taille actuelle : ${W0} × ${H0} px. Agrandir ajoute de la place autour de l'image ; réduire la recadre.`),
      el('div', { class: 'row' }, field('Largeur (px)', w), field('Hauteur (px)', h)),
      field('Point d\'ancrage', grid),
      field('Remplir la zone ajoutée (calque du bas)', fill), cw);
    await openDialog({
      title: 'Taille de la zone de travail', body,
      onSubmit: () => {
        const W = Math.round(+w.value), H = Math.round(+h.value);
        if (!fitsLimits(W, H)) { toast('Taille impossible pour ce navigateur.', 4000); return false; }
        if (W === W0 && H === H0) return;
        const f = fill.value === 'color' ? color.value : fill.value || null;
        this.commit('Taille de la zone de travail', ops.resizeCanvasArea(d.committed, W, H, anchor, f));
        this.view.fit(true);
      },
    });
  }

  async dialogExport() {
    const d = this.doc;
    const last = (() => { try { return JSON.parse(localStorage.getItem('enluminure.export') || 'null'); } catch { return null; } })() || { format: 'jpg', quality: 90, scale: 100 };
    const format = el('select', {}, el('option', { value: 'jpg' }, 'JPG — photos, fichier léger'), el('option', { value: 'png' }, 'PNG — sans perte, transparence'), el('option', { value: 'webp' }, 'WebP — léger, transparence'));
    format.value = last.format;
    const q = el('input', { type: 'range', min: 10, max: 100, value: last.quality });
    const qv = el('span', { class: 'qv' }, `${last.quality} %`);
    q.addEventListener('input', () => { qv.textContent = `${q.value} %`; });
    const qf = field('Qualité', el('div', { class: 'row tight' }, q, qv));
    const scale = el('select', {}, [100, 75, 50, 33, 25].map(s => el('option', { value: s }, `${s} % — ${Math.round(d.width * s / 100)} × ${Math.round(d.height * s / 100)} px`)));
    scale.value = last.scale;
    const fname = el('input', { type: 'text', value: d.name });
    const sync = () => { qf.hidden = format.value === 'png'; };
    format.addEventListener('change', sync); sync();
    const note = el('p', { class: 'muted' }, isIOS ? 'Sur iPhone, choisissez « Enregistrer l\'image » pour la mettre dans Photos.' : 'Les calques sont fusionnés dans le fichier exporté. Pour les garder, enregistrez aussi en .psd.');
    const body = el('div', { class: 'form' }, field('Nom du fichier', fname), field('Format', format), qf, field('Taille', scale), note);
    await openDialog({
      title: 'Exporter', body, buttons: [{ label: 'Annuler' }, { label: 'Exporter', primary: true }],
      onSubmit: async () => {
        const opts = { format: format.value, quality: +q.value / 100, scale: +scale.value / 100 };
        try { localStorage.setItem('enluminure.export', JSON.stringify({ format: format.value, quality: +q.value, scale: +scale.value })); } catch {}
        const blob = await this.withBusy('Export…', () => exportBlob(d, opts));
        let ext = format.value;
        if (ext === 'webp' && blob.type && blob.type !== 'image/webp') { ext = 'png'; toast('Ce navigateur ne sait pas écrire le WebP : image exportée en PNG.', 5000); }
        const ok = await saveBlob(blob, `${(fname.value.trim() || d.name)}.${ext}`, 'Image');
        if (ok) toast(`Image exportée (${Math.round(blob.size / 1024).toLocaleString('fr-FR')} Ko).`);
      },
    });
  }

  dialogShortcuts() {
    const rows = [
      ['Nouveau / Ouvrir / Enregistrer (.psd)', K('Ctrl+N · Ctrl+O · Ctrl+S')],
      ['Exporter en JPG / PNG / WebP', K('Ctrl+Alt+Maj+W')],
      ['Annuler / Rétablir', K('Ctrl+Z · Ctrl+Maj+Z')],
      ['Nouveau calque / Dupliquer', K('Ctrl+Maj+N · Ctrl+J')],
      ['Fusionner vers le bas / les visibles', K('Ctrl+E · Ctrl+Maj+E')],
      ['Monter / descendre le calque', K('Ctrl+] · Ctrl+[')],
      ["Masque d'écrêtage", K('Ctrl+Alt+G')],
      ["Taille de l'image / de la zone de travail", K('Ctrl+Alt+I · Ctrl+Alt+C')],
      ["Taille de l'écran / 100 %", K('Ctrl+0 · Ctrl+1')],
      ['Zoom avant / arrière', K('Ctrl++ · Ctrl+- · molette')],
      ['Déplacer / Main / Zoom', 'V · H · Z'],
      ['Pinceau / Gomme / Pipette', 'B · E · I'],
      ['Dégradé / Pot de peinture', 'G · Maj+G'],
      ['Texte / Formes / Recadrage', 'T · U · C'],
      ['Correcteur / Tampon de duplication', 'J · S (Alt+clic : choisir la source)'],
      ['Suppression IA (gomme magique) / Sélection d\'objet IA', 'Maj+J · Maj+W'],
      ["Remplissage d'après le contenu (IA)", 'Maj+Retour arrière'],
      ['Fluidité', K('Ctrl+Maj+X')],
      ['Taille du pinceau / dureté', '[ ] · Maj+[ ]'],
      ['Opacité du pinceau', '1 … 9, 0 = 100 %'],
      ['Trait droit', 'Maj+clic'],
      ['Inverser les couleurs / noir et blanc', 'X · D'],
      ['Sélection rectangle-ellipse / lasso / baguette', 'M · L · W (Maj+M, Maj+L : variante)'],
      ['Ajouter / soustraire / intersection', 'Maj · Alt · Maj+Alt au début du tracé'],
      ['Tout sélectionner / désélectionner / resélectionner', K('Ctrl+A · Ctrl+D · Ctrl+Maj+D')],
      ['Intervertir la sélection / contour progressif', K('Ctrl+Maj+I · Maj+F6')],
      ['Calque par copie / par coupe', K('Ctrl+J · Ctrl+Maj+J')],
      ['Transformation manuelle', K('Ctrl+T (Entrée / Échap)')],
      ['Grouper / dissocier', K('Ctrl+G · Ctrl+Maj+G')],
      ['Sélection multiple de calques', K('Ctrl+clic · Maj+clic (appui long au doigt)')],
      ['Niveaux / Courbes / Teinte-saturation / Balance', K('Ctrl+L · Ctrl+M · Ctrl+U · Ctrl+B')],
      ['Négatif / Désaturation', K('Ctrl+I · Ctrl+Maj+U')],
      ['Niveaux / contraste / couleur automatiques', K('Ctrl+Maj+L · Ctrl+Alt+Maj+L · Ctrl+Maj+B')],
      ['Dernier filtre', K('Ctrl+F')],
      ['Remplir premier plan / arrière-plan', K('Alt+Retour arrière · Ctrl+Retour arrière')],
      ['Main temporaire', 'Espace (maintenu) ou clic molette'],
      ['Choisir le calque sous la souris', `${MOD}+clic avec Déplacer`],
      ['Décaler le calque', 'Flèches (Maj : 10 px)'],
      ['Coller une image comme calque', K('Ctrl+V')],
      ['Sur écran tactile', 'Deux doigts : zoom et déplacement'],
    ];
    const table = el('table', { class: 'keys' }, rows.map(([a, b]) => el('tr', {}, el('td', {}, a), el('td', {}, el('kbd', {}, b)))));
    openDialog({ title: 'Raccourcis clavier', body: table, wide: true, buttons: [{ label: 'Fermer', primary: true }] });
  }

  dialogAbout() {
    const body = el('div', { class: 'about' },
      el('img', { src: 'icons/sceau-enluminure.svg', alt: '', width: 120, height: 120 }),
      el('p', {}, el('b', {}, 'Enluminure'), ` — version ${VERSION}`),
      el('p', { class: 'muted' }, "L'atelier d'images d'Anamnesis · CSC. Tout se passe sur votre appareil : aucune image n'est envoyée sur internet."),
      el('p', { class: 'muted' }, 'Étape 6 — IA locale : sujet, suppression de l\'arrière-plan, sélection d\'objet, gomme magique, remplissage d\'après le contenu et agrandissement, calculés sur votre appareil.'),
      el('p', { class: 'muted' }, 'Version 0.6.1 : grande vérification de toutes les fonctions et corrections.'),
      el('p', { class: 'muted small' }, 'Lecture et écriture des PSD : bibliothèque ag-psd (licence MIT). IA : transformers.js (Apache 2.0) et ONNX Runtime (MIT) ; modèles RMBG 1.4 (BRIA AI, usage non commercial), SAM 2.1 (Meta), MI-GAN (Picsart), Real-ESRGAN (Xintao Wang).'));
    openDialog({ title: 'À propos', body, buttons: [{ label: 'Fermer', primary: true }] });
  }
}

const app = new App();
// Une erreur imprévue ne doit jamais passer inaperçue : on l'affiche (cela aide aussi à la signaler).
let lastErr = 0;
const report = (msg) => {
  if (!msg || /ResizeObserver loop/.test(msg)) return;
  const now = Date.now(); if (now - lastErr < 4000) return; lastErr = now;
  document.querySelector('#busy').hidden = true;
  toast(`Un problème est survenu : ${String(msg).slice(0, 140)}`, 7000);
};
window.addEventListener('error', (e) => report(e.message));
window.addEventListener('unhandledrejection', (e) => report(e.reason?.message || e.reason));
window.enluminure = app; // pratique pour le débogage

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

function effectiveVisibleL(d, L) { return !!L && tree.effectiveVisible(d.committed.layers, L); }

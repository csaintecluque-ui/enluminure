// Enluminure — application
import { VERSION, el, mkLayer, newCanvas, ctxOf, fitsLimits, LIMITS, isIOS, isMac, baseName, canvasToBlob } from './util.js';
import { Doc } from './document.js';
import * as ops from './ops.js';
import { flattenState } from './render.js';
import { Viewport } from './view.js';
import { $, toast, openDialog, confirmDialog, field, MenuBar, modalOpen } from './ui.js';
import { initLayersPanel, renderLayers, renderHistory, renderTabs, initToolbar, renderToolbar, renderOptions, renderStatus, startRename, TOOLS } from './panels.js';
import { openFileAsDoc, fileToCanvas, isPsd, docToPsdBlob, exportBlob, saveBlob } from './io.js';
import { icon, LOGO_SMALL } from './icons.js';

const MOD = isMac || isIOS ? '⌘' : 'Ctrl';
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
  }

  saveOpts() { try { localStorage.setItem('enluminure.opts', JSON.stringify(this.opts)); } catch {} }
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
    this.tool = id;
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
    const imgOp = (label, kind) => ({ enabled: hasDoc, run: () => {
      const st = ops.transformImage(D().committed, kind);
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
      layerCW: layerOp('Rotation du calque 90° horaire', (st, id) => ops.transformLayer(st, id, 'cw')),
      layerCCW: layerOp('Rotation du calque 90° antihoraire', (st, id) => ops.transformLayer(st, id, 'ccw')),
      layer180: layerOp('Rotation du calque 180°', (st, id) => ops.transformLayer(st, id, '180')),
      layerFH: layerOp('Symétrie horizontale du calque', (st, id) => ops.transformLayer(st, id, 'fh')),
      layerFV: layerOp('Symétrie verticale du calque', (st, id) => ops.transformLayer(st, id, 'fv')),
      centerLayer: layerOp('Centrer le calque', (st, id) => {
        const l = st.layers.find(x => x.id === id);
        return ops.updateLayer(st, id, { x: Math.round((st.width - l.canvas.width) / 2), y: Math.round((st.height - l.canvas.height) / 2) });
      }),

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
      } },
      duplicateLayer: { enabled: hasLayer, run: () => { const d = D(); const r = ops.duplicateLayer(d.committed, d.activeId); this.commit('Dupliquer le calque', r.state, { activeId: r.activeId }); } },
      deleteLayer: { enabled: () => !!D()?.active && D().layers.length > 1, run: () => this.commit('Supprimer le calque', ops.removeLayer(D().committed, D().activeId)) },
      renameLayer: { enabled: hasLayer, run: () => {
        if (window.matchMedia('(max-width: 760px)').matches && this.panelOpen !== 'layers') this.togglePanel('layers');
        const row = document.querySelector(`.layer-row[data-id="${D().activeId}"]`);
        if (row) startRename(this, row, D().active);
      } },
      layerUp: { enabled: () => hasLayer() && D().activeIndex < D().layers.length - 1, run: () => { const d = D(); this.commit('Ordre des calques', ops.moveLayerTo(d.committed, d.activeId, d.activeIndex + 1)); } },
      layerDown: { enabled: () => hasLayer() && D().activeIndex > 0, run: () => { const d = D(); this.commit('Ordre des calques', ops.moveLayerTo(d.committed, d.activeId, d.activeIndex - 1)); } },
      layerTop: { enabled: () => hasLayer() && D().activeIndex < D().layers.length - 1, run: () => { const d = D(); this.commit('Ordre des calques', ops.moveLayerTo(d.committed, d.activeId, d.layers.length - 1)); } },
      layerBottom: { enabled: () => hasLayer() && D().activeIndex > 0, run: () => { const d = D(); this.commit('Ordre des calques', ops.moveLayerTo(d.committed, d.activeId, 0)); } },
      clipLayer: { enabled: () => hasLayer() && D().activeIndex > 0, checked: () => !!D()?.active?.clipping, run: () => {
        const d = D(), l = d.active;
        this.commit(l.clipping ? "Annuler le masque d'écrêtage" : "Créer un masque d'écrêtage", ops.updateLayer(d.committed, l.id, { clipping: !l.clipping }));
      } },
      toggleVisible: { enabled: hasLayer, run: () => { const d = D(), l = d.active; this.commit(l.visible ? 'Masquer le calque' : 'Afficher le calque', ops.updateLayer(d.committed, l.id, { visible: !l.visible })); } },
      mergeDown: { enabled: () => hasLayer() && D().activeIndex > 0, run: () => {
        const d = D(), i = d.activeIndex;
        if (!d.layers[i].visible || !d.layers[i - 1].visible) { toast('Impossible de fusionner un calque masqué.'); return; }
        const r = ops.mergeDown(d.committed, d.activeId);
        if (r) this.commit('Fusionner avec le calque inférieur', r.state, { activeId: r.activeId });
      } },
      mergeVisible: { enabled: () => (D()?.layers.filter(l => l.visible).length || 0) > 1, run: () => {
        const r = ops.mergeVisible(D().committed);
        if (r) this.commit('Fusionner les calques visibles', r.state, { activeId: r.activeId });
      } },

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
        { label: 'Copier le calque', action: 'copy', key: K('Ctrl+C') },
        { label: 'Copier avec fusion', action: 'copyMerged', key: K('Ctrl+Maj+C') },
        { label: 'Coller', action: 'paste', key: K('Ctrl+V') },
        '-',
        { heading: 'Transformation du calque' },
        { label: 'Rotation 90° horaire', action: 'layerCW' },
        { label: 'Rotation 90° antihoraire', action: 'layerCCW' },
        { label: 'Rotation 180°', action: 'layer180' },
        { label: 'Symétrie horizontale', action: 'layerFH' },
        { label: 'Symétrie verticale', action: 'layerFV' },
        { label: 'Centrer dans l\'image', action: 'centerLayer' },
      ] },
      { label: 'Image', items: [
        { label: "Taille de l'image…", action: 'imageSize', key: K('Ctrl+Alt+I') },
        { label: 'Taille de la zone de travail…', action: 'canvasSize', key: K('Ctrl+Alt+C') },
        '-',
        { heading: "Rotation de l'image" },
        { label: '90° horaire', action: 'rotCW' },
        { label: '90° antihoraire', action: 'rotCCW' },
        { label: '180°', action: 'rot180' },
        { label: 'Symétrie horizontale', action: 'flipH' },
        { label: 'Symétrie verticale', action: 'flipV' },
        '-',
        { label: "Aplatir l'image", action: 'flatten' },
      ] },
      { label: 'Calque', items: [
        { label: 'Nouveau calque', action: 'newLayer', key: K('Ctrl+Maj+N') },
        { label: 'Dupliquer le calque', action: 'duplicateLayer', key: K('Ctrl+J') },
        { label: 'Supprimer le calque', action: 'deleteLayer', key: 'Suppr' },
        { label: 'Renommer le calque…', action: 'renameLayer' },
        { label: 'Afficher / masquer', action: 'toggleVisible', key: K('Ctrl+,') },
        '-',
        { label: "Masque d'écrêtage", action: 'clipLayer', key: K('Ctrl+Alt+G') },
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
      'ctrl+shift+n': 'newLayer', 'ctrl+j': 'duplicateLayer', 'ctrl+e': 'mergeDown', 'ctrl+shift+e': 'mergeVisible',
      'ctrl+alt+g': 'clipLayer', 'ctrl+alt+i': 'imageSize', 'ctrl+alt+c': 'canvasSize', 'ctrl+,': 'toggleVisible',
      'ctrl+]': 'layerUp', 'ctrl+[': 'layerDown', 'ctrl+shift+]': 'layerTop', 'ctrl+shift+[': 'layerBottom',
      'ctrl+0': 'fit', 'ctrl+1': 'zoom100', 'ctrl++': 'zoomIn', 'ctrl+-': 'zoomOut',
      'delete': 'deleteLayer', 'backspace': 'deleteLayer', 'f11': 'fullscreen',
    };
    const typing = (t) => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
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
      if (map[combo]) {
        if (k === 'f11' && !document.documentElement.requestFullscreen) return;
        e.preventDefault();
        this.run(map[combo]);
        return;
      }
      if (ctrl || e.altKey) return;
      // Outils
      const tool = { v: 'move', h: 'hand', z: 'zoom' }[k];
      if (tool) { this.setTool(tool); return; }
      // Décalage au clavier
      const arrows = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] };
      if (arrows[k] && this.tool === 'move' && this.doc?.active) {
        e.preventDefault();
        const [dx, dy] = arrows[k].map(v => v * (e.shiftKey ? 10 : 1));
        const d = this.doc, l = d.active;
        this.commit('Déplacer', ops.updateLayer(d.committed, l.id, { x: l.x + dx, y: l.y + dy }), { mergeKey: `nudge:${l.id}` });
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
      if (!item) return;
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
    if (!navigator.clipboard?.read) { toast(`Utilisez ${MOD}+V pour coller une image.`); return; }
    try {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const type = it.types.find(t => t.startsWith('image/'));
        if (type) { await this.pasteImage(await it.getType(type)); return; }
      }
      toast('Le presse-papiers ne contient pas d\'image.');
    } catch {
      toast(`Accès au presse-papiers refusé : utilisez ${MOD}+V.`);
    }
  }

  async copy(merged) {
    const d = this.doc;
    let c;
    if (merged) c = flattenState(d.committed);
    else c = d.active.canvas;
    if (!navigator.clipboard?.write || !window.ClipboardItem) { toast('Copie d\'image non disponible dans ce navigateur.'); return; }
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': canvasToBlob(c, 'image/png') })]);
      toast(merged ? 'Image fusionnée copiée.' : 'Calque copié.');
    } catch {
      toast('Copie refusée par le navigateur.');
    }
  }

  async savePsd() {
    const d = this.doc;
    const blob = await this.withBusy('Préparation du fichier .psd…', () => docToPsdBlob(d));
    const ok = await saveBlob(blob, `${d.name}.psd`, 'Document Photoshop');
    if (ok) { d.markSaved(); this.refresh({ history: false }); toast('Document enregistré.'); }
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
        const st = await this.withBusy('Redimensionnement…', () => ops.resizeImage(d.committed, W, H, method.value));
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
        const ext = format.value;
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
      el('p', { class: 'muted' }, 'Étape 1 — le socle : calques, modes de fusion, historique, PSD.'),
      el('p', { class: 'muted small' }, 'Lecture et écriture des PSD : bibliothèque ag-psd (licence MIT).'));
    openDialog({ title: 'À propos', body, buttons: [{ label: 'Fermer', primary: true }] });
  }
}

const app = new App();
window.enluminure = app; // pratique pour le débogage

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

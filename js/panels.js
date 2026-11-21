// Enluminure — panneaux : calques, historique, onglets, outils, options, barre d'état
import { el, BLENDS, blendSupported, fmtBytes, clamp } from './util.js';
import { icon } from './icons.js';
import { $ } from './ui.js';
import { updateLayer, moveLayerTo } from './ops.js';

// ——— Vignettes des calques (mises en cache : les toiles ne changent jamais) ———
const thumbCache = new WeakMap();
const TH = 40;
function thumbFor(layer, W, H) {
  const key = `${layer.x},${layer.y},${W},${H},${layer.canvas?._v || 0}`;
  const c = layer.canvas;
  if (!c || !c.width) return null;
  const hit = thumbCache.get(c);
  if (hit && hit.key === key) return hit.canvas;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const size = Math.round(TH * dpr);
  const t = document.createElement('canvas');
  t.width = t.height = size;
  const ctx = t.getContext('2d');
  const s = Math.min(size / W, size / H);
  const fw = W * s, fh = H * s, ox = (size - fw) / 2, oy = (size - fh) / 2;
  // damier
  const q = Math.max(3, Math.round(4 * dpr));
  for (let y = 0; y < fh; y += q) for (let x = 0; x < fw; x += q) {
    ctx.fillStyle = ((x / q + y / q) & 1) ? '#cdc7bf' : '#ece8e2';
    ctx.fillRect(ox + x, oy + y, Math.min(q, fw - x), Math.min(q, fh - y));
  }
  ctx.save();
  ctx.beginPath(); ctx.rect(ox, oy, fw, fh); ctx.clip();
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(c, ox + layer.x * s, oy + layer.y * s, c.width * s, c.height * s);
  ctx.restore();
  thumbCache.set(c, { key, canvas: t });
  return t;
}

// ——— Panneau Calques ———
export function initLayersPanel(app) {
  const blend = $('#layer-blend');
  for (const b of BLENDS) {
    if (b === '-') { blend.append(el('option', { disabled: true }, '──────────')); continue; }
    const [val, label, op] = b;
    blend.append(el('option', { value: val, 'data-ok': op ? '1' : '0' }, op ? label : `${label} (bientôt)`));
  }
  blend.addEventListener('change', () => {
    const d = app.doc, L = d?.active; if (!L) return;
    app.commit('Mode de fusion', updateLayer(d.committed, L.id, { blend: blend.value }));
  });

  const range = $('#layer-opacity'), num = $('#layer-opacity-num');
  const preview = (v) => {
    const d = app.doc, L = d?.active; if (!L) return;
    v = clamp(Math.round(v), 0, 100);
    range.value = v; num.value = v;
    d.setPreview(updateLayer(d.committed, L.id, { opacity: v / 100 }));
    app.view.requestRender();
  };
  const commit = () => {
    const d = app.doc, L = d?.committed.layers.find(l => l.id === d.activeId); if (!L) return;
    const v = clamp(Math.round(+range.value), 0, 100) / 100;
    if (Math.abs(v - L.opacity) < 0.001) { d.cancelPreview(); app.view.requestRender(); return; }
    app.commit('Opacité du calque', updateLayer(d.committed, L.id, { opacity: v }));
  };
  range.addEventListener('input', () => preview(+range.value));
  range.addEventListener('change', commit);
  num.addEventListener('input', () => { if (num.value !== '') preview(+num.value); });
  num.addEventListener('change', commit);
  num.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); num.blur(); } });

  const foot = $('#layers-foot');
  const btns = [
    ['newLayer', 'newLayer', 'Nouveau calque (Ctrl+Maj+N)'],
    ['duplicateLayer', 'duplicate', 'Dupliquer le calque (Ctrl+J)'],
    ['layerUp', 'up', 'Monter le calque (Ctrl+])'],
    ['layerDown', 'down', 'Descendre le calque (Ctrl+[)'],
    ['clipLayer', 'clip', "Masque d'écrêtage (Ctrl+Alt+G)"],
    ['mergeDown', 'merge', 'Fusionner avec le calque inférieur (Ctrl+E)'],
    ['deleteLayer', 'trash', 'Supprimer le calque'],
  ];
  for (const [action, ic, title] of btns) {
    const b = el('button', { type: 'button', class: 'icon-btn', title, 'aria-label': title, 'data-action': action, html: icon(ic) });
    b.addEventListener('click', () => app.run(action));
    foot.append(b);
  }
}

export function renderLayers(app) {
  const d = app.doc;
  const list = $('#layers-list');
  const blend = $('#layer-blend'), range = $('#layer-opacity'), num = $('#layer-opacity-num');
  const L = d?.active;
  blend.disabled = range.disabled = num.disabled = !L;
  if (L) {
    blend.value = L.blend;
    for (const o of blend.options) if (o.value) o.disabled = o.dataset.ok !== '1' && o.value !== L.blend;
    if (document.activeElement !== num) num.value = Math.round(L.opacity * 100);
    range.value = Math.round(L.opacity * 100);
  }
  for (const b of $('#layers-foot').children) {
    const a = app.actions[b.dataset.action];
    b.disabled = !(a && (!a.enabled || a.enabled()));
  }
  if (list.querySelector('.renaming')) return; // ne pas casser une saisie en cours
  list.textContent = '';
  if (!d) { list.append(el('div', { class: 'empty' }, 'Aucun document ouvert')); return; }
  const layers = d.state.layers;
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    const t = thumbFor(l, d.width, d.height);
    const thumb = el('canvas', { class: 'thumb', width: t ? t.width : TH, height: t ? t.height : TH });
    if (t) thumb.getContext('2d').drawImage(t, 0, 0);
    const eye = el('button', { type: 'button', class: 'eye', title: l.visible ? 'Masquer' : 'Afficher', html: icon(l.visible ? 'eye' : 'eyeOff', 16) });
    const name = el('span', { class: 'lname' }, l.name);
    const grip = el('span', { class: 'grip', title: 'Glisser pour réorganiser', html: icon('grip', 16) });
    const row = el('div', {
      class: `layer-row ${l.id === d.activeId ? 'active' : ''} ${l.visible ? '' : 'hidden-layer'} ${l.clipping && i > 0 ? 'clipped' : ''}`,
      'data-id': l.id,
    }, eye, l.clipping && i > 0 ? el('span', { class: 'clip-mark', html: icon('clip', 14) }) : null, thumb, l.text ? el('span', { class: 'text-badge', title: 'Calque de texte (outil Texte pour le modifier)' }, 'T') : null, el('div', { class: 'lmeta' }, name,
      (l.blend !== 'normal' || l.opacity < 1) ? el('small', {}, `${blendLabel(l.blend)}${l.opacity < 1 ? ` · ${Math.round(l.opacity * 100)} %` : ''}`) : null), grip);

    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      app.commit(l.visible ? 'Masquer le calque' : 'Afficher le calque', updateLayer(d.committed, l.id, { visible: !l.visible }));
    });
    row.addEventListener('click', () => { if (d.activeId !== l.id) { d.setActive(l.id); app.refresh({ history: false }); } });
    name.addEventListener('dblclick', (e) => { e.stopPropagation(); startRename(app, row, l); });
    grip.addEventListener('pointerdown', (e) => startDrag(app, e, row, l));
    list.append(row);
  }
}

function blendLabel(v) {
  const b = BLENDS.find(x => Array.isArray(x) && x[0] === v);
  return b ? b[1] : v;
}

export function startRename(app, row, l) {
  const d = app.doc;
  const name = row.querySelector('.lname');
  const input = el('input', { class: 'rename', value: l.name, maxlength: 120 });
  row.classList.add('renaming');
  name.replaceWith(input);
  input.focus(); input.select();
  let finished = false;
  const finish = (ok) => {
    if (finished) return; finished = true;
    row.classList.remove('renaming');
    const v = input.value.trim();
    if (ok && v && v !== l.name) app.commit('Renommer le calque', updateLayer(d.committed, l.id, { name: v }));
    else app.refresh({ history: false });
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

function startDrag(app, e, row, l) {
  e.preventDefault(); e.stopPropagation();
  const d = app.doc;
  const list = $('#layers-list');
  const rows = [...list.children];
  const startY = e.clientY;
  const rect = row.getBoundingClientRect();
  const from0 = rows.indexOf(row);
  const mids = rows.map(r => { const b = r.getBoundingClientRect(); return b.top + b.height / 2; });
  const scroll0 = list.scrollTop;
  const marker = el('div', { class: 'drop-marker' });
  let target = null;
  row.classList.add('dragging');
  const grip = e.currentTarget;
  try { grip.setPointerCapture(e.pointerId); } catch {}
  const move = (ev) => {
    const dy = ev.clientY - startY;
    row.style.transform = `translateY(${dy}px)`;
    // position d'insertion (dans l'ordre affiché, haut = dessus de la pile)
    let pos = rows.length;
    const ds = list.scrollTop - scroll0;
    for (let k = 0; k < rows.length; k++) {
      if (k === from0) continue; // la ligne déplacée suit le doigt : on l'ignore
      if (ev.clientY < mids[k] - ds) { pos = k; break; }
    }
    target = pos;
    const ref = rows[pos];
    if (ref) list.insertBefore(marker, ref); else list.append(marker);
    // défilement automatique
    const lr = list.getBoundingClientRect();
    if (ev.clientY < lr.top + 20) list.scrollTop -= 8;
    if (ev.clientY > lr.bottom - 20) list.scrollTop += 8;
  };
  const up = () => {
    grip.removeEventListener('pointermove', move);
    grip.removeEventListener('pointerup', up);
    grip.removeEventListener('pointercancel', up);
    marker.remove();
    row.style.transform = '';
    row.classList.remove('dragging');
    if (target == null) return;
    const n = d.state.layers.length;
    const from = rows.indexOf(row); // index affiché
    let toDisplay = target > from ? target - 1 : target;
    if (toDisplay === from) return;
    const toStack = n - 1 - toDisplay;
    app.commit('Ordre des calques', moveLayerTo(d.committed, l.id, toStack));
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', up);
  grip.addEventListener('pointercancel', up);
  void rect;
}

// ——— Panneau Historique ———
export function renderHistory(app) {
  const d = app.doc;
  const list = $('#history-list');
  const info = $('#history-info');
  list.textContent = '';
  if (!d) { list.append(el('div', { class: 'empty' }, 'Aucun document ouvert')); info.textContent = ''; return; }
  d.entries.forEach((e, i) => {
    const row = el('button', { type: 'button', class: `hist-row ${i === d.index ? 'current' : ''} ${i > d.index ? 'future' : ''}` },
      el('span', { class: 'hist-dot' }), e.label);
    row.addEventListener('click', () => { if (d.goTo(i)) app.refresh(); });
    list.append(row);
  });
  const cur = list.children[d.index];
  cur?.scrollIntoView({ block: 'nearest' });
  info.textContent = `${d.entries.length} étape${d.entries.length > 1 ? 's' : ''} · ${fmtBytes(d.memoryBytes())}${d.trimmed ? ` · ${d.trimmed} ancienne(s) oubliée(s) (mémoire)` : ''}`;
}

// ——— Onglets des documents ———
export function renderTabs(app) {
  const tabs = $('#tabs');
  tabs.textContent = '';
  for (const d of app.docs) {
    const close = el('button', { type: 'button', class: 'tab-close', title: 'Fermer', 'aria-label': 'Fermer', html: icon('close', 14) });
    const tab = el('div', { class: `tab ${d === app.doc ? 'active' : ''}`, title: d.name },
      el('span', { class: 'tab-name' }, d.name), d.dirty ? el('span', { class: 'tab-dirty', title: 'Modifié' }, '•') : null, close);
    tab.addEventListener('click', () => app.switchDoc(d));
    close.addEventListener('click', (e) => { e.stopPropagation(); app.closeDoc(d); });
    tabs.append(tab);
  }
  tabs.classList.toggle('no-tabs', !app.docs.length);
}

// ——— Boîte à outils ———
export const TOOLS = [
  { id: 'move', icon: 'move', label: 'Déplacer', key: 'V' },
  { id: 'marquee', icon: 'marquee', label: 'Rectangle de sélection', key: 'M', step: 3 },
  { id: 'lasso', icon: 'lasso', label: 'Lasso', key: 'L', step: 3 },
  { id: 'wand', icon: 'wand', label: 'Baguette magique', key: 'W', step: 3 },
  { id: 'crop', icon: 'crop', label: 'Recadrage', key: 'C' },
  { id: 'eyedropper', icon: 'eyedropper', label: 'Pipette', key: 'I' },
  '-',
  { id: 'heal', icon: 'heal', label: 'Correcteur', key: 'J', step: 5 },
  { id: 'brush', icon: 'brush', label: 'Pinceau', key: 'B' },
  { id: 'stamp', icon: 'stamp', label: 'Tampon de duplication', key: 'S', step: 5 },
  { id: 'eraser', icon: 'eraser', label: 'Gomme', key: 'E' },
  { id: 'gradient', icon: 'gradient', label: 'Dégradé', key: 'G' },
  { id: 'bucket', icon: 'bucket', label: 'Pot de peinture', key: 'Maj+G' },
  '-',
  { id: 'text', icon: 'text', label: 'Texte', key: 'T' },
  { id: 'shapes', icon: 'shapes', label: 'Formes', key: 'U' },
  '-',
  { id: 'hand', icon: 'hand', label: 'Main', key: 'H' },
  { id: 'zoom', icon: 'zoom', label: 'Zoom', key: 'Z' },
];

export function initToolbar(app) {
  const root = $('#toolbar');
  const bar = el('div', { class: 'tools-scroll' });
  root.append(bar);
  for (const t of TOOLS) {
    if (t === '-') { bar.append(el('div', { class: 'tool-sep' })); continue; }
    const title = t.step ? `${t.label} — arrive à l'étape ${t.step}` : `${t.label} (${t.key})`;
    const b = el('button', { type: 'button', class: `tool ${t.step ? 'soon' : ''}`, 'data-tool': t.id, title, 'aria-label': t.label, html: icon(t.icon, 20) });
    b.addEventListener('click', () => app.setTool(t.id));
    bar.append(b);
  }
  // Couleurs de premier plan / d'arrière-plan
  const fg = el('button', { type: 'button', class: 'sw sw-fg', title: 'Couleur de premier plan', 'aria-label': 'Couleur de premier plan' });
  const bg = el('button', { type: 'button', class: 'sw sw-bg', title: "Couleur d'arrière-plan", 'aria-label': "Couleur d'arrière-plan" });
  const swap = el('button', { type: 'button', class: 'sw-mini sw-swap', title: 'Inverser les couleurs (X)', 'aria-label': 'Inverser les couleurs' }, '⇄');
  const reset = el('button', { type: 'button', class: 'sw-mini sw-reset', title: 'Noir et blanc (D)', 'aria-label': 'Couleurs par défaut' }, el('i'), el('i'));
  fg.addEventListener('click', () => app.pickColor('fg'));
  bg.addEventListener('click', () => app.pickColor('bg'));
  swap.addEventListener('click', () => app.swapColors());
  reset.addEventListener('click', () => app.resetColors());
  bar.append(el('div', { class: 'tool-sep' }), el('div', { class: 'swatches' }, bg, fg, swap, reset));
  bar.append(el('div', { class: 'tool-spacer' }));
  // Sur téléphone : boutons Calques / Historique dans la barre du haut
  for (const b of document.querySelectorAll('#topbar .panel-toggle')) {
    b.innerHTML = icon(b.dataset.panel, 20);
    b.addEventListener('click', () => app.togglePanel(b.dataset.panel));
  }
}

export function renderToolbar(app) {
  for (const b of $('#toolbar').querySelectorAll('[data-tool]')) b.classList.toggle('active', b.dataset.tool === app.tool);
  for (const b of document.querySelectorAll('.panel-toggle')) b.classList.toggle('active', app.panelOpen === b.dataset.panel);
  $('#toolbar .sw-fg').style.background = app.colors.fg;
  $('#toolbar .sw-bg').style.background = app.colors.bg;
}

// ——— Barre d'options (selon l'outil) ———
export function renderOptions(app) {
  const bar = $('#optionsbar');
  bar.textContent = '';
  const t = TOOLS.find(x => x.id === app.tool);
  bar.append(el('span', { class: 'opt-tool', html: icon(t.icon, 16) }, el('b', {}, t.label)));
  const check = (key, label) => {
    const i = el('input', { type: 'checkbox', checked: app.opts[key] });
    i.addEventListener('change', () => { app.opts[key] = i.checked; app.saveOpts(); app.view.requestRender(); });
    return el('label', { class: 'opt' }, i, label);
  };
  const btn = (label, action) => {
    const b = el('button', { type: 'button', class: 'btn small' }, label);
    b.addEventListener('click', () => app.run(action));
    return b;
  };
  if (app.tool === 'move') {
    bar.append(check('autoSelect', 'Sélection auto du calque'), check('showBounds', 'Afficher les bords'));
    bar.append(el('span', { class: 'opt-hint' }, 'Flèches : décaler de 1 px (Maj : 10 px)'));
  } else if (app.tool === 'hand') {
    bar.append(btn('100 %', 'zoom100'), btn("Taille de l'écran", 'fit'));
  } else if (app.tools[app.tool]) {
    app.tools[app.tool].options(bar);
  } else if (app.tool === 'zoom') {
    const seg = el('div', { class: 'seg' });
    for (const [v, label] of [[false, 'Zoom avant'], [true, 'Zoom arrière']]) {
      const b = el('button', { type: 'button', class: `btn small ${app.opts.zoomOut === v ? 'on' : ''}` }, label);
      b.addEventListener('click', () => { app.opts.zoomOut = v; renderOptions(app); app.view.updateCursor(); });
      seg.append(b);
    }
    bar.append(seg, btn('100 %', 'zoom100'), btn("Taille de l'écran", 'fit'));
    bar.append(el('span', { class: 'opt-hint' }, 'Glisser horizontalement pour un zoom progressif · Alt : inverser'));
  }
}

// ——— Barre d'état ———
export function renderStatus(app) {
  const d = app.doc;
  $('#st-size').textContent = d ? `${d.width} × ${d.height} px` : '';
  $('#st-layers').textContent = d ? `${d.layers.length} calque${d.layers.length > 1 ? 's' : ''}` : '';
  app.updateZoomInfo();
}

// Enluminure — panneaux : calques, historique, onglets, outils, options, barre d'état
import { el, BLENDS, blendSupported, fmtBytes, clamp } from './util.js';
import { icon } from './icons.js';
import { $ } from './ui.js';
import { updateLayer } from './ops.js';
import { buildTree, isGroup, isAdjust, descendants, placeRelative } from './tree.js';
import { ADJ } from './adjust.js';

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
  blend.append(el('option', { value: 'pass through', 'data-ok': '1', 'data-group': '1' }, 'Transfert'));
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
    ['newGroup', 'folder', 'Nouveau groupe (Ctrl+G : grouper la sélection)'],
    ['maskReveal', 'mask', 'Ajouter un masque de fusion (depuis la sélection s\'il y en a une)'],
    ['newAdjustLayer', 'adjust', 'Nouveau calque de réglage'],
    ['duplicateLayer', 'duplicate', 'Dupliquer (Ctrl+J)'],
    ['layerUp', 'up', 'Monter (Ctrl+])'],
    ['layerDown', 'down', 'Descendre (Ctrl+[)'],
    ['clipLayer', 'clip', "Masque d'écrêtage (Ctrl+Alt+G)"],
    ['mergeDown', 'merge', 'Fusionner vers le bas / fusionner le groupe (Ctrl+E)'],
    ['deleteLayer', 'trash', 'Supprimer'],
  ];
  for (const [action, ic, title] of btns) {
    const b = el('button', { type: 'button', class: 'icon-btn', title, 'aria-label': title, 'data-action': action, html: icon(ic) });
    b.addEventListener('click', () => app.run(action));
    foot.append(b);
  }
}

// Vignette d'un masque : blanc = visible, noir = masqué
const maskThumbCache = new WeakMap();
function maskThumb(m, W, H) {
  const key = `${m.x},${m.y},${W},${H},${m.def},${m.canvas._v || 0}`;
  const hit = maskThumbCache.get(m.canvas);
  if (hit && hit.key === key) return hit.canvas;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const size = Math.round(TH * dpr);
  const t = document.createElement('canvas'); t.width = t.height = size;
  const ctx = t.getContext('2d');
  const s = Math.min(size / W, size / H);
  const fw = W * s, fh = H * s, ox = (size - fw) / 2, oy = (size - fh) / 2;
  ctx.fillStyle = '#222'; ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = m.def ? '#fff' : '#000'; ctx.fillRect(ox, oy, fw, fh);
  ctx.fillStyle = '#000'; ctx.fillRect(ox + m.x * s, oy + m.y * s, m.canvas.width * s, m.canvas.height * s);
  const w2 = document.createElement('canvas'); w2.width = w2.height = size;
  const c2 = w2.getContext('2d');
  c2.drawImage(m.canvas, ox + m.x * s, oy + m.y * s, m.canvas.width * s, m.canvas.height * s);
  c2.globalCompositeOperation = 'source-in'; c2.fillStyle = '#fff'; c2.fillRect(0, 0, size, size);
  ctx.save(); ctx.beginPath(); ctx.rect(ox, oy, fw, fh); ctx.clip(); ctx.drawImage(w2, 0, 0); ctx.restore();
  maskThumbCache.set(m.canvas, { key, canvas: t });
  return t;
}
const thumbEl = (t, cls) => { const c = el('canvas', { class: cls, width: t ? t.width : TH, height: t ? t.height : TH }); if (t) c.getContext('2d').drawImage(t, 0, 0); return c; };

export function renderLayers(app) {
  const d = app.doc;
  const list = $('#layers-list');
  const blend = $('#layer-blend'), range = $('#layer-opacity'), num = $('#layer-opacity-num');
  const L = d?.active;
  blend.disabled = range.disabled = num.disabled = !L;
  if (L) {
    const grp = isGroup(L);
    for (const o of blend.options) {
      if (!o.value) continue;
      o.hidden = o.dataset.group === '1' && !grp;
      o.disabled = (o.dataset.ok !== '1' && o.value !== L.blend) || o.hidden;
    }
    blend.value = L.blend;
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
  d.collapsed = d.collapsed || new Set();
  const rows = [];
  const walk = (nodes, depth, hiddenParent) => {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      rows.push({ l: n.layer, depth, clipped: n.layer.clipping && i > 0, dim: hiddenParent });
      if (n.children && !d.collapsed.has(n.layer.id)) walk(n.children, depth + 1, hiddenParent || !n.layer.visible);
    }
  };
  walk(buildTree(layers), 0, false);
  for (const { l, depth, clipped, dim } of rows) list.append(layerRow(app, d, l, depth, clipped, dim));
}

function layerRow(app, d, l, depth, clipped, dim) {
  const group = isGroup(l);
  const eye = el('button', { type: 'button', class: 'eye', title: l.visible ? 'Masquer' : 'Afficher', html: icon(l.visible ? 'eye' : 'eyeOff', 16) });
  const name = el('span', { class: 'lname' }, l.name);
  const grip = el('span', { class: 'grip', title: 'Glisser pour réorganiser', html: icon('grip', 16) });
  const onMask = d.target === 'mask' && l.id === d.activeId;
  let twisty = null, thumb, mthumb = null;
  if (isAdjust(l)) {
    thumb = el('span', { class: `thumb folder adj-thumb ${!onMask && l.id === d.activeId ? 'target' : ''}`, title: 'Calque de réglage — double-clic : modifier', html: icon('adjust', 22) });
    thumb.addEventListener('dblclick', (e) => { e.stopPropagation(); app.editAdjust(l.id); });
  } else if (group) {
    const open = !d.collapsed.has(l.id);
    twisty = el('button', { type: 'button', class: 'twisty', title: open ? 'Replier' : 'Déplier', html: open ? '▾' : '▸' });
    twisty.addEventListener('click', (e) => { e.stopPropagation(); if (open) d.collapsed.add(l.id); else d.collapsed.delete(l.id); app.refresh({ history: false }); });
    thumb = el('span', { class: `thumb folder ${!onMask && l.id === d.activeId ? 'target' : ''}`, html: icon('folder', 22) });
  } else {
    thumb = thumbEl(thumbFor(l, d.width, d.height), `thumb ${!onMask && l.id === d.activeId && l.mask ? 'target' : ''}`);
  }
  if (l.mask) {
    mthumb = thumbEl(maskThumb(l.mask, d.width, d.height), `thumb mask-thumb ${onMask ? 'target' : ''} ${l.mask.disabled ? 'disabled' : ''}`);
    mthumb.title = 'Masque de fusion — clic : peindre dessus · Maj+clic : désactiver · Ctrl+clic : sélection';
    mthumb.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.shiftKey) { app.selectLayer(l.id); app.run('maskToggle'); return; }
      if (e.ctrlKey || e.metaKey) { app.selectLayer(l.id); app.run('selectMask'); return; }
      const was = d.target;
      app.selectLayer(l.id); d.target = 'mask';
      if (was !== 'mask') app.refresh({ history: false });
    });
  }
  thumb.title = thumb.title || (group ? 'Groupe' : 'Calque — Ctrl+clic : sélectionner ses pixels');
  thumb.addEventListener('click', (e) => {
    e.stopPropagation();
    if ((e.ctrlKey || e.metaKey) && !group) { app.selectLayer(l.id); app.run('selectLayerPixels'); return; }
    const wasMask = d.target === 'mask';
    app.selectLayer(l.id); d.target = 'layer';
    if (wasMask) app.refresh({ history: false });
  });
  const selected = d.selIds.has(l.id) || l.id === d.activeId;
  const row = el('div', {
    class: `layer-row ${l.id === d.activeId ? 'active' : selected ? 'selected' : ''} ${l.visible && !dim ? '' : 'hidden-layer'} ${clipped ? 'clipped' : ''} ${group ? 'group-row' : ''}`,
    'data-id': l.id, style: `padding-left:${2 + depth * 16}px`,
  }, eye, twisty, clipped ? el('span', { class: 'clip-mark', html: icon('clip', 14) }) : null, thumb, mthumb,
  l.text ? el('span', { class: 'text-badge', title: 'Calque de texte (outil Texte pour le modifier)' }, 'T') : null,
  el('div', { class: 'lmeta' }, name,
    (isAdjust(l) && ADJ[l.adjust.type]?.label !== l.name) || (l.blend !== 'normal' && l.blend !== 'pass through') || l.opacity < 1 ? el('small', {}, [isAdjust(l) && ADJ[l.adjust.type]?.label !== l.name ? ADJ[l.adjust.type]?.label : '', (l.blend !== 'normal' && l.blend !== 'pass through') ? blendLabel(l.blend) : '', l.opacity < 1 ? `${Math.round(l.opacity * 100)} %` : ''].filter(Boolean).join(' · ')) : null), grip);

  eye.addEventListener('click', (e) => {
    e.stopPropagation();
    app.commit(l.visible ? 'Masquer le calque' : 'Afficher le calque', updateLayer(d.committed, l.id, { visible: !l.visible }));
  });
  row.addEventListener('click', (e) => {
    if (row._longPressed) { row._longPressed = false; return; }
    app.selectLayer(l.id, e.ctrlKey || e.metaKey ? 'toggle' : e.shiftKey ? 'range' : 'single');
  });
  // appui long (écran tactile) : ajouter / retirer de la sélection multiple
  let lp = 0;
  row.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    lp = setTimeout(() => { row._longPressed = true; app.selectLayer(l.id, 'toggle'); navigator.vibrate?.(15); }, 480);
  });
  for (const ev of ['pointerup', 'pointercancel', 'pointermove']) row.addEventListener(ev, (e) => { if (ev !== 'pointermove' || Math.abs(e.movementY) > 3) clearTimeout(lp); });
  name.addEventListener('dblclick', (e) => { e.stopPropagation(); startRename(app, row, l); });
  grip.addEventListener('pointerdown', (e) => startDrag(app, e, row, l));
  return row;
}

function blendLabel(v) {
  if (v === 'pass through') return 'Transfert';
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
  // lignes qui peuvent recevoir (pas la ligne déplacée ni le contenu d'un groupe déplacé)
  const banned = descendants(d.state.layers, l.id); banned.add(l.id);
  const rows = [...list.children].filter(r => r.classList.contains('layer-row') && !banned.has(r.dataset.id));
  const startY = e.clientY;
  const scroll0 = list.scrollTop;
  const rects = rows.map(r => r.getBoundingClientRect());
  const marker = el('div', { class: 'drop-marker' });
  let target = null;
  row.classList.add('dragging');
  const grip = e.currentTarget;
  try { grip.setPointerCapture(e.pointerId); } catch {}
  const clearHi = () => list.querySelectorAll('.drop-into').forEach(x => x.classList.remove('drop-into'));
  const move = (ev) => {
    row.style.transform = `translateY(${ev.clientY - startY}px)`;
    const ds = list.scrollTop - scroll0;
    const y = ev.clientY + ds;
    target = null;
    for (let k = 0; k < rows.length; k++) {
      const r = rects[k];
      if (y < r.top || y > r.bottom) continue;
      const f = (y - r.top) / r.height;
      const grp = rows[k].classList.contains('group-row');
      const where = grp ? (f < 0.3 ? 'above' : f > 0.7 ? 'below' : 'inside') : (f < 0.5 ? 'above' : 'below');
      target = { id: rows[k].dataset.id, where, el: rows[k] };
      break;
    }
    if (!target && rows.length) {
      if (y < rects[0].top) target = { id: rows[0].dataset.id, where: 'above', el: rows[0] };
      else if (y > rects[rects.length - 1].bottom) target = { id: rows.at(-1).dataset.id, where: 'below', el: rows.at(-1) };
    }
    clearHi(); marker.remove();
    if (target) {
      if (target.where === 'inside') target.el.classList.add('drop-into');
      else {
        marker.style.marginLeft = target.el.style.paddingLeft;
        if (target.where === 'above') list.insertBefore(marker, target.el); else target.el.after(marker);
      }
    }
    const lr = list.getBoundingClientRect();
    if (ev.clientY < lr.top + 20) list.scrollTop -= 8;
    if (ev.clientY > lr.bottom - 20) list.scrollTop += 8;
  };
  const up = () => {
    grip.removeEventListener('pointermove', move);
    grip.removeEventListener('pointerup', up);
    grip.removeEventListener('pointercancel', up);
    marker.remove(); clearHi();
    row.style.transform = '';
    row.classList.remove('dragging');
    if (!target) return;
    const st = placeRelative(d.committed, l.id, target.id, target.where);
    if (st !== d.committed) app.commit('Ordre des calques', st);
    if (target.where === 'inside') { d.collapsed?.delete(target.id); app.refresh({ history: false }); }
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', up);
  grip.addEventListener('pointercancel', up);
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
  { id: 'marquee', icon: 'marquee', label: 'Rectangle / ellipse de sélection', key: 'M' },
  { id: 'lasso', icon: 'lasso', label: 'Lasso', key: 'L' },
  { id: 'wand', icon: 'wand', label: 'Baguette magique', key: 'W' },
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
  const t = TOOLS.find(x => x.id === app.tool) || { icon: 'fit', label: 'Transformation manuelle' };
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
  if (app.tool === 'hand') {
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

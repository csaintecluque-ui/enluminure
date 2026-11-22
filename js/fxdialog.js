// Enluminure — fenêtre « Style de calque » (effets), avec aperçu en direct
import { el, BLENDS } from './util.js';
import { openDialog } from './ui.js';
import { slider, check, colorIn, selectRow } from './adjust.js';
import { FX, FX_ORDER, newFx, anyStyles } from './styles.js';
import { updateLayer } from './ops.js';

const BLEND_OPTS = BLENDS.filter(b => Array.isArray(b) && b[2]).map(b => [b[0], b[1]]);

/** Nettoie les styles avant de les enregistrer (null s'il n'y a plus rien). */
export function cleanStyles(s) {
  if (!s) return null;
  const out = {};
  if ((s.fill ?? 1) < 1) out.fill = s.fill;
  if (s.hidden) out.hidden = true;
  for (const k of FX_ORDER) if (s[k]) out[k] = { ...s[k] };
  return anyStyles(out) ? out : null;
}

/** Réglages d'un effet (pourcentages affichés de 0 à 100). */
function controls(k, f, set) {
  const pct = (label, key) => slider(label, Math.round(f[key] * 100), 0, 100, 1, v => { f[key] = v / 100; set(); }, '%');
  const num = (label, key, min, max, unit = 'px', step = 1) => slider(label, f[key], min, max, step, v => { f[key] = v; set(); }, unit);
  const blend = (label = 'Mode', key = 'blend') => selectRow(label, f[key], BLEND_OPTS, v => { f[key] = v; set(); });
  const color = (label = 'Couleur', key = 'color') => colorIn(label, f[key], v => { f[key] = v; set(); });
  switch (k) {
    case 'dropShadow': return [blend(), color(), pct('Opacité', 'opacity'), num('Angle', 'angle', -180, 180, '°'), num('Distance', 'distance', 0, 300), num('Grossi', 'spread', 0, 100, '%'), num('Taille', 'size', 0, 250)];
    case 'innerShadow': return [blend(), color(), pct('Opacité', 'opacity'), num('Angle', 'angle', -180, 180, '°'), num('Distance', 'distance', 0, 300), num('Maigri', 'choke', 0, 100, '%'), num('Taille', 'size', 0, 250)];
    case 'outerGlow': return [blend(), color(), pct('Opacité', 'opacity'), num('Grossi', 'spread', 0, 100, '%'), num('Taille', 'size', 0, 250)];
    case 'innerGlow': return [blend(), color(), pct('Opacité', 'opacity'), selectRow('Source', f.source, [['edge', 'Bord'], ['center', 'Centre']], v => { f.source = v; set(); }), num('Maigri', 'choke', 0, 100, '%'), num('Taille', 'size', 0, 250)];
    case 'bevel': return [
      selectRow('Style', f.style, [['inner', 'Biseau interne'], ['outer', 'Biseau externe'], ['emboss', 'Estampage']], v => { f.style = v; set(); }),
      num('Profondeur', 'depth', 1, 1000, '%'),
      selectRow('Direction', f.up === false ? 'down' : 'up', [['up', 'Haut'], ['down', 'Bas']], v => { f.up = v === 'up'; set(); }),
      num('Taille', 'size', 0, 250), num('Flou', 'soften', 0, 16),
      num('Angle', 'angle', -180, 180, '°'), num('Altitude', 'altitude', 0, 90, '°'),
      el('div', { class: 'fx-sub' }, 'Tons clairs'), blend('Mode', 'hiBlend'), color('Couleur', 'hiColor'), pct('Opacité', 'hiOpacity'),
      el('div', { class: 'fx-sub' }, 'Ombres'), blend('Mode', 'shBlend'), color('Couleur', 'shColor'), pct('Opacité', 'shOpacity')];
    case 'stroke': return [num('Taille', 'size', 1, 250), selectRow('Position', f.position, [['outside', 'Extérieur'], ['inside', 'Intérieur'], ['center', 'Centre']], v => { f.position = v; set(); }), blend(), pct('Opacité', 'opacity'), color()];
    case 'colorOverlay': return [blend(), color(), pct('Opacité', 'opacity')];
    case 'gradientOverlay': return [blend(), pct('Opacité', 'opacity'), color('Couleur 1', 'c1'), color('Couleur 2', 'c2'),
      check('Inverser', f.reverse, v => { f.reverse = v; set(); }),
      selectRow('Style', f.type, [['linear', 'Linéaire'], ['radial', 'Radial']], v => { f.type = v; set(); }),
      num('Angle', 'angle', -180, 180, '°'), num('Échelle', 'scale', 10, 150, '%')];
  }
  return [];
}

export async function styleDialog(app, layerId, focus = null) {
  const d = app.doc, st0 = d.committed;
  const L = st0.layers.find(l => l.id === layerId);
  if (!L) return;
  const s = structuredClone(L.styles || {});
  delete s.hidden; // on rend les effets visibles pendant qu'on les règle
  let cur = focus || FX_ORDER.find(k => s[k]?.on) || 'blending';
  let raf = 0;
  const stateWith = () => updateLayer(st0, layerId, { styles: cleanStyles(s) });
  const update = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; d.setPreview(stateWith()); app.view.requestRender(); });
  };
  const list = el('div', { class: 'fx-list' });
  const pane = el('div', { class: 'fx-pane' });
  const renderPane = () => {
    if (cur === 'blending') {
      pane.replaceChildren(el('div', { class: 'fx-title' }, 'Options de fusion'),
        slider('Opacité du fond', Math.round((s.fill ?? 1) * 100), 0, 100, 1, v => { s.fill = v / 100; update(); }, '%'),
        el('p', { class: 'fx-note' }, 'Le fond règle l\'opacité des pixels du calque sans toucher aux effets : à 0 %, il ne reste que le contour, les ombres, les lueurs…'));
      return;
    }
    const f = s[cur];
    pane.replaceChildren(el('div', { class: 'fx-title' }, FX[cur].label), ...controls(cur, f, update));
  };
  const renderList = () => {
    const item = (k, label) => {
      const row = el('div', { class: `fx-item ${cur === k ? 'current' : ''}` });
      if (k !== 'blending') {
        const cb = el('input', { type: 'checkbox', checked: !!s[k]?.on, 'aria-label': label });
        cb.addEventListener('change', () => {
          if (cb.checked) { s[k] = s[k] ? { ...s[k], on: true } : newFx(k); cur = k; } else if (s[k]) s[k].on = false;
          renderList(); renderPane(); update();
        });
        row.append(cb);
      }
      const b = el('button', { type: 'button', class: 'fx-name' }, label);
      b.addEventListener('click', () => {
        if (k !== 'blending' && !s[k]?.on) { s[k] = s[k] ? { ...s[k], on: true } : newFx(k); update(); }
        cur = k; renderList(); renderPane();
      });
      row.append(b);
      return row;
    };
    list.replaceChildren(item('blending', 'Options de fusion'), ...FX_ORDER.map(k => item(k, FX[k].label)));
  };
  if (cur !== 'blending' && !s[cur]) s[cur] = newFx(cur);
  renderList(); renderPane(); update();
  const ok = await openDialog({
    title: `Style de calque — ${L.name}`, body: el('div', { class: 'fx-body' }, list, pane), floating: true, className: 'fx-dialog',
    buttons: [{ label: 'Annuler', value: false }, { label: 'OK', primary: true, value: true }],
  });
  cancelAnimationFrame(raf);
  if (!ok) { d.cancelPreview(); app.refresh({ history: false }); return; }
  app.commit(L.styles ? 'Modifier le style de calque' : 'Style de calque', stateWith(), { activeId: layerId });
}

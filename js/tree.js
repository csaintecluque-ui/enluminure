// Enluminure — groupes de calques.
// La liste des calques reste « à plat » (du bas vers le haut), chaque élément connaît
// son groupe parent (`parent`). Un groupe est un élément { kind: 'group' } placé
// juste au-dessus de ses enfants. Ces fonctions passent de la liste à l'arbre et inversement.
import { uid } from './util.js';

export const isGroup = (l) => !!l && l.kind === 'group';

/** Arbre (du bas vers le haut à chaque niveau) : [{ layer, children? }]. */
export function buildTree(layers) {
  const groups = new Set(layers.filter(isGroup).map(l => l.id));
  const by = new Map();
  for (const l of layers) {
    const p = l.parent && groups.has(l.parent) ? l.parent : null;
    if (!by.has(p)) by.set(p, []);
    by.get(p).push(l);
  }
  const seen = new Set();
  const make = (pid) => (by.get(pid) || []).filter(l => !seen.has(l.id) && seen.add(l.id))
    .map(l => (isGroup(l) ? { layer: l, children: make(l.id) } : { layer: l }));
  return make(null);
}

/** Liste à plat dans l'ordre canonique (enfants puis groupe). */
export function flattenTree(nodes, parent = null, out = []) {
  for (const n of nodes) {
    if (n.children) flattenTree(n.children, n.layer.id, out);
    out.push((n.layer.parent || null) === parent ? n.layer : { ...n.layer, parent });
  }
  return out;
}

export const normalize = (layers) => flattenTree(buildTree(layers));
const withLayers = (st, layers) => ({ ...st, layers: normalize(layers) });

export function byId(st, id) { return st.layers.find(l => l.id === id) || null; }

/** Identifiants de tous les descendants d'un groupe. */
export function descendants(layers, id) {
  const out = new Set();
  let grew = true;
  out.add(id);
  while (grew) {
    grew = false;
    for (const l of layers) if (l.parent && out.has(l.parent) && !out.has(l.id)) { out.add(l.id); grew = true; }
  }
  out.delete(id);
  return out;
}

/** Calque réellement visible (lui et tous ses groupes parents). */
export function effectiveVisible(layers, l) {
  const map = new Map(layers.map(x => [x.id, x]));
  let cur = l;
  while (cur) { if (!cur.visible) return false; cur = cur.parent ? map.get(cur.parent) : null; }
  return true;
}

export function depthOf(layers, l) {
  const map = new Map(layers.map(x => [x.id, x]));
  let d = 0, cur = l;
  while (cur && cur.parent && map.has(cur.parent)) { d++; cur = map.get(cur.parent); }
  return d;
}

export const siblingsOf = (layers, l) => layers.filter(x => (x.parent || null) === (l.parent || null));

/** Insère un calque juste au-dessus de `aboveId` (ou en haut du groupe si c'est un groupe). */
export function insertAbove(st, layer, aboveId) {
  const layers = [...st.layers];
  const target = aboveId ? layers.find(l => l.id === aboveId) : null;
  if (!target) { layers.push({ ...layer, parent: null }); return withLayers(st, layers); }
  const i = layers.indexOf(target);
  if (isGroup(target)) layers.splice(i, 0, { ...layer, parent: target.id });
  else layers.splice(i + 1, 0, { ...layer, parent: target.parent || null });
  return withLayers(st, layers);
}

/** Supprime des éléments (et le contenu des groupes). */
export function removeItems(st, ids) {
  const kill = new Set(ids);
  for (const id of ids) for (const d of descendants(st.layers, id)) kill.add(d);
  return withLayers(st, st.layers.filter(l => !kill.has(l.id)));
}

/** Monte (+1) ou descend (-1) un élément parmi ses voisins du même groupe (un groupe voisin compte pour un). */
export function moveSibling(st, id, dir, toEdge = false) {
  const tree = buildTree(st.layers);
  const loc = findNode(tree, id);
  if (!loc) return st;
  const { list, index } = loc;
  let to = toEdge ? (dir > 0 ? list.length - 1 : 0) : index + dir;
  to = Math.max(0, Math.min(list.length - 1, to));
  if (to === index) return st;
  const [n] = list.splice(index, 1);
  list.splice(to, 0, n);
  return { ...st, layers: flattenTree(tree) };
}

function findNode(nodes, id, parent = null) {
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].layer.id === id) return { list: nodes, index: i, node: nodes[i], parent };
    if (nodes[i].children) { const r = findNode(nodes[i].children, id, nodes[i]); if (r) return r; }
  }
  return null;
}

/** Déplace un élément au-dessus / au-dessous d'un autre, ou dans un groupe (en haut). */
export function placeRelative(st, id, targetId, where) {
  if (id === targetId) return st;
  if (descendants(st.layers, id).has(targetId)) return st; // pas dans soi-même
  const tree = buildTree(st.layers);
  const src = findNode(tree, id);
  if (!src) return st;
  const [n] = src.list.splice(src.index, 1);
  const dst = findNode(tree, targetId);
  if (!dst) return st;
  if (where === 'inside' && dst.node.children) dst.node.children.push(n);
  else dst.list.splice(where === 'above' ? dst.index + 1 : dst.index, 0, n);
  return { ...st, layers: flattenTree(tree) };
}

/** Met les éléments `ids` dans un nouveau groupe, à la place du plus haut d'entre eux. */
export function groupItems(st, ids, name) {
  const set = new Set(ids);
  // on ignore ceux dont un parent est déjà sélectionné
  const top = (l) => { let p = l.parent; while (p) { if (set.has(p)) return false; p = st.layers.find(x => x.id === p)?.parent; } return true; };
  const chosen = st.layers.filter(l => set.has(l.id) && top(l));
  if (!chosen.length) return null;
  const highest = chosen[chosen.length - 1];
  const g = { id: uid(), kind: 'group', name, visible: true, opacity: 1, blend: 'pass through', parent: highest.parent || null, clipping: false, mask: null, canvas: null, x: 0, y: 0 };
  const layers = [];
  for (const l of st.layers) {
    if (l === highest) {
      for (const c of chosen) layers.push({ ...c, parent: g.id });
      layers.push(g);
    } else if (!chosen.includes(l)) layers.push(l);
  }
  // les descendants des éléments choisis suivent automatiquement (leur parent ne change pas)
  return { state: withLayers(st, layers), activeId: g.id };
}

export function ungroup(st, gid) {
  const g = st.layers.find(l => l.id === gid);
  if (!isGroup(g)) return null;
  const tree = buildTree(st.layers);
  const loc = findNode(tree, gid);
  loc.list.splice(loc.index, 1, ...loc.node.children);
  const kids = loc.node.children.map(c => c.layer.id);
  return { state: { ...st, layers: flattenTree(tree) }, activeId: kids.at(-1) || null };
}

/** Duplique un calque ou un groupe entier (les toiles, immuables, sont partagées). */
export function duplicateItem(st, id) {
  const l = st.layers.find(x => x.id === id);
  if (!l) return null;
  const ids = [id, ...descendants(st.layers, id)];
  const map = new Map(ids.map(i => [i, uid()]));
  const copies = st.layers.filter(x => map.has(x.id)).map(x => ({
    ...x, id: map.get(x.id), parent: x.id === id ? x.parent : map.get(x.parent), name: x.id === id ? `${x.name} copie` : x.name,
  }));
  const layers = [...st.layers];
  const i = layers.indexOf(l);
  layers.splice(i + 1, 0, ...copies);
  return { state: withLayers(st, layers), activeId: map.get(id) };
}

/** Calques « feuilles » concernés par un élément (lui-même, ou le contenu d'un groupe). */
export function leavesOf(st, id) {
  const l = st.layers.find(x => x.id === id);
  if (!l) return [];
  if (!isGroup(l)) return [l];
  const d = descendants(st.layers, id);
  return st.layers.filter(x => d.has(x.id) && !isGroup(x));
}

/** Décale des éléments (et leurs masques, et le contenu des groupes). */
export function moveItems(st, ids, dx, dy) {
  const set = new Set();
  for (const id of ids) { set.add(id); for (const d of descendants(st.layers, id)) set.add(d); }
  return {
    ...st,
    layers: st.layers.map(l => {
      if (!set.has(l.id)) return l;
      const m = l.mask ? { ...l.mask, x: l.mask.x + dx, y: l.mask.y + dy } : l.mask;
      return isGroup(l) ? { ...l, mask: m } : { ...l, x: l.x + dx, y: l.y + dy, mask: m };
    }),
  };
}

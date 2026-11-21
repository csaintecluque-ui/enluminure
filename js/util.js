// Enluminure — outils communs (toiles, limites, modes de fusion)

export const VERSION = '0.1.0';

export const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isMac = /Mac/.test(navigator.platform) && !isIOS;
export const isTouch = matchMedia('(pointer: coarse)').matches;

// Limites des navigateurs pour une toile (canvas).
// Safari sur iPhone/iPad refuse les toiles de plus de ~16,7 millions de pixels.
export const LIMITS = isIOS
  ? { side: 16384, area: 16_777_216, historyBytes: 200 * 1024 * 1024 }
  : { side: 16384, area: 268_000_000, historyBytes: 1536 * 1024 * 1024 };

let _uid = 0;
export const uid = () => `${Date.now().toString(36)}-${(++_uid).toString(36)}`;
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function newCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}
export const ctxOf = (c) => c.getContext('2d');

export function cloneCanvas(src) {
  const c = newCanvas(src.width, src.height);
  ctxOf(c).drawImage(src, 0, 0);
  return c;
}

/** Libère tout de suite la mémoire d'une toile qui n'est plus utilisée (important sur iPhone). */
export function freeCanvas(c) {
  if (c && c.width) { c.width = 0; c.height = 0; }
}

export function fitsLimits(w, h) {
  return w >= 1 && h >= 1 && w <= LIMITS.side && h <= LIMITS.side && w * h <= LIMITS.area;
}
/** Facteur de réduction nécessaire pour qu'une image tienne dans les limites (1 = aucune réduction). */
export function limitScale(w, h) {
  let s = 1;
  if (w * h > LIMITS.area) s = Math.sqrt(LIMITS.area / (w * h));
  s = Math.min(s, LIMITS.side / w, LIMITS.side / h);
  return s >= 1 ? 1 : s * 0.999;
}

// Modes de fusion, dans l'ordre et avec les noms de Photoshop (version française).
// [nom PSD, libellé, opération canvas ou null si pas encore géré]
export const BLENDS = [
  ['normal', 'Normal', 'source-over'],
  ['dissolve', 'Fondu', null],
  '-',
  ['darken', 'Obscurcir', 'darken'],
  ['multiply', 'Produit', 'multiply'],
  ['color burn', 'Densité couleur +', 'color-burn'],
  ['linear burn', 'Densité linéaire +', null],
  ['darker color', 'Couleur plus foncée', null],
  '-',
  ['lighten', 'Éclaircir', 'lighten'],
  ['screen', 'Superposition', 'screen'],
  ['color dodge', 'Densité couleur -', 'color-dodge'],
  ['linear dodge', 'Densité linéaire - (Ajout)', 'lighter'],
  ['lighter color', 'Couleur plus claire', null],
  '-',
  ['overlay', 'Incrustation', 'overlay'],
  ['soft light', 'Lumière tamisée', 'soft-light'],
  ['hard light', 'Lumière crue', 'hard-light'],
  ['vivid light', 'Lumière vive', null],
  ['linear light', 'Lumière linéaire', null],
  ['pin light', 'Lumière ponctuelle', null],
  ['hard mix', 'Mélange maximal', null],
  '-',
  ['difference', 'Différence', 'difference'],
  ['exclusion', 'Exclusion', 'exclusion'],
  ['subtract', 'Soustraction', null],
  ['divide', 'Division', null],
  '-',
  ['hue', 'Teinte', 'hue'],
  ['saturation', 'Saturation', 'saturation'],
  ['color', 'Couleur', 'color'],
  ['luminosity', 'Luminosité', 'luminosity'],
];
const BLEND_OP = new Map(BLENDS.filter(Array.isArray).map(b => [b[0], b[2]]));
export const blendOp = (name) => BLEND_OP.get(name) || 'source-over';
export const blendSupported = (name) => !!BLEND_OP.get(name);

/** Crée un calque. Les toiles des calques ne sont JAMAIS modifiées après création :
 *  chaque changement de pixels fabrique une nouvelle toile. C'est ce qui rend
 *  l'historique (annuler / rétablir) simple et sûr. */
export function mkLayer(p) {
  return {
    id: uid(),
    name: 'Calque',
    canvas: null,
    x: 0, y: 0,
    opacity: 1,
    blend: 'normal',
    visible: true,
    clipping: false,
    ...p,
  };
}

export function fmtBytes(n) {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} Ko`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} Mo`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2).replace('.', ',')} Go`;
}

export function baseName(filename) {
  return (filename || 'Sans titre').replace(/\.[^.]+$/, '');
}

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'html') e.innerHTML = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}

export function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((res, rej) => canvas.toBlob(b => b ? res(b) : rej(new Error('Conversion impossible')), type, quality));
}

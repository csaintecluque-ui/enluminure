// Enluminure — ouverture et enregistrement (JPG, PNG, WebP, PSD)
import { newCanvas, ctxOf, mkLayer, limitScale, isIOS, isTouch, baseName, canvasToBlob } from './util.js';
import { Doc } from './document.js';
import { flattenState } from './render.js';
import { scaleCanvas } from './ops.js';

let agPsdPromise = null;
const PSD_LIB = [
  new URL('../vendor/ag-psd.min.js', import.meta.url).href,           // copie locale (hors connexion)
  'https://cdn.jsdelivr.net/npm/ag-psd@34.1.0/dist/bundle.js',        // secours
];
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => res();
    s.onerror = () => { s.remove(); rej(new Error(src)); };
    document.head.append(s);
  });
}
/** La bibliothèque PSD (ag-psd, open source, licence MIT) n'est chargée qu'au premier besoin. */
export function loadPsdLib() {
  if (window.agPsd) return Promise.resolve(window.agPsd);
  if (!agPsdPromise) {
    agPsdPromise = (async () => {
      for (const src of PSD_LIB) {
        try { await loadScript(src); if (window.agPsd) return window.agPsd; } catch {}
      }
      agPsdPromise = null;
      throw new Error('Impossible de charger la bibliothèque PSD (vérifiez la connexion).');
    })();
  }
  return agPsdPromise;
}

export const isPsd = (file) => /\.(psd|psb)$/i.test(file.name || '') || file.type === 'image/vnd.adobe.photoshop';

/** Décode une image (JPG, PNG, WebP, GIF, AVIF, BMP…) en toile, en respectant l'orientation EXIF. */
export async function fileToCanvas(file) {
  let source, w, h, close = () => {};
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    source = bmp; w = bmp.width; h = bmp.height; close = () => bmp.close();
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      source = img; w = img.naturalWidth; h = img.naturalHeight;
    } catch {
      URL.revokeObjectURL(url);
      throw new Error(`Format non reconnu : ${file.name || 'image'}`);
    }
    close = () => URL.revokeObjectURL(url);
  }
  const s = limitScale(w, h);
  const nw = Math.max(1, Math.round(w * s)), nh = Math.max(1, Math.round(h * s));
  const c = newCanvas(nw, nh);
  const ctx = ctxOf(c);
  if (s < 1) { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; }
  ctx.drawImage(source, 0, 0, nw, nh);
  close();
  return { canvas: c, scaled: s < 1, origW: w, origH: h };
}

/** Ouvre un fichier et renvoie un Doc (+ remarques éventuelles). */
export async function openFileAsDoc(file) {
  if (isPsd(file)) return openPsd(file);
  const { canvas, scaled, origW, origH } = await fileToCanvas(file);
  const bg = mkLayer({ name: 'Arrière-plan', canvas });
  const doc = new Doc({ name: baseName(file.name), width: canvas.width, height: canvas.height, layers: [bg], label: 'Ouverture' });
  doc.fileName = file.name;
  const notes = [];
  if (scaled) notes.push(`Image réduite de ${origW}×${origH} à ${canvas.width}×${canvas.height} px : c'est la taille maximale que ${isIOS ? 'Safari accepte sur iPhone / iPad' : 'le navigateur accepte'}.`);
  return { doc, notes };
}

// ——— PSD ———

/** Applique un masque de fusion PSD directement dans les pixels (les masques modifiables arrivent à l'étape 3). */
function bakeMask(layer, canvas) {
  const m = layer.mask;
  if (!m || m.disabled || !m.canvas) return false;
  const w = canvas.width, h = canvas.height;
  const alpha = newCanvas(w, h);
  const a = ctxOf(alpha);
  const def = m.defaultColor ?? 0;
  a.fillStyle = `rgb(${def},${def},${def})`;
  a.fillRect(0, 0, w, h);
  a.drawImage(m.canvas, (m.left ?? 0) - (layer.left ?? 0), (m.top ?? 0) - (layer.top ?? 0));
  const img = a.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) { d[i + 3] = d[i]; d[i] = d[i + 1] = d[i + 2] = 0; }
  a.putImageData(img, 0, 0);
  const ctx = ctxOf(canvas);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(alpha, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  alpha.width = 0;
  return true;
}

export async function openPsd(file) {
  const ag = await loadPsdLib();
  const buf = await file.arrayBuffer();
  const psd = ag.readPsd(new Uint8Array(buf), { skipThumbnail: true, skipLinkedFilesData: true });
  const notes = [];
  const scale = limitScale(psd.width, psd.height);
  if (scale < 1) throw new Error(`Ce PSD fait ${psd.width}×${psd.height} px : trop grand pour ${isIOS ? 'Safari sur iPhone / iPad' : 'ce navigateur'}.`);
  const out = [];
  let groups = 0, adjust = 0, masks = 0, texts = 0;
  const walk = (children, parentHidden, parentOpacity, prefix) => {
    for (const ch of children || []) {
      if (ch.children) {
        groups++;
        walk(ch.children, parentHidden || ch.hidden, parentOpacity * (ch.opacity ?? 1), `${prefix}${ch.name || 'Groupe'} › `);
        continue;
      }
      if (ch.adjustment) { adjust++; continue; }
      if (ch.text) texts++;
      let canvas = ch.canvas;
      let x = ch.left ?? 0, y = ch.top ?? 0;
      if (!canvas || !canvas.width || !canvas.height) {
        canvas = newCanvas(psd.width, psd.height); x = 0; y = 0; // calque vide
      } else if (bakeMask(ch, canvas)) masks++;
      out.push(mkLayer({
        name: `${prefix}${ch.name || 'Calque'}`,
        canvas, x, y,
        opacity: (ch.opacity ?? 1) * parentOpacity,
        blend: ch.blendMode || 'normal',
        visible: !(ch.hidden || parentHidden),
        clipping: !!ch.clipping,
      }));
    }
  };
  walk(psd.children, false, 1, '');
  if (!out.length && psd.canvas) out.push(mkLayer({ name: 'Arrière-plan', canvas: psd.canvas }));
  if (!out.length) throw new Error('Ce PSD ne contient aucune image lisible.');
  if (groups) notes.push(`${groups} groupe(s) de calques mis à plat dans la liste (les groupes arrivent dans une prochaine étape).`);
  if (masks) notes.push(`${masks} masque(s) de fusion appliqué(s) directement aux pixels.`);
  if (adjust) notes.push(`${adjust} calque(s) de réglage ignoré(s) pour l'instant (étape 4).`);
  if (texts) notes.push(`${texts} calque(s) de texte ouverts comme images.`);
  const doc = new Doc({ name: baseName(file.name), width: psd.width, height: psd.height, layers: out, label: 'Ouverture' });
  doc.fileName = file.name;
  doc.markSaved();
  return { doc, notes };
}

export async function docToPsdBlob(doc) {
  const ag = await loadPsdLib();
  const st = doc.committed;
  const psd = {
    width: st.width,
    height: st.height,
    canvas: flattenState(st),
    children: st.layers.map(l => ({
      name: l.name,
      canvas: l.canvas,
      left: l.x,
      top: l.y,
      opacity: l.opacity,
      blendMode: l.blend,
      hidden: !l.visible,
      clipping: l.clipping,
    })),
  };
  const data = ag.writePsd(psd, { generateThumbnail: true, trimImageData: true, noBackground: true });
  psd.canvas.width = 0;
  return new Blob([data], { type: 'image/vnd.adobe.photoshop' });
}

export async function exportBlob(doc, { format = 'png', quality = 0.92, scale = 1 }) {
  const st = doc.committed;
  const mime = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }[format];
  let c = flattenState(st, format === 'jpg' ? '#ffffff' : null);
  if (scale !== 1) {
    const s = scaleCanvas(c, st.width * scale, st.height * scale, 'auto');
    c.width = 0; c = s;
  }
  const blob = await canvasToBlob(c, mime, format === 'png' ? undefined : quality);
  c.width = 0;
  return blob;
}

/**
 * Enregistre un fichier : fenêtre « Enregistrer sous » sur PC (Chrome / Edge),
 * menu de partage sur iPhone (→ Photos ou Fichiers), sinon téléchargement.
 * Renvoie false si l'utilisateur a annulé.
 */
export async function saveBlob(blob, filename, description = 'Image') {
  const ext = filename.split('.').pop().toLowerCase();
  // Version de test hébergée sur claude.ai : on passe par l'enregistrement proposé par la page
  const dl = await claudeDownloads();
  if (dl) {
    let data = blob, name = filename;
    if (!CLAUDE_EXT.has(ext)) { data = await zipOne(filename, blob); name = `${filename}.zip`; }
    try { await dl.save({ filename: name, data }); return true; }
    catch (e) {
      if (e?.code === 'declined') return false;
      throw new Error(`Enregistrement impossible ici (${e?.code || e?.message || 'erreur'})`);
    }
  }
  if (window.showSaveFilePicker && !isTouch) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description, accept: { [blob.type || 'application/octet-stream']: [`.${ext}`] } }],
      });
      const w = await handle.createWritable();
      await w.write(blob); await w.close();
      return true;
    } catch (e) {
      if (e.name === 'AbortError') return false;
      // sinon on retombe sur le téléchargement classique
    }
  }
  const file = new File([blob], filename, { type: blob.type });
  if (isTouch && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return true; }
    catch (e) { if (e.name === 'AbortError') return false; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return true;
}

// ——— Enregistrement dans la version de test claude.ai ———
const CLAUDE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'zip']);
let _dl;
async function claudeDownloads() {
  if (_dl !== undefined) return _dl;
  if (!window.claude?.use) return (_dl = null);
  try { _dl = await window.claude.use('downloads'); } catch { _dl = null; }
  return _dl;
}

/** Petit ZIP sans compression contenant un seul fichier (pour les .psd sur claude.ai). */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
async function zipOne(name, blob) {
  const data = new Uint8Array(await blob.arrayBuffer());
  const fname = new TextEncoder().encode(name);
  const crc = crc32(data);
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const local = new DataView(new ArrayBuffer(30));
  local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
  local.setUint16(8, 0, true); local.setUint16(10, time, true); local.setUint16(12, date, true);
  local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
  local.setUint16(26, fname.length, true); local.setUint16(28, 0, true);
  const central = new DataView(new ArrayBuffer(46));
  central.setUint32(0, 0x02014b50, true); central.setUint16(4, 20, true); central.setUint16(6, 20, true);
  central.setUint16(8, 0x0800, true); central.setUint16(10, 0, true); central.setUint16(12, time, true); central.setUint16(14, date, true);
  central.setUint32(16, crc, true); central.setUint32(20, data.length, true); central.setUint32(24, data.length, true);
  central.setUint16(28, fname.length, true); central.setUint32(42, 0, true);
  const cdOffset = 30 + fname.length + data.length;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, 1, true); end.setUint16(10, 1, true);
  end.setUint32(12, 46 + fname.length, true); end.setUint32(16, cdOffset, true);
  return new Blob([local, fname, data, central, fname, end], { type: 'application/zip' });
}
export const _test = { zipOne };

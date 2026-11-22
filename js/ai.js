// Enluminure — IA locale. Les modèles tournent dans le navigateur : sur la carte graphique (WebGPU)
// quand elle est disponible, sinon sur le processeur. Chaque modèle est téléchargé une seule fois
// (depuis Hugging Face) puis gardé sur l'appareil. Les images, elles, ne quittent jamais l'appareil.
import { newCanvas, ctxOf, freeCanvas, clamp, isIOS, isTouch } from './util.js';

const PREF_KEY = 'enluminure.ai';
export function prefs() { try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch { return {}; } }
export function setPrefs(p) { try { localStorage.setItem(PREF_KEY, JSON.stringify({ ...prefs(), ...p })); } catch {} }

export class AIError extends Error {}

// ——— Le moteur (transformers.js + ONNX Runtime, fournis avec l'appli) ———
export const TRANSFORMERS_CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/dist/transformers.min.js';
let T = null;
let gpuProbe = null;
async function lib() {
  if (T) return T;
  // transformers.js : copie locale si elle existe (développement), sinon version figée sur jsDelivr
  // (gardée ensuite par l'appli pour le hors-connexion). ONNX Runtime, lui, est fourni avec l'appli.
  for (const url of ['../vendor/transformers/transformers.min.js', TRANSFORMERS_CDN]) {
    try { T = await import(url); break; } catch (err) { console.warn('Moteur IA indisponible ici :', url, err); }
  }
  if (!T) throw new AIError("Le moteur d'IA n'a pas pu être chargé : connectez-vous une fois à internet (il reste ensuite sur l'appareil).");
  const env = T.env;
  env.allowLocalModels = false;
  const host = prefs().host; // miroir des modèles (tests ou hébergement personnel)
  if (host) env.remoteHost = host;
  env.backends.onnx.wasm.wasmPaths = new URL('../vendor/ort/', import.meta.url).href;
  env.backends.onnx.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
  return T;
}

/** 'webgpu' (carte graphique) ou 'wasm' (processeur). */
export async function device() {
  if (prefs().device === 'wasm') return 'wasm';
  gpuProbe ??= (async () => {
    try { return navigator.gpu && (await navigator.gpu.requestAdapter()) ? 'webgpu' : 'wasm'; } catch { return 'wasm'; }
  })();
  return gpuProbe;
}
export async function gpuAvailable() {
  try { return !!(navigator.gpu && (await navigator.gpu.requestAdapter())); } catch { return false; }
}

// ——— Fenêtre de progression (téléchargement, calcul) ———
let cancelFlag = false;
export const progress = {
  show(msg, frac = null, cancellable = false) {
    const b = document.querySelector('#busy');
    if (!b) return;
    let bar = b.querySelector('.busy-bar'), btn = b.querySelector('.busy-cancel');
    if (!bar) {
      bar = document.createElement('div'); bar.className = 'busy-bar'; bar.append(document.createElement('i'));
      btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn busy-cancel'; btn.textContent = 'Arrêter';
      btn.addEventListener('click', () => { cancelFlag = true; btn.disabled = true; btn.textContent = 'Arrêt…'; });
      b.append(bar, btn);
    }
    document.querySelector('#busy-msg').textContent = msg;
    bar.hidden = frac == null;
    if (frac != null) bar.firstChild.style.width = `${Math.round(clamp(frac, 0, 1) * 100)}%`;
    btn.hidden = !cancellable;
    if (!cancellable) { btn.disabled = false; btn.textContent = 'Arrêter'; }
    b.hidden = false;
  },
  hide() {
    const b = document.querySelector('#busy');
    if (!b) return;
    b.hidden = true;
    const btn = b.querySelector('.busy-cancel');
    if (btn) { btn.hidden = true; btn.disabled = false; btn.textContent = 'Arrêter'; }
    const bar = b.querySelector('.busy-bar');
    if (bar) bar.hidden = true;
  },
};
const frame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
const mb = (n) => `${Math.round(n / 1048576)} Mo`;

// ——— Les modèles ———
export const MODELS = {
  rmbg: {
    title: 'Détourage et sujet', model: 'RMBG 1.4 — BRIA AI', licence: 'Licence BRIA : usage personnel, non commercial',
    size: (dev) => (dev === 'webgpu' && !isTouch ? 176 : 44),
    async load(T, dev, cb) {
      const model = await T.AutoModel.from_pretrained('briaai/RMBG-1.4', {
        config: { model_type: 'custom' }, device: dev, dtype: dev === 'webgpu' && !isTouch ? 'fp32' : 'q8', progress_callback: cb,
      });
      return { model };
    },
  },
  sam: {
    title: "Sélection d'objet", model: 'SAM 2.1 tiny — Meta', licence: 'Apache 2.0',
    size: () => 155,
    async load(T, dev, cb) {
      try {
        const id = 'onnx-community/sam2.1-hiera-tiny-ONNX';
        const model = await T.Sam2Model.from_pretrained(id, { device: dev, dtype: 'fp32', progress_callback: cb });
        const processor = await T.AutoProcessor.from_pretrained(id);
        return { model, processor, boxes: true, name: 'SAM 2.1 tiny — Meta' };
      } catch (err) {
        console.warn('SAM 2.1 indisponible, on passe à SlimSAM', err);
        const id = 'Xenova/slimsam-77-uniform';
        const model = await T.SamModel.from_pretrained(id, { device: dev, dtype: dev === 'webgpu' ? 'fp32' : 'q8', progress_callback: cb });
        const processor = await T.AutoProcessor.from_pretrained(id);
        return { model, processor, boxes: false, name: 'SlimSAM (SAM allégé) — Meta' };
      }
    },
  },
  migan: {
    title: 'Suppression et remplissage', model: 'MI-GAN — Picsart AI Research', licence: 'MIT',
    size: () => 28,
    async load(T, dev, cb) {
      const model = await T.AutoModel.from_pretrained('andraniksargsyan/migan', {
        config: { model_type: 'custom' }, subfolder: '', model_file_name: 'migan_pipeline_v2', dtype: 'fp32', device: dev, progress_callback: cb,
      });
      return { model };
    },
  },
  esrgan: {
    title: 'Agrandissement', model: 'Real-ESRGAN ×4 — Xintao Wang', licence: 'BSD-3',
    size: () => 67,
    async load(T, dev, cb) {
      const model = await T.AutoModel.from_pretrained('lxfater/inpaint-web', {
        config: { model_type: 'custom' }, subfolder: '', model_file_name: 'realesrgan-x4', dtype: 'fp32', device: dev, progress_callback: cb,
      });
      return { model };
    },
  },
};

const loaded = {};
const loading = {};
/** Charge un modèle (téléchargement la première fois, avec une barre de progression). */
export async function getModel(key) {
  if (loaded[key]) return loaded[key];
  loading[key] ??= (async () => {
    const T = await lib();
    const dev = await device();
    const def = MODELS[key];
    const files = {};
    let shown = false;
    const cb = (e) => {
      if (!e) return;
      if (e.status === 'progress' && e.file) files[e.file] = { loaded: e.loaded || 0, total: e.total || 0 };
      else if (e.status === 'progress_total' && e.total) files.__total = { loaded: e.loaded || 0, total: e.total };
      const list = files.__total ? [files.__total] : Object.values(files);
      const tot = list.reduce((s, f) => s + f.total, 0), got = list.reduce((s, f) => s + f.loaded, 0);
      if (e.status === 'progress' || e.status === 'progress_total') {
        shown = true;
        progress.show(`Téléchargement du modèle « ${def.title} » — ${mb(got)}${tot ? ` / ${mb(tot)}` : ''}\nUne seule fois : il reste ensuite sur l'appareil.`, tot ? got / tot : null);
      }
    };
    progress.show(`Préparation de l'IA « ${def.title} »…`);
    try {
      const m = await def.load(T, dev, cb);
      if (shown) progress.show(`Démarrage du modèle « ${def.title} »…`);
      loaded[key] = { ...m, device: dev };
      markDownloaded(key);
      return loaded[key];
    } catch (err) {
      console.error(err);
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      throw new AIError(offline
        ? `Le modèle « ${def.title} » n'est pas encore sur l'appareil : connectez-vous une fois pour le télécharger.`
        : `Le modèle « ${def.title} » n'a pas pu être chargé (${err.message || err}).`);
    } finally {
      delete loading[key];
    }
  })();
  return loading[key];
}

function markDownloaded(key) {
  const d = prefs().downloaded || {};
  if (!d[key]) setPrefs({ downloaded: { ...d, [key]: Date.now() } });
}
export const isDownloaded = (key) => !!(prefs().downloaded || {})[key];
export const loadedName = (key) => loaded[key]?.name || null;

/** Supprime les modèles gardés sur l'appareil (cache du navigateur). */
export async function clearModels() {
  for (const k of Object.keys(loaded)) { try { await loaded[k].model?.dispose?.(); } catch {} delete loaded[k]; }
  try { await caches.delete('transformers-cache'); } catch {}
  setPrefs({ downloaded: {} });
}
/** Place occupée par les modèles (octets), si le navigateur sait le dire. */
export async function storedBytes() {
  try {
    const c = await caches.open('transformers-cache');
    const keys = await c.keys();
    let n = 0;
    for (const k of keys) {
      const r = await c.match(k);
      const len = +r.headers.get('content-length');
      n += len || (await r.clone().blob()).size;
    }
    return n;
  } catch { return null; }
}

// ——— Outils de conversion ———
/** Copie réduite d'une toile (côté le plus long ≤ max), sur fond blanc si demandé. */
function scaled(src, max, white = false) {
  const k = Math.min(1, max / Math.max(src.width, src.height));
  const w = Math.max(1, Math.round(src.width * k)), h = Math.max(1, Math.round(src.height * k));
  const c = newCanvas(w, h), ctx = ctxOf(c);
  if (white) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  return { c, k, w, h };
}
/** Toile de masque (valeurs dans l'alpha) à partir de valeurs 0..1. */
function maskCanvas(values, w, h, map = (v) => v) {
  const c = newCanvas(w, h), ctx = ctxOf(c);
  const img = ctx.createImageData(w, h), d = img.data;
  for (let i = 0, k = 3; i < w * h; i++, k += 4) d[k] = clamp(map(values[i]), 0, 1) * 255;
  ctx.putImageData(img, 0, 0);
  return c;
}

// ——— 1. Sujet / détourage ———
/** Masque du sujet principal (toile 1024 × 1024, valeurs dans l'alpha) — à étirer à la taille voulue. */
export async function subjectMask(src) {
  const { model } = await getModel('rmbg');
  const T = await lib();
  progress.show('Recherche du sujet…');
  await frame();
  const S = 1024;
  const c = newCanvas(S, S), ctx = ctxOf(c);
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, S, S);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, S, S);
  const px = ctx.getImageData(0, 0, S, S).data;
  freeCanvas(c);
  const n = S * S, data = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    data[i] = px[i * 4] / 255 - 0.5;
    data[n + i] = px[i * 4 + 1] / 255 - 0.5;
    data[2 * n + i] = px[i * 4 + 2] / 255 - 0.5;
  }
  const out = await model({ input: new T.Tensor('float32', data, [1, 3, S, S]) });
  const t = out.output ?? Object.values(out)[0];
  const v = t.data;
  // les sorties ne sont pas toujours entre 0 et 1 : on les ramène à cette plage
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) { if (v[i] < lo) lo = v[i]; if (v[i] > hi) hi = v[i]; }
  const span = hi - lo || 1;
  return maskCanvas(v, S, S, (x) => (x - lo) / span);
}

// ——— 2. Sélection d'objet (Segment Anything) ———
let samState = null;
/** Analyse l'image (une fois par état du document) avant de pouvoir cliquer sur les objets. */
export async function samPrepare(key, src) {
  if (samState?.key === key) return samState;
  const m = await getModel('sam');
  const T = await lib();
  progress.show("Analyse de l'image…");
  await frame();
  const { c, k, w, h } = scaled(src, 1536, true);
  const px = ctxOf(c).getImageData(0, 0, w, h).data;
  freeCanvas(c);
  const rgb = new Uint8ClampedArray(w * h * 3);
  for (let i = 0, j = 0; i < px.length; i += 4, j += 3) { rgb[j] = px[i]; rgb[j + 1] = px[i + 1]; rgb[j + 2] = px[i + 2]; }
  const image = new T.RawImage(rgb, w, h, 3);
  const inputs = await m.processor(image);
  const emb = await m.model.get_image_embeddings(inputs);
  samState = { key, inputs, emb, k, w, h };
  return samState;
}
export const samReady = (key) => samState?.key === key;
export function samForget() { samState = null; }

/**
 * Masque de l'objet désigné : points [{ x, y, label: 1 (objet) | 0 (fond) }] et/ou cadre { x0, y0, x1, y1 }
 * (coordonnées du document). Renvoie { canvas (taille de l'analyse), scale } ou null.
 */
export async function samSegment({ points = [], box = null }) {
  if (!samState) throw new AIError("L'image n'a pas été analysée.");
  const m = await getModel('sam');
  const T = await lib();
  const { inputs, emb, k, w, h } = samState;
  const P = m.processor;
  const feeds = { ...emb };
  let pts = points.map(p => [p.x * k, p.y * k]), labels = points.map(p => p.label ?? 1);
  if (box && !m.boxes) { // ancien modèle : le cadre devient un point au centre
    pts.push([(box.x0 + box.x1) / 2 * k, (box.y0 + box.y1) / 2 * k]); labels.push(1);
    box = null;
  }
  if (pts.length) {
    feeds.input_points = P.reshape_input_points([[pts]], inputs.original_sizes, inputs.reshaped_input_sizes);
    feeds.input_labels = new T.Tensor('int64', BigInt64Array.from(labels.map(BigInt)), [1, 1, labels.length]);
  }
  if (box) feeds.input_boxes = P.reshape_input_points([[[box.x0 * k, box.y0 * k, box.x1 * k, box.y1 * k]]], inputs.original_sizes, inputs.reshaped_input_sizes, true);
  const out = await m.model(feeds);
  const masks = await P.post_process_masks(out.pred_masks, inputs.original_sizes, inputs.reshaped_input_sizes, { binarize: false });
  const t = masks[0];
  const nm = t.dims.length === 4 ? t.dims[1] : 1;
  const scores = out.iou_scores?.data ? Array.from(out.iou_scores.data) : [1];
  let best = 0;
  for (let i = 1; i < nm; i++) if ((scores[i] ?? -1) > (scores[best] ?? -1)) best = i;
  const size = w * h, logits = t.data.subarray(best * size, (best + 1) * size);
  let any = false;
  for (let i = 0; i < size; i += 7) if (logits[i] > 0) { any = true; break; }
  if (!any) return null;
  return { canvas: maskCanvas(logits, w, h, (x) => 1 / (1 + Math.exp(-x * 2))), scale: k, score: scores[best] };
}

// ——— 3. Suppression / remplissage (MI-GAN) ———
/**
 * Remplit les trous d'une image. `img` : toile RGBA ; `hole` : Uint8Array (taille w × h), 1 = à remplir.
 * Renvoie une toile de même taille.
 */
export async function inpaint(img, hole) {
  const m = await getModel('migan');
  const T = await lib();
  const W = img.width, H = img.height, n = W * H;
  const px = ctxOf(img).getImageData(0, 0, W, H).data;
  const rgb = new Uint8Array(3 * n), mk = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    rgb[i] = px[i * 4]; rgb[n + i] = px[i * 4 + 1]; rgb[2 * n + i] = px[i * 4 + 2];
    mk[i] = hole[i] ? 0 : 255; // 255 = pixel connu, 0 = trou
  }
  const sess = m.model.sessions?.model ?? Object.values(m.model.sessions || {})[0];
  const names = sess?.inputNames || ['image', 'mask'];
  const out = await m.model({ [names[0]]: new T.Tensor('uint8', rgb, [1, 3, H, W]), [names[1]]: new T.Tensor('uint8', mk, [1, 1, H, W]) });
  const t = (sess?.outputNames && out[sess.outputNames[0]]) || Object.values(out)[0];
  const o = t.data;
  let conv = (v) => v; // sortie attendue : octets 0..255
  if (!(o instanceof Uint8Array) && !(o instanceof Uint8ClampedArray)) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < o.length; i += 97) { if (o[i] < lo) lo = o[i]; if (o[i] > hi) hi = o[i]; }
    if (lo < -0.01) conv = (v) => (v + 1) * 127.5; else if (hi <= 1.01) conv = (v) => v * 255;
  }
  const res = newCanvas(W, H), rctx = ctxOf(res);
  const id = rctx.createImageData(W, H), d = id.data;
  for (let i = 0; i < n; i++) {
    const k4 = i * 4;
    d[k4] = conv(o[i]); d[k4 + 1] = conv(o[n + i]); d[k4 + 2] = conv(o[2 * n + i]); d[k4 + 3] = 255;
  }
  rctx.putImageData(id, 0, 0);
  return res;
}

// ——— 4. Agrandissement (Real-ESRGAN ×4, par tuiles) ———
/**
 * Agrandit une image ×2 ou ×4. Les tuiles sont calculées une à une (barre de progression, bouton Arrêter).
 * Renvoie la toile agrandie, ou null si l'utilisateur a arrêté.
 */
export async function upscale(src, factor = 4, onProgress = null) {
  const m = await getModel('esrgan');
  const T = await lib();
  const sess = m.model.sessions?.model ?? Object.values(m.model.sessions || {})[0];
  const inName = sess?.inputNames?.[0] || 'input.1';
  const outName = sess?.outputNames?.[0];
  const W = src.width, H = src.height;
  const all = ctxOf(src).getImageData(0, 0, W, H).data;
  const out = newCanvas(W * factor, H * factor), octx = ctxOf(out);
  octx.imageSmoothingQuality = 'high';
  const PAD = 6;
  // taille des tuiles : celle imposée par le modèle, sinon des tuiles plus grandes (bien plus rapide)
  const meta = sess?.inputMetadata?.find?.(x => x.name === inName) ?? sess?.inputMetadata?.[0];
  const fixed = meta?.shape && typeof meta.shape[2] === 'number' && meta.shape[2] > 0 ? meta.shape[2] : null;
  let tile = fixed || 192;
  const run = async (T0, size) => {
    const t = await m.model({ [inName]: new T.Tensor('float32', T0, [1, 3, size, size]) });
    return (outName && t[outName]) || Object.values(t)[0];
  };
  const tileData = (x0, y0, size) => {
    const d = new Float32Array(3 * size * size), s2 = size * size;
    for (let y = 0; y < size; y++) {
      const sy = clamp(y0 + y, 0, H - 1);
      for (let x = 0; x < size; x++) {
        const sx = clamp(x0 + x, 0, W - 1), i = (sy * W + sx) * 4, j = y * size + x;
        d[j] = all[i] / 255; d[s2 + j] = all[i + 1] / 255; d[2 * s2 + j] = all[i + 2] / 255;
      }
    }
    return d;
  };
  const core = tile - PAD * 2;
  const nx = Math.ceil(W / core), ny = Math.ceil(H / core), total = nx * ny;
  const S = tile * 4, piece = newCanvas(S, S), pctx = ctxOf(piece);
  const pimg = pctx.createImageData(S, S);
  cancelFlag = false;
  let done = 0;
  for (let ty = 0; ty < ny; ty++) {
    for (let tx = 0; tx < nx; tx++) {
      if (cancelFlag) { freeCanvas(out); freeCanvas(piece); return null; }
      const x0 = tx * core - PAD, y0 = ty * core - PAD;
      const r = await run(tileData(x0, y0, tile), tile);
      const o = r.data, s2 = S * S, d = pimg.data;
      for (let i = 0; i < s2; i++) {
        d[i * 4] = o[i] * 255; d[i * 4 + 1] = o[s2 + i] * 255; d[i * 4 + 2] = o[2 * s2 + i] * 255; d[i * 4 + 3] = 255;
      }
      pctx.putImageData(pimg, 0, 0);
      // on ne garde que le cœur de la tuile (sans la marge), à l'échelle voulue
      const cw = Math.min(core, W - tx * core), ch = Math.min(core, H - ty * core);
      const f = factor / 4;
      octx.drawImage(piece, PAD * 4, PAD * 4, cw * 4, ch * 4, tx * core * factor, ty * core * factor, cw * 4 * f, ch * 4 * f);
      done++;
      if (onProgress && (done % 4 === 0 || done === total)) { onProgress(done / total); await frame(); }
    }
  }
  freeCanvas(piece);
  // la transparence d'origine est gardée (agrandie simplement)
  let hasAlpha = false;
  for (let i = 3; i < all.length; i += 4 * 13) if (all[i] < 255) { hasAlpha = true; break; }
  if (hasAlpha) {
    octx.globalCompositeOperation = 'destination-in';
    octx.drawImage(src, 0, 0, W * factor, H * factor);
    octx.globalCompositeOperation = 'source-over';
  }
  return out;
}

export const _test = { lib, scaled, maskCanvas };

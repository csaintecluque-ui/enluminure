// Enluminure — les fonctions d'IA dans l'appli : sujet, arrière-plan, suppression, remplissage, agrandissement
import { el, clamp, newCanvas, ctxOf, freeCanvas, mkLayer, fitsLimits, isTouch } from './util.js';
import { toast, openDialog, confirmDialog } from './ui.js';
import * as AI from './ai.js';
import * as ops from './ops.js';
import { prepareTarget, commitPixels } from './paint.js';
import { trimSel, alphaBounds } from './selection.js';
import { Doc } from './document.js';

/** Lance une tâche d'IA : messages clairs en cas de souci, fenêtre d'attente toujours refermée. */
export async function aiRun(fn) {
  try { return await fn(); }
  catch (err) {
    console.error(err);
    toast(err instanceof AI.AIError ? err.message : `L'IA a rencontré un problème : ${err.message || err}`, 7000);
    return null;
  } finally { AI.progress.hide(); }
}

/** Étire une toile de masque à la taille du document (valeurs dans l'alpha). */
function toDocMask(m, W, H, x = 0, y = 0, w = W, h = H) {
  const c = newCanvas(W, H), ctx = ctxOf(c);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(m, x, y, w, h);
  return c;
}

// ——— Sélection > Sujet ———
export async function selectSubject(app) {
  const d = app.doc; if (!d) return;
  const sel = await aiRun(async () => {
    const m = await AI.subjectMask(d.composite());
    const c = toDocMask(m, d.width, d.height);
    freeCanvas(m);
    return trimSel({ canvas: c, x: 0, y: 0 });
  });
  if (sel === null) return;
  if (!sel) { toast("Aucun sujet net n'a été trouvé."); return; }
  app.setSelection(sel, 'Sélectionner le sujet');
  toast('Sujet sélectionné. Maj : ajouter, Alt : retirer avec les outils de sélection.', 3500);
}

// ——— Calque > Supprimer l'arrière-plan (masque de fusion : rien n'est effacé) ———
export async function removeBackground(app) {
  const d = app.doc, L = d?.active;
  if (!L || !L.canvas || L.kind) { toast("Choisissez un calque d'image."); return; }
  if (L.mask && !(await confirmDialog('Remplacer le masque ?', 'Ce calque a déjà un masque : il sera remplacé par celui du sujet (Ctrl+Z pour revenir).', 'Remplacer'))) return;
  const mask = await aiRun(async () => {
    const m = await AI.subjectMask(L.canvas);
    const c = toDocMask(m, d.width, d.height, L.x, L.y, L.canvas.width, L.canvas.height);
    freeCanvas(m);
    return c;
  });
  if (!mask) return;
  d.target = 'mask';
  app.commit("Supprimer l'arrière-plan", ops.updateLayer(d.committed, L.id, { mask: { canvas: mask, x: 0, y: 0, def: 0, disabled: false } }));
  toast("Arrière-plan masqué, sans rien effacer : retouchez le masque au pinceau (noir = cacher, blanc = montrer).", 5000);
}

// ——— Remplissage par l'IA (outil Suppression, remplissage d'après le contenu) ———
function dilate(hole, w, h, r) {
  if (r < 1) return hole;
  const tmp = new Uint8Array(hole.length), out = new Uint8Array(hole.length);
  for (let y = 0; y < h; y++) { // horizontal
    let run = -1e9;
    for (let x = 0; x < w; x++) { if (hole[y * w + x]) run = x; if (x - run <= r) tmp[y * w + x] = 1; }
    run = 1e9;
    for (let x = w - 1; x >= 0; x--) { if (hole[y * w + x]) run = x; if (run - x <= r) tmp[y * w + x] = 1; }
  }
  for (let x = 0; x < w; x++) { // vertical
    let run = -1e9;
    for (let y = 0; y < h; y++) { if (tmp[y * w + x]) run = y; if (y - run <= r) out[y * w + x] = 1; }
    run = 1e9;
    for (let y = h - 1; y >= 0; y--) { if (tmp[y * w + x]) run = y; if (run - y <= r) out[y * w + x] = 1; }
  }
  return out;
}
function blurAlpha(a, w, h, r) { // flou en boîte (2 passes) d'un masque 0..255
  const t = new Float32Array(a.length), o = new Float32Array(a.length);
  const k = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += a[y * w + clamp(x + i, 0, w - 1)];
    t[y * w + x] = s * k;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += t[clamp(y + i, 0, h - 1) * w + x];
    o[y * w + x] = s * k;
  }
  return o;
}

/**
 * Remplit une zone d'un calque avec l'IA. `mask` : { canvas, x, y } en coordonnées du document,
 * valeurs dans l'alpha. `sampleAll` : on part de l'image entière (pratique sur un calque vide).
 */
export async function aiInpaint(app, { layerId, mask, label, sampleAll = false, prepared = null, limit = null }) {
  const d = app.doc;
  const P = prepared || prepareTarget(d, layerId);
  if (!P) return false;
  const mb = alphaBounds(mask.canvas);
  if (!mb) { d.cancelPreview(); app.refresh({ history: false }); return false; }
  mb.x += mask.x; mb.y += mask.y;
  const big = Math.max(mb.w, mb.h), margin = Math.max(48, Math.round(big * 0.75));
  const x0 = clamp(mb.x - margin, 0, d.width), y0 = clamp(mb.y - margin, 0, d.height);
  const x1 = clamp(mb.x + mb.w + margin, 0, d.width), y1 = clamp(mb.y + mb.h + margin, 0, d.height);
  const R = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  if (R.w < 4 || R.h < 4) { d.cancelPreview(); app.refresh({ history: false }); return false; }
  const ok = await aiRun(async () => {
    const k = Math.min(1, 2048 / Math.max(R.w, R.h));
    const w = Math.max(4, Math.round(R.w * k)), h = Math.max(4, Math.round(R.h * k));
    // l'image de départ
    const src = newCanvas(w, h), sctx = ctxOf(src);
    sctx.imageSmoothingQuality = 'high';
    if (sampleAll) sctx.drawImage(d.composite(), R.x, R.y, R.w, R.h, 0, 0, w, h);
    else sctx.drawImage(P.canvas, R.x - P.ox, R.y - P.oy, R.w, R.h, 0, 0, w, h);
    // le trou, un peu élargi pour couvrir les bords flous de l'objet
    const mc = newCanvas(w, h), mctx = ctxOf(mc);
    mctx.drawImage(mask.canvas, (mask.x - R.x) * k, (mask.y - R.y) * k, mask.canvas.width * k, mask.canvas.height * k);
    const ma = mctx.getImageData(0, 0, w, h).data;
    freeCanvas(mc);
    let hole = new Uint8Array(w * h);
    for (let i = 0; i < hole.length; i++) hole[i] = ma[i * 4 + 3] > 12 ? 1 : 0;
    hole = dilate(hole, w, h, Math.max(1, Math.round(3 * k)));
    AI.progress.show('Remplissage par l\'IA…');
    const out = await AI.inpaint(src, hole);
    freeCanvas(src);
    // fondu doux sur le bord du trou
    const a = new Float32Array(hole.length);
    for (let i = 0; i < a.length; i++) a[i] = hole[i] * 255;
    const soft = blurAlpha(a, w, h, Math.max(1, Math.round(2 * k)));
    const octx = ctxOf(out), od = octx.getImageData(0, 0, w, h);
    for (let i = 0; i < soft.length; i++) od.data[i * 4 + 3] = Math.max(soft[i], hole[i] ? 255 : 0);
    octx.putImageData(od, 0, 0);
    // limite éventuelle (sélection active)
    if (limit) {
      octx.globalCompositeOperation = 'destination-in';
      octx.drawImage(limit.canvas, (limit.x - R.x) * k, (limit.y - R.y) * k, limit.canvas.width * k, limit.canvas.height * k);
      octx.globalCompositeOperation = 'source-over';
    }
    commitPixels(app, label, layerId, R, (ctx, P2, r) => {
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(out, 0, 0, w, h, r.x, r.y, r.w, r.h);
    }, P);
    freeCanvas(out);
    return true;
  });
  if (!ok) { d.cancelPreview(); app.refresh({ history: false }); }
  return !!ok;
}

// ——— Édition > Remplissage d'après le contenu ———
export async function contentAwareFill(app) {
  const d = app.doc, sel = d?.committed.selection;
  if (!sel) { toast("Sélectionnez d'abord ce qu'il faut remplacer (lasso, sélection d'objet…)."); return; }
  const L = d.active;
  if (!L || !L.canvas || L.kind) { toast("Choisissez un calque d'image."); return; }
  if (app.smartBlocked(L)) return;
  if (d.target === 'mask') { toast('Le remplissage par l\'IA travaille sur les pixels du calque, pas sur son masque.'); return; }
  await aiInpaint(app, { layerId: L.id, mask: { canvas: sel.canvas, x: sel.x, y: sel.y }, label: "Remplissage d'après le contenu" });
}

// ——— Image > Agrandir avec l'IA (nouveau document : l'original reste intact) ———
export async function upscaleDialog(app) {
  const d = app.doc; if (!d) return;
  const W = d.width, H = d.height;
  const choice = el('select', {}, ...[2, 4].map(f => el('option', { value: f }, `×${f} — ${W * f} × ${H * f} px`)));
  const note = el('p', { class: 'muted small' }, "Le résultat s'ouvre dans un nouvel onglet : votre document n'est pas modifié. Les calques visibles sont d'abord fusionnés.");
  const f = await openDialog({
    title: "Agrandir avec l'IA", body: el('div', { class: 'form' }, el('label', { class: 'field' }, el('span', {}, 'Agrandissement'), choice), note),
    buttons: [{ label: 'Annuler', value: null }, { label: 'Agrandir', primary: true, value: 'ok' }], onSubmit: () => +choice.value,
  });
  if (!f) return;
  const factor = +f;
  if (!fitsLimits(W * factor, H * factor)) { toast(`Trop grand pour cet appareil (${W * factor} × ${H * factor} px) : essayez ×2, ou réduisez l'image avant.`, 6000); return; }
  const t0 = performance.now();
  const big = await aiRun(async () => {
    await AI.getModel('esrgan');
    AI.progress.show(`Agrandissement ×${factor}…`, 0, true);
    return AI.upscale(d.composite(), factor, (fr) => {
      const s = (performance.now() - t0) / 1000, left = fr > 0.02 ? Math.round(s / fr - s) : null;
      AI.progress.show(`Agrandissement ×${factor}… ${Math.round(fr * 100)} %${left != null ? ` — encore ${left < 90 ? `${left} s` : `${Math.round(left / 60)} min`}` : ''}`, fr, true);
    });
  });
  if (!big) { if (big === null) toast('Agrandissement arrêté.'); return; }
  const layer = mkLayer({ name: 'Arrière-plan', canvas: big });
  const doc = new Doc({ name: `${d.name} ×${factor}`, width: big.width, height: big.height, layers: [layer], label: `Agrandissement IA ×${factor}` });
  app.addDoc(doc, []);
  toast(`Image agrandie ×${factor} (${big.width} × ${big.height} px).`);
}

// ——— Aide > IA locale : les modèles, où ils tournent, place occupée ———
export async function aiDialog(app) {
  const dev = await AI.device(), gpu = await AI.gpuAvailable();
  const rows = Object.entries(AI.MODELS).map(([k, m]) => el('tr', {},
    el('td', {}, el('b', {}, m.title), el('div', { class: 'muted small' }, `${AI.loadedName(k) || m.model} · ${m.licence}`)),
    el('td', { class: 'num' }, `≈ ${m.size(dev)} Mo`),
    el('td', {}, AI.isDownloaded(k) ? '✓ sur l\'appareil' : 'à la première utilisation')));
  const used = el('span', {}, '…');
  AI.storedBytes().then(n => { used.textContent = n == null ? 'inconnue' : `${Math.round(n / 1048576)} Mo`; });
  const devSel = el('select', {},
    el('option', { value: 'auto' }, gpu ? 'Carte graphique (WebGPU) — recommandé' : 'Automatique (pas de WebGPU ici : processeur)'),
    el('option', { value: 'wasm' }, 'Processeur seulement (plus lent)'));
  devSel.value = AI.prefs().device === 'wasm' ? 'wasm' : 'auto';
  const body = el('div', { class: 'form ai-dialog' },
    el('p', {}, "Les modèles d'IA tournent sur cet appareil. Chacun est téléchargé une seule fois (depuis Hugging Face), puis il reste ici et fonctionne hors connexion. ", el('b', {}, 'Vos images ne quittent jamais l\'appareil.')),
    el('table', { class: 'ai-models' }, rows),
    el('label', { class: 'field' }, el('span', {}, 'Calcul'), devSel),
    el('p', { class: 'muted small' }, 'Place occupée par les modèles : ', used, `. Calcul actuel : ${dev === 'webgpu' ? 'carte graphique' : 'processeur'}.`));
  const r = await openDialog({
    title: 'IA locale', body, wide: true,
    buttons: [{ label: 'Supprimer les modèles', value: 'clear' }, { label: 'Tout télécharger', value: 'all' }, { label: 'Fermer', primary: true, value: 'ok' }],
  });
  if (r == null) return;
  const want = devSel.value === 'wasm' ? 'wasm' : undefined;
  if (want !== AI.prefs().device) { AI.setPrefs({ device: want }); toast('Réglage enregistré : il sera pris en compte au prochain lancement de l\'appli.', 4000); }
  if (r === 'clear') {
    if (await confirmDialog('Supprimer les modèles ?', "Ils seront de nouveau téléchargés à la prochaine utilisation.", 'Supprimer')) { await AI.clearModels(); toast('Modèles supprimés de l\'appareil.'); }
  } else if (r === 'all') {
    for (const k of Object.keys(AI.MODELS)) { const ok = await aiRun(() => AI.getModel(k)); if (!ok) return; }
    toast("Tous les modèles sont sur l'appareil : l'IA marche maintenant hors connexion.", 5000);
  }
}

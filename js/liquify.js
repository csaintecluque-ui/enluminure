// Enluminure — Fluidité : déformer, reconstruire, contracter, dilater, tourbillon
// On travaille sur un aperçu réduit (rapide), puis on applique la déformation en pleine résolution.
import { el, clamp, isIOS, newCanvas, ctxOf, freeCanvas } from './util.js';
import { toast } from './ui.js';
import { prepareTarget, commitPixels } from './paint.js';

const TOOLS = [
  ['push', 'Déformer', 'W', 'Pousse les pixels dans le sens du geste'],
  ['reconstruct', 'Reconstruire', 'R', 'Revient peu à peu à l\'image d\'origine'],
  ['pucker', 'Contracter', 'S', 'Resserre vers le centre du pinceau'],
  ['bloat', 'Dilater', 'B', 'Gonfle depuis le centre du pinceau'],
  ['twirl', 'Tourbillon', 'C', 'Fait tourner (Alt : dans l\'autre sens)'],
];
const settings = { tool: 'push', size: 120, rate: 50 }; // gardés d'une ouverture à l'autre

/** Échantillonnage bilinéaire (couleurs prémultipliées par l'alpha). Bords : répétés. */
function sampleInto(src, W, H, x, y, out, k) {
  x = clamp(x, 0, W - 1); y = clamp(y, 0, H - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const i00 = (y0 * W + x0) * 4, i10 = (y0 * W + x1) * 4, i01 = (y1 * W + x0) * 4, i11 = (y1 * W + x1) * 4;
  const w00 = (1 - fx) * (1 - fy) * src[i00 + 3], w10 = fx * (1 - fy) * src[i10 + 3], w01 = (1 - fx) * fy * src[i01 + 3], w11 = fx * fy * src[i11 + 3];
  const a = w00 + w10 + w01 + w11;
  if (a <= 0) { out[k] = out[k + 1] = out[k + 2] = out[k + 3] = 0; return; }
  for (let c = 0; c < 3; c++) out[k + c] = (src[i00 + c] * w00 + src[i10 + c] * w10 + src[i01 + c] * w01 + src[i11 + c] * w11) / a;
  out[k + 3] = a;
}
function bil(f, W, H, x, y) {
  x = clamp(x, 0, W - 1); y = clamp(y, 0, H - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  return (f[y0 * W + x0] * (1 - fx) + f[y0 * W + x1] * fx) * (1 - fy) + (f[y1 * W + x0] * (1 - fx) + f[y1 * W + x1] * fx) * fy;
}

/** Applique un champ de déplacement (taille pw × ph, en px de l'aperçu) à une image de taille W × H. */
export function warpFull(src, W, H, dx, dy, pw, ph) {
  const out = new ImageData(W, H), o = out.data;
  const kx = pw / W, ky = ph / H;
  for (let y = 0; y < H; y++) {
    const py = (y + 0.5) * ky - 0.5;
    for (let x = 0; x < W; x++) {
      const px = (x + 0.5) * kx - 0.5;
      const ddx = bil(dx, pw, ph, px, py) / kx, ddy = bil(dy, pw, ph, px, py) / ky;
      const k = (y * W + x) * 4;
      if (!ddx && !ddy) { o[k] = src[k]; o[k + 1] = src[k + 1]; o[k + 2] = src[k + 2]; o[k + 3] = src[k + 3]; continue; }
      sampleInto(src, W, H, x + ddx, y + ddy, o, k);
    }
  }
  return out;
}

export async function liquifyDialog(app) {
  const d = app.doc;
  const L = d?.active;
  if (!L || !L.canvas || L.kind) { toast('Choisissez un calque d\'image.'); return; }
  if (d.target === 'mask') { toast('La fluidité s\'applique aux pixels du calque, pas à son masque.'); return; }
  const P = prepareTarget(d, L.id);
  if (!P) return;
  const c = P.canvas;
  // Zone de travail (coordonnées de la toile) : la sélection, sinon la partie visible du calque
  const doc = { x: -P.ox, y: -P.oy, w: d.width, h: d.height };
  let R = doc;
  const sel = P.state.selection;
  if (sel) R = { x: sel.x - P.ox, y: sel.y - P.oy, w: sel.canvas.width, h: sel.canvas.height };
  const x0 = clamp(Math.floor(Math.max(R.x, doc.x)), 0, c.width), y0 = clamp(Math.floor(Math.max(R.y, doc.y)), 0, c.height);
  const x1 = clamp(Math.ceil(Math.min(R.x + R.w, doc.x + doc.w)), 0, c.width), y1 = clamp(Math.ceil(Math.min(R.y + R.h, doc.y + doc.h)), 0, c.height);
  const W = x1 - x0, H = y1 - y0;
  if (W < 2 || H < 2) { toast('Rien à déformer ici.'); return; }

  // Aperçu réduit
  const maxP = isIOS ? 800 : 1200;
  const k = Math.min(1, maxP / Math.max(W, H));
  const pw = Math.max(2, Math.round(W * k)), ph = Math.max(2, Math.round(H * k));
  const pc = newCanvas(pw, ph), pctx = ctxOf(pc);
  pctx.imageSmoothingQuality = 'high';
  pctx.drawImage(c, x0, y0, W, H, 0, 0, pw, ph);
  const src = pctx.getImageData(0, 0, pw, ph).data;
  freeCanvas(pc);
  const n = pw * ph;
  let dx = new Float32Array(n), dy = new Float32Array(n);
  const undo = [];

  // ——— Interface plein écran ———
  const view = el('canvas', { class: 'lq-canvas', width: pw, height: ph });
  const vctx = view.getContext('2d');
  const outImg = vctx.createImageData(pw, ph);
  outImg.data.set(src);
  vctx.putImageData(outImg, 0, 0);
  const ring = el('div', { class: 'lq-ring' });
  const stage = el('div', { class: 'lq-stage' }, view, ring);
  const toolBtns = TOOLS.map(([id, label, key, hint]) => {
    const b = el('button', { type: 'button', class: `btn small ${settings.tool === id ? 'primary' : ''}`, title: `${hint} (${key})` }, label);
    b.addEventListener('click', () => setTool(id));
    b.dataset.tool = id;
    return b;
  });
  const range = (label, key, min, max, unit) => {
    const r = el('input', { type: 'range', min, max, value: settings[key] });
    const num = el('input', { type: 'number', min, max, value: settings[key], class: 'opt-num' });
    const set = (v) => { v = clamp(Math.round(+v || 0), min, max); settings[key] = v; r.value = v; num.value = v; };
    r.addEventListener('input', () => set(r.value));
    num.addEventListener('change', () => set(num.value));
    num.addEventListener('keydown', (e) => e.stopPropagation());
    const w = el('label', { class: 'opt opt-range' }, el('span', {}, label), r, num, el('span', { class: 'opt-unit' }, unit));
    w.set = set;
    return w;
  };
  const sizeCtl = range('Taille', 'size', 5, 1500, 'px');
  const rateCtl = range('Force', 'rate', 1, 100, '%');
  const btnUndo = el('button', { type: 'button', class: 'btn small', title: 'Annuler le dernier geste (Ctrl+Z)' }, 'Défaire');
  const btnReset = el('button', { type: 'button', class: 'btn small', title: 'Revenir à l\'image de départ' }, 'Tout rétablir');
  const btnCancel = el('button', { type: 'button', class: 'btn' }, 'Annuler');
  const btnOk = el('button', { type: 'button', class: 'btn primary' }, 'OK');
  const overlay = el('div', { class: 'lq-overlay' },
    el('div', { class: 'lq-top' }, el('strong', { class: 'lq-title' }, 'Fluidité'), el('div', { class: 'lq-tools' }, toolBtns), sizeCtl, rateCtl),
    stage,
    el('div', { class: 'lq-foot' }, btnUndo, btnReset, el('span', { class: 'lq-hint' }, '[ et ] : taille du pinceau'), el('span', { class: 'lq-spacer' }), btnCancel, btnOk));
  document.querySelector('#modal-root').append(overlay);
  const fit = () => {
    const r = stage.getBoundingClientRect();
    const f = Math.min((r.width - 16) / pw, (r.height - 16) / ph, 8);
    view.style.width = `${Math.max(1, pw * f)}px`;
    view.style.height = `${Math.max(1, ph * f)}px`;
  };
  fit();
  window.addEventListener('resize', fit);

  function setTool(id) {
    settings.tool = id;
    for (const b of toolBtns) b.classList.toggle('primary', b.dataset.tool === id);
  }
  const scale = () => view.getBoundingClientRect().width / pw; // px écran par px d'aperçu
  const docToPrev = k * 1; // 1 px de la toile = k px d'aperçu
  const radius = () => Math.max(2, settings.size * docToPrev / 2);
  const toPrev = (e) => { const r = view.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width * pw, y: (e.clientY - r.top) / r.height * ph }; };
  const showRing = (e) => {
    const r = view.getBoundingClientRect(), sr = stage.getBoundingClientRect();
    const rad = radius() * scale();
    ring.style.width = ring.style.height = `${rad * 2}px`;
    ring.style.left = `${e.clientX - sr.left - rad}px`;
    ring.style.top = `${e.clientY - sr.top - rad}px`;
    ring.hidden = !(e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom);
  };

  // ——— Le pinceau ———
  /** T(x) = position à reprendre ; D' (x) = T(x) − x + D(T(x)). */
  function dab(p, T) {
    const rad = radius();
    const bx0 = Math.max(0, Math.floor(p.x - rad)), by0 = Math.max(0, Math.floor(p.y - rad));
    const bx1 = Math.min(pw - 1, Math.ceil(p.x + rad)), by1 = Math.min(ph - 1, Math.ceil(p.y + rad));
    if (bx1 < bx0 || by1 < by0) return;
    const ndx = new Float32Array((bx1 - bx0 + 1) * (by1 - by0 + 1)), ndy = new Float32Array(ndx.length);
    const r2 = rad * rad, rate = settings.rate / 100;
    let j = 0;
    for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++, j++) {
      const i = y * pw + x;
      const ddx = x - p.x, ddy = y - p.y, dd = ddx * ddx + ddy * ddy;
      if (dd >= r2) { ndx[j] = dx[i]; ndy[j] = dy[i]; continue; }
      const f = 1 - dd / r2, w = f * f * rate;
      const t = T(x, y, w, ddx, ddy);
      if (!t) { ndx[j] = dx[i] * (1 - w); ndy[j] = dy[i] * (1 - w); continue; } // reconstruire
      ndx[j] = t[0] - x + bil(dx, pw, ph, t[0], t[1]);
      ndy[j] = t[1] - y + bil(dy, pw, ph, t[0], t[1]);
    }
    j = 0;
    for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++, j++) { dx[y * pw + x] = ndx[j]; dy[y * pw + x] = ndy[j]; }
    redraw(bx0, by0, bx1, by1);
  }
  function redraw(bx0, by0, bx1, by1) {
    const o = outImg.data;
    for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
      const i = y * pw + x;
      if (!dx[i] && !dy[i]) { const k4 = i * 4; o[k4] = src[k4]; o[k4 + 1] = src[k4 + 1]; o[k4 + 2] = src[k4 + 2]; o[k4 + 3] = src[k4 + 3]; continue; }
      sampleInto(src, pw, ph, x + dx[i], y + dy[i], o, i * 4);
    }
    vctx.putImageData(outImg, 0, 0, bx0, by0, bx1 - bx0 + 1, by1 - by0 + 1);
  }
  const transforms = {
    push: (v) => (x, y, w) => [x - w * v.x, y - w * v.y],
    reconstruct: () => () => null,
    pucker: () => (x, y, w, ex, ey) => [x + ex * w * 0.08, y + ey * w * 0.08],
    bloat: () => (x, y, w, ex, ey) => [x - ex * w * 0.08, y - ey * w * 0.08],
    twirl: (v, alt) => (x, y, w, ex, ey) => {
      const a = (alt ? -1 : 1) * w * 0.12, cs = Math.cos(a), sn = Math.sin(a);
      return [x - ex + (ex * cs - ey * sn), y - ey + (ex * sn + ey * cs)];
    },
  };

  let drawing = null;
  const startStroke = (e) => {
    if (drawing) return;
    e.preventDefault();
    try { view.setPointerCapture(e.pointerId); } catch {}
    undo.push([dx.slice(), dy.slice()]);
    if (undo.length > (isIOS ? 4 : 10)) undo.shift();
    const p = toPrev(e);
    drawing = { id: e.pointerId, last: p, alt: e.altKey, timer: 0, pos: p };
    const t = settings.tool;
    if (t === 'push') return;
    const tick = () => dab(drawing.pos, transforms[t](null, drawing.alt));
    tick();
    drawing.timer = setInterval(tick, 40);
  };
  const moveStroke = (e) => {
    showRing(e);
    if (!drawing || e.pointerId !== drawing.id) return;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    for (const ev of (evs.length ? evs : [e])) {
      const p = toPrev(ev);
      drawing.pos = p;
      if (settings.tool === 'push' || settings.tool === 'reconstruct') {
        const L0 = drawing.last, vx = p.x - L0.x, vy = p.y - L0.y, dist = Math.hypot(vx, vy);
        const step = Math.max(1, radius() / 4), m = Math.ceil(dist / step);
        if (!m) continue;
        for (let s = 1; s <= m; s++) {
          const q = { x: L0.x + vx * s / m, y: L0.y + vy * s / m };
          dab(q, transforms[settings.tool]({ x: vx / m, y: vy / m }));
        }
        drawing.last = p;
      }
    }
  };
  const endStroke = (e) => {
    if (!drawing || (e && e.pointerId !== drawing.id)) return;
    clearInterval(drawing.timer);
    drawing = null;
  };
  view.addEventListener('touchmove', e => e.preventDefault(), { passive: false });
  view.addEventListener('pointerdown', startStroke);
  view.addEventListener('pointermove', moveStroke);
  view.addEventListener('pointerup', endStroke);
  view.addEventListener('pointercancel', endStroke);
  stage.addEventListener('pointermove', showRing);
  stage.addEventListener('pointerleave', () => { ring.hidden = true; });

  const resetAll = () => { undo.push([dx.slice(), dy.slice()]); dx.fill(0); dy.fill(0); redraw(0, 0, pw - 1, ph - 1); };
  const undoStep = () => { const u = undo.pop(); if (!u) return; [dx, dy] = u; redraw(0, 0, pw - 1, ph - 1); };
  btnReset.addEventListener('click', resetAll);
  btnUndo.addEventListener('click', undoStep);

  const ok = await new Promise(resolve => {
    const onKey = (e) => {
      const kk = e.key.toLowerCase();
      if (e.target.matches?.('input[type=number]')) return;
      if (kk === 'escape') { e.preventDefault(); resolve(false); }
      else if (kk === 'enter') { e.preventDefault(); resolve(true); }
      else if ((e.ctrlKey || e.metaKey) && kk === 'z') { e.preventDefault(); undoStep(); }
      else if (kk === '[' || kk === ']') { e.preventDefault(); const s = settings.size; sizeCtl.set(s + (kk === ']' ? 1 : -1) * Math.max(2, Math.round(s * 0.12))); }
      else { const t = TOOLS.find(x => x[2].toLowerCase() === kk); if (t && !e.ctrlKey && !e.metaKey) { e.preventDefault(); setTool(t[0]); } else return; }
      e.stopPropagation();
    };
    document.addEventListener('keydown', onKey, true);
    btnCancel.addEventListener('click', () => resolve(false));
    btnOk.addEventListener('click', () => resolve(true));
    overlay._cleanup = () => document.removeEventListener('keydown', onKey, true);
  });
  overlay._cleanup();
  window.removeEventListener('resize', fit);
  endStroke();
  overlay.remove();
  if (!ok) return;
  let any = false;
  for (let i = 0; i < n && !any; i++) if (dx[i] || dy[i]) any = true;
  if (!any) return;

  // ——— Pleine résolution ———
  await app.withBusy('Application de la fluidité…', () => {
    const cctx = ctxOf(c);
    const full = cctx.getImageData(x0, y0, W, H);
    const out = warpFull(full.data, W, H, dx, dy, pw, ph);
    if (sel) { // limitée à la sélection : mélange avec l'original selon la sélection
      const t = newCanvas(W, H), tc = ctxOf(t);
      tc.drawImage(sel.canvas, sel.x - P.ox - x0, sel.y - P.oy - y0);
      const m = tc.getImageData(0, 0, W, H).data;
      freeCanvas(t);
      const o = out.data, f = full.data;
      for (let i = 3; i < o.length; i += 4) {
        const a = m[i] / 255;
        if (a >= 1) continue;
        for (let c2 = -3; c2 <= 0; c2++) o[i + c2] = f[i + c2] + (o[i + c2] - f[i + c2]) * a;
      }
    }
    commitPixels(app, 'Fluidité', L.id, { x: x0 + P.ox, y: y0 + P.oy, w: W, h: H }, (ctx, P2, r) => ctx.putImageData(out, r.x, r.y), P);
  });
}

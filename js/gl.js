// Enluminure — moteur graphique (WebGL) : réglages et filtres calculés par la carte graphique.
// Les grandes images sont traitées par tuiles (avec une marge pour les flous) pour ménager la mémoire.
import { newCanvas, ctxOf } from './util.js';

const VERT = 'attribute vec2 a; varying vec2 v; void main(){ v = a * 0.5 + 0.5; gl_Position = vec4(a, 0.0, 1.0); }';
export const HEAD = `precision highp float;
varying vec2 v;
uniform sampler2D u_tex;   // entrée de la passe
uniform sampler2D u_orig;  // image d'origine
uniform sampler2D u_lut;   // table de correspondance 256×1
uniform vec2 u_size;       // taille de la tuile (px)
uniform vec2 u_origin;     // position de la tuile dans l'image (px, depuis le haut-gauche)
uniform vec2 u_full;       // taille de toute l'image (px)
float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
vec3 rgb2hsl(vec3 c) {
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
  float l = (mx + mn) * 0.5, h = 0.0, s = 0.0, d = mx - mn;
  if (d > 0.00001) {
    s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
    if (mx == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
    else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
    else h = (c.r - c.g) / d + 4.0;
    h /= 6.0;
  }
  return vec3(h, s, l);
}
float hue2rgb(float p, float q, float t) {
  t = fract(t);
  if (t < 1.0/6.0) return p + (q - p) * 6.0 * t;
  if (t < 0.5) return q;
  if (t < 2.0/3.0) return p + (q - p) * (2.0/3.0 - t) * 6.0;
  return p;
}
vec3 hsl2rgb(vec3 h) {
  if (h.y <= 0.0) return vec3(h.z);
  float q = h.z < 0.5 ? h.z * (1.0 + h.y) : h.z + h.y - h.z * h.y;
  float p = 2.0 * h.z - q;
  return vec3(hue2rgb(p, q, h.x + 1.0/3.0), hue2rgb(p, q, h.x), hue2rgb(p, q, h.x - 1.0/3.0));
}
// position du pixel dans l'image entière (px, origine en haut à gauche)
vec2 pixelPos() { return u_origin + vec2(v.x, 1.0 - v.y) * u_size; }
`;

let S = null;
const TILE = 2048;

function init() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const gl = canvas.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false, alpha: true });
  if (!gl) throw new Error("La carte graphique (WebGL) n'est pas disponible dans ce navigateur.");
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); S = null; });
  S = { canvas, gl, programs: new Map(), fbos: [], fboSize: '', up: null, lutTex: null, maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE) };
  return S;
}

function program(frag) {
  const { gl, programs } = S;
  let p = programs.get(frag);
  if (p) return p;
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`Shader : ${gl.getShaderInfoLog(s)}`);
    return s;
  };
  p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, HEAD + frag));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Programme : ${gl.getProgramInfoLog(p)}`);
  p.uniforms = new Map();
  p.loc = (n) => { if (!p.uniforms.has(n)) p.uniforms.set(n, gl.getUniformLocation(p, n)); return p.uniforms.get(n); };
  programs.set(frag, p);
  return p;
}

function texture(linear = true) {
  const { gl } = S;
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, linear ? gl.LINEAR : gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, linear ? gl.LINEAR : gl.NEAREST);
  return t;
}

function ensureFbos(w, h) {
  const { gl } = S;
  const key = `${w}x${h}`;
  if (S.fboSize === key) return;
  for (const f of S.fbos) { gl.deleteFramebuffer(f.fb); gl.deleteTexture(f.tex); }
  S.fbos = [0, 1].map(() => {
    const tex = texture(true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { fb, tex };
  });
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  S.fboSize = key;
}

let upCanvas = null;
/** Traite une tuile (déjà dans une toile 2D source de la taille de la tuile). */
function runTile(tileSrc, w, h, origin, full, passes) {
  const { gl, canvas } = S;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  gl.viewport(0, 0, w, h);
  if (!S.up) S.up = texture(true);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, S.up);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tileSrc);
  if (passes.length > 1) ensureFbos(w, h);
  let input = S.up;
  passes.forEach((ps, i) => {
    const last = i === passes.length - 1;
    const p = program(ps.frag);
    gl.useProgram(p);
    const aLoc = gl.getAttribLocation(p, 'a');
    gl.enableVertexAttribArray(aLoc);
    gl.vertexAttribPointer(aLoc, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, input);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, S.up);
    gl.uniform1i(p.loc('u_tex'), 0);
    gl.uniform1i(p.loc('u_orig'), 1);
    if (ps.lut) {
      if (!S.lutTex) S.lutTex = texture(false);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, S.lutTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, ps.lut);
      gl.uniform1i(p.loc('u_lut'), 2);
    }
    gl.uniform2f(p.loc('u_size'), w, h);
    gl.uniform2f(p.loc('u_origin'), origin.x, origin.y);
    gl.uniform2f(p.loc('u_full'), full.w, full.h);
    for (const [name, val] of Object.entries(ps.uniforms || {})) {
      const loc = p.loc(name);
      if (loc == null) continue;
      if (typeof val === 'number' || typeof val === 'boolean') gl.uniform1f(loc, +val);
      else if (val.length === 2) gl.uniform2fv(loc, val);
      else if (val.length === 3) gl.uniform3fv(loc, val);
      else if (val.length === 4) gl.uniform4fv(loc, val);
    }
    const target = last ? null : S.fbos[i % 2];
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    if (target) input = target.tex;
  });
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return canvas;
}

let bigOut = null;
/**
 * Applique une suite de passes à la zone `rect` de la toile `src`.
 * `pad` : marge en pixels dont les passes ont besoin autour de chaque pixel (flous).
 * Renvoie une toile de la taille de `rect`, valable jusqu'au prochain appel (à recopier pour la garder).
 */
export function glRun(src, rect, passes, pad = 0) {
  const r = rect || { x: 0, y: 0, w: src.width, h: src.height };
  if (!S || S.gl.isContextLost()) {
    try { init(); }
    catch (err) {
      // Pas de carte graphique utilisable : les réglages simples (tables de tons) se calculent quand même, sur le processeur
      if (passes.every(p => p.lut && !/uniform/.test(p.frag))) return cpuLut(src, r, passes);
      throw new Error("Ce réglage a besoin de l'accélération graphique (WebGL), désactivée ou absente dans ce navigateur. Essayez avec Chrome ou Edge à jour.");
    }
  }
  const full = { w: r.w, h: r.h };
  if (!upCanvas) upCanvas = newCanvas(1, 1);
  const tileMax = Math.min(TILE, S.maxTex - 2 * pad);
  if (r.w <= tileMax && r.h <= tileMax && pad === 0 && r.x === 0 && r.y === 0 && r.w === src.width && r.h === src.height) {
    return runTile(src, r.w, r.h, { x: 0, y: 0 }, full, passes);
  }
  // Tuiles (avec marge) → toile 2D de sortie
  if (!bigOut || bigOut.width !== r.w || bigOut.height !== r.h) { if (bigOut) { bigOut.width = 0; } bigOut = newCanvas(r.w, r.h); }
  const out = ctxOf(bigOut);
  out.clearRect(0, 0, r.w, r.h);
  for (let ty = 0; ty < r.h; ty += tileMax) {
    for (let tx = 0; tx < r.w; tx += tileMax) {
      const tw = Math.min(tileMax, r.w - tx), th = Math.min(tileMax, r.h - ty);
      // tuile + marge, limitée à la source
      const sx0 = Math.max(0, r.x + tx - pad), sy0 = Math.max(0, r.y + ty - pad);
      const sx1 = Math.min(src.width, r.x + tx + tw + pad), sy1 = Math.min(src.height, r.y + ty + th + pad);
      const w = sx1 - sx0, h = sy1 - sy0;
      if (upCanvas.width !== w || upCanvas.height !== h) { upCanvas.width = w; upCanvas.height = h; }
      const u = ctxOf(upCanvas);
      u.clearRect(0, 0, w, h);
      u.drawImage(src, sx0, sy0, w, h, 0, 0, w, h);
      const res = runTile(upCanvas, w, h, { x: sx0 - r.x, y: sy0 - r.y }, full, passes);
      out.drawImage(res, r.x + tx - sx0, r.y + ty - sy0, tw, th, tx, ty, tw, th);
    }
  }
  return bigOut;
}

let cpuOut = null;
function cpuLut(src, r, passes) {
  if (!cpuOut || cpuOut.width !== r.w || cpuOut.height !== r.h) { if (cpuOut) cpuOut.width = 0; cpuOut = newCanvas(r.w, r.h); }
  const ctx = ctxOf(cpuOut);
  ctx.clearRect(0, 0, r.w, r.h);
  ctx.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  const img = ctx.getImageData(0, 0, r.w, r.h), d = img.data;
  for (const p of passes) {
    const t = p.lut;
    for (let i = 0; i < d.length; i += 4) { d[i] = t[d[i] * 4]; d[i + 1] = t[d[i + 1] * 4 + 1]; d[i + 2] = t[d[i + 2] * 4 + 2]; }
  }
  ctx.putImageData(img, 0, 0);
  return cpuOut;
}

/** Copie durable d'un résultat. */
export function keep(c) { const k = newCanvas(c.width, c.height); ctxOf(k).drawImage(c, 0, 0); return k; }

export function glAvailable() {
  try { if (!S) init(); return true; } catch { return false; }
}

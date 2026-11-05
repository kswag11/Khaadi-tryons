// tailor.js: the sculpting and tailoring engine behind the Nool try-on.
//
// Bodies and garments are written as signed distance fields (SDFs): a function that says how far any
// point in space is from the surface. Muscles, facial features and fingers are smooth-blended shapes;
// garments are the body surface pushed outward by an "ease" and shaped with folds, pleats, hems and cuts.
// A sparse surface-nets mesher turns each field into a triangle mesh with smooth normals and baked
// ambient occlusion. This file has no dependencies and runs inside a Web Worker (worker.js).

const { sqrt, abs, min, max, sin, cos, atan2, floor, exp, PI } = Math;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
function smin(a, b, k) { if (k <= 0) return a < b ? a : b; const h = max(k - abs(a - b), 0) / k; return min(a, b) - h * h * k * 0.25; }
function smax(a, b, k) { return -smin(-a, -b, k); }

const V = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]),
  norm: (a) => { const l = sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
  lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
};

/* ------------------------------------------------------------------ */
/* Noise                                                               */
/* ------------------------------------------------------------------ */

function hash(i, j, k) {
  let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(k, 1440662683)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h & 0xffff) / 65535;
}
function vnoise(x, y, z) {
  const xi = floor(x), yi = floor(y), zi = floor(z);
  let fx = x - xi, fy = y - yi, fz = z - zi;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  const a = hash(xi, yi, zi), b = hash(xi + 1, yi, zi), c = hash(xi, yi + 1, zi), d = hash(xi + 1, yi + 1, zi);
  const e = hash(xi, yi, zi + 1), f = hash(xi + 1, yi, zi + 1), g = hash(xi, yi + 1, zi + 1), h = hash(xi + 1, yi + 1, zi + 1);
  const x0 = a + (b - a) * fx, x1 = c + (d - c) * fx, x2 = e + (f - e) * fx, x3 = g + (h - g) * fx;
  const y0 = x0 + (x1 - x0) * fy, y1 = x2 + (x3 - x2) * fy;
  return (y0 + (y1 - y0) * fz) * 2 - 1;
}

/* ------------------------------------------------------------------ */
/* Primitives and groups                                               */
/* ------------------------------------------------------------------ */

function ellD(u, v, w, rx, ry, rz) {
  const a = u / rx, b = v / ry, c = w / rz;
  const k0 = sqrt(a * a + b * b + c * c);
  const a1 = a / rx, b1 = b / ry, c1 = c / rz;
  const k1 = sqrt(a1 * a1 + b1 * b1 + c1 * c1);
  return k1 < 1e-12 ? -min(rx, ry, rz) : (k0 * (k0 - 1)) / k1;
}

// Ellipsoid with optional local axes. op 0 = add, 1 = carve.
function E(c, r, k = 0, op = 0, axes = null) {
  const [cx, cy, cz] = c, [rx, ry, rz] = r;
  let f;
  if (axes) {
    const [A, B, C] = axes;
    f = (x, y, z) => {
      const px = x - cx, py = y - cy, pz = z - cz;
      return ellD(px * A[0] + py * A[1] + pz * A[2], px * B[0] + py * B[1] + pz * B[2], px * C[0] + py * C[1] + pz * C[2], rx, ry, rz);
    };
  } else f = (x, y, z) => ellD(x - cx, y - cy, z - cz, rx, ry, rz);
  return { f, cx, cy, cz, R: max(rx, ry, rz), k, op };
}

// Round cone between two points (capsule when r1 == r2).
function RC(a, b, r1, r2, k = 0, op = 0) {
  const [ax, ay, az] = a;
  const bax = b[0] - ax, bay = b[1] - ay, baz = b[2] - az;
  const l2 = bax * bax + bay * bay + baz * baz, rr = r1 - r2, a2 = l2 - rr * rr, il2 = 1 / l2;
  const srr = Math.sign(rr) * rr * rr;
  const f = (x, y, z) => {
    const pax = x - ax, pay = y - ay, paz = z - az;
    const yy = pax * bax + pay * bay + paz * baz;
    const zz = yy - l2;
    const qx = pax * l2 - bax * yy, qy = pay * l2 - bay * yy, qz = paz * l2 - baz * yy;
    const x2 = qx * qx + qy * qy + qz * qz;
    const y2 = yy * yy * l2, z2 = zz * zz * l2;
    const kk = srr * x2;
    if (Math.sign(zz) * a2 * z2 > kk) return sqrt(x2 + z2) * il2 - r2;
    if (Math.sign(yy) * a2 * y2 < kk) return sqrt(x2 + y2) * il2 - r1;
    return (sqrt(x2 * a2 * il2) + yy * rr) * il2 - r1;
  };
  return { f, cx: ax + bax / 2, cy: ay + bay / 2, cz: az + baz / 2, R: sqrt(l2) / 2 + max(r1, r2), k, op };
}

const MARGIN = 0.004;
function G(prims, post = null) {
  let cx = 0, cy = 0, cz = 0;
  for (const p of prims) { cx += p.cx; cy += p.cy; cz += p.cz; }
  cx /= prims.length; cy /= prims.length; cz /= prims.length;
  let R = 0;
  for (const p of prims) R = max(R, sqrt((p.cx - cx) ** 2 + (p.cy - cy) ** 2 + (p.cz - cz) ** 2) + p.R);
  return { prims, cx, cy, cz, R, post };
}
function evalG(g, x, y, z) {
  const P = g.prims;
  let d = 1e9;
  for (let i = 0; i < P.length; i++) {
    const p = P[i];
    const dx = x - p.cx, dy = y - p.cy, dz = z - p.cz;
    const lb = sqrt(dx * dx + dy * dy + dz * dz) - p.R;
    if (p.op === 0) {
      if (lb > d + p.k + MARGIN) continue;
      d = smin(d, p.f(x, y, z), p.k);
    } else {
      if (lb > p.k + MARGIN - d) continue;
      d = smax(d, -p.f(x, y, z), p.k);
    }
  }
  return g.post ? g.post(d, x, y, z) : d;
}
function lbG(g, x, y, z) {
  const dx = x - g.cx, dy = y - g.cy, dz = z - g.cz;
  return sqrt(dx * dx + dy * dy + dz * dz) - g.R;
}
function unionG(list) {
  return (x, y, z) => {
    let d = 1e9;
    for (let i = 0; i < list.length; i++) {
      const [g, k] = list[i];
      if (lbG(g, x, y, z) > d + k + MARGIN) continue;
      d = smin(d, evalG(g, x, y, z), k);
    }
    return d;
  };
}

/* ------------------------------------------------------------------ */
/* Body measurements (metres; +y up, +z forward, +x is the model's left) */
/* ------------------------------------------------------------------ */

const MALE = {
  torso: [
    { e: [[0, 0.96, -0.01], [0.16, 0.1, 0.105]], pel: 1 },
    { e: [[0.07, 0.925, -0.05], [0.08, 0.085, 0.07]], k: 0.04, pel: 1, m: 1 },
    { e: [[0, 1.02, 0.02], [0.14, 0.08, 0.095]], k: 0.05, pel: 1 },
    { e: [[0, 1.11, 0.005], [0.138, 0.11, 0.098]], k: 0.06, pel: 1 },
    { e: [[0, 1.26, 0.0], [0.15, 0.16, 0.11]], k: 0.06 },
    { e: [[0, 1.3, -0.025], [0.158, 0.12, 0.088]], k: 0.05 },
    { e: [[0.065, 1.325, 0.075], [0.07, 0.05, 0.04]], k: 0.03, m: 1 },
    { e: [[0.176, 1.388, -0.005], [0.05, 0.058, 0.052]], k: 0.035, m: 1 },
    { rc: [[0.15, 1.408, -0.018], [0, 1.465, -0.03], 0.028, 0.04], k: 0.05, m: 1 },
  ],
  neck: [
    { rc: [[0, 1.43, -0.012], [0, 1.6, 0.0], 0.058, 0.05] },
    { rc: [[0.055, 1.615, -0.02], [0.02, 1.455, 0.04], 0.012, 0.009], k: 0.02, m: 1 },
    { e: [[0, 1.512, 0.044], [0.008, 0.011, 0.008]], k: 0.012 },
  ],
  arm: { S: [0.19, 1.41, -0.005], E: [0.235, 1.125, -0.022], W: [0.262, 0.88, 0.03], u1: 0.047, u2: 0.037, f1: 0.039, f2: 0.027,
    bic: [0.038, 0.075, 0.04], tri: [0.04, 0.085, 0.04], fore: [0.04, 0.075, 0.038], wrist: [0.018, 0.02, 0.028], hs: 1 },
  leg: { H: [0.09, 0.92, -0.005], K: [0.1, 0.5, 0.012], A: [0.104, 0.085, -0.012], t1: 0.088, t2: 0.053,
    quad: [0.068, 0.16, 0.065], add: [0.05, 0.12, 0.06], cap: [0.028, 0.03, 0.022], calf: [0.052, 0.115, 0.055], s1: 0.047, s2: 0.032, ank: [0.031, 0.03, 0.036] },
  foot: { heel: [0.104, 0.042, -0.045], ball: [0.112, 0.032, 0.125], toe: [0.114, 0.026, 0.18], rh: [0.033, 0.033, 0.04], r1: 0.036, r2: 0.031, r3: 0.03, r4: 0.019 },
  head: { c: [0, 1.665, 0.008], s: 1 },
  lm: { waistY: 1.08, hipY: 0.95, crotchY: 0.84, kneeY: 0.5, ankleY: 0.085, neckBaseY: 1.47, neckR: 0.058, neckZ: -0.01, shoulderY: 1.45,
    chestY: 1.3, bustY: 1.3, hipRx: 0.18, hipRz: 0.125, hipZ: -0.015 },
};

const FEMALE = {
  torso: [
    { e: [[0, 0.915, -0.015], [0.172, 0.1, 0.11]], pel: 1 },
    { e: [[0.074, 0.885, -0.06], [0.086, 0.09, 0.078]], k: 0.04, pel: 1, m: 1 },
    { e: [[0, 0.97, 0.015], [0.14, 0.075, 0.09]], k: 0.05, pel: 1 },
    { e: [[0, 1.035, 0.0], [0.115, 0.09, 0.083]], k: 0.07, pel: 1 },
    { e: [[0, 1.16, 0.0], [0.125, 0.125, 0.095]], k: 0.06 },
    { e: [[0, 1.2, -0.02], [0.135, 0.1, 0.077]], k: 0.05 },
    { e: [[0.058, 1.19, 0.068], [0.056, 0.054, 0.048]], k: 0.035, m: 1 },
    { e: [[0.152, 1.3, -0.005], [0.043, 0.05, 0.045]], k: 0.035, m: 1 },
    { rc: [[0.125, 1.323, -0.016], [0, 1.368, -0.026], 0.023, 0.033], k: 0.045, m: 1 },
  ],
  neck: [
    { rc: [[0, 1.335, -0.012], [0, 1.49, -0.002], 0.048, 0.042] },
    { rc: [[0.05, 1.505, -0.02], [0.017, 1.36, 0.034], 0.01, 0.008], k: 0.018, m: 1 },
  ],
  arm: { S: [0.163, 1.318, -0.005], E: [0.205, 1.06, -0.022], W: [0.232, 0.835, 0.03], u1: 0.04, u2: 0.031, f1: 0.033, f2: 0.023,
    bic: [0.032, 0.07, 0.034], tri: [0.035, 0.08, 0.035], fore: [0.034, 0.07, 0.032], wrist: [0.016, 0.018, 0.025], hs: 0.9 },
  leg: { H: [0.088, 0.86, -0.01], K: [0.088, 0.465, 0.006], A: [0.09, 0.08, -0.014], t1: 0.094, t2: 0.05,
    quad: [0.066, 0.15, 0.062], add: [0.054, 0.11, 0.062], cap: [0.026, 0.028, 0.02], calf: [0.048, 0.105, 0.052], s1: 0.043, s2: 0.029, ank: [0.028, 0.028, 0.033] },
  foot: { heel: [0.09, 0.04, -0.042], ball: [0.097, 0.03, 0.112], toe: [0.099, 0.025, 0.162], rh: [0.03, 0.03, 0.037], r1: 0.032, r2: 0.028, r3: 0.027, r4: 0.017 },
  head: { c: [0, 1.556, 0.006], s: 0.935 },
  lm: { waistY: 1.035, hipY: 0.9, crotchY: 0.79, kneeY: 0.465, ankleY: 0.08, neckBaseY: 1.375, neckR: 0.048, neckZ: -0.012, shoulderY: 1.355,
    chestY: 1.2, bustY: 1.19, hipRx: 0.19, hipRz: 0.13, hipZ: -0.025 },
};

function mk(spec, flip) {
  const fx = (v) => (flip ? [-v[0], v[1], v[2]] : v);
  if (spec.e) return E(fx(spec.e[0]), spec.e[1], spec.k || 0);
  return RC(fx(spec.rc[0]), fx(spec.rc[1]), spec.rc[2], spec.rc[3], spec.k || 0);
}
function fromSpecs(list, filter = () => true) {
  const out = [];
  for (const s of list) {
    if (!filter(s)) continue;
    out.push(mk(s, false));
    if (s.m) out.push(mk(s, true));
  }
  return out;
}

// Face and skull in head-local coordinates (origin between the ears at eye level).
function headPrims(F, c, s) {
  const P = [];
  const w = (v) => [c[0] + s * v[0], c[1] + s * v[1], c[2] + s * v[2]];
  const e = (cc, r, k = 0, op = 0) => P.push(E(w(cc), [r[0] * s, r[1] * s, r[2] * s], k * s, op));
  const rc = (a, b, r1, r2, k = 0, op = 0) => P.push(RC(w(a), w(b), r1 * s, r2 * s, k * s, op));
  const both = (fn) => { fn(1); fn(-1); };
  e([0, 0.03, -0.012], [0.075, 0.09, 0.097]);                                   // cranium
  e([0, 0.03, 0.028], [0.068, 0.062, 0.06], 0.03);                              // forehead
  e([0, -0.03, 0.035], [F ? 0.053 : 0.056, 0.065, 0.058], 0.03);                // mid face
  e([0, -0.055, 0.06], [0.04, 0.032, 0.03], 0.02);                              // muzzle
  e([0, -0.07, 0.012], [F ? 0.047 : 0.054, 0.04, 0.06], 0.035);                 // jaw
  both((sd) => e([sd * (F ? 0.04 : 0.044), -0.06, -0.008], [F ? 0.016 : 0.019, 0.019, 0.019], 0.03)); // jaw angle
  e([0, F ? -0.096 : -0.1, 0.062], [F ? 0.019 : 0.024, 0.017, 0.017], 0.025);   // chin
  both((sd) => e([sd * 0.046, -0.005, F ? 0.054 : 0.056], F ? [0.019, 0.012, 0.017] : [0.021, 0.013, 0.019], 0.02)); // cheekbones
  both((sd) => rc([sd * 0.05, 0.028, 0.066], [sd * 0.012, 0.029, 0.083], F ? 0.008 : 0.011, F ? 0.009 : 0.012, 0.02)); // brow
  e([0, 0.012, 0.08], [0.012, 0.014, 0.01], 0.012);                             // nose root
  rc([0, 0.014, 0.086], [0, -0.021, F ? 0.101 : 0.105], 0.006, F ? 0.0072 : 0.0088, 0.01); // nose bridge
  e([0, F ? -0.025 : -0.026, F ? 0.1 : 0.104], [F ? 0.0092 : 0.0112, F ? 0.0095 : 0.0108, 0.0102], 0.008); // nose tip
  both((sd) => e([sd * (F ? 0.0112 : 0.0122), -0.029, F ? 0.091 : 0.094], [F ? 0.0068 : 0.0076, 0.0068, 0.0078], 0.006)); // nostril wings
  both((sd) => e([sd * 0.077, -0.002, -0.008], [0.011, 0.031, 0.019], 0.008));  // ears
  both((sd) => e([sd * 0.032, 0.006, 0.083], [0.019, 0.0135, 0.016], 0.008, 1)); // eye sockets
  both((sd) => e([sd * 0.087, -0.004, -0.004], [0.006, 0.017, 0.011], 0.004, 1)); // ear bowl
  both((sd) => e([sd * 0.032, 0.0148, 0.066], [0.0168, 0.0068, 0.013], 0.003));  // upper lids
  both((sd) => e([sd * 0.032, -0.0075, 0.066], [0.016, 0.005, 0.0115], 0.003));  // lower lids
  e([0, -0.054, 0.09], [F ? 0.022 : 0.024, F ? 0.0092 : 0.0075, F ? 0.0108 : 0.01], 0.008); // upper lip
  e([0, -0.0665, 0.088], [F ? 0.02 : 0.021, F ? 0.0105 : 0.0085, F ? 0.0112 : 0.0105], 0.008); // lower lip
  return P;
}

const HAIRLINE = {
  male: [[0, 0.054], [0.4, 0.052], [0.75, 0.042], [1.05, 0.036], [1.3, 0.03], [1.55, 0.032], [1.85, 0.028], [2.2, 0.0], [2.6, -0.04], [3.15, -0.058]],
  female: [[0, 0.06], [0.45, 0.055], [0.8, 0.04], [1.1, 0.03], [1.35, 0.02], [1.6, 0.018], [1.9, 0.012], [2.3, -0.02], [2.7, -0.05], [3.15, -0.065]],
};
function interp(tab, v) {
  if (v <= tab[0][0]) return tab[0][1];
  for (let i = 1; i < tab.length; i++) if (v <= tab[i][0]) {
    const [x0, y0] = tab[i - 1], [x1, y1] = tab[i];
    const t = (v - x0) / (x1 - x0);
    return y0 + (y1 - y0) * t * t * (3 - 2 * t);
  }
  return tab[tab.length - 1][1];
}

const bodyCache = {};
export function getBody(gender) {
  if (!bodyCache[gender]) bodyCache[gender] = buildBody(gender);
  return bodyCache[gender];
}

function buildBody(gender) {
  const F = gender === 'female';
  const P = F ? FEMALE : MALE;
  const L = P.lm;
  const torsoG = G(fromSpecs(P.torso));
  const pelvisG = G(fromSpecs(P.torso, (s) => s.pel));
  const neckG = G(fromSpecs(P.neck));
  const armG = {}, handG = {}, legG = {}, footG = {}, armPts = {}, armS = {}, legPts = {}, handBoxes = [];
  let L1 = 0, L2 = 0;

  for (const side of [-1, 1]) {
    const X = (v) => [v[0] * side, v[1], v[2]];
    const A = P.arm;
    const S = X(A.S), El = X(A.E), W = X(A.W);
    armG[side] = G([
      RC(S, El, A.u1, A.u2, 0),
      E(V.add(V.lerp(S, El, 0.42), [0, 0, 0.012]), A.bic, 0.02),
      E(V.add(V.lerp(S, El, 0.38), [0, 0, -0.014]), A.tri, 0.02),
      RC(El, W, A.f1, A.f2, 0.015),
      E(V.add(V.lerp(El, W, 0.28), [side * 0.004, 0, 0.004]), A.fore, 0.02),
      E(W, A.wrist, 0.012),
    ]);
    // hand frame: d runs down the hand, w points forward (thumb side), n faces the thigh
    const hs = A.hs;
    const d = V.norm(V.sub(W, El));
    const w = V.norm(V.sub([0, 0, 1], V.mul(d, d[2])));
    const n = V.mul(V.norm(V.cross(d, w)), side);
    const pc = V.add(W, V.mul(d, 0.05 * hs));
    const hp = [E(pc, [0.05 * hs, 0.043 * hs, 0.016 * hs], 0.012, 0, [d, w, n])];
    const offs = [0.025, 0.008, -0.009, -0.025], lens = [0.075, 0.083, 0.078, 0.062], rads = [0.0092, 0.0096, 0.009, 0.008];
    const pts = [W];
    for (let i = 0; i < 4; i++) {
      const base = V.add(V.add(pc, V.mul(d, 0.044 * hs)), V.mul(w, offs[i] * hs));
      const spread = V.mul(w, offs[i] * 0.18);
      const d1 = V.norm(V.add(V.add(V.mul(d, cos(0.22)), V.mul(n, sin(0.22))), spread));
      const d2 = V.norm(V.add(V.add(V.mul(d, cos(0.62)), V.mul(n, sin(0.62))), spread));
      const j = V.add(base, V.mul(d1, lens[i] * 0.52 * hs));
      const tip = V.add(j, V.mul(d2, lens[i] * 0.48 * hs));
      const r = rads[i] * hs;
      hp.push(RC(base, j, r, r * 0.92, 0.004), RC(j, tip, r * 0.92, r * 0.78, 0.003));
      pts.push(tip);
    }
    const tb = V.add(V.add(V.add(pc, V.mul(w, 0.03 * hs)), V.mul(d, -0.02 * hs)), V.mul(n, 0.012 * hs));
    const t1 = V.norm(V.add(V.add(V.mul(d, 0.6), V.mul(w, 0.5)), V.mul(n, 0.45)));
    const tj = V.add(tb, V.mul(t1, 0.036 * hs));
    const t2 = V.norm(V.add(V.add(V.mul(d, 0.85), V.mul(w, 0.2)), V.mul(n, 0.45)));
    const tt = V.add(tj, V.mul(t2, 0.03 * hs));
    hp.push(E(V.add(V.add(pc, V.mul(w, 0.024 * hs)), V.mul(d, -0.012 * hs)), [0.022 * hs, 0.016 * hs, 0.013 * hs], 0.01, 0, [d, w, n]));
    hp.push(RC(tb, tj, 0.0115 * hs, 0.0105 * hs, 0.006), RC(tj, tt, 0.0105 * hs, 0.0088 * hs, 0.003));
    pts.push(tt);
    handG[side] = G(hp);
    const bmin = [1e9, 1e9, 1e9], bmax = [-1e9, -1e9, -1e9];
    for (const p of pts) for (let a = 0; a < 3; a++) { bmin[a] = min(bmin[a], p[a] - 0.028); bmax[a] = max(bmax[a], p[a] + 0.028); }
    handBoxes.push({ min: bmin, max: bmax });

    // arm length parameter along shoulder → elbow → wrist → fingertip
    const tip = V.add(W, V.mul(d, 0.18 * hs));
    const segs = [[S, El], [El, W], [W, tip]].map(([a, b]) => ({ a, b, ab: V.sub(b, a), l: V.len(V.sub(b, a)) }));
    L1 = segs[0].l; L2 = segs[1].l;
    armS[side] = (x, y, z) => {
      let best = 1e9, s = 0, acc = 0;
      for (const g of segs) {
        const px = x - g.a[0], py = y - g.a[1], pz = z - g.a[2];
        const t = clamp((px * g.ab[0] + py * g.ab[1] + pz * g.ab[2]) / (g.l * g.l), 0, 1);
        const qx = px - g.ab[0] * t, qy = py - g.ab[1] * t, qz = pz - g.ab[2] * t;
        const d2 = qx * qx + qy * qy + qz * qz;
        if (d2 < best) { best = d2; s = acc + t * g.l; }
        acc += g.l;
      }
      return s;
    };
    armPts[side] = { S, E: El, W, tip, d, w, n };

    const Lg = P.leg;
    const H = X(Lg.H), K = X(Lg.K), An = X(Lg.A);
    legPts[side] = { H, K, A: An };
    legG[side] = G([
      RC(H, K, Lg.t1, Lg.t2, 0),
      E(V.add(V.lerp(H, K, 0.42), [0, 0, 0.022]), Lg.quad, 0.035),
      E(V.add(V.lerp(H, K, 0.22), [-side * 0.035, 0, 0]), Lg.add, 0.035),
      E(V.add(K, [0, 0.005, 0.033]), Lg.cap, 0.02),
      E(V.add(V.lerp(K, An, 0.3), [side * 0.004, 0, -0.026]), Lg.calf, 0.03),
      RC(K, An, Lg.s1, Lg.s2, 0.02),
      E(An, Lg.ank, 0.015),
    ]);
    const Fo = P.foot;
    const heel = X(Fo.heel), ball = X(Fo.ball), toe = X(Fo.toe);
    footG[side] = G([
      E(heel, Fo.rh, 0),
      RC(heel, ball, Fo.r1, Fo.r2, 0.015),
      RC(ball, toe, Fo.r3, Fo.r4, 0.01),
      RC(V.add(An, [0, -0.02, 0.01]), V.add(ball, [0, 0.01, -0.03]), 0.03, 0.026, 0.02),
    ], (dd, x, y) => max(dd, 0.012 - y));
  }

  const hs = P.head.s, Hc = P.head.c;
  const headG = G(headPrims(F, Hc, hs));
  const full = unionG([
    [torsoG, 0], [neckG, 0.03], [armG[-1], 0.012], [armG[1], 0.012], [handG[-1], 0.012], [handG[1], 0.012],
    [legG[-1], 0.04], [legG[1], 0.04], [footG[-1], 0.02], [footG[1], 0.02], [headG, 0.03],
  ]);

  /* hair, eyebrows, jasmine */
  const wl = (v) => [Hc[0] + hs * v[0], Hc[1] + hs * v[1], Hc[2] + hs * v[2]];
  const scalpG = G([E(wl([0, 0.03, -0.012]), [0.075 * hs, 0.09 * hs, 0.097 * hs]), E(wl([0, 0.03, 0.028]), [0.068 * hs, 0.062 * hs, 0.06 * hs], 0.03 * hs)]);
  const hl = HAIRLINE[gender];
  const bunP = [0, -0.03, -0.118], frontP = [0, 0.055, 0.085];
  const axis = V.norm(V.sub(frontP, bunP)), axX = [1, 0, 0], axY = V.cross(axis, axX), cc = [0, 0.01, -0.01];
  const braidPath = [[0, -0.04, -0.108], [0, -0.11, -0.128], [0, -0.2, -0.142], [0, -0.3, -0.15], [0, -0.39, -0.152]];
  const braidR = [0.024, 0.021, 0.019, 0.016, 0.011];
  const braid = [];
  for (let i = 0; i < braidPath.length - 1; i++) braid.push(RC(braidPath[i], braidPath[i + 1], braidR[i], braidR[i + 1], 0.01));
  const braidG = G(braid);
  const jasmine = [];
  if (F) for (let i = 0; i < 16; i++) {
    const t = i / 15, a = braidPath[0], b = braidPath[2];
    const side = i % 2 ? 1 : -1;
    jasmine.push([side * 0.021, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t - 0.012]);
  }
  const jasmineD = (lx, ly, lz) => {
    let d = 1e9;
    for (const p of jasmine) d = min(d, sqrt((lx - p[0]) ** 2 + (ly - p[1]) ** 2 + (lz - p[2]) ** 2) - 0.0068);
    return d;
  };
  const hair = (x, y, z) => {
    const lx = (x - Hc[0]) / hs, ly = (y - Hc[1]) / hs, lz = (z - Hc[2]) / hs;
    let d = evalG(scalpG, x, y, z) / hs;
    const phi = abs(atan2(lx, lz + 0.01));
    const above = ly - interp(hl, phi);
    d -= F ? 0.004 + 0.013 * smoothstep(0, 0.04, above) : 0.0015 + 0.0085 * smoothstep(0, 0.03, above);
    // strand grooves along meridians that run from the front hairline to the crown/bun
    const qx = lx - cc[0], qy = ly - cc[1], qz = lz - cc[2];
    const qa = qx * axis[0] + qy * axis[1] + qz * axis[2];
    const px = qx - axis[0] * qa, py = qy - axis[1] * qa, pz = qz - axis[2] * qa;
    const lon = atan2(px * axX[0] + py * axX[1] + pz * axX[2], px * axY[0] + py * axY[1] + pz * axY[2]);
    d += (F ? 0.0005 : 0.0003) * sin(lon * (F ? 80 : 110) + 2.5 * vnoise(lx * 40, ly * 40, lz * 40));
    d += (F ? 0.0012 : 0.0022) * vnoise(lx * 38, ly * 38, lz * 38) + 0.0008 * vnoise(lx * 110, ly * 110, lz * 110);
    if (!F) d = smin(d, ellD(lx, ly - 0.082, lz - 0.03, 0.058, 0.03, 0.062) + 0.0015 * vnoise(lx * 45, ly * 45, lz * 45), 0.02); // textured crop on top
    if (F && lz > -0.03 && ly > 0.05) d += 0.003 * exp(-((lx / 0.0035) ** 2)); // centre parting
    d = max(d, -above);
    if (F && ly < 0.0 && lz < -0.04) {
      let br = evalG(braidG, lx, ly, lz);
      if (br < 0.02) br += 0.0032 * (abs(sin(ly * 105 + abs(lx) * 150)) - 0.5) + 0.0006 * sin(lx * 900);
      d = smin(d, br, 0.012);
      d = min(d, jasmineD(lx, ly, lz));
    }
    let res = d * hs;
    // eyebrows: a thin layer on the skin inside a brow-shaped patch
    const ax2 = abs(lx);
    if (ax2 > 0.006 && ax2 < 0.06 && ly > 0.012 && ly < 0.05 && lz > 0.04) {
      const t = clamp((ax2 - 0.01) / 0.042, 0, 1);
      const cy = (F ? 0.0305 : 0.0295) + (F ? 0.006 : 0.0025) * sin(t * PI * 0.85) - (F ? 0.002 : 0.001) * t;
      const ry = (F ? 0.0032 : 0.0046) * (1 - 0.45 * t);
      const mask = (((ax2 - 0.031) / 0.0215) ** 2 + ((ly - cy) / ry) ** 2 - 1) * ry;
      const brow = max(evalG(headG, x, y, z) / hs - 0.0011 - 0.0004 * vnoise(lx * 900, ly * 300, lz * 900), mask);
      res = min(res, brow * hs);
    }
    return res;
  };
  const hairZone = (x, y, z) => {
    if (!F) return 0;
    const lx = (x - Hc[0]) / hs, ly = (y - Hc[1]) / hs, lz = (z - Hc[2]) / hs;
    return jasmineD(lx, ly, lz) < 0.002 ? 1 : 0;
  };

  /* footwear: mojari for men, jutti for women */
  const footD = (x, y, z) => min(evalG(footG[-1], x, y, z), evalG(footG[1], x, y, z));
  const ballZ = P.foot.ball[2];
  const shoe = (x, y, z) => {
    const f = footD(x, y, z);
    const top = F ? 0.05 - 0.012 * smoothstep(ballZ - 0.06, ballZ + 0.02, z) : 0.066;
    const upper = max(f - 0.0055, y - top);
    const sole = max(f - 0.008, y - 0.014, 0.0005 - y);
    return min(upper, sole);
  };
  const shoeZone = (x, y, z) => {
    if (y < 0.0142) return 1;
    if (F && z > ballZ - 0.045 && y > 0.026) return 2;
    if (!F && z > ballZ - 0.02 && y > 0.03) return 2;
    return 0;
  };

  /* skin tint: lips and a little warmth in the cheeks */
  const tint = (x, y, z) => {
    const lx = (x - Hc[0]) / hs, ly = (y - Hc[1]) / hs, lz = (z - Hc[2]) / hs;
    let r = 1, g = 1, b = 1;
    if (abs(lx) < 0.12 && ly < 0.08 && ly > -0.14 && lz > -0.02) {
      const lip = min(ellD(lx, ly + 0.054, lz - 0.09, 0.024, 0.0085, 0.0105), ellD(lx, ly + 0.0665, lz - 0.088, 0.021, 0.0095, 0.0105));
      const wv = smoothstep(0.0035, -0.0008, lip);
      const seam = exp(-(((ly + 0.0602) / 0.0011) ** 2)) * smoothstep(0.026, 0.018, abs(lx)) * (lz > 0.08 ? 1 : 0);
      r *= 1 - 0.45 * seam; g *= 1 - 0.55 * seam; b *= 1 - 0.55 * seam;
      r *= 1 - (F ? 0.1 : 0.08) * wv; g *= 1 - (F ? 0.3 : 0.26) * wv; b *= 1 - (F ? 0.26 : 0.22) * wv;
      const ck = exp(-(((abs(lx) - 0.042) ** 2 + (ly + 0.012) ** 2) / 0.0005)) * (lz > 0.03 ? 1 : 0) * (F ? 0.05 : 0.025);
      g *= 1 - ck; b *= 1 - ck * 0.8;
      const lid = exp(-(((abs(lx) - 0.032) ** 2) / 0.0003 + ((ly - 0.013) ** 2) / 0.00005)) * 0.12;
      r *= 1 - lid; g *= 1 - lid * 1.1; b *= 1 - lid;
    }
    return [r, g, b];
  };

  const eyes = [-1, 1].map((sd) => ({ c: wl([sd * 0.032, 0.006, 0.062]), r: 0.0122 * hs }));
  const reach = max(...handBoxes.map((b) => max(abs(b.min[0]), abs(b.max[0]))));
  const top = Hc[1] + 0.14 * hs;
  const box = { min: [-reach - 0.02, -0.004, -0.2], max: [reach + 0.02, top + 0.02, 0.25] };
  const hairBox = { min: [Hc[0] - 0.112 * hs, Hc[1] - (F ? 0.43 : 0.15) * hs, Hc[2] - (F ? 0.2 : 0.178) * hs], max: [Hc[0] + 0.112 * hs, Hc[1] + 0.148 * hs, Hc[2] + 0.136 * hs] };
  const headBox = { min: [Hc[0] - 0.112 * hs, Hc[1] - 0.15 * hs, Hc[2] - 0.178 * hs], max: [Hc[0] + 0.112 * hs, Hc[1] + 0.148 * hs, Hc[2] + 0.136 * hs] };
  const feetBox = { min: [-0.2, -0.004, -0.1], max: [0.2, 0.085, 0.22] };

  return {
    gender, lm: L, full,
    torso: (x, y, z) => evalG(torsoG, x, y, z),
    pelvis: (x, y, z) => evalG(pelvisG, x, y, z),
    arm: (side, x, y, z) => evalG(armG[side], x, y, z),
    leg: (side, x, y, z) => evalG(legG[side], x, y, z),
    armS: (side, x, y, z) => armS[side](x, y, z),
    armPts, legPts, L1, L2, hair, hairZone, shoe, shoeZone, tint, eyes, box, headBox, hairBox, handBoxes, feetBox,
  };
}

/* ------------------------------------------------------------------ */
/* Mesher: sparse surface nets                                         */
/* ------------------------------------------------------------------ */

const AO_H = [0.012, 0.028, 0.05];
const CORNERS = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];

function inBoxes(boxes, x, y, z, pad = 0) {
  for (const b of boxes) {
    if (x - pad >= b.min[0] && x + pad <= b.max[0] && y - pad >= b.min[1] && y + pad <= b.max[1] && z - pad >= b.min[2] && z + pad <= b.max[2]) return true;
  }
  return false;
}

export function polygonize(sdf, box, h, opt = {}) {
  const ex = (opt.exclude || []).map((b) => ({ min: b.min.map((v) => v + 2 * h), max: b.max.map((v) => v - 2 * h) }));
  const ox = box.min[0], oy = box.min[1], oz = box.min[2];
  const nx = Math.ceil((box.max[0] - ox) / h) + 1, ny = Math.ceil((box.max[1] - oy) / h) + 1, nz = Math.ceil((box.max[2] - oz) / h) + 1;
  const BS = 4;
  const bnx = Math.ceil((nx - 1) / BS), bny = Math.ceil((ny - 1) / BS), bnz = Math.ceil((nz - 1) / BS);
  const sy = nx, sz = nx * ny;
  const vals = new Float32Array(nx * ny * nz);
  const have = new Uint8Array(nx * ny * nz);
  const thr = sqrt(3) * BS * h * 0.5 * 1.5 + 1.5 * h;

  const blocks = [];
  for (let bk = 0; bk < bnz; bk++) for (let bj = 0; bj < bny; bj++) for (let bi = 0; bi < bnx; bi++) {
    const x = ox + (bi * BS + BS / 2) * h, y = oy + (bj * BS + BS / 2) * h, z = oz + (bk * BS + BS / 2) * h;
    if (ex.length && inBoxes(ex, x, y, z, BS * h * 0.5)) continue;
    if (abs(sdf(x, y, z)) < thr) blocks.push(bi, bj, bk);
  }

  for (let b = 0; b < blocks.length; b += 3) {
    const i0 = blocks[b] * BS, j0 = blocks[b + 1] * BS, k0 = blocks[b + 2] * BS;
    const i1 = min(i0 + BS, nx - 1), j1 = min(j0 + BS, ny - 1), k1 = min(k0 + BS, nz - 1);
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const id = i + j * sy + k * sz;
      if (!have[id]) { vals[id] = sdf(ox + i * h, oy + j * h, oz + k * h); have[id] = 1; }
    }
  }

  const cellMap = new Map();
  const P = [];
  const cv = new Float64Array(8);
  for (let b = 0; b < blocks.length; b += 3) {
    const i0 = blocks[b] * BS, j0 = blocks[b + 1] * BS, k0 = blocks[b + 2] * BS;
    const i1 = min(i0 + BS, nx - 1), j1 = min(j0 + BS, ny - 1), k1 = min(k0 + BS, nz - 1);
    for (let k = k0; k < k1; k++) for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) {
      if (ex.length && inBoxes(ex, ox + (i + 0.5) * h, oy + (j + 0.5) * h, oz + (k + 0.5) * h)) continue;
      const id0 = i + j * sy + k * sz;
      let mask = 0;
      for (let c = 0; c < 8; c++) {
        const o = CORNERS[c];
        const v = vals[id0 + o[0] + o[1] * sy + o[2] * sz];
        cv[c] = v;
        if (v < 0) mask |= 1 << c;
      }
      if (mask === 0 || mask === 255) continue;
      let ax = 0, ay = 0, az = 0, cnt = 0;
      for (const [a, bb] of EDGES) {
        const va = cv[a], vb = cv[bb];
        if ((va < 0) === (vb < 0)) continue;
        const t = va / (va - vb);
        const A = CORNERS[a], B = CORNERS[bb];
        ax += A[0] + (B[0] - A[0]) * t; ay += A[1] + (B[1] - A[1]) * t; az += A[2] + (B[2] - A[2]) * t;
        cnt++;
      }
      cellMap.set(id0, P.length / 3);
      P.push(ox + (i + ax / cnt) * h, oy + (j + ay / cnt) * h, oz + (k + az / cnt) * h);
    }
  }

  const tris = [];
  const quad = (a, b, c, d) => {
    const va = cellMap.get(a), vb = cellMap.get(b), vc = cellMap.get(c), vd = cellMap.get(d);
    if (va === undefined || vb === undefined || vc === undefined || vd === undefined) return;
    tris.push(va, vb, vc, va, vc, vd);
  };
  for (const [id0] of cellMap) {
    const i = id0 % nx, j = ((id0 / nx) | 0) % ny, k = (id0 / sz) | 0;
    const v0 = vals[id0] < 0;
    if (j > 0 && k > 0 && (vals[id0 + 1] < 0) !== v0) quad(id0, id0 - sy, id0 - sy - sz, id0 - sz);
    if (i > 0 && k > 0 && (vals[id0 + sy] < 0) !== v0) quad(id0, id0 - sz, id0 - 1 - sz, id0 - 1);
    if (i > 0 && j > 0 && (vals[id0 + sz] < 0) !== v0) quad(id0, id0 - 1, id0 - 1 - sy, id0 - sy);
  }

  // project vertices onto the surface and take normals from the field gradient
  const nv = P.length / 3;
  const pos = new Float32Array(P);
  const nrm = new Float32Array(nv * 3);
  const e = h * 0.3;
  for (let v = 0; v < nv; v++) {
    let x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    const f1 = sdf(x + e, y - e, z - e), f2 = sdf(x - e, y - e, z + e), f3 = sdf(x - e, y + e, z - e), f4 = sdf(x + e, y + e, z + e);
    let gx = f1 - f2 - f3 + f4, gy = -f1 - f2 + f3 + f4, gz = -f1 + f2 - f3 + f4;
    const gl = sqrt(gx * gx + gy * gy + gz * gz) || 1;
    gx /= gl; gy /= gl; gz /= gl;
    const step = clamp((f1 + f2 + f3 + f4) * 0.25, -h * 0.6, h * 0.6);
    x -= gx * step; y -= gy * step; z -= gz * step;
    nrm[v * 3] = gx; nrm[v * 3 + 1] = gy; nrm[v * 3 + 2] = gz;
    pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z;
  }

  // fix winding against the normals
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const wx = pos[c] - pos[a], wy = pos[c + 1] - pos[a + 1], wz = pos[c + 2] - pos[a + 2];
    const fx = uy * wz - uz * wy, fy = uz * wx - ux * wz, fz = ux * wy - uy * wx;
    const s = fx * (nrm[a] + nrm[b] + nrm[c]) + fy * (nrm[a + 1] + nrm[b + 1] + nrm[c + 1]) + fz * (nrm[a + 2] + nrm[b + 2] + nrm[c + 2]);
    if (s < 0) { const tmp = tris[t + 1]; tris[t + 1] = tris[t + 2]; tris[t + 2] = tmp; }
  }

  // baked ambient occlusion
  const ao = new Float32Array(nv).fill(1);
  if (opt.ao) {
    const aoS = opt.ao, k = opt.aoK || 3.2;
    for (let v = 0; v < nv; v++) {
      const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
      const gx = nrm[v * 3], gy = nrm[v * 3 + 1], gz = nrm[v * 3 + 2];
      let occ = 0, sca = 1;
      for (let i = 0; i < 3; i++) {
        const hh = AO_H[i];
        occ += (hh - aoS(x + gx * hh, y + gy * hh, z + gz * hh)) * sca;
        sca *= 0.62;
      }
      ao[v] = clamp(1 - k * occ, 0.22, 1);
    }
  }

  let tint = null;
  if (opt.tint) {
    tint = new Float32Array(nv * 3);
    for (let v = 0; v < nv; v++) {
      const t = opt.tint(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
      tint[v * 3] = t[0]; tint[v * 3 + 1] = t[1]; tint[v * 3 + 2] = t[2];
    }
  }

  // material zones → index groups
  const zv = new Uint8Array(nv);
  if (opt.zone) for (let v = 0; v < nv; v++) zv[v] = opt.zone(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
  const buckets = [];
  for (let t = 0; t < tris.length; t += 3) {
    const a = zv[tris[t]], b = zv[tris[t + 1]], c = zv[tris[t + 2]];
    const zt = b === c ? b : a;
    (buckets[zt] = buckets[zt] || []).push(tris[t], tris[t + 1], tris[t + 2]);
  }
  const idx = new Uint32Array(tris.length);
  const groups = [];
  let off = 0;
  buckets.forEach((arr, zt) => {
    if (!arr) return;
    idx.set(arr, off);
    groups.push({ start: off, count: arr.length, zone: zt });
    off += arr.length;
  });
  return { pos, nrm, ao, tint, idx, groups };
}

/* ------------------------------------------------------------------ */
/* Garment kit                                                         */
/* ------------------------------------------------------------------ */

// Hollow out the garment only near its openings (hem, cuffs, slits, open fronts), where the lining shows.
function hollow(d, th, region) {
  if (!th) return d;
  return max(d, -max(d + 2 * th, region));
}

function coneD(x, y, z, y0, rx0, rz0, zc, flare) {
  const t = max(0, y0 - y);
  const rx = rx0 + flare * t, rz = rz0 + flare * 0.75 * t;
  const ex = x / rx, ez = (z - zc) / rz;
  return max((sqrt(ex * ex + ez * ez) - 1) * min(rx, rz), y - y0);
}

// Measure the body's horizontal sections (torso + legs, no arms) so cloth can hang from its widest point.
function sections(B) {
  if (B._sec) return B._sec;
  const ys = [], rx = [], zf = [], zb = [];
  for (let y = 0.02; y <= B.lm.shoulderY + 0.001; y += 0.02) {
    let mx = 0, fz = -0.05, bz = 0.05;
    for (let x = -0.3; x <= 0.3; x += 0.01) for (let z = -0.25; z <= 0.25; z += 0.01) {
      const d = smin(B.torso(x, y, z), smin(B.leg(-1, x, y, z), B.leg(1, x, y, z), 0.02), 0.04);
      if (d < 0) { mx = max(mx, abs(x)); fz = max(fz, z); bz = min(bz, z); }
    }
    ys.push(y); rx.push(mx + 0.005); zf.push(fz + 0.005); zb.push(bz - 0.005);
  }
  // per-leg radius about the hip-to-ankle axis
  const legR = { '-1': [], '1': [] };
  for (const side of [-1, 1]) {
    for (const y of ys) {
      const ax = axisAt(B, side, y);
      let R = 0;
      for (let a = 0; a < 16; a++) {
        const c = cos((a / 16) * 2 * PI), sn = sin((a / 16) * 2 * PI);
        let r = 0;
        while (r < 0.16 && B.leg(side, ax[0] + c * r, y, ax[1] + sn * r) < 0) r += 0.003;
        R = max(R, r);
      }
      legR[side].push(R);
    }
  }
  B._sec = { ys, rx, zf, zb, legR };
  return B._sec;
}
function axisAt(B, side, y) {
  const H = B.legPts[side].H, A = B.legPts[side].A;
  const t = clamp((H[1] - y) / (H[1] - A[1]), 0, 1);
  return [H[0] + (A[0] - H[0]) * t, H[2] + (A[2] - H[2]) * t];
}
function tableAt(S, arr, y) {
  const f = clamp((y - S.ys[0]) / 0.02, 0, S.ys.length - 1.001), i = floor(f), t = f - i;
  return arr[i] + (arr[i + 1] - arr[i]) * t;
}
// Cloth hanging straight down from hangY, flaring below flareFrom.
function envelope(B, hangY, flare, flareFrom) {
  const S = sections(B), n = S.ys.length;
  const RX = new Array(n), ZF = new Array(n), ZB = new Array(n);
  let mx = 0, mf = -1, mb = 1;
  for (let i = n - 1; i >= 0; i--) {
    const y = S.ys[i];
    if (y <= hangY + 0.0001) { mx = max(mx, S.rx[i]); mf = max(mf, S.zf[i]); mb = min(mb, S.zb[i]); }
    // above the hang line the envelope sits just inside the body, below it hangs from the widest section
    const w = smoothstep(hangY + 0.02, hangY - 0.1, y);
    const ix = S.rx[i] - 0.02, fz = S.zf[i] - 0.02, bz = S.zb[i] + 0.02;
    RX[i] = ix + (max(mx, ix) - ix) * w; ZF[i] = fz + (max(mf, fz) - fz) * w; ZB[i] = bz + (min(mb, bz) - bz) * w;
  }
  const Sx = { ys: S.ys };
  return (x, y, z) => {
    const fl = flare * max(0, flareFrom - y);
    const rx = tableAt(Sx, RX, y) + fl, zf = tableAt(Sx, ZF, y) + fl * 0.75, zb = tableAt(Sx, ZB, y) - fl * 0.75;
    const zm = (zf + zb) / 2, rz = (zf - zb) / 2;
    const u = x / rx, v = (z - zm) / rz;
    return max((sqrt(u * u + v * v) - 1) * min(rx, rz), y - hangY - 0.02);
  };
}
function legTube(B, side, loose, topY) {
  const S = sections(B), n = S.ys.length, raw = S.legR[side], R = new Array(n);
  const src = raw.map((v, i) => { let a = 0, c = 0; for (let j = max(0, i - 3); j <= min(n - 1, i + 3); j++) { a += raw[j]; c++; } return max(v, a / c); });
  let m = 0;
  for (let i = n - 1; i >= 0; i--) {
    if (S.ys[i] <= topY) m = max(m, src[i]);
    R[i] = src[i] + (max(m, src[i]) - src[i]) * loose;
  }
  return (x, y, z) => {
    const ax = axisAt(B, side, y);
    return sqrt((x - ax[0]) ** 2 + (z - ax[1]) ** 2) - tableAt(S, R, y);
  };
}

function gradAt(f, x, y, z, e = 0.0007) {
  const gx = f(x + e, y, z) - f(x - e, y, z), gy = f(x, y + e, z) - f(x, y - e, z), gz = f(x, y, z + e) - f(x, y, z - e);
  return V.norm([gx, gy, gz]);
}

function kit(B) {
  const L = B.lm;
  const full = B.L1 + B.L2 - 0.012;

  function top(o) {
    const hasDrape = o.hem < L.hipY + 0.06 && !o.fitted;
    const hang = o.hang ?? (B.gender === 'male' ? L.chestY : L.hipY);
    const env = hasDrape ? envelope(B, hang, o.flare || 0, o.flareFrom ?? L.hipY) : null;
    const neckR = o.neckR ?? L.neckR + 0.014;
    const holeLow = L.neckBaseY - 0.14;
    const scoopY = L.neckBaseY + 0.008, scoopZ = L.neckZ + 0.075;
    const hz = L.hipZ, drop = o.hemDrop || 0, bd = o.border || {};
    const hemAt = (x, z) => { if (!drop) return o.hem; const c = cos(atan2(x, z - hz)); return o.hem - drop * c * c; };
    const gapAt = (y) => (o.open || 0) + (o.openFlare || 0) * clamp((L.chestY - y) / 0.6, 0, 1);
    return {
      y0: o.hem - drop - 0.03, y1: L.neckBaseY + 0.1,
      d(x, y, z) {
        let d = B.torso(x, y, z);
        if (env && y < hang + 0.04) d = smin(d, env(x, y, z), 0.03);
        d -= o.ease;
        if (o.waistEase) d -= o.waistEase * exp(-(((y - L.waistY) / 0.13) ** 2));
        if (o.folds && y < L.hipY + 0.05) {
          const t = clamp((L.hipY + 0.05 - y) / max(0.12, L.hipY + 0.05 - o.hem), 0, 1);
          const ph = atan2(x, z - hz);
          const fn = o.foldN || 12;
          d += o.folds * t * (sin(ph * fn + 2.6 * vnoise(x * 7, y * 2.2, z * 7)) + 0.4 * sin(ph * (2 * fn + 1) + 1.3 + 1.5 * vnoise(x * 5, y * 3, z * 5)));
        }
        if (o.shell) {
          let reg = y - hemAt(x, z) - 0.07;
          if (o.slit) reg = min(reg, y - o.slit - 0.04);
          if (o.open) reg = min(reg, max(abs(x) - gapAt(y) - 0.05, L.neckZ - z));
          if (o.armhole) reg = min(reg, max((abs(B.armPts[1].S[0]) - o.armhole - 0.05) - abs(x), B.armPts[1].S[1] - 0.22 - y));
          d = hollow(d, o.shell, reg);
        }
        d = smax(d, hemAt(x, z) - y, 0.005);
        const dz = z - L.neckZ;
        let hole = max(sqrt(x * x + dz * dz) - neckR, holeLow - y);
        if (o.scoop) hole = min(hole, ellD(x, y - scoopY, z - scoopZ, o.scoop[0], o.scoop[1], 0.09));
        d = max(d, -hole);
        if (o.slit) {
          const g = 0.004 + 0.05 * max(0, o.slit - y);
          d = max(d, -max(abs(z - hz) - g, 0.08 - abs(x), y - o.slit));
        }
        if (o.open) d = max(d, -max(abs(x) - gapAt(y), L.neckZ - z));
        if (o.armhole) {
          const S = B.armPts[1].S;
          const ex = abs(x) - (abs(S[0]) - o.armhole - 0.05 * clamp((S[1] - y) / 0.17, 0, 1)), ey = y - (S[1] - 0.17);
          d = max(d, min(ex, ey));
        }
        return d;
      },
      zone(x, y, z) {
        if (bd.hem && y < hemAt(x, z) + bd.hem) return 2;
        if (bd.neck) {
          const dz = z - L.neckZ;
          if (sqrt(x * x + dz * dz) < neckR + bd.neck && y > L.neckBaseY - 0.05) return 2;
          if (o.scoop && ellD(x, y - scoopY, z - scoopZ, o.scoop[0] + bd.neck, o.scoop[1] + bd.neck, 0.09 + bd.neck) < 0) return 2;
        }
        if (bd.open && o.open && z > L.neckZ && abs(x) < gapAt(y) + bd.open) return 2;
        if (bd.placket && z > 0 && abs(x) < bd.placket[0] && y > bd.placket[1]) return 2;
        return o.mat;
      },
    };
  }

  function sleeves(o) {
    const len = o.len === 'full' ? full : o.len;
    return [-1, 1].map((side) => {
      const P = B.armPts[side];
      return {
        y0: min(P.W[1], P.E[1]) - 0.06, y1: P.S[1] + 0.12,
        d(x, y, z) {
          const s = B.armS(side, x, y, z);
          let d = B.arm(side, x, y, z) - (o.ease + (o.flare || 0) * clamp(s / len, 0, 1));
          d += 0.0012 * sin(s * 95 + 3 * vnoise(x * 30, y * 30, z * 30)) * exp(-(((s - B.L1) / 0.06) ** 2));
          if (o.shell) d = hollow(d, o.shell, len - 0.06 - s);
          return smax(d, s - len, 0.004);
        },
        zone(x, y, z) {
          if (o.cuff && B.armS(side, x, y, z) > len - o.cuff) return o.cuffZone ?? 2;
          return o.mat;
        },
      };
    });
  }

  function trousers(o) {
    const hem = o.hem ?? L.ankleY + 0.004, topY = o.top ?? L.waistY;
    const tubes = o.loose ? [-1, 1].map((sd) => legTube(B, sd, o.loose, L.crotchY + 0.02)) : null;
    const pal = o.palazzo ? [-1, 1].map((side) => RC([side * 0.085, L.hipY - 0.06, L.hipZ], [side * 0.115, L.ankleY + 0.01, 0.0], 0.078, 0.17, 0)) : null;
    return {
      y0: hem - 0.01, y1: topY + 0.02,
      d(x, y, z) {
        let lg;
        if (pal) lg = smin(pal[0].f(x, y, z), pal[1].f(x, y, z), 0.05);
        else if (tubes) lg = smin(smin(B.leg(-1, x, y, z), tubes[0](x, y, z), 0.02), smin(B.leg(1, x, y, z), tubes[1](x, y, z), 0.02), 0.02);
        else lg = smin(B.leg(-1, x, y, z), B.leg(1, x, y, z), 0.02);
        let d = smin(B.pelvis(x, y, z), lg, 0.05);
        const t = clamp((L.kneeY - y) / (L.kneeY - L.ankleY), 0, 1);
        d -= o.ease + (o.flare || 0) * t;
        if (o.taper) d += o.taper * smoothstep(L.ankleY + 0.12, L.ankleY + 0.035, y);
        const bt = o.bunchTop ?? L.ankleY + 0.13;
        d += (o.bunch ?? 0.0015) * smoothstep(bt, L.ankleY + 0.03, y) * sin(y * 150 + 7 * vnoise(x * 22, y * 5, z * 22) + 3 * vnoise(x * 9, y * 9, z * 9));
        if (pal) d += 0.006 * t * sin(atan2(x - (x > 0 ? 0.1 : -0.1), z) * 9 + 2 * vnoise(x * 8, y * 2, z * 8));
        else if (o.loose) { const sd = x > 0 ? 1 : -1, ax = axisAt(B, sd, y); d += 0.0028 * clamp((L.crotchY - y) / 0.4, 0, 1) * sin(atan2(x - ax[0], z - ax[1]) * 5 + 2.5 * vnoise(x * 10, y * 2.5, z * 10)); }
        if (o.cuffRib) d += 0.0012 * sin(y * 900) * smoothstep(L.ankleY + 0.07, L.ankleY + 0.05, y);
        d = max(d, y - topY);
        return smax(d, hem - y, 0.004);
      },
      zone: () => o.mat,
    };
  }

  function skirtBase(o) {
    const hang = o.hang ?? L.hipY;
    const env = envelope(B, hang, o.flare || 0, o.flareFrom ?? hang);
    return (x, y, z) => {
      let d = smin(B.pelvis(x, y, z), env(x, y, z), 0.05) - o.ease;
      if (o.folds && y < L.hipY + 0.05) {
        const t = clamp((L.hipY + 0.05 - y) / max(0.15, L.hipY + 0.05 - o.hem), 0, 1);
        const ph = atan2(x, z - L.hipZ), fn = o.foldN || 12;
        d += o.folds * t * (sin(ph * fn + 2.4 * vnoise(x * 8, y * 2, z * 8)) + 0.4 * sin(ph * (2 * fn + 1) + 0.7 + 1.5 * vnoise(x * 5, y * 3, z * 5)));
      }
      if (o.pleats && z > L.hipZ && y < o.top - 0.03) {
        const pw = o.pleats.width, ax = abs(x);
        if (ax < pw) {
          const t = clamp((o.top - 0.03 - y) / 0.25, 0, 1);
          const f = (x / o.pleats.period) % 1;
          const tri = abs((f + 1) % 1 - 0.5) * 4 - 1;
          d += o.pleats.amp * t * tri * smoothstep(pw, pw - 0.03, ax);
        }
      }
      return d;
    };
  }
  function skirt(o) {
    const base = skirtBase(o), bd = o.border || {};
    const reach = L.hipRx + (o.flare || 0) * max(0, (o.flareFrom ?? o.hang ?? L.hipY) - o.hem) + 0.06;
    return {
      y0: o.hem - 0.01, y1: o.top + 0.02, xr: reach, zr: L.hipRz + (o.flare || 0) * 0.75 * max(0, (o.flareFrom ?? o.hang ?? L.hipY) - o.hem) + 0.08,
      d(x, y, z) {
        let d = hollow(base(x, y, z), o.shell, y - o.hem - 0.07);
        d = max(d, y - o.top);
        return smax(d, o.hem - y, 0.005);
      },
      zone(x, y, z) {
        if (bd.hem && y < o.hem + bd.hem) return 2;
        if (bd.top && y > o.top - bd.top) return bd.topZone ?? 2;
        if (bd.band && y > bd.band[0] && y < bd.band[1]) return bd.band[2];
        return o.mat;
      },
    };
  }
  // the outer wrap of a mundu: one extra layer of cloth across the front with a finished edge
  function wrapPanel(o) {
    const base = skirtBase(o), bd = o.border || {};
    return {
      y0: o.hem - 0.01, y1: o.top + 0.02, xr: 0.32, zr: 0.32,
      d(x, y, z) {
        let d = base(x, y, z) - 0.0045;
        d = max(d, o.edge - x * o.side, L.hipZ - z);
        d = max(d, y - o.top);
        return max(d, o.hem - y);
      },
      zone(x, y) {
        if (bd.hem && y < o.hem + bd.hem) return 2;
        if (bd.edge && x * o.side - o.edge < bd.edge) return 2;
        return o.mat;
      },
    };
  }

  function collar(o) {
    const R0 = L.neckR + (o.gap ?? 0.008), y0 = L.neckBaseY - 0.012, th = 0.0028;
    return {
      y0: y0 - 0.01, y1: y0 + o.h + 0.01,
      d(x, y, z) {
        const dz = z - L.neckZ - 0.004;
        const r = sqrt(x * x + dz * dz);
        const R = R0 - 0.006 * clamp((y - y0) / o.h, 0, 1);
        let d = max(abs(r - R - th) - th, abs(y - y0 - o.h / 2) - o.h / 2);
        return max(d, (o.open ?? 0.012) - abs(atan2(x, dz)) * R0);
      },
      zone: () => o.mat,
    };
  }

  // a draped length of cloth (dupatta, saree pallu) laid over everything underneath
  function ribbon(o) {
    let S = null;
    const piece = {
      ribbon: true, y0: -1, y1: 3,
      prepare(under) {
        const C = o.ctrl, N = 90, pts = [];
        for (let i = 0; i <= N; i++) {
          const u = (i / N) * (C.length - 1), k = min(floor(u), C.length - 2), t = u - k;
          const p0 = C[max(k - 1, 0)], p1 = C[k], p2 = C[k + 1], p3 = C[min(k + 2, C.length - 1)];
          const t2 = t * t, t3 = t2 * t;
          pts.push([0, 1, 2].map((a) => 0.5 * (2 * p1[a] + (-p0[a] + p2[a]) * t + (2 * p0[a] - 5 * p1[a] + 4 * p2[a] - p3[a]) * t2 + (-p0[a] + 3 * p1[a] - 3 * p2[a] + p3[a]) * t3)));
        }
        const gap = o.th + 0.004;
        const project = (p) => {
          for (let it = 0; it < 6; it++) {
            const d = under(p[0], p[1], p[2]);
            const g = gradAt(under, p[0], p[1], p[2]);
            p = V.add(p, V.mul(g, gap - d));
          }
          return p;
        };
        let P = pts.map(project);
        for (let pass = 0; pass < 3; pass++) {
          P = P.map((p, i) => (i === 0 || i === P.length - 1 ? p : V.lerp(p, V.mul(V.add(P[i - 1], P[i + 1]), 0.5), 0.5)));
          P = P.map(project);
        }
        const Nn = P.map((p) => gradAt(under, p[0], p[1], p[2]));
        const segs = [];
        let acc = 0;
        for (let i = 0; i < P.length - 1; i++) {
          const a = P[i], b = P[i + 1], ab = V.sub(b, a), l = V.len(ab), T = V.mul(ab, 1 / l);
          segs.push({ a, T, l, n0: Nn[i], n1: Nn[i + 1], s0: acc, mid: V.lerp(a, b, 0.5) });
          acc += l;
        }
        const pad = max(o.width[0], o.width[1]) * 0.5 + o.th + 0.01;
        const bb = [1e9, 1e9, 1e9, -1e9, -1e9, -1e9];
        for (const p of P) for (let a = 0; a < 3; a++) { bb[a] = min(bb[a], p[a] - pad); bb[a + 3] = max(bb[a + 3], p[a] + pad); }
        S = { segs, total: acc, bb };
        piece.y0 = bb[1]; piece.y1 = bb[4];
      },
      lb(x, y, z) {
        const b = S.bb;
        return max(b[0] - x, x - b[3], b[1] - y, y - b[4], b[2] - z, z - b[5], 0);
      },
      local(x, y, z, upper = 1e9) {
        let best = upper, bu = -1, bs = 0;
        const wmax = max(o.width[0], o.width[1]) * 0.5 + 0.02;
        for (const g of S.segs) {
          const mx = x - g.mid[0], my = y - g.mid[1], mz = z - g.mid[2];
          if (sqrt(mx * mx + my * my + mz * mz) - g.l * 0.5 - wmax > best) continue;
          const qx = x - g.a[0], qy = y - g.a[1], qz = z - g.a[2];
          const along = qx * g.T[0] + qy * g.T[1] + qz * g.T[2];
          const tt = clamp(along / g.l, 0, 1);
          const n = V.norm(V.lerp(g.n0, g.n1, tt));
          const W = V.norm(V.cross(g.T, n));
          const rx = qx - g.T[0] * tt * g.l, ry = qy - g.T[1] * tt * g.l, rz = qz - g.T[2] * tt * g.l;
          const u = rx * W[0] + ry * W[1] + rz * W[2], v = rx * n[0] + ry * n[1] + rz * n[2];
          const s = g.s0 + tt * g.l;
          const hw = (o.width[0] + (o.width[1] - o.width[0]) * (s / S.total)) * 0.5;
          const dx = abs(u) - hw, dy = abs(v) - o.th, dzz = abs(along - g.l * 0.5) - g.l * 0.5 - 0.002;
          const ox = max(dx, 0), oy = max(dy, 0), oz = max(dzz, 0);
          const d = sqrt(ox * ox + oy * oy + oz * oz) + min(max(dx, dy, dzz), 0);
          if (d < best) { best = d; bu = hw - abs(u); bs = s; }
        }
        return [best, bu, bs];
      },
      d(x, y, z, upper) { return piece.local(x, y, z, upper)[0]; },
      zone(x, y, z) {
        const [, bu, s] = piece.local(x, y, z);
        if (o.border && bu < o.border) return 2;
        if (o.endBand && s > S.total - o.endBand) return 2;
        return o.mat;
      },
    };
    return piece;
  }

  return { L, full, top, sleeves, trousers, skirt, wrapPanel, collar, ribbon };
}

/* ------------------------------------------------------------------ */
/* The twelve outfits                                                  */
/* ------------------------------------------------------------------ */

const OUTFIT_DEFS = {
  male: {
    kurta: (T, L) => ({
      pieces: [
        T.top({ mat: 0, hem: L.kneeY + 0.04, ease: 0.018, waistEase: 0.01, flare: 0.11, folds: 0.006, foldN: 11, slit: L.hipY - 0.12, shell: 0.005 }),
        ...T.sleeves({ mat: 0, len: 'full', ease: 0.011, flare: 0.012 }),
        T.collar({ mat: 0, h: 0.034 }),
        T.trousers({ mat: 1, ease: 0.012, flare: 0.006, bunch: 0.002, loose: 0.45 }),
      ],
      buttons: { ys: [L.neckBaseY - 0.035, L.neckBaseY - 0.075, L.neckBaseY - 0.115, L.neckBaseY - 0.155], r: 0.0058, style: 'wood' },
      collar: true,
    }),
    nehru: (T, L) => ({
      pieces: [
        T.top({ mat: 0, hem: L.kneeY + 0.08, ease: 0.016, flare: 0.1, folds: 0.0055, foldN: 11, slit: L.hipY - 0.12, shell: 0.005 }),
        ...T.sleeves({ mat: 0, len: 'full', ease: 0.01, flare: 0.006 }),
        T.trousers({ mat: 0, ease: 0.006, bunch: 0.0035, bunchTop: L.kneeY - 0.05 }),
        T.top({ mat: 1, hem: L.hipY - 0.03, ease: 0.03, shell: 0.005, armhole: 0.015, neckR: L.neckR + 0.02 }),
        T.collar({ mat: 1, h: 0.04, gap: 0.017 }),
      ],
      buttons: { ys: [0, 1, 2, 3, 4, 5].map((i) => L.neckBaseY - 0.045 - i * 0.075), r: 0.0062, style: 'brass' },
      collar: true,
    }),
    shirt: (T, L) => ({
      pieces: [
        T.top({ mat: 0, hem: L.hipY - 0.06, hemDrop: 0.035, ease: 0.02, waistEase: 0.008, shell: 0.005 }),
        ...T.sleeves({ mat: 0, len: 0.2, ease: 0.016, flare: 0.01, shell: 0.005, cuff: 0.03, cuffZone: 0 }),
        T.collar({ mat: 0, h: 0.03 }),
        T.trousers({ mat: 1, ease: 0.012, flare: 0.004, loose: 0.6 }),
      ],
      buttons: { ys: [0, 1, 2, 3, 4, 5].map((i) => L.neckBaseY - 0.035 - i * 0.075), r: 0.0052, style: 'shell' },
      collar: true,
    }),
    tee: (T, L) => ({
      pieces: [
        T.top({ mat: 0, hem: L.hipY - 0.07, ease: 0.032, waistEase: 0.012, shell: 0.005, neckR: L.neckR + 0.012 }),
        ...T.sleeves({ mat: 0, len: 0.24, ease: 0.028, flare: 0.006, shell: 0.005 }),
        T.trousers({ mat: 1, ease: 0.016, taper: 0.016, bunch: 0.003, cuffRib: true, loose: 0.5 }),
      ],
    }),
    mundu: (T, L) => ({
      pieces: [
        T.top({ mat: 0, hem: L.hipY - 0.05, hemDrop: 0.02, ease: 0.02, waistEase: 0.008, shell: 0.005 }),
        ...T.sleeves({ mat: 0, len: 0.2, ease: 0.016, flare: 0.01, shell: 0.005, cuff: 0.03, cuffZone: 0 }),
        T.collar({ mat: 0, h: 0.03 }),
        T.skirt({ mat: 1, top: L.waistY + 0.01, hem: 0.065, ease: 0.016, flare: 0.035, folds: 0.003, foldN: 10, shell: 0.005, border: { hem: 0.05 } }),
        T.wrapPanel({ mat: 1, top: L.waistY + 0.01, hem: 0.065, ease: 0.016, flare: 0.035, side: 1, edge: 0.02, border: { hem: 0.05, edge: 0.032 } }),
      ],
      buttons: { ys: [0, 1, 2, 3, 4, 5].map((i) => L.neckBaseY - 0.035 - i * 0.075), r: 0.0052, style: 'shell' },
      collar: true,
    }),
    kasavuK: (T, L) => ({
      pieces: [
        T.top({ mat: 0, hem: L.kneeY + 0.1, ease: 0.018, waistEase: 0.008, flare: 0.1, folds: 0.0055, foldN: 11, slit: L.hipY - 0.12, shell: 0.005,
          border: { hem: 0.045, placket: [0.013, L.neckBaseY - 0.2] } }),
        ...T.sleeves({ mat: 0, len: 'full', ease: 0.011, flare: 0.012, cuff: 0.035, cuffZone: 2 }),
        T.collar({ mat: 2, h: 0.034 }),
        T.trousers({ mat: 1, ease: 0.012, flare: 0.006, bunch: 0.002, loose: 0.45 }),
      ],
      buttons: { ys: [L.neckBaseY - 0.04, L.neckBaseY - 0.085, L.neckBaseY - 0.13], r: 0.0058, style: 'brass' },
      collar: true,
    }),
  },
  female: {
    palazzo: (T, L) => ({
      pieces: [
        T.top({ mat: 0, hem: L.kneeY + 0.02, ease: 0.014, waistEase: 0.006, flare: 0.12, folds: 0.004, foldN: 14, slit: L.hipY - 0.1, shell: 0.005,
          scoop: [0.06, 0.055], neckR: L.neckR + 0.016 }),
        ...T.sleeves({ mat: 0, len: 0.43, ease: 0.01, flare: 0.008 }),
        T.trousers({ mat: 1, palazzo: true, ease: 0.006, bunch: 0 }),
      ],
      ribbon: { mat: 1, width: [0.12, 0.13], th: 0.004, ctrl: [
        [-0.12, L.hipY - 0.15, -0.16], [-0.12, L.bustY, -0.12], [-0.12, L.shoulderY + 0.03, -0.02], [-0.09, L.bustY + 0.03, 0.12],
        [0, L.bustY - 0.09, 0.16], [0.09, L.bustY + 0.03, 0.12], [0.12, L.shoulderY + 0.03, -0.02], [0.12, L.bustY, -0.12], [0.12, L.hipY - 0.15, -0.16]] },
    }),
    kasavuSet: (T, L) => ({
      pieces: [
        T.top({ mat: 0, hem: L.waistY + 0.06, ease: 0.011, scoop: [0.055, 0.035], neckR: L.neckR + 0.016, border: { hem: 0.022, neck: 0.012 } }),
        ...T.sleeves({ mat: 0, len: 0.13, ease: 0.012, flare: 0.006, cuff: 0.022, cuffZone: 2 }),
        T.skirt({ mat: 1, top: L.waistY + 0.01, hem: 0.035, ease: 0.012, flare: 0.26, folds: 0.006, foldN: 15, shell: 0.005, border: { hem: 0.09, top: 0.03 } }),
      ],
      jasmine: true,
    }),
    saree: (T, L) => ({
      pieces: [
        T.top({ mat: 1, hem: L.bustY - 0.085, ease: 0.008, scoop: [0.055, 0.05], neckR: L.neckR + 0.016 }),
        ...T.sleeves({ mat: 1, len: 0.15, ease: 0.008, flare: 0.004 }),
        T.skirt({ mat: 0, top: L.waistY - 0.015, hem: 0.02, ease: 0.014, flare: 0.075, folds: 0.003, foldN: 11, shell: 0.005,
          pleats: { amp: 0.0045, period: 0.028, width: 0.11 }, border: { hem: 0.055 } }),
      ],
      ribbon: { mat: 0, width: [0.17, 0.36], th: 0.0045, border: 0.028, endBand: 0.14, ctrl: [
        [-0.1, L.waistY, 0.13], [-0.03, L.bustY - 0.07, 0.16], [0.05, L.bustY + 0.03, 0.14], [0.11, L.shoulderY - 0.02, 0.08], [0.13, L.shoulderY + 0.03, 0.0],
        [0.12, L.shoulderY - 0.05, -0.09], [0.1, L.bustY - 0.1, -0.12], [0.09, L.waistY - 0.15, -0.14], [0.09, L.hipY - 0.25, -0.16], [0.09, L.kneeY, -0.16]] },
      jasmine: true,
    }),
    coord: (T, L) => ({
      pieces: [
        T.top({ mat: 0, hem: L.hipY - 0.03, ease: 0.024, hang: L.bustY, shell: 0.005 }),
        ...T.sleeves({ mat: 0, len: 0.24, ease: 0.024, flare: 0.004, shell: 0.005, cuff: 0.03, cuffZone: 0 }),
        T.collar({ mat: 0, h: 0.028 }),
        T.trousers({ mat: 1, ease: 0.014, flare: 0.01, loose: 0.7 }),
      ],
      buttons: { ys: [0, 1, 2, 3, 4].map((i) => L.neckBaseY - 0.035 - i * 0.075), r: 0.005, style: 'wood' },
      collar: true,
    }),
    dress: (T, L) => ({
      pieces: [
        T.top({ mat: 0, hem: L.waistY - 0.01, ease: 0.008, scoop: [0.06, 0.045], neckR: L.neckR + 0.016 }),
        T.skirt({ mat: 0, top: L.waistY + 0.005, hem: L.kneeY, ease: 0.012, flare: 0.22, hang: L.waistY, flareFrom: L.waistY, folds: 0.012, foldN: 13, shell: 0.005,
          border: { band: [L.waistY - 0.02, L.waistY + 0.02, 1] } }),
        ...T.sleeves({ mat: 0, len: 0.12, ease: 0.02, flare: 0.05, shell: 0.005 }),
      ],
    }),
    layer: (T, L) => ({
      pieces: [
        T.top({ mat: 0, hem: L.crotchY - 0.12, ease: 0.012, flare: 0.07, slit: L.hipY - 0.08, shell: 0.005, scoop: [0.055, 0.045], neckR: L.neckR + 0.016 }),
        ...T.sleeves({ mat: 0, len: 'full', ease: 0.009 }),
        T.top({ mat: 1, hem: L.kneeY + 0.06, ease: 0.03, waistEase: 0.005, flare: 0.12, folds: 0.004, shell: 0.005, open: 0.035, openFlare: 0.05, neckR: L.neckR + 0.03 }),
        ...T.sleeves({ mat: 1, len: 0.32, ease: 0.026, flare: 0.01, shell: 0.005 }),
        T.trousers({ mat: 0, ease: 0.008, loose: 0.3 }),
      ],
    }),
  },
};

/* ------------------------------------------------------------------ */
/* Entry points                                                        */
/* ------------------------------------------------------------------ */

export function makeAvatar(gender) {
  const t0 = Date.now();
  const B = getBody(gender);
  const skin = polygonize(B.full, B.box, 0.0055, { exclude: [B.headBox, ...B.handBoxes], ao: B.full, tint: B.tint });
  const head = polygonize(B.full, B.headBox, 0.0021, { ao: B.full, tint: B.tint, aoK: 2.6 });
  const hands = B.handBoxes.map((b) => polygonize(B.full, b, 0.0019, { ao: B.full }));
  const hairAll = (x, y, z) => min(B.full(x, y, z), B.hair(x, y, z));
  const hair = polygonize(B.hair, B.hairBox, 0.0022, { ao: hairAll, zone: B.hairZone, aoK: 4 });
  const shoeAll = (x, y, z) => min(B.full(x, y, z), B.shoe(x, y, z));
  const shoes = polygonize(B.shoe, B.feetBox, 0.0034, { ao: shoeAll, zone: B.shoeZone, aoK: 4 });
  return { gender, skinCoarse: skin, skinFine: [head, ...hands], hair, shoes, eyes: B.eyes, ms: Date.now() - t0 };
}

export function makeOutfit(gender, id) {
  const t0 = Date.now();
  const B = getBody(gender);
  const T = kit(B), L = B.lm;
  const def = OUTFIT_DEFS[gender][id](T, L);
  const pieces = def.pieces.slice();
  const solid = pieces.slice();
  if (def.ribbon) {
    const r = T.ribbon(def.ribbon);
    const under = (x, y, z) => { let d = B.full(x, y, z); for (const p of solid) d = min(d, p.d(x, y, z)); return d; };
    r.prepare(under);
    pieces.push(r);
  }
  const K = 0.004;
  const sdf = (x, y, z) => {
    let d = 1e9;
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i];
      const lb = p.lb ? p.lb(x, y, z) : max(p.y0 - y, y - p.y1, 0);
      if (lb > d + K) continue;
      d = smin(d, p.d(x, y, z, d + K), K);
    }
    return d;
  };
  const zone = (x, y, z) => {
    let best = 1e9, zz = 0;
    for (const p of pieces) {
      if (max(p.y0 - y, y - p.y1) > 0.01) continue;
      const d = p.d(x, y, z);
      if (d < best - 0.0005) { best = d; zz = p.zone(x, y, z); }
    }
    return zz;
  };
  let y0 = 1e9, y1 = -1e9, reach = B.box.max[0] + 0.02, zr = 0.3;
  for (const p of pieces) { y0 = min(y0, p.y0); y1 = max(y1, p.y1); if (p.xr) reach = max(reach, p.xr); if (p.zr) zr = max(zr, p.zr); }
  const box = { min: [-reach, max(-0.004, y0), -zr], max: [reach, min(B.box.max[1], y1), zr] };
  const aoS = (x, y, z) => min(B.full(x, y, z), sdf(x, y, z));
  const detail = def.collar ? [{ min: [-0.12, L.neckBaseY - 0.035, L.neckZ - 0.12], max: [0.12, L.neckBaseY + 0.075, L.neckZ + 0.12] }] : [];
  const main = polygonize(sdf, box, 0.0055, { exclude: detail, zone, ao: aoS });
  const fine = detail.map((b) => polygonize(sdf, b, 0.0024, { zone, ao: aoS }));

  const buttons = [];
  if (def.buttons) {
    for (const y of def.buttons.ys) {
      let z = 0.3;
      for (let i = 0; i < 80; i++) { const d = sdf(0, y, z); if (d < 2e-4) break; z -= max(d * 0.9, 1e-4); }
      const n = gradAt(sdf, 0, y, z);
      buttons.push({ p: [n[0] * 0.0012, y + n[1] * 0.0012, z + n[2] * 0.0012], n });
    }
  }
  return { gender, id, meshes: [main], fine, buttons, buttonR: def.buttons?.r || 0.005, buttonStyle: def.buttons?.style || 'wood', jasmine: !!def.jasmine, ms: Date.now() - t0 };
}

export const OUTFIT_IDS = { male: Object.keys(OUTFIT_DEFS.male), female: Object.keys(OUTFIT_DEFS.female) };

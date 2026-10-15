const nt = -12, ot = 9, W = Math.exp(-12), Z = Math.exp(9), X = -30, T = Math.exp(X), P = 11, b = 11, w = 11, z = P + b, N = 1 << P, I = 1 << b, O = 1 << w, D = 1, Q = N - 1, Y = I - 1, q = O - 1, K = !0, d = !0;
var p = /* @__PURE__ */ ((t) => (t.PLY = "ply", t.SPZ = "spz", t.SPLAT = "splat", t.KSPLAT = "ksplat", t.PCSOGS = "pcsogs", t.PCSOGSZIP = "pcsogszip", t.RAD = "rad", t.SSOG = "ssog", t))(p || {});
const j = {
  rgbMin: 0,
  rgbMax: 1,
  lnScaleMin: -12,
  lnScaleMax: 9,
  sh1Max: 1,
  sh2Max: 1,
  sh3Max: 1,
  lodOpacity: !1
}, ct = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  DEFAULT_SPLAT_ENCODING: j,
  LN_SCALE_MAX: 9,
  LN_SCALE_MIN: -12,
  LN_SCALE_ZERO: X,
  SCALE_MAX: Z,
  SCALE_MIN: W,
  SCALE_ZERO: T,
  SPLAT_TEX_DEPTH: O,
  SPLAT_TEX_DEPTH_BITS: w,
  SPLAT_TEX_DEPTH_MASK: q,
  SPLAT_TEX_HEIGHT: I,
  SPLAT_TEX_HEIGHT_BITS: b,
  SPLAT_TEX_HEIGHT_MASK: Y,
  SPLAT_TEX_LAYER_BITS: z,
  SPLAT_TEX_MIN_HEIGHT: D,
  SPLAT_TEX_WIDTH: N,
  SPLAT_TEX_WIDTH_BITS: P,
  SPLAT_TEX_WIDTH_MASK: Q,
  SplatFileType: p,
  USE_COMPILED_PARSER_FUNCTION: d,
  WASM_SPLAT_SORT: K
}, Symbol.toStringTag, { value: "Module" })), y = new Float32Array(1), F = new Uint32Array(y.buffer), C = "Float16Array" in globalThis, E = C ? new globalThis.Float16Array(1) : null, B = new Uint16Array(E == null ? void 0 : E.buffer), m = C ? J : $, rt = C ? g : tt;
function J(t) {
  return E[0] = t, B[0];
}
const U = new Float64Array(1), k = new Uint32Array(U.buffer), V = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1 ? 1 : 0, R = Array.from({ length: 30 }, (t, n) => 2 ** (24 - n));
function H(t) {
  const n = Math.floor(t), a = t - n;
  return a > 0.5 || a === 0.5 && (n & 1) === 1 ? n + 1 : n;
}
function $(t) {
  U[0] = t;
  const n = k[V], a = n >>> 16 & 32768, o = n >>> 20 & 2047;
  if (o === 2047)
    return a | (Number.isNaN(t) ? 32256 : 31744);
  const r = Math.abs(t), s = o - 1023;
  return s >= 16 ? a | 31744 : s < -14 ? a | H(r * 16777216) : a | (s + 15 << 10) + H(r * R[s + 14]) - 1024;
}
function g(t) {
  return B[0] = t, E[0];
}
function tt(t) {
  const n = t >> 15 & 1, a = t >> 10 & 31, o = t & 1023;
  let r;
  if (a === 0)
    if (o === 0)
      r = n << 31;
    else {
      let s = o, c = -14;
      for (; (s & 1024) === 0; )
        s <<= 1, c--;
      s &= 1023;
      const M = c + 127, e = s << 13;
      r = n << 31 | M << 23 | e;
    }
  else if (a === 31)
    o === 0 ? r = n << 31 | 2139095040 : r = n << 31 | 2143289344;
  else {
    const s = a - 15 + 127, c = o << 13;
    r = n << 31 | s << 23 | c;
  }
  return F[0] = r, y[0];
}
function L(t) {
  return Math.max(0, Math.min(255, Math.round(t * 255)));
}
function at(t) {
  let { x: n, y: a, z: o, w: r } = t;
  const s = Math.sqrt(n * n + a * a + o * o + r * r);
  if (s === 0)
    n = 0, a = 0, o = 0, r = 1;
  else {
    const i = 1 / s;
    n *= i, a *= i, o *= i, r *= i;
  }
  r < 0 && (n = -n, a = -a, o = -o, r = -r);
  const c = 2 * Math.acos(r), M = Math.sqrt(n * n + a * a + o * o);
  let e, l, u;
  M < 1e-6 ? (e = 1, l = 0, u = 0) : (e = n / M, l = a / M, u = o / M);
  const S = Math.abs(e) + Math.abs(l) + Math.abs(u);
  let f = e / S, _ = l / S;
  if (u < 0) {
    const i = f;
    f = (1 - Math.abs(_)) * (f >= 0 ? 1 : -1), _ = (1 - Math.abs(i)) * (_ >= 0 ? 1 : -1);
  }
  const h = f * 0.5 + 0.5, A = _ * 0.5 + 0.5, v = Math.round(h * 255), G = Math.round(A * 255);
  return Math.round(c * (255 / Math.PI)) << 16 | G << 8 | v;
}
function Mt(t, n, a, o, r) {
  const s = m(a), c = m(o), M = m(r), e = n * 4;
  t[e + 1] = s | c << 16, t[e + 2] = M | t[e + 2] & 4294901760;
}
function et(t, n, a, o, r, s) {
  const c = (s == null ? void 0 : s.lnScaleMin) ?? -12, e = 254 / (((s == null ? void 0 : s.lnScaleMax) ?? 9) - c), l = a < T ? 0 : Math.min(
    255,
    Math.max(
      1,
      Math.round((Math.log(a) - c) * e) + 1
    )
  ), u = o < T ? 0 : Math.min(
    255,
    Math.max(
      1,
      Math.round((Math.log(o) - c) * e) + 1
    )
  ), S = r < T ? 0 : Math.min(
    255,
    Math.max(
      1,
      Math.round((Math.log(r) - c) * e) + 1
    )
  ), f = n * 4;
  t[f + 3] = l | u << 8 | S << 16 | t[f + 3] & 4278190080;
}
function ut(t, n, a, o, r, s) {
  const c = at({
    x: a,
    y: o,
    z: r,
    w: s
  }), M = c & 255, e = c >>> 8 & 255, l = c >>> 16 & 255, u = n * 4;
  t[u + 2] = t[u + 2] & 65535 | M << 16 | e << 24, t[u + 3] = t[u + 3] & 16777215 | l << 24;
}
function ft(t, n, a, o, r, s, c) {
  const M = (c == null ? void 0 : c.rgbMin) ?? 0, l = ((c == null ? void 0 : c.rgbMax) ?? 1) - M, u = L((a - M) / l), S = L((o - M) / l), f = L((r - M) / l), _ = L(c != null && c.lodOpacity ? 0.5 * s : s), h = n * 4;
  t[h] = u | S << 8 | f << 16 | _ << 24;
}
function lt(t) {
  const n = N, a = Math.max(
    D,
    Math.min(I, Math.ceil(t / n))
  ), o = Math.ceil(t / (n * a));
  return n * a * o;
}
function x(t, n, a, o) {
  const r = Math.round(Math.max(-127, Math.min(127, t * 127))), s = Math.round(Math.max(-127, Math.min(127, n * 127))), c = Math.round(Math.max(-127, Math.min(127, a * 127))), M = Math.round(Math.max(-127, Math.min(127, o * 127)));
  return r & 255 | (s & 255) << 8 | (c & 255) << 16 | (M & 255) << 24;
}
function _t(t, n, a, o) {
  const s = 63 / ((o == null ? void 0 : o.sh1Max) ?? 1), c = n * 2;
  for (let M = 0; M < 9; ++M) {
    const e = a[M] * s, l = Math.round(Math.max(-63, Math.min(63, e))) & 127, u = M * 7, S = u + 7, f = Math.floor(u / 32), _ = u - f * 32, h = l << _ & 4294967295;
    if (t[c + f] |= h, S > f * 32 + 32) {
      const A = l >>> 32 - _ & 4294967295;
      t[c + f + 1] |= A;
    }
  }
}
function St(t, n, a, o) {
  const s = 1 / ((o == null ? void 0 : o.sh2Max) ?? 1);
  t[n * 4 + 0] = x(
    a[0] * s,
    a[1] * s,
    a[2] * s,
    a[3] * s
  ), t[n * 4 + 1] = x(
    a[4] * s,
    a[5] * s,
    a[6] * s,
    a[7] * s
  ), t[n * 4 + 2] = x(
    a[8] * s,
    a[9] * s,
    a[10] * s,
    a[11] * s
  ), t[n * 4 + 3] = x(
    a[12] * s,
    a[13] * s,
    a[14] * s,
    0
  );
}
function ht(t, n, a, o) {
  const s = 31 / ((o == null ? void 0 : o.sh3Max) ?? 1), c = n * 4;
  for (let M = 0; M < 21; ++M) {
    const e = a[M] * s, l = Math.round(Math.max(-31, Math.min(31, e))) & 63, u = M * 6, S = u + 6, f = Math.floor(u / 32), _ = u - f * 32, h = l << _ & 4294967295;
    if (t[c + f] |= h, S > f * 32 + 32) {
      const A = l >>> 32 - _ & 4294967295;
      t[c + f + 1] |= A;
    }
  }
}
export {
  j as D,
  nt as L,
  N as S,
  D as a,
  I as b,
  ot as c,
  L as d,
  at as e,
  rt as f,
  T as g,
  lt as h,
  _t as i,
  St as j,
  ht as k,
  ut as l,
  ft as m,
  et as n,
  p as o,
  ct as p,
  Mt as s,
  m as t
};
//# sourceMappingURL=packedEncode-DY0Nqklc.js.map

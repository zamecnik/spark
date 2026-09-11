const $ = -12, g = 9, U = Math.exp(-12), Z = Math.exp(9), H = -30, T = Math.exp(H), P = 11, I = 11, O = 11, z = P + I, b = 1 << P, N = 1 << I, w = 1 << O, p = 1, Q = b - 1, y = N - 1, Y = w - 1, q = !0, K = !0;
var D = /* @__PURE__ */ ((t) => (t.PLY = "ply", t.SPZ = "spz", t.SPLAT = "splat", t.KSPLAT = "ksplat", t.PCSOGS = "pcsogs", t.PCSOGSZIP = "pcsogszip", t.RAD = "rad", t.SSOG = "ssog", t))(D || {});
const j = {
  rgbMin: 0,
  rgbMax: 1,
  lnScaleMin: -12,
  lnScaleMax: 9,
  sh1Max: 1,
  sh2Max: 1,
  sh3Max: 1,
  lodOpacity: !1
}, tt = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  DEFAULT_SPLAT_ENCODING: j,
  LN_SCALE_MAX: 9,
  LN_SCALE_MIN: -12,
  LN_SCALE_ZERO: H,
  SCALE_MAX: Z,
  SCALE_MIN: U,
  SCALE_ZERO: T,
  SPLAT_TEX_DEPTH: w,
  SPLAT_TEX_DEPTH_BITS: O,
  SPLAT_TEX_DEPTH_MASK: Y,
  SPLAT_TEX_HEIGHT: N,
  SPLAT_TEX_HEIGHT_BITS: I,
  SPLAT_TEX_HEIGHT_MASK: y,
  SPLAT_TEX_LAYER_BITS: z,
  SPLAT_TEX_MIN_HEIGHT: p,
  SPLAT_TEX_WIDTH: b,
  SPLAT_TEX_WIDTH_BITS: P,
  SPLAT_TEX_WIDTH_MASK: Q,
  SplatFileType: D,
  USE_COMPILED_PARSER_FUNCTION: K,
  WASM_SPLAT_SORT: q
}, Symbol.toStringTag, { value: "Module" })), C = new Float32Array(1), B = new Uint32Array(C.buffer), X = "Float16Array" in globalThis, A = X ? new globalThis.Float16Array(1) : null, G = new Uint16Array(A == null ? void 0 : A.buffer), m = X ? F : J, at = X ? k : V;
function F(t) {
  return A[0] = t, G[0];
}
function J(t) {
  C[0] = t;
  const n = B[0], s = n >> 31 & 1, o = n >> 23 & 255, M = n & 8388607, a = s << 15;
  if (o === 255)
    return M !== 0 ? a | 32767 : a | 31744;
  const c = o - 127 + 15;
  if (c >= 31)
    return a | 31744;
  if (c <= 0) {
    if (c < -10)
      return a;
    const u = (M | 8388608) >> 1 - c + 13;
    return a | u;
  }
  const r = M >> 13;
  return a | c << 10 | r;
}
function k(t) {
  return G[0] = t, A[0];
}
function V(t) {
  const n = t >> 15 & 1, s = t >> 10 & 31, o = t & 1023;
  let M;
  if (s === 0)
    if (o === 0)
      M = n << 31;
    else {
      let a = o, c = -14;
      for (; (a & 1024) === 0; )
        a <<= 1, c--;
      a &= 1023;
      const r = c + 127, u = a << 13;
      M = n << 31 | r << 23 | u;
    }
  else if (s === 31)
    o === 0 ? M = n << 31 | 2139095040 : M = n << 31 | 2143289344;
  else {
    const a = s - 15 + 127, c = o << 13;
    M = n << 31 | a << 23 | c;
  }
  return B[0] = M, C[0];
}
function E(t) {
  return Math.max(0, Math.min(255, Math.round(t * 255)));
}
function d(t) {
  let { x: n, y: s, z: o, w: M } = t;
  const a = Math.sqrt(n * n + s * s + o * o + M * M);
  if (a === 0)
    n = 0, s = 0, o = 0, M = 1;
  else {
    const i = 1 / a;
    n *= i, s *= i, o *= i, M *= i;
  }
  M < 0 && (n = -n, s = -s, o = -o, M = -M);
  const c = 2 * Math.acos(M), r = Math.sqrt(n * n + s * s + o * o);
  let u, f, e;
  r < 1e-6 ? (u = 1, f = 0, e = 0) : (u = n / r, f = s / r, e = o / r);
  const S = Math.abs(u) + Math.abs(f) + Math.abs(e);
  let _ = u / S, l = f / S;
  if (e < 0) {
    const i = _;
    _ = (1 - Math.abs(l)) * (_ >= 0 ? 1 : -1), l = (1 - Math.abs(i)) * (l >= 0 ? 1 : -1);
  }
  const h = _ * 0.5 + 0.5, x = l * 0.5 + 0.5, v = Math.round(h * 255), W = Math.round(x * 255);
  return Math.round(c * (255 / Math.PI)) << 16 | W << 8 | v;
}
function st(t, n, s, o, M) {
  const a = m(s), c = m(o), r = m(M), u = n * 4;
  t[u + 1] = a | c << 16, t[u + 2] = r | t[u + 2] & 4294901760;
}
function nt(t, n, s, o, M, a) {
  const c = (a == null ? void 0 : a.lnScaleMin) ?? -12, u = 254 / (((a == null ? void 0 : a.lnScaleMax) ?? 9) - c), f = s < T ? 0 : Math.min(
    255,
    Math.max(
      1,
      Math.round((Math.log(s) - c) * u) + 1
    )
  ), e = o < T ? 0 : Math.min(
    255,
    Math.max(
      1,
      Math.round((Math.log(o) - c) * u) + 1
    )
  ), S = M < T ? 0 : Math.min(
    255,
    Math.max(
      1,
      Math.round((Math.log(M) - c) * u) + 1
    )
  ), _ = n * 4;
  t[_ + 3] = f | e << 8 | S << 16 | t[_ + 3] & 4278190080;
}
function ot(t, n, s, o, M, a) {
  const c = d({
    x: s,
    y: o,
    z: M,
    w: a
  }), r = c & 255, u = c >>> 8 & 255, f = c >>> 16 & 255, e = n * 4;
  t[e + 2] = t[e + 2] & 65535 | r << 16 | u << 24, t[e + 3] = t[e + 3] & 16777215 | f << 24;
}
function ct(t, n, s, o, M, a, c) {
  const r = (c == null ? void 0 : c.rgbMin) ?? 0, f = ((c == null ? void 0 : c.rgbMax) ?? 1) - r, e = E((s - r) / f), S = E((o - r) / f), _ = E((M - r) / f), l = E(c != null && c.lodOpacity ? 0.5 * a : a), h = n * 4;
  t[h] = e | S << 8 | _ << 16 | l << 24;
}
function Mt(t) {
  const n = b, s = Math.max(
    p,
    Math.min(N, Math.ceil(t / n))
  ), o = Math.ceil(t / (n * s));
  return n * s * o;
}
function L(t, n, s, o) {
  const M = Math.round(Math.max(-127, Math.min(127, t * 127))), a = Math.round(Math.max(-127, Math.min(127, n * 127))), c = Math.round(Math.max(-127, Math.min(127, s * 127))), r = Math.round(Math.max(-127, Math.min(127, o * 127)));
  return M & 255 | (a & 255) << 8 | (c & 255) << 16 | (r & 255) << 24;
}
function rt(t, n, s, o) {
  const a = 63 / ((o == null ? void 0 : o.sh1Max) ?? 1), c = n * 2;
  for (let r = 0; r < 9; ++r) {
    const u = s[r] * a, f = Math.round(Math.max(-63, Math.min(63, u))) & 127, e = r * 7, S = e + 7, _ = Math.floor(e / 32), l = e - _ * 32, h = f << l & 4294967295;
    if (t[c + _] |= h, S > _ * 32 + 32) {
      const x = f >>> 32 - l & 4294967295;
      t[c + _ + 1] |= x;
    }
  }
}
function ut(t, n, s, o) {
  const a = 1 / ((o == null ? void 0 : o.sh2Max) ?? 1);
  t[n * 4 + 0] = L(
    s[0] * a,
    s[1] * a,
    s[2] * a,
    s[3] * a
  ), t[n * 4 + 1] = L(
    s[4] * a,
    s[5] * a,
    s[6] * a,
    s[7] * a
  ), t[n * 4 + 2] = L(
    s[8] * a,
    s[9] * a,
    s[10] * a,
    s[11] * a
  ), t[n * 4 + 3] = L(
    s[12] * a,
    s[13] * a,
    s[14] * a,
    0
  );
}
function et(t, n, s, o) {
  const a = 31 / ((o == null ? void 0 : o.sh3Max) ?? 1), c = n * 4;
  for (let r = 0; r < 21; ++r) {
    const u = s[r] * a, f = Math.round(Math.max(-31, Math.min(31, u))) & 63, e = r * 6, S = e + 6, _ = Math.floor(e / 32), l = e - _ * 32, h = f << l & 4294967295;
    if (t[c + _] |= h, S > _ * 32 + 32) {
      const x = f >>> 32 - l & 4294967295;
      t[c + _ + 1] |= x;
    }
  }
}
export {
  j as D,
  $ as L,
  b as S,
  p as a,
  N as b,
  g as c,
  E as d,
  d as e,
  at as f,
  T as g,
  Mt as h,
  rt as i,
  ut as j,
  et as k,
  ot as l,
  ct as m,
  nt as n,
  D as o,
  tt as p,
  st as s,
  m as t
};
//# sourceMappingURL=packedEncode-CwLrobk1.js.map

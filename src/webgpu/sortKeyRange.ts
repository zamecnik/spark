// Kroscloud WebGPU fork (2026) — see FORK-CHANGES.md [fov-1].
//
// The distance -> 16-bit sort-key mapping of WebGpuSplatBackend, as pure math
// (no three, no TSL) so it can be tested in Node: the robust box quantiles and
// the piecewise-log key map. The backend's keygen evaluates robustKeyNorm's
// formula on the GPU; robustKeyNorm is its CPU reference.
//
// Why: the [ssog-30] log keys spread 65,536 keys over [nearest, farthest]
// distance of the RAW bounds of every centre. Photogrammetry floaters put
// those bounds kilometres out (prod qsoy: 83 x 52 x 61 km raw around a ~300 m
// castle), so once the camera is pulled far back - a 1-2 deg FOV dolly zoom,
// the viewer's 1 deg nadir "Top view" at 53x the orbit distance - the camera
// sits inside or near that box, the range starts at 2 cm and the subject
// 7.5 km away gets buckets of d * ln(M/c) / 65535 = 1.75 m: tied splats draw
// in index order and blink as the ties re-form while the camera moves. The
// robust box (per-axis 0.5 % quantiles, the build's dense-box rule) holds
// 98 % of the splats in 1.8 km x 133 m x 1.2 km there; the keys now
// concentrate on it and the outliers keep two thin tail ranges.

/** per-axis quantile that bounds the robust box (each side) */
export const ROBUST_Q = 0.005;
/** padding of the robust box, as a fraction of its quantile span per side */
export const ROBUST_PAD = 0.05;
/** centres sampled for the quantiles (evenly spaced over the source) */
export const ROBUST_SAMPLES = 32768;
/** key share of each outlier tail range (near / far) when it exists */
export const ROBUST_TAIL_SHARE = 1 / 16;

/**
 * In-place quickselect (Hoare partition, median-of-three pivot): afterwards
 * a[k] is the k-th smallest value of a[lo..hi], every element of a[lo..k) is
 * <= a[k] and every element of (k..hi] is >= a[k]. Returns a[k].
 */
export function selectKth(
  a: Float32Array,
  k: number,
  lo0: number,
  hi0: number,
): number {
  let lo = lo0;
  let hi = hi0;
  while (hi > lo) {
    const mid = (lo + hi) >>> 1;
    if (a[mid] < a[lo]) [a[mid], a[lo]] = [a[lo], a[mid]];
    if (a[hi] < a[lo]) [a[hi], a[lo]] = [a[lo], a[hi]];
    if (a[hi] < a[mid]) [a[hi], a[mid]] = [a[mid], a[hi]];
    const pivot = a[mid];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) {
        const t = a[i];
        a[i] = a[j];
        a[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else break;
  }
  return a[k];
}

/**
 * The [q, 1 - q] quantiles of a[0..m) (reorders a), padded by `pad` of their
 * span on each side: [lo - p, hi + p] with p = pad * (hi - lo) + 1e-6.
 */
export function paddedQuantileRange(
  a: Float32Array,
  m: number,
  q = ROBUST_Q,
  pad = ROBUST_PAD,
): [number, number] {
  const kLo = Math.floor(q * (m - 1));
  const kHi = Math.ceil((1 - q) * (m - 1));
  const lo = selectKth(a, kLo, 0, m - 1);
  // everything from kLo on is >= a[kLo], so the kHi-th smallest lies there
  const hi = selectKth(a, kHi, kLo, m - 1);
  const p = pad * (hi - lo) + 1e-6;
  return [lo - p, hi + p];
}

/** robustKeyMap's result: the keygen's three uniforms */
export type RobustKeyMap = {
  /** (c0, 1/c1, L0, L2) */
  a: [number, number, number, number];
  /** gains (gN, gM, gF) */
  g: [number, number, number];
  /** key shares (aN, aM, aF), summing to 1 */
  cap: [number, number, number];
};

/**
 * The piecewise-log key map over the raw distance range [c0, m0] with the
 * robust range [robustMin, robustMax] inside it. In l = ln(d / c1):
 *   near tail  [ln(c0/c1), 0]          share aN of the keys
 *   robust     [0, ln(m1/c1)]          share aM
 *   far tail   [ln(m1/c1), ln(m0/c1)]  share aF
 * (c1, m1 = the robust range clamped into [c0, m0]; a tail thinner than 1 %
 * in distance is folded into the robust range, its share 0). With no tails
 * this is [ssog-30]'s mapping ln(d/c0) / ln(m0/c0). See robustKeyNorm for the
 * formula the keygen evaluates. c0 > 0 and m0 >= 2 c0 (the backend's raw
 * range guarantees both).
 */
export function robustKeyMap(
  c0: number,
  m0: number,
  robustMin: number,
  robustMax: number,
): RobustKeyMap {
  let c1 = Math.min(Math.max(robustMin, c0), m0);
  let m1 = Math.min(Math.max(robustMax, c1), m0);
  if (!(c1 >= c0 * 1.01)) c1 = c0;
  if (!(m1 <= m0 / 1.01)) m1 = m0;
  if (m1 < c1 * 1.001) {
    // a degenerate robust range (every sampled centre at one distance)
    m1 = Math.min(m0, c1 * 1.001);
    if (m1 < c1 * 1.001) c1 = Math.max(c0, m1 / 1.001);
  }
  const aN = c1 > c0 ? ROBUST_TAIL_SHARE : 0;
  const aF = m1 < m0 ? ROBUST_TAIL_SHARE : 0;
  const aM = 1 - aN - aF;
  const l0 = Math.log(c0 / c1);
  const l2 = Math.log(m1 / c1);
  const l3 = Math.log(m0 / c1);
  return {
    a: [c0, 1 / c1, l0, l2],
    g: [aN > 0 ? aN / -l0 : 0, aM / l2, aF > 0 ? aF / (l3 - l2) : 0],
    cap: [aN, aM, aF],
  };
}

/**
 * CPU reference of the keygen's robust key position (0 = nearest .. 1 =
 * farthest, before the caller's clamp and 16-bit inversion):
 *   l = ln(max(d, c0) / c1)    (relative to c1: near 0 for a far camera,
 *                               where float32 log is precise)
 *   norm = clamp((l - L0) gN, 0, aN) + clamp(l gM, 0, aM)
 *        + clamp((l - L2) gF, 0, aF)
 * `f` rounds every intermediate (Math.fround emulates the GPU's float32).
 */
export function robustKeyNorm(
  d: number,
  map: RobustKeyMap,
  f: (x: number) => number = (x) => x,
): number {
  const [c0, invC1, l0, l2] = map.a.map(f);
  const [gN, gM, gF] = map.g.map(f);
  const [aN, aM, aF] = map.cap.map(f);
  const clamp = (x: number, hi: number) => Math.min(Math.max(x, 0), hi);
  const l = f(Math.log(f(f(Math.max(f(d), c0)) * invC1)));
  return f(
    f(clamp(f(f(l - l0) * gN), aN) + clamp(f(l * gM), aM)) +
      clamp(f(f(l - l2) * gF), aF),
  );
}

/** CPU reference of [ssog-30]'s log key position over [c0, m0]. */
export function legacyLogKeyNorm(
  d: number,
  c0: number,
  m0: number,
  f: (x: number) => number = (x) => x,
): number {
  const logMin = f(Math.log(c0));
  const span = f(Math.log(m0) - Math.log(c0));
  return f(f(f(Math.log(f(Math.max(f(d), f(c0))))) - logMin) / span);
}

/** The 16-bit key of a position (the keygen's inverted quantization). */
export function keyOf(norm: number, quantMax = 65535): number {
  return Math.floor((1 - Math.min(Math.max(norm, 0), 1)) * quantMax);
}

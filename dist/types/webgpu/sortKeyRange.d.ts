/** per-axis quantile that bounds the robust box (each side) */
export declare const ROBUST_Q = 0.005;
/** padding of the robust box, as a fraction of its quantile span per side */
export declare const ROBUST_PAD = 0.05;
/** centres sampled for the quantiles (evenly spaced over the source) */
export declare const ROBUST_SAMPLES = 32768;
/** key share of each outlier tail range (near / far) when it exists */
export declare const ROBUST_TAIL_SHARE: number;
/**
 * In-place quickselect (Hoare partition, median-of-three pivot): afterwards
 * a[k] is the k-th smallest value of a[lo..hi], every element of a[lo..k) is
 * <= a[k] and every element of (k..hi] is >= a[k]. Returns a[k].
 */
export declare function selectKth(a: Float32Array, k: number, lo0: number, hi0: number): number;
/**
 * The [q, 1 - q] quantiles of a[0..m) (reorders a), padded by `pad` of their
 * span on each side: [lo - p, hi + p] with p = pad * (hi - lo) + 1e-6.
 */
export declare function paddedQuantileRange(a: Float32Array, m: number, q?: number, pad?: number): [number, number];
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
export declare function robustKeyMap(c0: number, m0: number, robustMin: number, robustMax: number): RobustKeyMap;
/**
 * CPU reference of the keygen's robust key position (0 = nearest .. 1 =
 * farthest, before the caller's clamp and 16-bit inversion):
 *   l = ln(max(d, c0) / c1)    (relative to c1: near 0 for a far camera,
 *                               where float32 log is precise)
 *   norm = clamp((l - L0) gN, 0, aN) + clamp(l gM, 0, aM)
 *        + clamp((l - L2) gF, 0, aF)
 * `f` rounds every intermediate (Math.fround emulates the GPU's float32).
 */
export declare function robustKeyNorm(d: number, map: RobustKeyMap, f?: (x: number) => number): number;
/** CPU reference of [ssog-30]'s log key position over [c0, m0]. */
export declare function legacyLogKeyNorm(d: number, c0: number, m0: number, f?: (x: number) => number): number;
/** The 16-bit key of a position (the keygen's inverted quantization). */
export declare function keyOf(norm: number, quantMax?: number): number;

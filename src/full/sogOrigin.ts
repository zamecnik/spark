// Kroscloud fork (2026) — see FORK-CHANGES.md [prec-1].
//
// The full-detail loader's RUNTIME PACK ORIGIN. Pure: typed arrays in,
// numbers out, no I/O, no three, Node-testable (test/full/sogOrigin.test.ts).
//
// Spark packs every splat centre as 3 x fp16 in the frame it is given. Content
// far from its file origin loses precision there: 18ss (5M splats, SH3)
// stores a real altitude on its up axis (raw z ~ 465), where fp16 steps are
// 0.25, so the dense core's 626,142 distinct heights collapse onto 57 layers
// 0.25 apart - strong horizontal stripes. The loader packs c - o instead (the
// centre tables subtract o, buildPackTables) and hands o to the PackedSplats
// as its centerOrigin, which the mesh transform re-adds in float64.
//
// o_rel is the per-axis MEDIAN of the decoded mean CODES over every splat -
// exact, through one 65,536-bin histogram per axis - decoded to linear and
// rounded to an integer (measured on 18ss: core height error 0.125 -> ~0.002
// to 0.004). A bounding-box centre is the trap: four stray splats below
// z = -30 put 18ss's meta box centre at z ~ 163 (still the 0.25 step) and a
// box centre would give w9s7 2-unit steps (new stripes).

import type { SogMeta } from "./sogMeta";

/**
 * Per-axis histograms of the 16-bit SOG mean codes (code of axis c = means_l
 * byte c | means_u byte c << 8, exactly as packRange reads it).
 */
export class SogMeanCodeHistogram {
  readonly bins: [Uint32Array, Uint32Array, Uint32Array] = [
    new Uint32Array(65536),
    new Uint32Array(65536),
    new Uint32Array(65536),
  ];
  /** Splats added so far. */
  count = 0;

  /**
   * Add `count` splats whose means_l / means_u RGBA pixels start at element 0
   * of each array (the loader's band layout; padding pixels past the scene's
   * splat count must not be included).
   */
  add(meansL: Uint8Array, meansU: Uint8Array, count: number): void {
    if (
      !Number.isInteger(count) ||
      count < 0 ||
      count * 4 > meansL.length ||
      count * 4 > meansU.length
    ) {
      throw new RangeError(
        `SogMeanCodeHistogram.add: ${count} splats do not fit planes of ${meansL.length} / ${meansU.length} bytes`,
      );
    }
    const [bx, by, bz] = this.bins;
    for (let i = 0; i < count; ++i) {
      const i4 = i * 4;
      bx[meansL[i4] | (meansU[i4] << 8)]++;
      by[meansL[i4 + 1] | (meansU[i4 + 1] << 8)]++;
      bz[meansL[i4 + 2] | (meansU[i4 + 2] << 8)]++;
    }
    this.count += count;
  }

  /**
   * Per-axis LOWER median code: the ceil(count / 2)-th smallest code (exact
   * for an odd count, the lower middle one for an even count). null before
   * any splat was added.
   */
  medianCodes(): [number, number, number] | null {
    if (this.count === 0) {
      return null;
    }
    const rank = Math.ceil(this.count / 2);
    const out: [number, number, number] = [0, 0, 0];
    for (let c = 0; c < 3; ++c) {
      const b = this.bins[c];
      let acc = 0;
      for (let k = 0; k < 65536; ++k) {
        acc += b[k];
        if (acc >= rank) {
          out[c] = k;
          break;
        }
      }
    }
    return out;
  }
}

/**
 * The linear value (stored frame) of 16-bit mean code `n` on axis `c` - the
 * expression buildPackTables and unpackPcSogs evaluate:
 * v = mins + (maxs - mins) * n / 65535, then sign(v)(exp|v| - 1).
 */
export function decodeMeanCode(
  meta: Pick<SogMeta, "means">,
  c: number,
  n: number,
): number {
  const mn = meta.means.mins[c];
  const mx = meta.means.maxs[c];
  const f = n / 65535;
  const v = mn + (mx - mn) * f;
  return Math.sign(v) * (Math.exp(Math.abs(v)) - 1);
}

/** Nearest integer (halves up, Math.round); -0 and non-finite give 0. */
function roundOrigin(v: number): number {
  const r = Math.round(v);
  return Number.isFinite(r) && r !== 0 ? r : 0;
}

/**
 * o_rel, the runtime pack origin: the per-axis median codes of `hist`
 * decoded to linear (stored frame) and rounded to integers. [0, 0, 0] when
 * the histogram is empty.
 */
export function sogPackOrigin(
  meta: Pick<SogMeta, "means">,
  hist: SogMeanCodeHistogram,
): [number, number, number] {
  const codes = hist.medianCodes();
  if (!codes) {
    return [0, 0, 0];
  }
  return [
    roundOrigin(decodeMeanCode(meta, 0, codes[0])),
    roundOrigin(decodeMeanCode(meta, 1, codes[1])),
    roundOrigin(decodeMeanCode(meta, 2, codes[2])),
  ];
}

/**
 * The PackedSplats' fold origin: centerOrigin = kcOrigin + o_rel (kcOrigin =
 * what the build subtracted, o_rel = what the loader's tables subtract), so
 * packed + centerOrigin = the original file-frame centre. null when every
 * component is 0.
 */
export function composeCenterOrigin(
  kcOrigin: readonly [number, number, number] | null,
  oRel: readonly [number, number, number],
): [number, number, number] | null {
  const k = kcOrigin ?? [0, 0, 0];
  const x = k[0] + oRel[0];
  const y = k[1] + oRel[1];
  const z = k[2] + oRel[2];
  return x === 0 && y === 0 && z === 0 ? null : [x || 0, y || 0, z || 0];
}

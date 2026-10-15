import { SogMeta } from './sogMeta';
/**
 * Per-axis histograms of the 16-bit SOG mean codes (code of axis c = means_l
 * byte c | means_u byte c << 8, exactly as packRange reads it).
 */
export declare class SogMeanCodeHistogram {
    readonly bins: [Uint32Array, Uint32Array, Uint32Array];
    /** Splats added so far. */
    count: number;
    /**
     * Add `count` splats whose means_l / means_u RGBA pixels start at element 0
     * of each array (the loader's band layout; padding pixels past the scene's
     * splat count must not be included).
     */
    add(meansL: Uint8Array, meansU: Uint8Array, count: number): void;
    /**
     * Per-axis LOWER median code: the ceil(count / 2)-th smallest code (exact
     * for an odd count, the lower middle one for an even count). null before
     * any splat was added.
     */
    medianCodes(): [number, number, number] | null;
}
/**
 * The linear value (stored frame) of 16-bit mean code `n` on axis `c` - the
 * expression buildPackTables and unpackPcSogs evaluate:
 * v = mins + (maxs - mins) * n / 65535, then sign(v)(exp|v| - 1).
 */
export declare function decodeMeanCode(meta: Pick<SogMeta, "means">, c: number, n: number): number;
/**
 * o_rel, the runtime pack origin: the per-axis median codes of `hist`
 * decoded to linear (stored frame) and rounded to integers. [0, 0, 0] when
 * the histogram is empty.
 */
export declare function sogPackOrigin(meta: Pick<SogMeta, "means">, hist: SogMeanCodeHistogram): [number, number, number];
/**
 * The PackedSplats' fold origin: centerOrigin = kcOrigin + o_rel (kcOrigin =
 * what the build subtracted, o_rel = what the loader's tables subtract), so
 * packed + centerOrigin = the original file-frame centre. null when every
 * component is 0.
 */
export declare function composeCenterOrigin(kcOrigin: readonly [number, number, number] | null, oRel: readonly [number, number, number]): [number, number, number] | null;

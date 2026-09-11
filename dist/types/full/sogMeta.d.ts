import { PcSogsV2Json } from '../SplatLoader';
export type SogPlaneName = "means_l" | "means_u" | "quats" | "scales" | "sh0" | "shN_centroids" | "shN_labels";
/** The parts of a validated v2 manifest the packer and the loader read. */
export type SogMeta = {
    count: number;
    /** SH bands carried by the file (0 = no shN section). */
    bands: 0 | 1 | 2 | 3;
    /** Number of palette centroids (shN.count), 0 without SH. */
    centroidCount: number;
    means: {
        mins: [number, number, number];
        maxs: [number, number, number];
    };
    scalesCodebook: Float64Array;
    sh0Codebook: Float64Array;
    shNCodebook: Float64Array | null;
    /** File names by role, as written in the manifest (no directory prefix). */
    files: Record<SogPlaneName, string | null>;
    /** The manifest, verbatim (the reference decoder's input shape). */
    json: PcSogsV2Json;
};
export declare class SogMetaError extends Error {
    readonly code: "not-v2" | "count" | "means" | "codebook" | "codebook-null" | "files" | "bands";
    constructor(code: SogMetaError["code"], message: string);
}
/**
 * Validate a parsed `meta.json` and extract what the loader needs. Throws
 * SogMetaError; never repairs.
 */
export declare function parseSogMeta(json: unknown): SogMeta;
/**
 * The plane geometry rule of splat-transform 3.x: W = roundUp4(ceil(sqrt n)),
 * H = roundUp4(ceil(n / W)). Used to cross-check the decoded bitmap size (a
 * plane of the wrong size means the file is not what the manifest says) and
 * to size band reads before the bitmap exists.
 */
export declare function planeSize(count: number): {
    width: number;
    height: number;
};
/**
 * Scene bounds straight from the manifest: the means are stored as
 * sign(v)·log(1+|v|) in [mins, maxs], so the corners of the decoded box are
 * sign(v)·(exp|v|−1) of the stored corners. Exact, and available before a
 * single texel is decoded — the loader hands these to the app so it never
 * has to walk 20M packed centers on the main thread.
 */
export declare function boundsFromMeta(meta: SogMeta): {
    min: [number, number, number];
    max: [number, number, number];
};
/**
 * Centroid image stride rule ([ssog-10]): writers pack 64 centroids per row
 * at `64 * coeffsPerCentroid` px (3 / 8 / 15 for bands 1 / 2 / 3); the image
 * width is authoritative. Returns the stride, or throws when width and bands
 * disagree (a wrong stride reads every SH lookup off by one centroid).
 */
export declare function centroidStride(width: number, bands: number): number;

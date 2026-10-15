import { SplatEncoding } from '../defines';
import { SogMeta } from './sogMeta';
export type SogPlaneRgba = {
    rgba: Uint8Array;
    width: number;
    height: number;
};
export type PackTables = {
    /**
     * toHalf(center_c(n) - origin[c]) for every 16-bit mean value n, per axis
     * ([prec-1]: origin = the loader's runtime pack origin o_rel, [0,0,0] =
     * the stream's words).
     */
    centerHalf: [Uint16Array, Uint16Array, Uint16Array];
    /** The packed scale byte for every scales-plane byte. */
    scaleByte: Uint8Array;
    /** The packed color byte for every sh0-plane color byte. */
    rgbByte: Uint8Array;
    /** The packed alpha byte for every sh0-plane alpha byte. */
    alphaByte: Uint8Array;
    /** (b / 255 - 0.5) * sqrt2 for every quats-plane component byte. */
    quatComp: Float64Array;
    /** Bands actually packed (min of the file's bands and the requested clamp). */
    maxSh: 0 | 1 | 2 | 3;
    /** Number of labels the palette tables cover (rows x 64 of the centroid image). */
    paletteEntries: number;
    paletteSh1: Uint32Array | null;
    paletteSh2: Uint32Array | null;
    paletteSh3: Uint32Array | null;
};
/**
 * Build every lookup the packer needs, once per scene. `centroids` is the
 * decoded shN_centroids plane (required when maxSh > 0 and the file has SH).
 * [prec-1] `origin` is subtracted from every decoded centre before the fp16
 * encode (the runtime pack origin; the PackedSplats carries it back as
 * centerOrigin). The default [0, 0, 0] writes the stream's words exactly.
 */
export declare function buildPackTables(meta: SogMeta, centroids: SogPlaneRgba | null, maxShRequested: number, encoding?: SplatEncoding, origin?: readonly [number, number, number]): PackTables;
/** RGBA pixels of the six per-splat planes for one contiguous splat range. */
export type PackPlanes = {
    meansL: Uint8Array;
    meansU: Uint8Array;
    quats: Uint8Array;
    scales: Uint8Array;
    sh0: Uint8Array;
    /** Required when tables.maxSh > 0. */
    labels: Uint8Array | null;
};
export type PackOutput = {
    packed: Uint32Array;
    sh1: Uint32Array | null;
    sh2: Uint32Array | null;
    sh3: Uint32Array | null;
};
/**
 * Pack `count` splats whose plane pixels start at element 0 of each plane
 * into `out` at splat index `outIndex`. Returns the number of labels that
 * fell outside the palette (encoded as zero SH, like the reference path).
 */
export declare function packRange(planes: PackPlanes, count: number, tables: PackTables, out: PackOutput, outIndex: number): {
    badLabels: number;
};

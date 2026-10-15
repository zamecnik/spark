export declare const SSOG_PAGE_SPLATS = 65536;
export interface SsogModelOptions {
    /**
     * [prec-1] compute the runtime pack origin (`SsogModel.packOrigin`).
     * Default true; false = null (centres packed in the file frame, the
     * kroscloud.47 words - the app's `?splatorigin=off` A/B lever).
     */
    packOrigin?: boolean;
}
/**
 * [prec-1] The runtime pack origin of a streamed scene: per axis, the median
 * of the leaf bound CENTRES weighted by each leaf's level-0 row count (the
 * lower weighted median: the first centre in sorted order at which the
 * cumulative weight reaches half the total), rounded to the nearest integer.
 *
 * Why: Spark packs every centre as 3 x fp16 in the frame it is given, so
 * content far from the file origin loses precision (18ss stores a real
 * altitude, z ~ 465, where fp16 steps are 0.25 - visible as horizontal
 * stripes). The unit decoder packs c - packOrigin instead and the mesh
 * transform re-adds it. A weighted MEDIAN, not a bounding-box centre: a few
 * stray splats stretch a box (18ss's lod-meta root bound centre z ~ 122 would
 * keep the 0.25 step; on w9s7 a box centre would make 2-unit steps).
 *
 * `centers` = [x, y, z] per leaf (3 * n), `weights` = n non-negative weights
 * (non-finite or <= 0 entries are ignored). Returns null when no weight is
 * positive or the rounded origin is [0, 0, 0].
 */
export declare function ssogPackOrigin(centers: ArrayLike<number>, weights: ArrayLike<number>): [number, number, number] | null;
export interface SsogLodMetaBound {
    min: number[];
    max: number[];
}
interface SsogLodMetaNode {
    bound?: SsogLodMetaBound;
    children?: SsogLodMetaNode[];
    lods?: Record<string, {
        file: number;
        offset: number;
        count: number;
    }>;
}
export interface SsogLodMeta {
    version: number;
    count: number;
    counts: number[];
    lodLevels: number;
    filenames: string[];
    environment?: unknown;
    /**
     * [ssog-16] builder --lod-chunk-extent stamp (world units; Viewme pipeline
     * ≥2026-08-31). splat-transform itself never writes it — the build
     * pipeline injects it so the runtime can calibrate d0/move-gate to the
     * ACTUAL tree instead of the CLI default (16).
     */
    chunkExtent?: number;
    /**
     * [ssog-27] pipeline packer stamp: 1 = every unit is ONE SOGU container
     * `{L}_{i}/unit.bin`; absent/0 = classic loose files. Any other value is
     * rejected at construction (never sniffed, never silently downgraded).
     */
    unitPack?: number;
    tree: SsogLodMetaNode & {
        bound: SsogLodMetaBound;
    };
}
export declare class SsogModel {
    readonly lodLevels: number;
    readonly count: number;
    readonly counts: number[];
    readonly filenames: string[];
    /** parsed-and-deferred (plan §2.3) — v1 never renders the environment */
    readonly hasEnvironment: boolean;
    /** [ssog-16] builder chunk extent from the meta stamp; null on old bundles */
    readonly chunkExtent: number | null;
    /** [ssog-27] unit container format: 0 = classic loose files, 1 = `unit.bin` per unit */
    readonly unitPack: 0 | 1;
    readonly numLeaves: number;
    /** [leaf*6 .. leaf*6+5] = minX,minY,minZ,maxX,maxY,maxZ */
    readonly boundsFlat: Float32Array;
    /** PRE-resolution refs: [(leaf*L+level)*3 +{0,1,2}] = file,offset,count; -1 = missing */
    readonly leafLodsPre: Int32Array;
    /** POST-resolution refs — every slot valid */
    readonly leafLods: Int32Array;
    /** number of levels ACTUALLY present per leaf (pre-resolution) */
    readonly leafLevelCount: Uint32Array;
    readonly numUnits: number;
    readonly unitLevel: Int32Array;
    readonly unitIndexInLevel: Int32Array;
    /** derived per-unit splat counts (VARIABLE; safe-integer arithmetic) */
    readonly unitSplats: Float64Array;
    /** blockBase[u] = first global pager chunk id of unit u; length numUnits+1 */
    readonly blockBase: Int32Array;
    readonly totalBlocks: number;
    readonly rootBound: {
        min: number[];
        max: number[];
    };
    /**
     * Quantified slack input (§2.3 pool formula): max over (leaf, level) of the
     * number of pool blocks that leaf's rows span at that level.
     */
    readonly maxLeafBlockFootprint: number;
    /**
     * [prec-1] runtime pack origin (file frame): `ssogPackOrigin` over the leaf
     * bound centres weighted by their level-0 rows. SsogUnitCache hands it to
     * the unit decode (centres packed as fp16(c - packOrigin)) and SsogSplats
     * exposes it as `centerOrigin`, which the mesh transform folds back in.
     * null = none (all zero, or `options.packOrigin === false`). Fixed for the
     * model's lifetime.
     */
    readonly packOrigin: [number, number, number] | null;
    constructor(meta: SsogLodMeta, options?: SsogModelOptions);
    /** unit dir name, e.g. "0_4" */
    unitDirName(unit: number): string;
    /** global pager chunk id + slot for (unit file index, row-in-unit) */
    rowToChunkSlot(file: number, row: number): {
        chunk: number;
        slot: number;
    };
    /** binary search: which unit owns a global chunk id */
    unitOfChunk(chunk: number): {
        unit: number;
        block: number;
    };
    /**
     * Scene AABB from the lod-meta root bound — kills the rad bbox-empty trap;
     * feeds GetSplatSceneDimension (§2.7).
     */
    getSceneBounds(): {
        min: [number, number, number];
        max: [number, number, number];
    };
}
export {};

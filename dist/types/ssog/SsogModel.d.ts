export declare const SSOG_PAGE_SPLATS = 65536;
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
    constructor(meta: SsogLodMeta);
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

import { PagedSplats, defines } from '../index.ts';
import { SsogModel } from './SsogModel';
import { SsogUnitCache } from './SsogUnitCache';
export interface SsogSplatsOptions {
    /** three renderer (WebGLRenderer or WebGPURenderer) — passed to the pager */
    renderer: any;
    model: SsogModel;
    cache: SsogUnitCache;
    /** splat budget (app ComputeSplatBudget product, phone 1M-class) */
    budget: number;
    /** pool SH plane ALLOCATION cap (kroscloud.6 pagedMaxSh; default 3) */
    maxSh?: number;
    /** parallel unit-block fetchers; device-tiered default (mobile 2, else 4) */
    numFetchers?: number;
    /**
     * Pool fragmentation factor on the BUDGET term of the §2.3 pool formula
     * (Phase C finding): the composed cut references rows scattered across
     * blocks, so displayed pages run well under full occupancy (~55% measured
     * on the 4.59M reference scene at a 2M budget) and the block-aware pool
     * guard then caps effective quality at ~0.55×budget. A factor ≈ 1.8
     * restores budget-level quality at the cost of a proportionally larger
     * pool. Default 1 (pre-calibration behavior); the app sets the calibrated
     * per-tier value.
     */
    poolFactor?: number;
}
export declare class SsogSplats extends PagedSplats {
    readonly externalLod: boolean;
    readonly model: SsogModel;
    readonly cache: SsogUnitCache;
    readonly budget: number;
    /** §2.3 pool sizing (pages) with quantified slack — recorded for the HUD */
    readonly poolPages: number;
    readonly slackSplats: number;
    /** §2.4 capacity policy: fixed cut-texture size, allocated once */
    readonly capacityRows: number;
    readonly capacitySplats: number;
    private numShResolved;
    private readonly fixedEncoding;
    constructor(options: SsogSplatsOptions);
    /**
     * Global pager chunk → exact-size block slice of the memoized unit decode.
     * NEVER `unitIndex*8 + block` — unit sizes are variable (P0a/P0b pinned).
     */
    fetchDecodeChunk(chunk: number): Promise<{
        numSplats: number;
        packedArray: Uint32Array<ArrayBufferLike>;
        extra: Record<string, unknown>;
        splatEncoding: defines.SplatEncoding;
    }>;
    /**
     * Full teardown (final scene destruction only). Regular dispose() is
     * detach-only by inheritance — the pool outlives the view for warm
     * pano-roundtrip reattach (§2.7).
     */
    disposePool(): void;
}

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
    /**
     * [ssog-18] pool page ceiling = the device's texture-array-layer class.
     * Default 256 (the WebGPU DEFAULT device limit / WebGL2 spec minimum).
     * The app passes the GRANTED device limit when it requested a higher one
     * (requiredLimits.maxTextureArrayLayers) — never a wish, always what
     * renderer.backend.device.limits actually reports.
     */
    maxPoolPages?: number;
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
    /**
     * [ssog-24] chunk → unit for every fetchDecodeChunk still awaiting its
     * unit download (one cache waiter each). A lease exists exactly while
     * the getUnit promise is pending, so cancelFetchChunk releases the cache
     * at most once per fetch and never for a superseded record.
     */
    private readonly leases;
    /**
     * [ssog-24] chunk → {unit, record id} of a lease this source RELEASED in
     * cancelFetchChunk while its fetchDecodeChunk was still awaiting the unit.
     * `resumeFetchChunk` re-leases from here when the pager finds the chunk
     * wanted again; the record id pins WHICH download the fetcher awaits, so a
     * re-lease can never land on a fresh record of the same unit (that waiter
     * could never be released, and the unit would become uncancellable).
     */
    private readonly releasedLeases;
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
     * [ssog-24] The pager no longer wants this in-flight chunk: drop its
     * waiter on the unit download. The cache aborts the transfer when no
     * other in-flight chunk of the unit is still wanted.
     */
    cancelFetchChunk(chunk: number): void;
    /**
     * [ssog-24] The pager wants this cancelled-but-still-in-flight chunk
     * again. Re-lease the very unit download the fetcher is awaiting; true =
     * the lease is back and the fetcher may be un-cancelled. False = the
     * record is gone (aborted, settled, or replaced), so the fetcher stays
     * cancelled and the chunk restarts through the normal path.
     */
    resumeFetchChunk(chunk: number): boolean;
    /**
     * [ssog-24] fetch group of a chunk = its UNIT: every chunk of one unit
     * shares a single download, so cancelling that download for one chunk
     * also kills the transfer a sibling chunk in the same group is waiting
     * for. The pager uses this to keep a group alive while any chunk of it is
     * still wanted.
     */
    fetchGroup(chunk: number): number | null;
    /** [ssog-24] download progress (0..1) of the chunk's unit, null = unknown */
    fetchProgress(chunk: number): number | null;
    /**
     * Full teardown (final scene destruction only). Regular dispose() is
     * detach-only by inheritance — the pool outlives the view for warm
     * pano-roundtrip reattach (§2.7).
     */
    disposePool(): void;
}

import { SparkRenderer, SplatMesh } from '../index.ts';
import { SsogSplats } from './SsogSplats';
import * as THREE from "three";
export interface SsogLodControllerOptions {
    mesh: SplatMesh;
    splats: SsogSplats;
    sparkRenderer: SparkRenderer;
    /** splat budget; defaults to splats.budget */
    budget?: number;
    /** builder --lod-chunk-extent (default 16) — feeds d0 = (5/16)·extent (C3) */
    chunkExtent?: number;
    /** direct override of lodBaseDistance (the ?ssogbands tuning hook) */
    lodBaseDistance?: number;
    /** moved-gate factor of lodBaseDistance (default 0.2 — §2.4) */
    moveGateFactor?: number;
    /** controller tick every N frames (default 10) */
    metronomeFrames?: number;
    /** chunk fetch-priority cooldown in controller ticks (default 10 — C4) */
    cooldownTicks?: number;
    /**
     * WebGL2 sort-worker backpressure: gate cut RECOMPOSITION on
     * sparkRenderer.sorting (§2.4). Default: auto-detect from the renderer.
     */
    isWebGL2?: boolean;
}
export declare class SsogLodController {
    readonly mesh: SplatMesh;
    readonly splats: SsogSplats;
    readonly sparkRenderer: SparkRenderer;
    readonly budget: number;
    readonly lodBaseDistance: number;
    readonly moveGateFactor: number;
    readonly metronomeFrames: number;
    readonly cooldownTicks: number;
    readonly isWebGL2: boolean;
    /** set true after any external param change to force a tick */
    paramsDirty: boolean;
    budgetScale: number;
    private readonly L;
    private readonly NL;
    private phase;
    private detached;
    /** per-leaf state (allocated once) */
    private readonly displayed;
    private readonly desired;
    private readonly optimalLevel;
    private readonly balancedLevel;
    private readonly bucketOf;
    private readonly dBucket;
    /** fixed-capacity compose buffer (§2.4 capacity policy — never regrows) */
    private readonly cut;
    private composedSplats;
    /** sum of displayed-level counts (maintained across flips) */
    private displayedTotal;
    private frameCounter;
    private tickCount;
    private converged;
    /**
     * A flip scan was deferred by the WebGL2 sort backpressure — retry on the
     * first sort-idle frame, OR after one metronome period regardless: under
     * continuous motion the stock sort loop chains back-to-back (`sorting`
     * flips false→true within one task in onSortComplete), so frames may NEVER
     * observe idle and an unbounded gate starves flips entirely (observed
     * live: 0 flips across a whole dolly). The stock mappingUpdated-while-
     * sorting deferral (§2.4) keeps display correct either way — this gate
     * only bounds recompose queueing.
     */
    private flipRetryPending;
    private flipRetryFrames;
    /** did the last selection tick move budgetScale (outside the dead zone)? */
    private scaleMoved;
    /**
     * Pool-settled detection (Phase C liveness finding): at fragmented near
     * poses the block-aware pool guard can defer EVERY remaining grow flip
     * forever (observed live: 191k deferrals at one fixed pose — quality is
     * pool-limited before budget-limited, which is the DESIGNED trade). With
     * only displayed==balanced as the criterion, `converged` never fires
     * there: the metronome spins every period and the Phase D render-on-demand
     * supplier would never rest. So "no flips for 3 consecutive ticks with a
     * quiet pager" also counts as converged; the motion/resource/params gates
     * un-converge exactly as before.
     */
    private lastFlipsStat;
    private ticksNoProgress;
    /** chunk → last controller tick it was in tiers 1–3 (cooldown bookkeeping) */
    private chunkLastNeeded;
    /**
     * Refcounts of chunks referenced by the CURRENT displayed cut (pinned
     * coarsest carries a permanent +1). |keys| is the exact page demand of
     * tier 1+2 — the block-aware pool guard: displayed+pinned may NEVER exceed
     * maxPages − fetcher margin, so displayed pages are never evictable (R7).
     * Splat budgets don't bound BLOCK footprint (partial-block fragmentation),
     * so grow flips that would overflow the pool are deferred instead.
     */
    private chunkRefs;
    /** pinned coarsest chunk ids (computed once) */
    private readonly pinnedChunks;
    /**
     * Chunks in THIS tick's fetchPriority (tiers 1–4). Flip eligibility
     * requires every desired chunk ∈ this set: a chunk that is resident but
     * NOT in the current priority is in driveFetchers' freeable set and can be
     * evicted between ticks — flipping onto it would open the R7 hole (a
     * sub-step-truncated staging can leave an already-resident shared chunk
     * unprotected while readiness still sees it mapped).
     */
    private priorityChunks;
    private readonly lastPose;
    private readonly tmpMat;
    private readonly tmpPos;
    private readonly tmpFwd;
    private readonly tmpQuat;
    private readonly tmpScale;
    readonly stats: {
        phase: string;
        ticks: number;
        recomposes: number;
        flips: number;
        composedSplats: number;
        budgetScale: number;
        totalOptimal: number;
        totalBalanced: number;
        headroomChecks: number;
        headroomStops: number;
        headroomViolations: number;
        capacityDeferrals: number;
        poolDeferrals: number;
        displayedChunkCount: number;
        capacityOverflowInCompose: number;
        missingSamples: {
            tick: number;
            li: number;
            level: number;
            chunk: number;
            mapped: boolean;
        }[];
        deferredBySort: number;
        missingPagesInCompose: number;
        priorityLen: number;
        lastTickMs: number;
        revealResidentBlocks: number;
        revealTotalBlocks: number;
    };
    constructor(options: SsogLodControllerOptions);
    /** Q8: call once per rendered frame from the app rAF. */
    frame(camera: THREE.PerspectiveCamera): void;
    /**
     * Public convergence probe (Phase C harness gates; the §2.9 render-on-
     * demand supplier will consume it in Phase D): true when the ladder is at
     * its balanced target, budgetScale has settled in the dead zone, and no
     * flip retry is queued behind the WebGL2 sort backpressure.
     */
    get isConverged(): boolean;
    /** Detach-only stop (pano roundtrip): state stays warm for reattach. */
    detach(): void;
    attach(): void;
    private gatesPass;
    /** camera pose in mesh-local space → tmpPos/tmpFwd/tmpQuat + uniformScale */
    private cameraLocal;
    private markPose;
    private pump;
    /** pages queued-but-not-yet-uploaded (recomputed per scan) */
    private pendingUploadPages;
    private chunkResidentUploaded;
    private addLeafRefs;
    private removeLeafRefs;
    /** pages tier 1+2 may occupy; leaves headroom for in-flight fetchers */
    private poolGuardLimit;
    /** iterate global chunk ids of a (leaf, level) ref */
    private forEachLeafChunk;
    private revealTick;
    private lodTick;
    private selectionAndBalance;
    private flipReadyLeaves;
    /**
     * Recompose the whole cut from displayed[] (per-leaf runs of consecutive
     * pool indices, ≤2 block-split sub-runs per §2.4), publish ONCE: row-padded
     * array (P0b writeTexture contract), numSplats together, mappingVersion
     * bump so both backends' same-frame-resort gates fire.
     */
    private compose;
    /**
     * Soak-gate sweep: verify every leaf's displayed blocks still map to live
     * pages owned by (this.splats, that chunk) — zero stale entries expected.
     */
    verifyCut(): {
        checked: number;
        stale: number;
    };
    /** per-level displayed splat totals (HUD readout) */
    displayedByLevel(): number[];
}

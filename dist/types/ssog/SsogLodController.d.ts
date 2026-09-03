import { SparkRenderer, SplatMesh } from '../index.ts';
import { SsogSplats } from './SsogSplats';
import * as THREE from "three";
export interface SsogLodControllerOptions {
    mesh: SplatMesh;
    splats: SsogSplats;
    sparkRenderer: SparkRenderer;
    /** splat budget; defaults to splats.budget */
    budget?: number;
    /**
     * builder --lod-chunk-extent — feeds d0 = (5/16)·extent (C3). Default:
     * the model's [ssog-16] lod-meta stamp when present, else 16 (the
     * splat-transform CLI default).
     */
    chunkExtent?: number;
    /** direct override of lodBaseDistance (the ?ssogbands tuning hook) */
    lodBaseDistance?: number;
    /** moved-gate factor of lodBaseDistance (default 0.2 — §2.4) */
    moveGateFactor?: number;
    /** controller tick every N frames (default 10) */
    metronomeFrames?: number;
    /**
     * chunk fetch-priority cooldown in controller ticks (default 100 — C4
     * revised: upstream gsplat-params parity at the same tick cadence)
     */
    cooldownTicks?: number;
    /**
     * grow-flip wave gather window in controller ticks (default 2): a ready
     * grow flip waits for the REST of its unit file's pending leaves at most
     * this long, so refinement lands as few spatially-coherent waves instead
     * of a per-block trickle. 0 = flip as soon as ready (pre-kroscloud.10).
     */
    flipBatchTicks?: number;
    /**
     * WebGL2 sort-worker backpressure: gate cut RECOMPOSITION on
     * sparkRenderer.sorting (§2.4). Default: auto-detect from the renderer.
     */
    isWebGL2?: boolean;
    /**
     * [ssog-20] hard page cap for the promote-to-fill leg (A/B override;
     * default = the budget's page-equivalent at ~0.78 row utilization).
     * Bytes, not splats, are what the fill actually spends — see
     * selectionAndBalance.
     */
    fillPageCap?: number;
    /**
     * [ssog-23] selection policy. "bands" = the shipped supersplat port
     * (distance bands rescaled by budgetScale feedback, then promote-to-fill
     * up to the budget). "sse" = screen-space-error termination: the bands are
     * calibrated in PIXELS from the scene's own L0 splat spacing (L1 acceptable
     * once its merge error projects to <= e px, level multiplier sqrt(2)),
     * there is no budgetScale feedback, and the promote-to-fill legs never
     * refine a leaf past the level the error rule allows; budget and pool
     * stay ceilings. Default "bands" (byte-identical to kroscloud.31).
     */
    lodMode?: "bands" | "sse";
    /** [ssog-23] sse: error tolerance in CSS pixels at rest (default 2) */
    sseErrorPx?: number;
    /**
     * [ssog-23] sse: error tolerance while the camera moves and for
     * sseDwellMs after it stops (default 4). 0 or <= sseErrorPx disables the
     * base phase.
     */
    sseBaseErrorPx?: number;
    /** [ssog-23] sse: dwell before switching from base to fine (ms, default 1500) */
    sseDwellMs?: number;
    /** [ssog-23] sse: viewport height in CSS pixels (default 1080; see setViewportHeight) */
    viewportHeightPx?: number;
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
    readonly flipBatchTicks: number;
    readonly isWebGL2: boolean;
    /** set true after any external param change to force a tick */
    paramsDirty: boolean;
    budgetScale: number;
    /** [ssog-23] selection policy (see SsogLodControllerOptions.lodMode) */
    readonly lodMode: "bands" | "sse";
    private sseErrorPx;
    private sseBaseErrorPx;
    private sseDwellMs;
    private viewportHeightPx;
    /**
     * [ssog-23] L1's geometric error in MESH-LOCAL units: half the level-1
     * splat spacing = 0.5 * s0 * sqrt(2), s0 = the scene-median L0 spacing per
     * leaf (extent_max / sqrt(rows)). Level l's error is err1 * sqrt(2)^(l-1),
     * so "coarsest level whose projected error <= e px" is exactly the bands
     * formula with d0 = err1 * f_px / e and multiplier sqrt(2).
     */
    private readonly sseErr1;
    /** [ssog-23] last controller tick that observed camera motion (ms) */
    private lastMotionMs;
    private ssePhase;
    /**
     * [ssog-15] moved-gate override in MESH-LOCAL units (null = default
     * moveGateFactor·lodBaseDistance). Set while the app pins the camera to a
     * viewpoint-POI sphere: the FPV eye excursion (≤ 2·fpvRadius ≈ 0.1 units)
     * can never cross the default gate, so a converged cut would freeze there.
     */
    private moveGateOverride;
    /**
     * [ssog-19] scripted-flight fetch hold: while true, tier-3 (desired-cut)
     * staging is suppressed — residency tiers, flips of already-resident
     * targets, and the pump keep running. Set by the app for the duration of
     * a scripted camera flight (POI fly-in/walk/exit); releasing sets
     * paramsDirty so the arrival pose stages its cut immediately.
     */
    private fetchHold;
    /** [ssog-20] explicit fill page cap (A/B override; null = auto) */
    private readonly fillPageCapOption;
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
    /**
     * [ssog-25] orbit-centric ordering: per-leaf distance from the INTEREST
     * point (the camera's orbit target, mesh-local), refreshed by every
     * selection while `interest` is set. Orders the page-capped grows and
     * the tier-3 fetch staging in place of dBucket; never the level rule,
     * never the budget demotion.
     */
    private readonly tBucket;
    /** [ssog-25] WORLD-space interest point (null = camera-centric) */
    private interest;
    private readonly tmpInterest;
    /**
     * [B4] controller tick at which a pending GROW leaf first became ready
     * while its unit-file wave was still incomplete (−1 = not held). Bounds
     * the wave-gather hold to flipBatchTicks (quantized release).
     */
    private readonly readySinceTick;
    /**
     * [B4] the last flip scan left ready-but-held grow flips (a BOUNDED
     * state — quantized deadline release resolves it within 2·flipBatchTicks
     * ticks). Pool-settled convergence must not latch over it: a converged
     * controller stops ticking, which would strand the held flips forever.
     */
    private heldPending;
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
    /**
     * [ssog-24] chunks that entered chunkRefs (pin or flip) during their
     * CURRENT residency — cleared on eviction. A page evicted without ever
     * having been displayed was a wasted download (wastedChunks/wastedBytes).
     */
    private readonly everDisplayed;
    /** pinned coarsest chunk ids (computed once) */
    private readonly pinnedChunks;
    /**
     * [ssog-17] per-tick scratch: final-cut page refcounts (balanced ∪ pinned)
     * for the page-aware balancer — allocated once, length totalBlocks.
     */
    private readonly pageRefs;
    /**
     * [ssog-17 perf] per-tick scratch for the bucket-ordered leaf index
     * (counting sort, stable in li): the balancer passes visit leaves in
     * (bucket, li) order — the former 64×NL rescans dominated tick cost.
     */
    private readonly bucketOrder;
    private readonly bucketStart;
    private readonly bucketCursor;
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
        /** [ssog-17] distinct pages of the balanced∪pinned final cut */
        balancedPages: number;
        /** [ssog-17] page budget the balancer enforced (0 = not enforced) */
        pageLimit: number;
        /** [ssog-20] page cap the promote-to-fill leg spent (0 = not enforced) */
        fillPageCap: number;
        /** [B4] wave-gather hold observations (per flip-scan pass, not unique) */
        batchHolds: number;
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
        /** [ssog-20] leaves whose resolved-coarsest ref is outside the pin tier */
        revealHoleLeaves: number;
        /** [ssog-23] selection policy in force */
        lodMode: string;
        /** [ssog-25] "target" while an interest point orders the fill, else "camera" */
        interestMode: string;
        /**
         * [ssog-25] grows deferred by capacity or the pool guard that sat in the
         * NEARER half of the ordered grow list — the subject's share of the
         * deferrals. Non-zero at rest means the subject is being held back by
         * the cap, not by the ordering.
         */
        subjectDeferrals: number;
        /** [ssog-23] L1 geometric error (mesh-local units) the sse mode calibrated */
        sseErr1: number;
        /** [ssog-23] error tolerance (CSS px) the last selection ran at */
        sseErrorPx: number;
        /** [ssog-23] "base" while moving / before dwell, "fine" at rest */
        ssePhase: string;
        /** [ssog-23] distance (world units) from which L1 is acceptable at the last selection */
        sseD0: number;
        /** [ssog-24] unit downloads aborted (no in-flight chunk still wanted) — cache mirror */
        fetchCancels: number;
        /** [ssog-24] EXACT Σ over aborted units of (known size − received) — cache mirror */
        cancelSavedBytes: number;
        /**
         * [ssog-24 fix E] modelled saving of the same aborts — cache mirror.
         * Cancels are admitted early, before Content-Length headers exist, so the
         * exact counter above reads 0 over a whole soak; this one estimates the
         * unit's total from the running bytes-per-splat mean of completed units.
         */
        cancelSavedEstimateBytes: number;
        /**
         * [ssog-24 fix D] WIRE bytes (PerformanceResourceTiming.transferSize,
         * body-sum fallback) — cache mirror. 0 for a file served from the HTTP
         * cache; compressed octets for a gzip'd meta.json.
         */
        bytesReceived: number;
        /** [ssog-24 fix D] DECODED body bytes read — cache mirror, NOT the wire */
        decodedBytesReceived: number;
        /**
         * [ssog-22 fix] shared SH palette files fetched — cache mirror. The build
         * writes one per LEVEL, so this settles at the number of distinct levels
         * touched; higher means the per-path memo is thrashing.
         */
        paletteFetches: number;
        /** [ssog-24] pager pages evicted whose chunk was never displayed while resident */
        wastedChunks: number;
        /** [ssog-24] estimate for wastedChunks: unit bytes / blocks in the unit */
        wastedBytes: number;
        /** [ssog-24] chunk-level cancel requests the pager issued — pager mirror */
        chunkCancels: number;
        /**
         * [ssog-24] chunks re-fetched within the pager's cancel cooldown of their
         * own cancel — pager mirror. Non-zero = the cancel lever is thrashing
         * under motion (bytes spent twice) rather than saving.
         */
        cancelRefetches: number;
        /**
         * [ssog-24] responses seen with no Content-Length — cache mirror. While
         * such a file is in flight its unit reports NO progress, so the ≥75%
         * skip is measuring blind rather than finding nothing to save.
         */
        filesWithoutLength: number;
        /**
         * [ssog-24 r4] settled files whose true WIRE size could not be read (no
         * resource-timing entry, or a cross-origin response without
         * Timing-Allow-Origin), so the higher decoded body sum was billed into
         * bytesReceived instead. Non-zero means the byte figures are an
         * over-estimate, not that little was transferred.
         */
        filesWithoutWireSize: number;
    };
    constructor(options: SsogLodControllerOptions);
    /**
     * [ssog-17] add (dir=+1) or remove (dir=−1) one leaf-level ref's pages
     * to/from the final-cut refcount scratch; returns the updated distinct
     * count. Same chunk math as forEachLeafChunk, inlined for the balancer's
     * hot path. Aliased level pairs net to zero across a move.
     */
    private bumpLeafPageRefs;
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
    /**
     * [ssog-15] Force a re-selection tick at the next metronome beat — the
     * attach() liveness semantic without a detach round-trip. Call sites:
     * viewpoint-POI arrival and FPV drag-rest (2026-08-31 teleport-blur
     * findings: after a flight the converged latch + motion gates could
     * permanently freeze a coarse cut at a pose the gates cannot re-open from).
     */
    invalidate(): void;
    /**
     * [ssog-15] Override the moved-gate distance (mesh-local units; null or
     * non-positive restores the default moveGateFactor·lodBaseDistance).
     * Counts as a param change — forces a tick so the new gate takes effect
     * at the current pose.
     */
    setMoveGate(units: number | null): void;
    /**
     * [ssog-25] Orbit-centric ordering. `point` is the camera's ORBIT TARGET in
     * WORLD space (converted into the mesh frame with the same matrix the
     * camera goes through); null restores the camera-centric order — the
     * shipped behaviour, and the right one inside a first-person viewpoint,
     * where the eye IS the target. Changes ONLY the order in which the
     * page-capped grows and the tier-3 fetch staging are served (distance
     * from this point instead of from the camera): never the level rule and
     * never the budget demotion — measured on the 20M scene, target-ordering
     * the demotion coarsens the subject (docs/features/gaussian-splatting/
     * orbit-centric-lod-proposal-2026-09.md). Under orbit the key does not
     * move with the camera, which also halves the per-step refetch
     * (sim: 55 -> 28 units per 30 degrees at 144 m). No tick is forced: a
     * target only moves together with the camera, which ticks anyway.
     */
    setInterest(point: {
        x: number;
        y: number;
        z: number;
    } | null): void;
    /** [ssog-25] ordering key: interest distance when set, else camera distance */
    private orderKey;
    /**
     * [ssog-19] Hold/release tier-3 fetch staging across a scripted camera
     * flight (see the fetchHold field). Release forces a tick so the arrival
     * cut stages without waiting for a motion gate.
     */
    setFetchHold(hold: boolean): void;
    /**
     * [ssog-23] Viewport height in CSS pixels — the sse projection's f_px.
     * CSS pixels on purpose (Cesium divides its SSE by pixelRatio for the same
     * reason): a DPR-3 phone must not fetch more than a desktop.
     */
    setViewportHeight(px: number): void;
    /** [ssog-23] runtime dials (A/B): fine tolerance, base tolerance, dwell */
    setSseError(finePx: number, basePx?: number, dwellMs?: number): void;
    /** [ssog-23] the tolerance the next selection will use */
    private sseTolerance;
    private gatesPass;
    /** camera pose in mesh-local space → tmpPos/tmpFwd/tmpQuat + uniformScale */
    private cameraLocal;
    private markPose;
    /**
     * [ssog-24] mirror the byte counters of the unit cache and the pager into
     * stats every frame (not per tick: downloads finish and abort between
     * ticks, and a converged controller stops ticking while transfers drain).
     */
    private syncByteStats;
    private pump;
    /** pages queued-but-not-yet-uploaded (recomputed per scan) */
    private pendingUploadPages;
    private chunkResidentUploaded;
    private addLeafRefs;
    /**
     * [ssog-24] Mark a (leaf, level) ref's chunks as HAVING BEEN DISPLAYED.
     * Deliberately NOT folded into addLeafRefs: the grow path adds refs
     * TENTATIVELY and reverts them when the block-aware pool guard rejects the
     * flip, so marking there counted chunks that were never composed and made
     * wastedChunks/wastedBytes undercount exactly in the near, pool-limited
     * regime the metric exists to measure. Only committed flips mark.
     */
    private markDisplayed;
    private removeLeafRefs;
    /** pages tier 1+2 may occupy; leaves headroom for in-flight fetchers */
    private poolGuardLimit;
    /**
     * [ssog-20] splat count a leaf currently contributes to the cut; 0 when the
     * leaf displays nothing (level −1: a reveal hole not yet laddered in).
     */
    private displayedCount;
    /**
     * [ssog-20] EXACT net change in distinct-page count of moving one leaf's
     * refs from level `from` to level `to`, computed read-only. Equivalent to
     * bump(+to) then bump(−from) and reading the delta, because:
     *   • every page of the FROM span already carries this leaf's ref (the
     *     leaf is currently at `from` in the refcounted cut), so it can never
     *     be counted as new, and
     *   • a page in BOTH spans nets zero under the +to/−from order (it sits
     *     at refs+1 when the decrement lands), so it is excluded from the
     *     freed count.
     * Used to reject a promotion without touching the scratch at all.
     */
    private netPageDelta;
    /** iterate global chunk ids of a (leaf, level) ref */
    private forEachLeafChunk;
    private revealTick;
    private lodTick;
    /**
     * Pure selection-only totalOptimal at a hypothetical budgetScale — the
     * same per-leaf math as selectionAndBalance's selection loop, writing
     * nothing. Uses tmpPos/tmpFwd prepared by the caller's cameraLocal().
     */
    private totalOptimalAt;
    /**
     * Iterate the EXACT budgetScale feedback recurrence (verbatim constants —
     * ·= 1 + (1/√ratio − 1)·0.3, clamp [0.01, 100], dead zone [0.6, 1.4]) to
     * its fixed point for the current pose. Same resting scale the multi-tick
     * walk reached, without staging a cut per intermediate step. Bounded at
     * 64 iterations (the 1→100 clamp walk is ~26; worst-case cost ≈ 100 ms
     * at 26K leaves, typical settles 2–20 ms); an unfinished walk simply
     * resumes the old per-tick behavior.
     */
    private settleBudgetScale;
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

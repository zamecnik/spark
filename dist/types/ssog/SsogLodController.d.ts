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
    /**
     * [ssog-26] behind-camera penalty factor k: a leaf whose closest point lies
     * behind the camera has its selection distance scaled by 1 + k·max(0, −dot)
     * (k = 4 → ×5 straight behind, the pre-[ssog-26] constant). 0 makes the cut
     * rotation-invariant: turning in place costs no fetch at all. Default 4.
     */
    behindPenalty?: number;
    /**
     * [ssog-31] graded budget (sse only). When the e-px cut exceeds the splat
     * budget or the page limit, RELAX THE TOLERANCE instead of demoting every
     * leaf one level per pass: the pure sse cut at the smallest tolerance
     * e·m (m on a quarter-level grid, ×2^(1/8) per step) that fits BOTH
     * limits becomes the balanced target, and the promote-to-fill legs spend
     * the residual nearest-first as before, still capped at the e-px levels.
     * Keeps the distance gradient (near sharp, far coarse) that the
     * one-level-per-pass demotion flattened into "everything L4". Default
     * true; false = the kroscloud.38 balancer (A/B).
     */
    gradedBudget?: boolean;
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
    /**
     * [ssog-32] sse: per-UNIT error blend α ∈ [0, 1]. 0 (default) = the
     * [ssog-23] rule, byte-identical: one error per LEVEL, err1·sqrt(2)^(l−1)
     * from the scene-median L0 spacing. α > 0 = each (leaf, level) error is
     * uniform_l^(1−α) · unit_l^α, where unit_l = 0.5·sqrt(Σext² / Σrows) over
     * the leaves whose level-l rows share that leaf's level-l unit (every leaf
     * of a unit gets the same value, so a unit's leaves still decide on
     * distance alone). A sparse unit (a far, thin area) then has a larger
     * error and goes coarse sooner; a dense one stays fine longer. Viewme
     * LOD-quality plan 2026-09-28, C3: α = 0.5 measured best whole-frame.
     */
    sseErrorBlend?: number;
    /**
     * [ssog-33] target focus g (sse + graded budget, and only while an
     * interest point is set - the orbit target, see setInterest): when the
     * e-px cut does not fit the budget/pool, the tolerance search relaxes a
     * leaf whose closest point lies t > R from the interest point FASTER than
     * the subject: shift·(1 + g·log2(t/R)) levels instead of shift, R =
     * focusRadius × the camera-to-interest distance. The budget then comes
     * from the periphery (far field, and the foreground away from the
     * target) before the subject; when the 2 px cut fits (shift 0) nothing
     * changes. 0 (default) = off, byte-identical. Viewme owner report
     * 2026-09-29 after [ssog-32]: far regions too good, the subject at the
     * orbit target rough and re-levelling as the camera moves.
     */
    focusStrength?: number;
    /** [ssog-33] focus radius R as a fraction of the camera-to-interest distance (default 0.25) */
    focusRadius?: number;
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
    /** [ssog-26] behind-camera penalty factor k in `1 + k·max(0, −dot)` */
    private behindPenalty;
    /** [ssog-31] graded budget on/off (see the option) */
    private gradedBudget;
    /**
     * [ssog-31] per-tick scratch: each leaf's continuous level position
     * log(db/d0)/log(m') from the selection loop, so the tolerance search
     * re-levels every leaf per step with one add + floor instead of a log.
     */
    private readonly levelPos;
    /** [ssog-32] per-unit error blend α in force (0 = the uniform [ssog-23] rule) */
    private sseErrorBlend;
    /** [ssog-32] scene-median L0 spacing (mesh-local), the uniform half of the blend */
    private readonly sseS0;
    /**
     * [ssog-32] per-(leaf, level) error as a LEVEL POSITION, NL·L:
     * log(err[li,l]) / log(sqrt2). Level l is acceptable for a leaf whose
     * levelPos (log(db/c)/log(sqrt2), c = uniformScale·f_px/e) plus the
     * tolerance shift is >= this value, i.e. err·c/db <= e·sqrt2^shift. null
     * while sseErrorBlend is 0 — the legacy level math runs untouched then.
     * The [ssog-23] rule is the special case errPos[l] = l − 1 relative to d0.
     */
    private errPos;
    /** [ssog-33] target focus strength g (0 = off) and radius (fraction of the camera-to-interest distance) */
    private focusStrength;
    private focusRadius;
    /** [ssog-33] per-tick scratch: each leaf's relaxation multiplier (allocated on first use) */
    private focusMul;
    /** [ssog-34] subject radius (mesh-local) of the last selection: focusRadius × |camera − interest|; −1 = none */
    private subjectR;
    /**
     * [ssog-31] EFFECTIVE tolerance (e·m, CSS px) the previous tick settled
     * at, the anchor of the next search — stored in px, not as the grid
     * index, because the base/fine phases change e (4 px moving, 2 px at
     * rest) and the same cut then sits 8 grid steps away; anchoring on k
     * made every phase change walk the cut down and back (harness look-
     * around at k=0: 6 refetched units and 2.3× the flips of a stable cut).
     * The search starts here: coarser only when the anchor no longer fits,
     * finer only when one step finer fits WITH slack.
     */
    private tolPxAnchor;
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
        /** [ssog-26] behind-camera penalty factor in force (4 = the ×5 legacy) */
        behindPenalty: number;
        /** [ssog-31] graded budget in force */
        gradedBudget: boolean;
        /** [ssog-31] tolerance multiplier the last selection settled at (1 = the e-px cut fit) */
        sseTolMul: number;
        /** [ssog-31] effective tolerance of the last selection (CSS px) = sseErrorPx × sseTolMul */
        sseTolPx: number;
        /** [ssog-31] quarter-level steps the last tolerance search took */
        sseTolSteps: number;
        /** [ssog-31] distinct pages of the all-coarsest cut (= the pinned tier since the empty coarse suffix) */
        floorPages: number;
        /**
         * [ssog-25] grows deferred by capacity or the pool guard that sat in the
         * NEARER half of the ordered grow list — the subject's share of the
         * deferrals. Non-zero at rest means the subject is being held back by
         * the cap, not by the ordering.
         */
        subjectDeferrals: number;
        /** [ssog-23] L1 geometric error (mesh-local units) the sse mode calibrated */
        sseErr1: number;
        /** [ssog-32] per-unit error blend α in force (0 = uniform per-level error) */
        sseErrorBlend: number;
        /** [ssog-33] target focus strength / radius in force */
        focusStrength: number;
        focusRadius: number;
        /** [ssog-33] true when the last selection applied the focus (interest set, sse + graded, g > 0) */
        focusActive: boolean;
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
        /** [ssog-27] units loaded through the ONE-file container path — cache mirror */
        packedFetches: number;
        /** [ssog-27] containers rejected (magic/version/table/count/member set) — cache mirror */
        packErrors: number;
        /** [ssog-27] non-abort unit failures that started a per-unit cool-down — cache mirror */
        unitStrikes: number;
        /** [ssog-27] getUnit calls refused during a unit's cool-down (no request made) — cache mirror */
        fetchRefused: number;
    };
    constructor(options: SsogLodControllerOptions);
    /**
     * [ssog-17]/[ssog-31] distinct pool pages of a cut — the pinned tier ∪
     * every leaf at `levels[li]` — leaving pageRefs holding that cut's
     * refcounts for the fill's incremental moves. Bump order (pinned, then
     * leaves ascending) is the one the inline passes used, so the refs are
     * bit-identical to kroscloud.38 on the non-graded path.
     */
    private countCutPages;
    /** [ssog-31] pages of the all-coarsest cut (the reset floor) — HUD/diagnostics, computed once. */
    private countFloorPages;
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
    /**
     * [ssog-34] Share of the SUBJECT's target detail on screen, for a host's
     * reveal ("show the scene once the place at the camera target is mostly
     * sharp"): Σ min(shown rows, target rows) / Σ target rows over the leaves
     * whose closest point lies within focusRadius × |camera − interest| of
     * the interest point (the same subject the [ssog-33] focus protects;
     * tBucket and the radius come from the last selection, the target is the
     * current balanced cut, shown = the displayed level, a reveal hole = 0).
     * Rows halve per level, so 0.75 ≈ half the subject final and the rest one
     * level short. −1 when it cannot be judged: no interest point, before the
     * first selection or during the reveal phase, while a fetch hold is armed
     * (the target is for a pose the camera is still flying to), or no leaf
     * within the radius. O(leaves) per call.
     */
    subjectProgress(): number;
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
     * [ssog-26] Behind-camera penalty factor (see `behindPenalty` option). An
     * app MAY lower it for first-person viewpoint sessions (Viewme: 0 inside
     * viewpoint sessions since 2026-09-08, `?ssogpenvp=k` overrides), where
     * turning in place is the primary gesture: with k = 4 every 90° turn re-cuts ~100
     * units of the 20M reference scene (the tour simulator priced a
     * four-turn look-around at 389 MB of fetches, 0 MB with k = 0, at a 15%
     * row cost in the front hemisphere). A change re-arms the tick like any
     * other parameter change.
     */
    setBehindPenalty(k: number): void;
    private static clampBehindPenalty;
    /** [ssog-31] graded budget on/off (see the option); takes effect next tick. */
    setGradedBudget(on: boolean): void;
    /** [ssog-33] target focus strength g and radius (see the options); takes effect next tick. */
    setFocus(strength: number, radius?: number): void;
    private applyFocus;
    /** [ssog-32] per-unit error blend α (see the option); takes effect next tick. */
    setSseErrorBlend(alpha: number): void;
    private applySseErrorBlend;
    /**
     * [ssog-32] the blended per-(leaf, level) error table as level positions
     * (see errPos). Per-unit error: unit_l = 0.5·sqrt(Σext² / Σrows) over the
     * PRE-resolution refs sharing the unit (ext = the leaf's max box extent).
     * A GAP level (no rows, at or below the leaf's coarsest real level) shows
     * the rows SsogModel resolves it to (nearest real level, tie → coarser),
     * so it carries that level's error — a missing entry must never read as
     * 0 error (Viewme sim: that bug scattered 15–17% of the 20M's levels).
     * The empty suffix past the coarsest real level draws nothing of this
     * leaf; it gets max(extrapolated ·sqrt2 per level, 0.5·ext) so it is
     * chosen only where the leaf is sub-pixel anyway. Then each level blends
     * with the uniform rule: err = uniform_l^(1−α) · unit_l^α (uniform_l =
     * 0.5·s0·sqrt2^l). Matches the Viewme sim `SIM_ERR=blend` and the table
     * `tools/ssog-quality/geotable.mjs` rendered (α = 0.5).
     */
    private buildErrPos;
    /** [ssog-32] coarsest level l >= 1 with errPos[li,l] <= x, else 0 */
    private levelAtPos;
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

// Kroscloud fork — ssog module [ssog-2]. See FORK-CHANGES.md.
//
// SsogLodController — the supersplat-equivalent runtime (plan §2.4, constants
// pinned; structural port of the P0d-proven balancer bench
// poc/ssog-p0/p0d-balancer.mjs where they overlap — since [ssog-14] the bench
// DIVERGES on the promote leg: it still carries the never-past-optimal guard):
//   - FOV-compensated distance-band selection with the ×1→×(1+k) behind-camera
//     penalty (k = `behindPenalty`, default 4 → ×5, [ssog-26]); d0 = lodBaseDistance·budgetScale with lodBaseDistance =
//     (5/16)·chunkExtent (C3); m′ = max(1.2, 3·budgetScale^−0.2);
//   - 64-√bucket balancer: farthest-first demote one level per leaf per pass
//     with early-exit, nearest-first promote-to-fill with fit-check-before-
//     apply and stop-don't-skip (C9; [ssog-14] the promote leg fills the
//     budget PAST optimal — budget is a soft target, not just a ceiling);
//     d_bucket includes penalty AND fovScale AND uniformScale (the pinned
//     definition);
//   - budgetScale feedback: ±40% dead zone, ·= 1 + (1/√ratio − 1)·0.3,
//     clamp [0.01, 100];
//   - 10-frame free-running metronome, latched, with motion gates (moved >
//     0.2·lodBaseDistance, rotated > 90°, FOV Δ > 2%, resource-arrival,
//     params-dirty, not-yet-converged);
//   - keep-old-until-resident swap state machine with cancel/retarget: a leaf
//     never leaves the cut (pop, never hole); desired = the balanced target
//     DIRECTLY (kroscloud.10 flip-visibility alignment — upstream
//     selectDesiredLodIndex semantics: one fetch + ONE flip per leaf, no
//     intermediate-level pops; underfill display stays dormant as upstream's
//     viewer ships it);
//   - unit-coherent grow-flip waves (kroscloud.10): ready grow flips gather
//     by their desired level's unit FILE and land together when every
//     pending grow leaf of that file is ready (upstream file-arrival apply
//     granule) or after flipBatchTicks (default 2) — a bounded hold that
//     turns the per-64k-block trickle into few spatially-coherent waves;
//     shrink flips stay immediate (budget/pool relief);
//   - fetchPriority tiers: (1) coarsest PINNED, (2) displayed, (3) desired
//     nearest-first with the free-pool headroom assert BEFORE each staged
//     leaf (livelock guard; sub-step staging fallback), (4) cooldown 100
//     controller ticks (C4 revised kroscloud.10 — upstream gsplat-params
//     cooldownTicks=100 at the same 10-frame tick cadence; the earlier 10
//     was a 10× misscale that evicted band-boundary content in ~1.6 s and
//     re-popped it from the network on revisit);
//   - initial reveal: coarsest pinned; the first cut is the complete coarsest
//     scene (a conservative strengthening of the §2.4 "≥95% resident"
//     trigger that keeps the no-hole invariant absolute) → activeSplats>0
//     releases the loading overlay;
//   - per-tick pump contract (§2.3): fetchPriority → driveFetchers() →
//     consumeLodTreeUpdates() with returns DISCARDED → processUploads();
//   - capacity policy: cut buffer fixed at SsogSplats.capacitySplats — no
//     regrow ever; grow-flips defer when a transient mix would overflow.
//
// Drive hook (open question Q8, decided Phase B): APP rAF — the host calls
// controller.frame(camera) once per rendered frame. No SparkRenderer
// auto-hook; keeps fork touches minimal and matches the render-on-demand
// supplier design (§2.9).

import * as THREE from "three";
import type { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import { SSOG_PAGE_SPLATS } from "./SsogModel";
import type { SsogSplats } from "./SsogSplats";

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

interface FetchPriorityEntry {
  splats: SsogSplats;
  chunk: number;
}

export class SsogLodController {
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
  paramsDirty = false;

  budgetScale = 1;

  /** [ssog-23] selection policy (see SsogLodControllerOptions.lodMode) */
  readonly lodMode: "bands" | "sse";
  private sseErrorPx: number;
  private sseBaseErrorPx: number;
  private sseDwellMs: number;
  private viewportHeightPx: number;
  /**
   * [ssog-23] L1's geometric error in MESH-LOCAL units: half the level-1
   * splat spacing = 0.5 * s0 * sqrt(2), s0 = the scene-median L0 spacing per
   * leaf (extent_max / sqrt(rows)). Level l's error is err1 * sqrt(2)^(l-1),
   * so "coarsest level whose projected error <= e px" is exactly the bands
   * formula with d0 = err1 * f_px / e and multiplier sqrt(2).
   */
  private readonly sseErr1: number;
  /** [ssog-23] last controller tick that observed camera motion (ms) */
  private lastMotionMs = Number.NEGATIVE_INFINITY;
  private ssePhase: "base" | "fine" = "fine";

  /**
   * [ssog-15] moved-gate override in MESH-LOCAL units (null = default
   * moveGateFactor·lodBaseDistance). Set while the app pins the camera to a
   * viewpoint-POI sphere: the FPV eye excursion (≤ 2·fpvRadius ≈ 0.1 units)
   * can never cross the default gate, so a converged cut would freeze there.
   */
  private moveGateOverride: number | null = null;

  /**
   * [ssog-19] scripted-flight fetch hold: while true, tier-3 (desired-cut)
   * staging is suppressed — residency tiers, flips of already-resident
   * targets, and the pump keep running. Set by the app for the duration of
   * a scripted camera flight (POI fly-in/walk/exit); releasing sets
   * paramsDirty so the arrival pose stages its cut immediately.
   */
  private fetchHold = false;

  /** [ssog-20] explicit fill page cap (A/B override; null = auto) */
  private readonly fillPageCapOption: number | null;

  private readonly L: number;
  private readonly NL: number;

  private phase: "reveal" | "run" = "reveal";
  private detached = false;

  /** per-leaf state (allocated once) */
  private readonly displayed: Int32Array;
  private readonly desired: Int32Array;
  private readonly optimalLevel: Int32Array;
  private readonly balancedLevel: Int32Array;
  private readonly bucketOf: Int32Array;
  private readonly dBucket: Float64Array;
  /**
   * [ssog-25] orbit-centric ordering: per-leaf distance from the INTEREST
   * point (the camera's orbit target, mesh-local), refreshed by every
   * selection while `interest` is set. Orders the page-capped grows and
   * the tier-3 fetch staging in place of dBucket; never the level rule,
   * never the budget demotion.
   */
  private readonly tBucket: Float64Array;
  /** [ssog-25] WORLD-space interest point (null = camera-centric) */
  private interest: THREE.Vector3 | null = null;
  private readonly tmpInterest = new THREE.Vector3();
  /**
   * [B4] controller tick at which a pending GROW leaf first became ready
   * while its unit-file wave was still incomplete (−1 = not held). Bounds
   * the wave-gather hold to flipBatchTicks (quantized release).
   */
  private readonly readySinceTick: Int32Array;
  /**
   * [B4] the last flip scan left ready-but-held grow flips (a BOUNDED
   * state — quantized deadline release resolves it within 2·flipBatchTicks
   * ticks). Pool-settled convergence must not latch over it: a converged
   * controller stops ticking, which would strand the held flips forever.
   */
  private heldPending = false;

  /** fixed-capacity compose buffer (§2.4 capacity policy — never regrows) */
  private readonly cut: Uint32Array;
  private composedSplats = 0;
  /** sum of displayed-level counts (maintained across flips) */
  private displayedTotal = 0;

  private frameCounter = 0;
  private tickCount = 0;
  private converged = false;
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
  private flipRetryPending = false;
  private flipRetryFrames = 0;
  /** did the last selection tick move budgetScale (outside the dead zone)? */
  private scaleMoved = false;
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
  private lastFlipsStat = 0;
  private ticksNoProgress = 0;

  /** chunk → last controller tick it was in tiers 1–3 (cooldown bookkeeping) */
  private chunkLastNeeded: Map<number, number> = new Map();

  /**
   * Refcounts of chunks referenced by the CURRENT displayed cut (pinned
   * coarsest carries a permanent +1). |keys| is the exact page demand of
   * tier 1+2 — the block-aware pool guard: displayed+pinned may NEVER exceed
   * maxPages − fetcher margin, so displayed pages are never evictable (R7).
   * Splat budgets don't bound BLOCK footprint (partial-block fragmentation),
   * so grow flips that would overflow the pool are deferred instead.
   */
  private chunkRefs: Map<number, number> = new Map();

  /**
   * [ssog-24] chunks that entered chunkRefs (pin or flip) during their
   * CURRENT residency — cleared on eviction. A page evicted without ever
   * having been displayed was a wasted download (wastedChunks/wastedBytes).
   */
  private readonly everDisplayed: Set<number> = new Set();

  /** pinned coarsest chunk ids (computed once) */
  private readonly pinnedChunks: number[];

  /**
   * [ssog-17] per-tick scratch: final-cut page refcounts (balanced ∪ pinned)
   * for the page-aware balancer — allocated once, length totalBlocks.
   */
  private readonly pageRefs: Int32Array;
  /** [ssog-26] behind-camera penalty factor k in `1 + k·max(0, −dot)` */
  private behindPenalty: number;

  /**
   * [ssog-17 perf] per-tick scratch for the bucket-ordered leaf index
   * (counting sort, stable in li): the balancer passes visit leaves in
   * (bucket, li) order — the former 64×NL rescans dominated tick cost.
   */
  private readonly bucketOrder: Int32Array;
  private readonly bucketStart: Int32Array;
  private readonly bucketCursor: Int32Array;

  /**
   * Chunks in THIS tick's fetchPriority (tiers 1–4). Flip eligibility
   * requires every desired chunk ∈ this set: a chunk that is resident but
   * NOT in the current priority is in driveFetchers' freeable set and can be
   * evicted between ticks — flipping onto it would open the R7 hole (a
   * sub-step-truncated staging can leave an already-resident shared chunk
   * unprotected while readiness still sees it mapped).
   */
  private priorityChunks: Set<number> = new Set();

  private readonly lastPose = {
    valid: false,
    pos: new THREE.Vector3(),
    quat: new THREE.Quaternion(),
    fov: 0,
  };

  // temps (no per-frame allocation)
  private readonly tmpMat = new THREE.Matrix4();
  private readonly tmpPos = new THREE.Vector3();
  private readonly tmpFwd = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpScale = new THREE.Vector3();

  readonly stats = {
    phase: "reveal" as string,
    ticks: 0,
    recomposes: 0,
    flips: 0,
    composedSplats: 0,
    budgetScale: 1,
    totalOptimal: 0,
    totalBalanced: 0,
    headroomChecks: 0,
    headroomStops: 0,
    headroomViolations: 0,
    capacityDeferrals: 0,
    poolDeferrals: 0,
    /** [ssog-17] distinct pages of the balanced∪pinned final cut */
    balancedPages: 0,
    /** [ssog-17] page budget the balancer enforced (0 = not enforced) */
    pageLimit: 0,
    /** [ssog-20] page cap the promote-to-fill leg spent (0 = not enforced) */
    fillPageCap: 0,
    /** [B4] wave-gather hold observations (per flip-scan pass, not unique) */
    batchHolds: 0,
    displayedChunkCount: 0,
    capacityOverflowInCompose: 0,
    missingSamples: [] as {
      tick: number;
      li: number;
      level: number;
      chunk: number;
      mapped: boolean;
    }[],
    deferredBySort: 0,
    missingPagesInCompose: 0,
    priorityLen: 0,
    lastTickMs: 0,
    revealResidentBlocks: 0,
    revealTotalBlocks: 0,
    /** [ssog-20] leaves whose resolved-coarsest ref is outside the pin tier */
    revealHoleLeaves: 0,
    /** [ssog-23] selection policy in force */
    lodMode: "bands" as string,
    /** [ssog-25] "target" while an interest point orders the fill, else "camera" */
    interestMode: "camera" as string,
    /** [ssog-26] behind-camera penalty factor in force (4 = the ×5 legacy) */
    behindPenalty: 4,
    /**
     * [ssog-25] grows deferred by capacity or the pool guard that sat in the
     * NEARER half of the ordered grow list — the subject's share of the
     * deferrals. Non-zero at rest means the subject is being held back by
     * the cap, not by the ordering.
     */
    subjectDeferrals: 0,
    /** [ssog-23] L1 geometric error (mesh-local units) the sse mode calibrated */
    sseErr1: 0,
    /** [ssog-23] error tolerance (CSS px) the last selection ran at */
    sseErrorPx: 0,
    /** [ssog-23] "base" while moving / before dwell, "fine" at rest */
    ssePhase: "fine" as string,
    /** [ssog-23] distance (world units) from which L1 is acceptable at the last selection */
    sseD0: 0,
    /** [ssog-24] unit downloads aborted (no in-flight chunk still wanted) — cache mirror */
    fetchCancels: 0,
    /** [ssog-24] EXACT Σ over aborted units of (known size − received) — cache mirror */
    cancelSavedBytes: 0,
    /**
     * [ssog-24 fix E] modelled saving of the same aborts — cache mirror.
     * Cancels are admitted early, before Content-Length headers exist, so the
     * exact counter above reads 0 over a whole soak; this one estimates the
     * unit's total from the running bytes-per-splat mean of completed units.
     */
    cancelSavedEstimateBytes: 0,
    /**
     * [ssog-24 fix D] WIRE bytes (PerformanceResourceTiming.transferSize,
     * body-sum fallback) — cache mirror. 0 for a file served from the HTTP
     * cache; compressed octets for a gzip'd meta.json.
     */
    bytesReceived: 0,
    /** [ssog-24 fix D] DECODED body bytes read — cache mirror, NOT the wire */
    decodedBytesReceived: 0,
    /**
     * [ssog-22 fix] shared SH palette files fetched — cache mirror. The build
     * writes one per LEVEL, so this settles at the number of distinct levels
     * touched; higher means the per-path memo is thrashing.
     */
    paletteFetches: 0,
    /** [ssog-24] pager pages evicted whose chunk was never displayed while resident */
    wastedChunks: 0,
    /** [ssog-24] estimate for wastedChunks: unit bytes / blocks in the unit */
    wastedBytes: 0,
    /** [ssog-24] chunk-level cancel requests the pager issued — pager mirror */
    chunkCancels: 0,
    /**
     * [ssog-24] chunks re-fetched within the pager's cancel cooldown of their
     * own cancel — pager mirror. Non-zero = the cancel lever is thrashing
     * under motion (bytes spent twice) rather than saving.
     */
    cancelRefetches: 0,
    /**
     * [ssog-24] responses seen with no Content-Length — cache mirror. While
     * such a file is in flight its unit reports NO progress, so the ≥75%
     * skip is measuring blind rather than finding nothing to save.
     */
    filesWithoutLength: 0,
    /**
     * [ssog-24 r4] settled files whose true WIRE size could not be read (no
     * resource-timing entry, or a cross-origin response without
     * Timing-Allow-Origin), so the higher decoded body sum was billed into
     * bytesReceived instead. Non-zero means the byte figures are an
     * over-estimate, not that little was transferred.
     */
    filesWithoutWireSize: 0,
  };

  constructor(options: SsogLodControllerOptions) {
    this.mesh = options.mesh;
    this.splats = options.splats;
    this.sparkRenderer = options.sparkRenderer;
    this.budget = options.budget ?? this.splats.budget;

    // [ssog-16] option > lod-meta stamp > CLI default: a runtime that
    // assumes extent 16 against a 4 m tree runs d0 and the moved gate 4×
    // off (budgetScale self-corrects d0 but parks ~4× low; the gate never
    // scales — 2026-08-31 budget-underfill findings).
    const chunkExtent =
      options.chunkExtent ?? this.splats.model.chunkExtent ?? 16;
    this.lodBaseDistance =
      options.lodBaseDistance ?? (5 / 16) * chunkExtent; // C3
    const rawFillCap = options.fillPageCap;
    this.fillPageCapOption =
      typeof rawFillCap === "number" &&
      Number.isFinite(rawFillCap) &&
      rawFillCap >= 1
        ? Math.floor(rawFillCap)
        : null;
    this.moveGateFactor = options.moveGateFactor ?? 0.2;
    this.metronomeFrames = options.metronomeFrames ?? 10;
    this.cooldownTicks = options.cooldownTicks ?? 100;
    this.flipBatchTicks = options.flipBatchTicks ?? 2;
    this.isWebGL2 =
      options.isWebGL2 ??
      (this.splats.pager
        ? (this.splats.pager.renderer as { isWebGPURenderer?: boolean })
            .isWebGPURenderer !== true
        : true);

    const model = this.splats.model;
    this.L = model.lodLevels;
    this.NL = model.numLeaves;

    this.displayed = new Int32Array(this.NL).fill(-1);
    this.desired = new Int32Array(this.NL).fill(-1);
    this.optimalLevel = new Int32Array(this.NL);
    this.balancedLevel = new Int32Array(this.NL);
    this.bucketOf = new Int32Array(this.NL);
    this.dBucket = new Float64Array(this.NL);
    this.tBucket = new Float64Array(this.NL);
    this.readySinceTick = new Int32Array(this.NL).fill(-1);

    // [ssog-23] SSE calibration from the artifact itself: median L0 leaf
    // spacing (extent_max / sqrt(L0 rows), PRE-resolution refs so resolved
    // aliases don't count). Measured on the 19.92M reference scene: 0.314 m.
    this.lodMode = options.lodMode === "sse" ? "sse" : "bands";
    this.behindPenalty = SsogLodController.clampBehindPenalty(
      options.behindPenalty,
    );
    this.stats.behindPenalty = this.behindPenalty;
    this.sseErrorPx = Math.max(0.1, options.sseErrorPx ?? 2);
    this.sseBaseErrorPx = options.sseBaseErrorPx ?? 4;
    this.sseDwellMs = Math.max(0, options.sseDwellMs ?? 1500);
    this.viewportHeightPx = Math.max(64, options.viewportHeightPx ?? 1080);
    {
      const L = this.L;
      const spacings: number[] = [];
      const bounds = model.boundsFlat;
      for (let li = 0; li < this.NL; li++) {
        const o = li * 6;
        const ext = Math.max(
          bounds[o + 3] - bounds[o],
          bounds[o + 4] - bounds[o + 1],
          bounds[o + 5] - bounds[o + 2],
        );
        const n0 =
          model.leafLodsPre[li * L * 3] >= 0
            ? model.leafLodsPre[li * L * 3 + 2]
            : 0;
        if (n0 > 0 && ext > 0) {
          spacings.push(ext / Math.sqrt(n0));
        }
      }
      spacings.sort((a, b) => a - b);
      const s0 = spacings.length > 0 ? spacings[spacings.length >> 1] : 1;
      this.sseErr1 = 0.5 * s0 * Math.SQRT2;
      this.stats.sseErr1 = this.sseErr1;
      this.stats.lodMode = this.lodMode;
    }

    this.cut = new Uint32Array(this.splats.capacitySplats);

    // pinned tier-1: every block of every coarsest-level unit (raycast +
    // underfill fallback set, ~1–2 units for a −50% ladder)
    const pinned: number[] = [];
    for (let u = 0; u < model.numUnits; u++) {
      if (model.unitLevel[u] !== this.L - 1) {
        continue;
      }
      const blocks = Math.ceil(model.unitSplats[u] / SSOG_PAGE_SPLATS);
      for (let b = 0; b < blocks; b++) {
        pinned.push(model.blockBase[u] + b);
      }
    }
    this.pinnedChunks = pinned;
    this.stats.revealTotalBlocks = pinned.length;

    // [ssog-17] page-aware balancer scratch + sanity: the page budget must
    // at least cover the pinned tier plus the transition margin, or the
    // balancer parks everything at coarsest (pool sized far too small).
    this.pageRefs = new Int32Array(model.totalBlocks);
    this.bucketOrder = new Int32Array(this.NL);
    this.bucketStart = new Int32Array(65);
    this.bucketCursor = new Int32Array(64);
    const pager = this.splats.pager;
    // [ssog-24] wasted-download telemetry: a page evicted whose chunk never
    // entered a displayed cut during this residency was fetched for nothing.
    // Priced at the unit's received bytes spread evenly over its blocks (0
    // when the unit's bytes are not remembered). Decides the eviction-order
    // lever of the request-side tier (2026-09-02 research D10).
    if (pager) {
      pager.onPageEvicted = (s, c) => {
        if (s !== this.splats) {
          return;
        }
        const displayed = this.everDisplayed.delete(c);
        if (displayed) {
          return;
        }
        this.stats.wastedChunks += 1;
        const { unit } = model.unitOfChunk(c);
        const bytes = this.splats.cache.unitBytes(unit);
        const blocks = model.blockBase[unit + 1] - model.blockBase[unit];
        if (bytes && blocks > 0) {
          this.stats.wastedBytes += bytes / blocks;
        }
      };
    }
    if (pager && pager.maxPages < model.totalBlocks) {
      const margin = model.maxLeafBlockFootprint + pager.numFetchers;
      const guard = this.poolGuardLimit();
      if (pinned.length + margin > guard) {
        console.warn(
          `[ssog] pool too small for page-aware balance: pinned ${pinned.length}` +
            ` + margin ${margin} > guard ${guard} — cut will rest at coarsest`,
        );
      }
    }
  }

  /**
   * [ssog-17] add (dir=+1) or remove (dir=−1) one leaf-level ref's pages
   * to/from the final-cut refcount scratch; returns the updated distinct
   * count. Same chunk math as forEachLeafChunk, inlined for the balancer's
   * hot path. Aliased level pairs net to zero across a move.
   */
  private bumpLeafPageRefs(
    li: number,
    level: number,
    refs: Int32Array,
    distinct: number,
    dir: 1 | -1,
  ): number {
    const model = this.splats.model;
    const o = (li * this.L + level) * 3;
    const file = model.leafLods[o];
    const offset = model.leafLods[o + 1];
    const count = model.leafLods[o + 2];
    if (count <= 0) {
      return distinct;
    }
    const first = model.blockBase[file] + Math.floor(offset / SSOG_PAGE_SPLATS);
    const last =
      model.blockBase[file] +
      Math.floor((offset + count - 1) / SSOG_PAGE_SPLATS);
    for (let c = first; c <= last; c++) {
      if (dir > 0) {
        if (refs[c] === 0) {
          distinct++;
        }
        refs[c]++;
      } else {
        refs[c]--;
        if (refs[c] === 0) {
          distinct--;
        }
      }
    }
    return distinct;
  }

  /** Q8: call once per rendered frame from the app rAF. */
  frame(camera: THREE.PerspectiveCamera) {
    if (this.detached) {
      return;
    }
    this.syncByteStats();
    if (this.phase === "reveal") {
      this.revealTick(camera);
      return;
    }
    // sort-idle flip retry (see flipRetryPending) — runs between metronome
    // beats so backpressure defers recomposition without starving it
    if (this.flipRetryPending) {
      this.flipRetryFrames += 1;
      if (
        !(this.isWebGL2 && this.sparkRenderer.sorting) ||
        this.flipRetryFrames >= this.metronomeFrames
      ) {
        this.flipRetryPending = false;
        this.flipRetryFrames = 0;
        this.flipReadyLeaves();
      }
    }
    // [ssog-19] completion-driven fetcher refill: the pager runs
    // autoDrive:false, so freed slots otherwise idled until the next
    // 10-frame lodTick while the STANDING fetchPriority still had work
    // (~half a metronome period per slot on average — a large share of the
    // measured 73 req/s ceiling). Re-issues from the list the last tick
    // published; eviction-fed lodTreeUpdates stay bounded by the next
    // tick's consume (§2.3 pump discards them).
    // (!converged: at rest the standing priority is never empty, and an
    // unconditional refill would re-scan + LRU-restamp ~400 entries every
    // frame forever; converged requires a quiet pager, so nothing new can
    // become fetchable until a gate un-converges and re-ticks.)
    const refillPager = this.splats.pager;
    if (
      !this.converged &&
      refillPager &&
      refillPager.fetchPriority.length > 0 &&
      refillPager.fetchers.length < refillPager.numFetchers
    ) {
      refillPager.driveFetchers();
    }
    // [ssog-23] dwell expiry: a converged base-phase cut must re-select at
    // the fine tolerance once the camera has rested long enough — the
    // motion/resource gates cannot re-open from a still pose, so this is
    // the only path from "base" to "fine".
    if (
      this.lodMode === "sse" &&
      this.ssePhase === "base" &&
      performance.now() - this.lastMotionMs >= this.sseDwellMs
    ) {
      this.paramsDirty = true;
    }
    this.frameCounter += 1;
    if (this.frameCounter < this.metronomeFrames) {
      return;
    }
    this.frameCounter = 0; // free-running metronome, latched
    if (this.gatesPass(camera)) {
      this.lodTick(camera);
    }
  }

  /**
   * Public convergence probe (Phase C harness gates; the §2.9 render-on-
   * demand supplier will consume it in Phase D): true when the ladder is at
   * its balanced target, budgetScale has settled in the dead zone, and no
   * flip retry is queued behind the WebGL2 sort backpressure.
   */
  get isConverged(): boolean {
    return this.phase === "run" && this.converged && !this.flipRetryPending;
  }

  /** Detach-only stop (pano roundtrip): state stays warm for reattach. */
  detach() {
    this.detached = true;
  }

  attach() {
    this.detached = false;
    // a detached interval may have republished nothing — force a tick
    this.paramsDirty = true;
  }

  /**
   * [ssog-15] Force a re-selection tick at the next metronome beat — the
   * attach() liveness semantic without a detach round-trip. Call sites:
   * viewpoint-POI arrival and FPV drag-rest (2026-08-31 teleport-blur
   * findings: after a flight the converged latch + motion gates could
   * permanently freeze a coarse cut at a pose the gates cannot re-open from).
   */
  invalidate() {
    this.paramsDirty = true;
  }

  /**
   * [ssog-15] Override the moved-gate distance (mesh-local units; null or
   * non-positive restores the default moveGateFactor·lodBaseDistance).
   * Counts as a param change — forces a tick so the new gate takes effect
   * at the current pose.
   */
  setMoveGate(units: number | null) {
    this.moveGateOverride =
      typeof units === "number" && Number.isFinite(units) && units > 0
        ? units
        : null;
    this.paramsDirty = true;
  }

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
  setBehindPenalty(k: number) {
    const next = SsogLodController.clampBehindPenalty(k);
    if (next === this.behindPenalty) {
      return;
    }
    this.behindPenalty = next;
    this.stats.behindPenalty = next;
    this.paramsDirty = true;
  }

  private static clampBehindPenalty(k: number | undefined): number {
    return typeof k === "number" && Number.isFinite(k)
      ? Math.min(16, Math.max(0, k))
      : 4;
  }

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
  setInterest(point: { x: number; y: number; z: number } | null) {
    if (
      point &&
      Number.isFinite(point.x) &&
      Number.isFinite(point.y) &&
      Number.isFinite(point.z)
    ) {
      if (!this.interest) {
        this.interest = new THREE.Vector3(point.x, point.y, point.z);
      } else {
        this.interest.set(point.x, point.y, point.z);
      }
    } else {
      this.interest = null;
    }
  }

  /** [ssog-25] ordering key: interest distance when set, else camera distance */
  private orderKey(li: number): number {
    return this.interest ? this.tBucket[li] : this.dBucket[li];
  }

  /**
   * [ssog-19] Hold/release tier-3 fetch staging across a scripted camera
   * flight (see the fetchHold field). Release forces a tick so the arrival
   * cut stages without waiting for a motion gate.
   */
  setFetchHold(hold: boolean) {
    const next = hold === true;
    if (this.fetchHold === next) {
      return;
    }
    this.fetchHold = next;
    if (!next) {
      this.paramsDirty = true;
    }
  }

  /**
   * [ssog-23] Viewport height in CSS pixels — the sse projection's f_px.
   * CSS pixels on purpose (Cesium divides its SSE by pixelRatio for the same
   * reason): a DPR-3 phone must not fetch more than a desktop.
   */
  setViewportHeight(px: number) {
    const next = Math.max(64, Number.isFinite(px) ? px : 1080);
    if (next === this.viewportHeightPx) {
      return;
    }
    this.viewportHeightPx = next;
    if (this.lodMode === "sse") {
      this.paramsDirty = true;
    }
  }

  /** [ssog-23] runtime dials (A/B): fine tolerance, base tolerance, dwell */
  setSseError(finePx: number, basePx?: number, dwellMs?: number) {
    if (Number.isFinite(finePx) && finePx > 0) {
      this.sseErrorPx = finePx;
    }
    if (typeof basePx === "number" && Number.isFinite(basePx)) {
      this.sseBaseErrorPx = basePx;
    }
    if (typeof dwellMs === "number" && Number.isFinite(dwellMs)) {
      this.sseDwellMs = Math.max(0, dwellMs);
    }
    if (this.lodMode === "sse") {
      this.paramsDirty = true;
    }
  }

  /** [ssog-23] the tolerance the next selection will use */
  private sseTolerance(): number {
    const baseActive =
      this.sseDwellMs > 0 &&
      this.sseBaseErrorPx > this.sseErrorPx &&
      performance.now() - this.lastMotionMs < this.sseDwellMs;
    this.ssePhase = baseActive ? "base" : "fine";
    return baseActive ? this.sseBaseErrorPx : this.sseErrorPx;
  }

  // ---- gates ---------------------------------------------------------------

  private gatesPass(camera: THREE.PerspectiveCamera): boolean {
    if (this.paramsDirty || !this.converged) {
      return true;
    }
    const pager = this.splats.pager;
    if (
      pager &&
      (pager.fetched.length > 0 ||
        pager.newUploads.length > 0 ||
        pager.readyUploads.length > 0 ||
        pager.fetchers.length > 0)
    ) {
      return true; // resource-arrival
    }
    if (!this.lastPose.valid) {
      return true;
    }
    this.cameraLocal(camera);
    const moveGate =
      this.moveGateOverride ?? this.moveGateFactor * this.lodBaseDistance;
    if (this.tmpPos.distanceTo(this.lastPose.pos) > moveGate) {
      return true; // moved
    }
    // rotation angle > 90° ⇔ |quat dot| < cos(45°)
    if (Math.abs(this.tmpQuat.dot(this.lastPose.quat)) < Math.SQRT1_2) {
      return true;
    }
    if (
      Math.abs(camera.fov - this.lastPose.fov) >
      0.02 * Math.max(1e-6, this.lastPose.fov)
    ) {
      return true; // FOV Δ > 2%
    }
    return false;
  }

  /** camera pose in mesh-local space → tmpPos/tmpFwd/tmpQuat + uniformScale */
  private cameraLocal(camera: THREE.PerspectiveCamera): number {
    this.tmpMat.copy(this.mesh.matrixWorld).invert();
    this.tmpPos.setFromMatrixPosition(camera.matrixWorld);
    this.tmpPos.applyMatrix4(this.tmpMat);
    this.tmpFwd.set(0, 0, -1).transformDirection(camera.matrixWorld);
    // rotate (not translate) into local space
    this.tmpFwd.transformDirection(this.tmpMat);
    this.tmpQuat.setFromRotationMatrix(camera.matrixWorld);
    this.mesh.getWorldScale(this.tmpScale);
    return this.tmpScale.x || 1;
  }

  private markPose(camera: THREE.PerspectiveCamera) {
    this.lastPose.valid = true;
    this.lastPose.pos.copy(this.tmpPos);
    this.lastPose.quat.copy(this.tmpQuat);
    this.lastPose.fov = camera.fov;
  }

  /**
   * [ssog-24] mirror the byte counters of the unit cache and the pager into
   * stats every frame (not per tick: downloads finish and abort between
   * ticks, and a converged controller stops ticking while transfers drain).
   */
  private syncByteStats() {
    const cs = this.splats.cache.stats;
    this.stats.fetchCancels = cs.fetchCancels;
    this.stats.cancelSavedBytes = cs.cancelSavedBytes;
    this.stats.cancelSavedEstimateBytes = cs.cancelSavedEstimateBytes;
    this.stats.bytesReceived = cs.bytesReceived;
    this.stats.decodedBytesReceived = cs.decodedBytesReceived;
    this.stats.paletteFetches = cs.paletteFetches;
    this.stats.filesWithoutLength = cs.filesWithoutLength;
    this.stats.filesWithoutWireSize = cs.filesWithoutWireSize;
    const pager = this.splats.pager;
    if (pager) {
      this.stats.chunkCancels = pager.fetchCancels;
      this.stats.cancelRefetches = pager.cancelRefetches;
    }
  }

  // ---- §2.3 pump contract --------------------------------------------------

  private pump(priority: FetchPriorityEntry[]) {
    const pager = this.splats.pager;
    if (!pager) {
      return;
    }
    pager.fetchPriority = priority;
    pager.driveFetchers();
    // returned rad-tree updates DISCARDED by contract (they also feed on
    // every eviction and would otherwise grow unboundedly)
    pager.consumeLodTreeUpdates();
    pager.processUploads();
  }

  /** pages queued-but-not-yet-uploaded (recomputed per scan) */
  private pendingUploadPages(): Set<number> {
    const pager = this.splats.pager;
    const pending = new Set<number>();
    if (!pager) {
      return pending;
    }
    for (const u of pager.newUploads) {
      pending.add(u.page);
    }
    for (const u of pager.readyUploads) {
      pending.add(u.page);
    }
    return pending;
  }

  private chunkResidentUploaded(chunk: number, pending: Set<number>): boolean {
    const pager = this.splats.pager;
    if (!pager) {
      return false;
    }
    const pageLru = pager.getSplatsChunk(this.splats, chunk);
    if (!pageLru) {
      return false;
    }
    return !pending.has(pageLru.page);
  }

  // ---- displayed-chunk refcounts (block-aware pool guard) ------------------

  private addLeafRefs(li: number, level: number) {
    this.forEachLeafChunk(li, level, (c) => {
      this.chunkRefs.set(c, (this.chunkRefs.get(c) ?? 0) + 1);
    });
  }

  /**
   * [ssog-24] Mark a (leaf, level) ref's chunks as HAVING BEEN DISPLAYED.
   * Deliberately NOT folded into addLeafRefs: the grow path adds refs
   * TENTATIVELY and reverts them when the block-aware pool guard rejects the
   * flip, so marking there counted chunks that were never composed and made
   * wastedChunks/wastedBytes undercount exactly in the near, pool-limited
   * regime the metric exists to measure. Only committed flips mark.
   */
  private markDisplayed(li: number, level: number) {
    this.forEachLeafChunk(li, level, (c) => {
      this.everDisplayed.add(c);
    });
  }

  private removeLeafRefs(li: number, level: number) {
    this.forEachLeafChunk(li, level, (c) => {
      const n = (this.chunkRefs.get(c) ?? 0) - 1;
      if (n <= 0) {
        this.chunkRefs.delete(c);
      } else {
        this.chunkRefs.set(c, n);
      }
    });
  }

  /** pages tier 1+2 may occupy; leaves headroom for in-flight fetchers */
  private poolGuardLimit(): number {
    const pager = this.splats.pager;
    if (!pager) {
      return 0;
    }
    // [ssog-6] Whole-scene-resident pools need NO fetcher headroom: when
    // maxPages covers every block of the artifact nothing ever has to be
    // evicted to fetch, so reserving numFetchers pages would — on tiny
    // deep-ladder scenes, where the kroscloud.8 totalBlocks clamp makes
    // maxPages == totalBlocks < numFetchers — drive the limit to zero or
    // negative and defer EVERY grow flip forever (found live in the Phase D
    // mixed-band sweep: 20k/3-level fixture, 191 deferrals, 0 flips, ladder
    // pinned at coarsest). Production-scale artifacts (multi-level ⇒ >1M
    // splats ⇒ dozens of blocks ≫ numFetchers) never take this branch.
    if (pager.maxPages >= this.splats.model.totalBlocks) {
      return pager.maxPages;
    }
    return pager.maxPages - pager.numFetchers;
  }

  /**
   * [ssog-20] splat count a leaf currently contributes to the cut; 0 when the
   * leaf displays nothing (level −1: a reveal hole not yet laddered in).
   */
  private displayedCount(li: number): number {
    const lvl = this.displayed[li];
    return lvl < 0
      ? 0
      : this.splats.model.leafLods[(li * this.L + lvl) * 3 + 2];
  }

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
  private netPageDelta(
    li: number,
    to: number,
    from: number,
    refs: Int32Array,
  ): number {
    const model = this.splats.model;
    const L = this.L;
    let toFirst = 0;
    let toLast = -1;
    const toOff = (li * L + to) * 3;
    const toCount = to >= 0 ? model.leafLods[toOff + 2] : 0;
    if (toCount > 0) {
      const file = model.leafLods[toOff];
      const offset = model.leafLods[toOff + 1];
      toFirst = model.blockBase[file] + Math.floor(offset / SSOG_PAGE_SPLATS);
      toLast =
        model.blockBase[file] +
        Math.floor((offset + toCount - 1) / SSOG_PAGE_SPLATS);
    }
    let fromFirst = 0;
    let fromLast = -1;
    const fromOff = (li * L + from) * 3;
    const fromCount = from >= 0 ? model.leafLods[fromOff + 2] : 0;
    if (fromCount > 0) {
      const file = model.leafLods[fromOff];
      const offset = model.leafLods[fromOff + 1];
      fromFirst = model.blockBase[file] + Math.floor(offset / SSOG_PAGE_SPLATS);
      fromLast =
        model.blockBase[file] +
        Math.floor((offset + fromCount - 1) / SSOG_PAGE_SPLATS);
    }
    let delta = 0;
    for (let c = toFirst; c <= toLast; c++) {
      if (refs[c] === 0) {
        delta += 1;
      }
    }
    for (let c = fromFirst; c <= fromLast; c++) {
      if (refs[c] === 1 && !(c >= toFirst && c <= toLast)) {
        delta -= 1;
      }
    }
    return delta;
  }

  /** iterate global chunk ids of a (leaf, level) ref */
  private forEachLeafChunk(
    li: number,
    level: number,
    fn: (chunk: number) => void,
  ) {
    if (level < 0) {
      return; // [ssog-20] leaf not displayed (reveal hole) — no chunks
    }
    const model = this.splats.model;
    const o = (li * this.L + level) * 3;
    const file = model.leafLods[o];
    const offset = model.leafLods[o + 1];
    const count = model.leafLods[o + 2];
    if (count <= 0) {
      return;
    }
    const first = model.blockBase[file] + Math.floor(offset / SSOG_PAGE_SPLATS);
    const last =
      model.blockBase[file] +
      Math.floor((offset + count - 1) / SSOG_PAGE_SPLATS);
    for (let c = first; c <= last; c++) {
      fn(c);
    }
  }

  // ---- reveal --------------------------------------------------------------

  private revealTick(camera: THREE.PerspectiveCamera) {
    const priority: FetchPriorityEntry[] = this.pinnedChunks.map((chunk) => ({
      splats: this.splats,
      chunk,
    }));
    this.pump(priority);

    const pending = this.pendingUploadPages();
    let resident = 0;
    for (const chunk of this.pinnedChunks) {
      if (this.chunkResidentUploaded(chunk, pending)) {
        resident += 1;
      }
    }
    this.stats.revealResidentBlocks = resident;
    if (resident < this.pinnedChunks.length) {
      return;
    }

    // complete coarsest scene → first cut → activeSplats>0 fires (§2.7)
    //
    // [ssog-20] HOLE-FREE reveal: the pinned tier is every block of every
    // unit whose LEVEL is L−1, but SsogModel resolves a leaf's MISSING
    // coarsest level to the nearest available one — which can be FINER, in
    // a unit that is not pinned (56bg: 537 of 26,041 leaves, whose refs
    // live in 44 unpinned units). The old unconditional fill(L−1) therefore
    // composed a cut with those leaves as holes AND refcounted their
    // chunks, which staged all 44 units as tier-2 — 65 MB that appears in
    // no balanced cut, for 1,832 splats (2026-09-01 bandwidth findings).
    // Those leaves now display NOTHING until the normal ladder reaches
    // them, so the composed cut is exact — no missing-page compose noise
    // masking a real R7 stale-cut failure in the soak counters.
    // mesh.raycastIndices below is UNCHANGED by this: compose() used to
    // break out on the first non-resident chunk, so those rows never made
    // it into the published set either way.
    const model = this.splats.model;
    this.displayedTotal = 0;
    this.chunkRefs.clear();
    for (const chunk of this.pinnedChunks) {
      this.chunkRefs.set(chunk, 1); // permanent pin ref
      this.everDisplayed.add(chunk);
    }
    let holes = 0;
    for (let li = 0; li < this.NL; li++) {
      // pinned ⇔ the leaf's resolved-coarsest ref lives in a coarsest-LEVEL
      // unit (the pinned tier is every block of every such unit, and a leaf
      // level ref lives in exactly one file) — the definition, O(1).
      const o = (li * this.L + this.L - 1) * 3;
      const pinnedResident =
        model.leafLods[o + 2] <= 0 ||
        model.unitLevel[model.leafLods[o]] === this.L - 1;
      if (!pinnedResident) {
        this.displayed[li] = -1;
        holes += 1;
        continue;
      }
      this.displayed[li] = this.L - 1;
      this.displayedTotal +=
        model.leafLods[(li * this.L + this.L - 1) * 3 + 2];
      this.addLeafRefs(li, this.L - 1);
      // [ssog-24] the reveal cut IS displayed. Redundant with the pinned adds
      // above (a pinnedResident leaf's refs live in a coarsest-LEVEL unit, and
      // pinnedChunks is every block of every such unit) — kept so "displayed"
      // never depends on that superset argument holding.
      this.markDisplayed(li, this.L - 1);
    }
    this.desired.set(this.displayed);
    this.stats.revealHoleLeaves = holes;
    this.compose();
    // §2.7 raycast contract: the dblclick 5-ray median consensus reads its
    // bounded set from the PINNED coarsest level — a complete, view-
    // independent scene that is resident for the whole session (tier-1 pin
    // means these pool pages never move or evict). Published in leaf-table
    // order, so raycast RESULTS are deterministic across runs regardless of
    // page-assignment order. SplatMesh.raycast consumes this over the pool
    // CPU mirror with lodOpacity=false (rescale ≡ 1). Copy, don't alias —
    // this.cut is rewritten by every later recompose.
    this.mesh.raycastIndices = {
      numSplats: this.composedSplats,
      indices: this.cut.slice(0, this.composedSplats),
    };
    this.phase = "run";
    this.stats.phase = "run";
    this.converged = false; // ladder-up begins
    this.cameraLocal(camera);
    this.markPose(camera);
  }

  // ---- the full LOD tick (§2.4) --------------------------------------------

  private lodTick(camera: THREE.PerspectiveCamera) {
    const t0 = performance.now();
    this.paramsDirty = false;
    this.tickCount += 1;

    const uniformScale = this.cameraLocal(camera);

    // [ssog-23] motion bookkeeping for the base/fine dwell phases: a tick
    // that sees a real pose change (the same thresholds the motion gates
    // use) stamps lastMotionMs; sseTolerance() reads it inside selection.
    if (this.lodMode === "sse" && this.lastPose.valid) {
      const moveGate =
        this.moveGateOverride ?? this.moveGateFactor * this.lodBaseDistance;
      if (
        this.tmpPos.distanceTo(this.lastPose.pos) > moveGate ||
        Math.abs(this.tmpQuat.dot(this.lastPose.quat)) < Math.SQRT1_2 ||
        Math.abs(camera.fov - this.lastPose.fov) >
          0.02 * Math.max(1e-6, this.lastPose.fov)
      ) {
        this.lastMotionMs = performance.now();
      }
    }

    this.selectionAndBalance(camera, uniformScale);

    // [ssog-19] inner-loop budgetScale settling: the multi-tick feedback
    // walk staged a (superseded) full cut per tick and poisoned the
    // cooldown tier; iterating the SAME recurrence to its fixed point
    // inside this tick (selection-only passes, ~2-20 ms typical, ≤~100 ms
    // at the 64-iteration bound) reaches the same resting scale with ONE
    // staged cut.
    // Settled poses pay nothing (scaleMoved false). Skipped under
    // fetchHold — flights re-pose every tick and stage nothing anyway.
    if (this.scaleMoved && !this.fetchHold) {
      this.settleBudgetScale(camera, uniformScale);
      this.selectionAndBalance(camera, uniformScale);
    }

    // ---- swap state machine: desired = the balanced target DIRECTLY
    // (kroscloud.10 — upstream selectDesiredLodIndex semantics: one fetch +
    // one flip per leaf; the old one-step ladder popped every intermediate
    // level AND downloaded it just to show it for a tick). Cancel/retarget
    // is implicit — desired is recomputed from the CURRENT target every
    // tick, so an in-flight prefetch for an abandoned target simply falls
    // out of the priority tiers. ------------------------------------------
    let anyPending = false;
    for (let li = 0; li < this.NL; li++) {
      const target = this.balancedLevel[li];
      this.desired[li] = target;
      if (target !== this.displayed[li]) {
        anyPending = true;
      }
    }

    // ---- fetchPriority tiers ---------------------------------------------
    const pager = this.splats.pager;
    const maxPages = pager ? pager.maxPages : 0;
    const priority: FetchPriorityEntry[] = [];
    const seen = new Set<number>();
    const pushChunk = (chunk: number, refreshCooldown: boolean) => {
      if (seen.has(chunk)) {
        return;
      }
      seen.add(chunk);
      priority.push({ splats: this.splats, chunk });
      if (refreshCooldown) {
        this.chunkLastNeeded.set(chunk, this.tickCount);
      }
    };

    // tier 1 — coarsest PINNED
    for (const chunk of this.pinnedChunks) {
      pushChunk(chunk, true);
    }
    // tier 2 — displayed blocks (keep-old enforced via residency priority;
    // chunkRefs keys ARE exactly pinned ∪ displayed, guarded ≤ maxPages −
    // fetcher margin by the block-aware flip guard)
    for (const chunk of this.chunkRefs.keys()) {
      pushChunk(chunk, true);
    }

    // tier 3 — desired blocks, nearest-first, headroom-asserted per leaf.
    // [ssog-19] suppressed while a scripted flight holds fetches: every
    // motion tick re-targets a full budget-sized cut along the flight arc,
    // and staged fetches are never aborted — one 1 s POI flight swept
    // ~300-500 MB of never-displayed units (2026-08-31 bandwidth findings).
    // Tiers 1/2 keep residency (keep-old contract); the arrival tick stages
    // the destination cut (setFetchHold(false) sets paramsDirty).
    if (anyPending && !this.fetchHold) {
      const pendingLeaves: number[] = [];
      for (let li = 0; li < this.NL; li++) {
        if (this.desired[li] !== this.displayed[li]) {
          pendingLeaves.push(li);
        }
      }
      // [ssog-25] nearest to the interest point when the app set one
      // (orbit target), else nearest to the camera: the subject downloads first
      pendingLeaves.sort((a, b) => this.orderKey(a) - this.orderKey(b));

      const stage: number[] = [];
      let staged = true;
      for (const li of pendingLeaves) {
        stage.length = 0;
        this.forEachLeafChunk(li, this.desired[li], (c) => {
          if (!seen.has(c)) {
            stage.push(c);
          }
        });
        // free-pool headroom assert BEFORE staging (livelock guard §2.3):
        // every priority entry retains or will occupy a page — the tail
        // beyond maxPages is never fetched and resident overflow becomes
        // evictable.
        this.stats.headroomChecks += 1;
        const headroom = maxPages - seen.size;
        if (stage.length <= headroom) {
          for (const c of stage) {
            pushChunk(c, true);
          }
        } else {
          // sub-step staging fallback: stage what fits, then STOP staging
          // further (farther) leaves — stop, don't skip.
          this.stats.headroomStops += 1;
          for (let i = 0; i < headroom; i++) {
            pushChunk(stage[i], true);
          }
          staged = false;
        }
        if (!staged) {
          break;
        }
      }
    }

    if (seen.size > maxPages) {
      // must be impossible under the §2.3 pool formula — harness gate
      this.stats.headroomViolations += 1;
    }

    // tier 4 — cooldown (C4): recently-needed chunks stay warm in priority
    // (lowest tier, no cooldown refresh) while there is room; prune the rest.
    // [ssog-19 t4res] RESIDENT-only: a chunk that was staged, superseded and
    // EVICTED must not be re-downloaded just to keep it warm — idle fetchers
    // were draining ~95-140 MB/session of such re-fetches on fast links
    // (2026-08-31 bandwidth findings). Resident chunks keep their
    // eviction-protection listing exactly as before.
    for (const [chunk, t] of this.chunkLastNeeded) {
      if (this.tickCount - t >= this.cooldownTicks) {
        this.chunkLastNeeded.delete(chunk);
        continue;
      }
      if (
        priority.length < maxPages &&
        pager &&
        pager.getSplatsChunk(this.splats, chunk)
      ) {
        pushChunk(chunk, false);
      }
    }

    this.stats.priorityLen = priority.length;
    this.priorityChunks = seen;

    // ---- pump (§2.3 contract) --------------------------------------------
    this.pump(priority);

    // ---- flip scan (keep-old-until-resident; recomposition gated on the
    // WebGL2 sort-worker backpressure §2.4) --------------------------------
    if (this.isWebGL2 && this.sparkRenderer.sorting) {
      this.stats.deferredBySort += 1;
      this.flipRetryPending = anyPending;
      this.flipRetryFrames = 0;
    } else if (anyPending) {
      this.flipRetryPending = false;
      this.flipRetryFrames = 0;
      this.flipReadyLeaves();
    }

    this.markPose(camera);

    // converged = nothing left to ladder AND budgetScale settled (a walking
    // scale changes next tick's optimal even at a fixed pose — dead zone)
    let allAtTarget = true;
    for (let li = 0; li < this.NL; li++) {
      if (this.displayed[li] !== this.balancedLevel[li]) {
        allAtTarget = false;
        break;
      }
    }
    // ... OR pool-settled (see ticksNoProgress): the remaining flips are
    // deferred by the pool/capacity guards and nothing is in flight — at a
    // fixed pose that state is permanent by construction (the priority set,
    // residency, and guards are all pose-stable).
    const flipsSince = this.stats.flips - this.lastFlipsStat;
    this.lastFlipsStat = this.stats.flips;
    if (flipsSince > 0 || !anyPending) {
      this.ticksNoProgress = 0;
    } else {
      this.ticksNoProgress += 1;
    }
    const pagerQuiet =
      !pager ||
      (pager.fetchers.length === 0 &&
        pager.newUploads.length === 0 &&
        pager.readyUploads.length === 0);
    // [B4] heldPending blocks the pool-settled leg only — held flips are a
    // bounded state the quantized release resolves, but a latched converged
    // stops the metronome and would strand them.
    // [ssog-19] a fetch-held tick must never latch converged — tier-3 was
    // suppressed, so "no progress with a quiet pager" is not a settled state.
    this.converged =
      !this.fetchHold &&
      (allAtTarget ||
        (this.ticksNoProgress >= 3 && pagerQuiet && !this.heldPending)) &&
      !this.scaleMoved;

    this.stats.ticks = this.tickCount;
    this.stats.budgetScale = this.budgetScale;
    this.stats.composedSplats = this.composedSplats;
    this.stats.lastTickMs = performance.now() - t0;
  }

  // ---- [ssog-19] inner-loop budgetScale settling ---------------------------

  /**
   * Pure selection-only totalOptimal at a hypothetical budgetScale — the
   * same per-leaf math as selectionAndBalance's selection loop, writing
   * nothing. Uses tmpPos/tmpFwd prepared by the caller's cameraLocal().
   */
  private totalOptimalAt(
    camera: THREE.PerspectiveCamera,
    uniformScale: number,
    scale: number,
  ): number {
    const model = this.splats.model;
    const L = this.L;
    const NL = this.NL;
    const bounds = model.boundsFlat;
    const cam = this.tmpPos;
    const fwd = this.tmpFwd;

    const tanHalfV = Math.tan(((camera.fov / 2) * Math.PI) / 180);
    const tanHalfH = tanHalfV * camera.aspect;
    const fovScale =
      Math.min(tanHalfV, tanHalfH) / Math.tan((22.5 * Math.PI) / 180);

    const d0 = this.lodBaseDistance * scale;
    const mPrime = Math.max(1.2, 3 * scale ** -0.2);
    const logM = Math.log(mPrime);

    let totalOptimal = 0;
    const behind = this.behindPenalty;
    for (let li = 0; li < NL; li++) {
      const o = li * 6;
      const px = Math.max(bounds[o], Math.min(cam.x, bounds[o + 3]));
      const py = Math.max(bounds[o + 1], Math.min(cam.y, bounds[o + 4]));
      const pz = Math.max(bounds[o + 2], Math.min(cam.z, bounds[o + 5]));
      let dx = px - cam.x;
      let dy = py - cam.y;
      let dz = pz - cam.z;
      const d = Math.hypot(dx, dy, dz);
      let penalty = 1;
      if (d > 1e-9 && behind > 0) {
        dx /= d;
        dy /= d;
        dz /= d;
        const dot = fwd.x * dx + fwd.y * dy + fwd.z * dz;
        penalty = 1 + behind * Math.max(0, -dot);
      }
      const db = d * penalty * fovScale * uniformScale;
      let lvl = db <= d0 ? 0 : 1 + Math.floor(Math.log(db / d0) / logM);
      if (lvl < 0) {
        lvl = 0;
      }
      if (lvl >= L) {
        lvl = L - 1;
      }
      totalOptimal += model.leafLods[(li * L + lvl) * 3 + 2];
    }
    return totalOptimal;
  }

  /**
   * Iterate the EXACT budgetScale feedback recurrence (verbatim constants —
   * ·= 1 + (1/√ratio − 1)·0.3, clamp [0.01, 100], dead zone [0.6, 1.4]) to
   * its fixed point for the current pose. Same resting scale the multi-tick
   * walk reached, without staging a cut per intermediate step. Bounded at
   * 64 iterations (the 1→100 clamp walk is ~26; worst-case cost ≈ 100 ms
   * at 26K leaves, typical settles 2–20 ms); an unfinished walk simply
   * resumes the old per-tick behavior.
   */
  private settleBudgetScale(
    camera: THREE.PerspectiveCamera,
    uniformScale: number,
  ) {
    let scale = this.budgetScale;
    for (let i = 0; i < 64; i++) {
      const totalOptimal = this.totalOptimalAt(camera, uniformScale, scale);
      const ratio = totalOptimal / this.budget;
      if (ratio <= 1.4 && ratio >= 0.6) {
        break; // dead zone — settled
      }
      const next = Math.max(
        0.01,
        Math.min(100, scale * (1 + (1 / Math.sqrt(ratio) - 1) * 0.3)),
      );
      if (next === scale) {
        break; // clamp-stuck
      }
      scale = next;
    }
    this.budgetScale = scale;
  }

  // ---- §2.4 selection + balancer + budgetScale (P0d structural port) -------

  private selectionAndBalance(
    camera: THREE.PerspectiveCamera,
    uniformScale: number,
  ) {
    const model = this.splats.model;
    const L = this.L;
    const NL = this.NL;
    const bounds = model.boundsFlat;
    const cam = this.tmpPos;
    const fwd = this.tmpFwd;

    const tanHalfV = Math.tan(((camera.fov / 2) * Math.PI) / 180);
    const tanHalfH = tanHalfV * camera.aspect;
    const fovScale =
      Math.min(tanHalfV, tanHalfH) / Math.tan((22.5 * Math.PI) / 180);

    // [ssog-25] interest point into the mesh frame (tmpMat = mesh inverse,
    // refreshed by cameraLocal at the top of this tick) — the ordering key
    // below is the closest-point distance from it, no behind penalty, no
    // FOV scale: it ranks, it does not select.
    const interest = this.interest
      ? this.tmpInterest.copy(this.interest).applyMatrix4(this.tmpMat)
      : null;
    this.stats.interestMode = interest ? "target" : "camera";

    // [ssog-23] sse: bands calibrated in pixels, terminated. L1 is acceptable
    // where its merge error err1 (mesh-local) projects to <= e px through
    // f_px_ref = (viewportH/2)/tan(22.5deg) — db below already carries the
    // camera FOV via fovScale (normalised to the 45deg reference) and the
    // mesh world scale via uniformScale, so d0 is scaled by uniformScale
    // too and the comparison db <= d0 is exactly err1*f_px/(d*penalty) <= e.
    // Multiplier sqrt(2): each coarser level halves the rows, so its spacing
    // (and merge error) grows by sqrt(2). No budgetScale feedback.
    const sse = this.lodMode === "sse";
    let sseD0 = 0;
    if (sse) {
      const e = this.sseTolerance();
      const fpxRef = this.viewportHeightPx / 2 / Math.tan((22.5 * Math.PI) / 180);
      sseD0 = (this.sseErr1 * uniformScale * fpxRef) / e;
      this.stats.sseErrorPx = e;
      this.stats.ssePhase = this.ssePhase;
      this.stats.sseD0 = sseD0;
    }
    const d0 = sse ? sseD0 : this.lodBaseDistance * this.budgetScale;
    const mPrime = sse ? Math.SQRT2 : Math.max(1.2, 3 * this.budgetScale ** -0.2);
    const logM = Math.log(mPrime);

    const rb = model.rootBound;
    const cx = (rb.min[0] + rb.max[0]) / 2;
    const cy = (rb.min[1] + rb.max[1]) / 2;
    const cz = (rb.min[2] + rb.max[2]) / 2;
    const radius =
      0.5 *
      Math.hypot(
        rb.max[0] - rb.min[0],
        rb.max[1] - rb.min[1],
        rb.max[2] - rb.min[2],
      );
    const dMax = Math.max(
      1,
      Math.hypot(cam.x - cx, cam.y - cy, cam.z - cz) + radius,
    );
    const sqrtDMax = Math.sqrt(dMax);
    // [ssog-26] k = 0 → the cut is a sphere around the camera and turning in
    // place re-fetches nothing; k = 4 → ×5 straight behind (legacy).
    const behind = this.behindPenalty;

    let totalOptimal = 0;
    for (let li = 0; li < NL; li++) {
      const o = li * 6;
      const px = Math.max(bounds[o], Math.min(cam.x, bounds[o + 3]));
      const py = Math.max(bounds[o + 1], Math.min(cam.y, bounds[o + 4]));
      const pz = Math.max(bounds[o + 2], Math.min(cam.z, bounds[o + 5]));
      let dx = px - cam.x;
      let dy = py - cam.y;
      let dz = pz - cam.z;
      const d = Math.hypot(dx, dy, dz);
      let penalty = 1;
      if (d > 1e-9 && behind > 0) {
        dx /= d;
        dy /= d;
        dz /= d;
        const dot = fwd.x * dx + fwd.y * dy + fwd.z * dz;
        penalty = 1 + behind * Math.max(0, -dot); // ×1 in view → ×(1+k) behind
      }
      // §2.4 pinned: d_bucket = penalizedDistance·fovScale·uniformScale —
      // the SAME value drives selection AND bucketing.
      const db = d * penalty * fovScale * uniformScale;
      this.dBucket[li] = db;
      if (interest) {
        const tx =
          Math.max(bounds[o], Math.min(interest.x, bounds[o + 3])) - interest.x;
        const ty =
          Math.max(bounds[o + 1], Math.min(interest.y, bounds[o + 4])) -
          interest.y;
        const tz =
          Math.max(bounds[o + 2], Math.min(interest.z, bounds[o + 5])) -
          interest.z;
        this.tBucket[li] = Math.hypot(tx, ty, tz);
      }
      this.bucketOf[li] = Math.min(
        63,
        Math.floor((64 * Math.sqrt(db)) / sqrtDMax),
      );
      let lvl = db <= d0 ? 0 : 1 + Math.floor(Math.log(db / d0) / logM);
      if (lvl < 0) {
        lvl = 0;
      }
      if (lvl >= L) {
        lvl = L - 1;
      }
      this.optimalLevel[li] = lvl;
      totalOptimal += model.leafLods[(li * L + lvl) * 3 + 2];
    }

    // [ssog-17 perf] bucket-ordered leaf index (counting sort, stable in
    // li): both balancer passes below visit leaves in exactly the former
    // (bucket, li-ascending) order, so the output is bit-identical to the
    // old 64×NL rescans at a fraction of the cost.
    const bucketOrder = this.bucketOrder;
    const bucketStart = this.bucketStart;
    const bucketCursor = this.bucketCursor;
    bucketStart.fill(0);
    for (let li = 0; li < NL; li++) {
      bucketStart[this.bucketOf[li] + 1]++;
    }
    for (let b = 0; b < 64; b++) {
      bucketStart[b + 1] += bucketStart[b];
      bucketCursor[b] = bucketStart[b];
    }
    for (let li = 0; li < NL; li++) {
      bucketOrder[bucketCursor[this.bucketOf[li]]++] = li;
    }

    // ---- balancer (C9 shape; [ssog-14] fill, now [ssog-17] page-aware) ----
    this.balancedLevel.set(this.optimalLevel);
    let totalBalanced = totalOptimal;
    const budget = this.budget;
    if (totalBalanced > budget) {
      let passes = 0;
      demote: while (totalBalanced > budget && passes < L) {
        passes++;
        for (let b = 63; b >= 0; b--) {
          for (let i = bucketStart[b]; i < bucketStart[b + 1]; i++) {
            const li = bucketOrder[i];
            const cur = this.balancedLevel[li];
            if (cur >= L - 1) {
              continue;
            }
            const curCount = model.leafLods[(li * L + cur) * 3 + 2];
            const nextCount = model.leafLods[(li * L + cur + 1) * 3 + 2];
            this.balancedLevel[li] = cur + 1;
            totalBalanced += nextCount - curCount; // aliased demote may free 0
            if (totalBalanced <= budget) {
              break demote;
            }
          }
        }
        // exhaustion: soft target (§2.4) — all at coarsest is legal; the
        // capacity policy absorbs it
      }
    }

    // ---- [ssog-17] page-feasibility + page-aware promote-to-fill ----------
    // (kroscloud.27 — 2026-08-31 pool-binder verification on the live 20M
    // artifact.) The splat budget is not the only resource: the displayed
    // cut occupies whole 64K-splat pool pages per touched unit block, and on
    // heavily-chunked trees the cut's page occupancy runs FAR below the
    // pool calibration (56bg: 1,139 single-page units, ~52% intrinsic fill,
    // displayed-cut occupancy measured 17–33% — a 4M cut demanded 205–376
    // pages against a 137-page guard). A page-blind balanced target then
    // dies at the flip guard: 12–21K grow flips per pose were vetoed
    // path-dependently by arrival order, and the pool-settled latch froze a
    // run-to-run DIFFERENT ~2.3–3M subset (the observed unreliability).
    // Fix: balance PAGES here in the selection so the final cut is
    // pool-feasible BY CONSTRUCTION — deterministic per pose, poolDeferrals
    // ≈ 0 at rest; the flip-time guard and the latch stay as backstops.
    //   - final-cut page demand is refcounted incrementally (pageRefs
    //     scratch seeded with the pinned tier; promotes MOVE a leaf's refs
    //     between levels, so freed pages are reusable within the same pass);
    //   - if the post-demote (or optimal) target is already page-infeasible,
    //     reset to per-leaf coarsest (≈ the pinned tier) and let the fill
    //     rebuild nearest-first;
    //   - the fill gets a DUAL fit-check: splat overflow → break (C9
    //     stop-don't-skip, unchanged axis); PAGE overflow → revert the
    //     tentative ref move and CONTINUE (skip) — a farther leaf may
    //     promote onto pages already paid for, which is the right page
    //     economics (measured on the live artifact: skip-not-stop composes
    //     2.8–3.1M deterministically at a 141-page pool where stop-on-miss
    //     or post-hoc farthest-first page-shedding collapse to 0.6–2.1M).
    // Margin: (maxLeafBlockFootprint + numFetchers) pages — the same
    // quantified slack SsogSplats reserves — covers keep-old transition
    // overlap (shrink flips land first and free refs; deferred grows retry
    // every tick). Whole-scene-resident pools skip enforcement (the
    // [ssog-6] class: demand can never exceed totalBlocks ≤ maxPages).
    // NOTE: diverges further from the P0d bench — it has no page model.
    const pager = this.splats.pager;
    const wholeResident = !pager || pager.maxPages >= model.totalBlocks;
    // NOTE: poolGuardLimit() already reserves numFetchers, so the margin
    // double-counts them (total slack = mLBF + 2·nF pages). INTENTIONAL —
    // conservative, and the validated simulation numbers include it; do not
    // "fix" without re-running the sim.
    const pageLimit = wholeResident
      ? Number.POSITIVE_INFINITY
      : this.poolGuardLimit() -
        (model.maxLeafBlockFootprint + pager.numFetchers);

    const pageRefs = this.pageRefs;
    pageRefs.fill(0);
    let distinctPages = 0;
    for (const c of this.pinnedChunks) {
      if (pageRefs[c] === 0) {
        distinctPages++;
      }
      pageRefs[c]++;
    }
    for (let li = 0; li < NL; li++) {
      distinctPages = this.bumpLeafPageRefs(
        li,
        this.balancedLevel[li],
        pageRefs,
        distinctPages,
        1,
      );
    }

    if (distinctPages > pageLimit) {
      // page-infeasible target: reset to per-leaf coarsest (its refs are
      // ≈ the pinned tier — resolved-missing coarsest slots can point at a
      // finer unit, so refs are recomputed, not assumed) and rebuild below.
      totalBalanced = 0;
      pageRefs.fill(0);
      distinctPages = 0;
      for (const c of this.pinnedChunks) {
        if (pageRefs[c] === 0) {
          distinctPages++;
        }
        pageRefs[c]++;
      }
      for (let li = 0; li < NL; li++) {
        this.balancedLevel[li] = L - 1;
        totalBalanced += model.leafLods[(li * L + L - 1) * 3 + 2];
        distinctPages = this.bumpLeafPageRefs(
          li,
          L - 1,
          pageRefs,
          distinctPages,
          1,
        );
      }
    }

    // [ssog-14] promote-to-fill (supersplat GSplatBudgetBalancer parity —
    // the budget is a soft TARGET, not just a ceiling; without this leg any
    // in-dead-zone selection rested permanently at 0.6–1.4× budget). Walk
    // nearest-first (bucket 0→63), one level per leaf per pass, PAST
    // optimal down to L0, while BOTH resources fit. ≤ L−1 passes + all-skip
    // early exit; deterministic per pose so allAtTarget still latches;
    // budgetScale feedback stays on totalOptimal (below). Runs after BOTH
    // demote and reset paths — a demote result already at budget breaks on
    // its first splat check. Aliased promotes may add 0 splats/pages (same
    // accepted class as the aliased-demote note above).
    // [ssog-20] ...and its currency is PAGES, not splats. A promoted leaf
    // costs a WHOLE unit download (~1–1.5 MB on production trees) however
    // few of its rows the cut composes, so a splat-only cap spends the
    // budget in the most expensive possible way: at a far pose the fill
    // spread 8M splats over 302 extra units = 452 MB, 83% of the session's
    // bytes, on detail the distance bands themselves called unnecessary
    // (2026-09-01 bandwidth findings). Two phases, both nearest-first:
    //   phase 1 — promote only where the finer refs cost no NEW page
    //             (page-count-neutral; a swap that frees its old page may
    //             still fetch a new one);
    //   phase 2 — promote into new pages until the page budget is spent.
    // The budget is the page count the splat budget can actually fill at a
    // realistic row utilization, so it auto-scales with the artifact's unit
    // size (measured optimum on the live 20M tree: ~300 pages at 32K units;
    // the same formula gives ~345 after a 28K rebuild, matching the
    // independently derived re-tune target). Whole-resident pools skip it
    // entirely — every page is downloaded anyway.
    const FILL_UTILIZATION = 0.78;
    const avgPageSplats = model.count / Math.max(1, model.totalBlocks);
    const autoFillCap = Math.ceil(
      this.budget / Math.max(1, avgPageSplats * FILL_UTILIZATION),
    );
    const fillPageCap = wholeResident
      ? Number.POSITIVE_INFINITY
      : Math.min(pageLimit, this.fillPageCapOption ?? autoFillCap);
    const basePages = distinctPages;

    const runFill = (cap: number) => {
      let passes = 0;
      promote: while (passes < L - 1) {
        passes++;
        let promoted = false;
        for (let b = 0; b < 64; b++) {
          for (let i = bucketStart[b]; i < bucketStart[b + 1]; i++) {
            const li = bucketOrder[i];
            const cur = this.balancedLevel[li];
            if (cur <= 0) {
              continue; // already finest
            }
            if (sse && cur - 1 < this.optimalLevel[li]) {
              // [ssog-23] termination: never finer than the error rule allows
              continue;
            }
            const curCount = model.leafLods[(li * L + cur) * 3 + 2];
            const finer = model.leafLods[(li * L + cur - 1) * 3 + 2];
            if (totalBalanced - curCount + finer > budget) {
              break promote; // stop, don't skip (C9, splat axis)
            }
            if (cap !== Number.POSITIVE_INFINITY) {
              // Price the move read-only, then apply only if it fits: the
              // old bump→test→revert cost four span walks per REJECTED
              // candidate, and at cap saturation the overwhelming majority
              // are rejected (~87k/tick measured at 26k leaves).
              if (
                distinctPages + this.netPageDelta(li, cur - 1, cur, pageRefs) >
                cap
              ) {
                // SKIP on the page axis (stop-don't-skip here was measured
                // to collapse the cut — see the [ssog-17] note).
                continue;
              }
              distinctPages = this.bumpLeafPageRefs(
                li,
                cur - 1,
                pageRefs,
                distinctPages,
                1,
              );
              distinctPages = this.bumpLeafPageRefs(
                li,
                cur,
                pageRefs,
                distinctPages,
                -1,
              );
            }
            this.balancedLevel[li] = cur - 1;
            totalBalanced += finer - curCount;
            promoted = true;
          }
        }
        if (!promoted) {
          break;
        }
      }
    };

    if (wholeResident) {
      // [ssog-6] class: every page is resident, so there is no page axis at
      // all — one unbounded splat-greedy fill, byte-identical to [ssog-17].
      runFill(Number.POSITIVE_INFINITY);
    } else {
      runFill(basePages); // free: refine only into pages already in the cut
      if (fillPageCap > basePages) {
        runFill(fillPageCap); // paid: nearest-first into new pages, capped
      }
    }

    this.stats.balancedPages = distinctPages;
    this.stats.fillPageCap =
      fillPageCap === Number.POSITIVE_INFINITY ? 0 : fillPageCap;
    // 0 when nothing is enforced (whole-resident pool) so the HUD's "gN"
    // marker only appears where the page budget actually binds.
    this.stats.pageLimit = wholeResident ? 0 : pageLimit;

    // ---- budgetScale feedback (verbatim constants) ------------------------
    // [ssog-23] sse: no feedback — the pixel tolerance is the dial and the
    // budget is a ceiling only; budgetScale stays 1 and never "moves".
    const ratio = totalOptimal / budget;
    if (sse) {
      this.scaleMoved = false;
    } else if (ratio > 1.4 || ratio < 0.6) {
      const before = this.budgetScale;
      this.budgetScale *= 1 + (1 / Math.sqrt(ratio) - 1) * 0.3;
      this.budgetScale = Math.max(0.01, Math.min(100, this.budgetScale));
      this.scaleMoved = this.budgetScale !== before;
    } else {
      this.scaleMoved = false;
    }

    this.stats.totalOptimal = totalOptimal;
    this.stats.totalBalanced = totalBalanced;
  }

  // ---- swap flips ----------------------------------------------------------

  private flipReadyLeaves() {
    // INVARIANT: `desired` is rewritten from balancedLevel (always 0…L−1)
    // at the top of every lodTick before anything here runs, and this never
    // runs before the first lodTick — so `to` is never −1 and the leafLods
    // indexing below needs no guard. `from` (= displayed) CAN be −1 (an
    // [ssog-20] reveal hole); every read of it goes through displayedCount
    // or forEachLeafChunk, both of which handle −1.
    const model = this.splats.model;
    const pending = this.pendingUploadPages();

    // ready = ALL blocks of (leaf, desired) resident AND uploaded.
    // [B4] grow readiness is additionally tallied per desired unit FILE:
    // upstream's apply granule is a file arrival (all leaves waiting on one
    // file swap in the same update), so a ready grow leaf holds — at most
    // flipBatchTicks — until its file's whole pending cohort is ready, and
    // refinement lands as few spatially-coherent waves instead of a
    // per-block trickle.
    const readyShrink: number[] = [];
    const readyGrow: number[] = [];
    const growPendingByFile = new Map<number, number>();
    const growReadyByFile = new Map<number, number>();
    for (let li = 0; li < this.NL; li++) {
      const to = this.desired[li];
      const from = this.displayed[li];
      if (to === from) {
        this.readySinceTick[li] = -1;
        continue;
      }
      const o = (li * this.L + to) * 3;
      // [ssog-20] from may be −1 (reveal hole) — contributes 0 rows, so the
      // flip is classified as a GROW (it adds content and needs pool pages)
      const delta = model.leafLods[o + 2] - this.displayedCount(li);
      const grow = delta > 0;
      const file = grow && model.leafLods[o + 2] > 0 ? model.leafLods[o] : -1;
      if (file >= 0) {
        growPendingByFile.set(file, (growPendingByFile.get(file) ?? 0) + 1);
      }
      let ready = true;
      this.forEachLeafChunk(li, to, (c) => {
        // resident+uploaded AND priority-protected THIS tick (see
        // priorityChunks — an unprotected resident chunk is evictable
        // between ticks, so flipping onto it would risk a hole)
        if (
          ready &&
          (!this.priorityChunks.has(c) ||
            !this.chunkResidentUploaded(c, pending))
        ) {
          ready = false;
        }
      });
      if (!ready) {
        this.readySinceTick[li] = -1;
        continue;
      }
      if (!grow) {
        this.readySinceTick[li] = -1;
        // [ssog-21] Under a scripted-flight hold, shrinks are suppressed
        // too. Tier-3 staging is already held, so nothing can grow — but
        // shrinks were still landing immediately, collapsing the departure
        // pose's working set onto the pinned coarsest tier mid-flight.
        // removeLeafRefs then drops those chunks out of tier 2, the
        // saturated tier-4 cooldown cannot re-protect them, their pages
        // become freeable, and the ARRIVAL re-downloads what the flight
        // just discarded (measured: 487 units per POI click where a
        // properly held flight needs 174-214). Holding the displayed set
        // still is free: no grow can become ready under the hold, so
        // displayedTotal, capacitySplats and chunkRefs cannot increase.
        if (!this.fetchHold) {
          readyShrink.push(li);
        }
      } else {
        if (file >= 0) {
          growReadyByFile.set(file, (growReadyByFile.get(file) ?? 0) + 1);
        }
        readyGrow.push(li);
      }
    }

    // [B4] wave eligibility: complete file cohort, no file data, or hold
    // expired. A capacity/pool-deferred flip keeps its aging hold stamp so
    // the deferral never extends the wave window. Deadline releases are
    // QUANTIZED to flipBatchTicks boundaries — with per-leaf deadlines
    // alone, staggered readiness released a partial wave EVERY tick under
    // sustained streaming (measured: dolly event count unchanged at ~1 per
    // tick, batchHolds 7.5k); quantizing bounds the incomplete-cohort event
    // rate to 1 per flipBatchTicks ticks. Worst hold = 2·flipBatchTicks − 1
    // ticks (~500 ms at defaults). Complete cohorts still land immediately.
    const releaseTick =
      this.flipBatchTicks <= 0 ||
      this.tickCount % this.flipBatchTicks === 0;
    let held = 0;
    const eligibleGrow: number[] = [];
    for (const li of readyGrow) {
      const o = (li * this.L + this.desired[li]) * 3;
      const file = model.leafLods[o + 2] > 0 ? model.leafLods[o] : -1;
      if (
        file < 0 ||
        growReadyByFile.get(file) === growPendingByFile.get(file)
      ) {
        eligibleGrow.push(li);
        continue;
      }
      if (this.readySinceTick[li] < 0) {
        this.readySinceTick[li] = this.tickCount;
      }
      if (
        releaseTick &&
        this.tickCount - this.readySinceTick[li] >= this.flipBatchTicks
      ) {
        eligibleGrow.push(li);
      } else {
        held += 1;
        this.stats.batchHolds += 1;
      }
    }
    this.heldPending = held > 0;
    if (readyShrink.length === 0 && eligibleGrow.length === 0) {
      return;
    }

    // flip every ready leaf in the same tick; shrink first so a transient
    // grow+shrink mix can't overflow the fixed capacity. Grow flips defer on
    // EITHER fixed-capacity overflow (splat rows — no regrow ever) OR the
    // block-aware pool guard (displayed+pinned chunk set must stay ≤
    // maxPages − fetcher margin, else driveFetchers' overflow path would
    // evict displayed pages → stale cut entries, the R7 failure). Shrink
    // flips bypass the pool guard: their transient overshoot is ≤ one leaf's
    // block footprint, which the §2.3 slack term covers.
    const poolLimit = this.poolGuardLimit();
    let flipped = 0;
    const applyFlip = (li: number, to: number) => {
      this.removeLeafRefs(li, this.displayed[li]); // no-op at level −1
      this.addLeafRefs(li, to);
      this.markDisplayed(li, to); // [ssog-24] this flip COMMITS
      this.displayedTotal +=
        model.leafLods[(li * this.L + to) * 3 + 2] - this.displayedCount(li);
      this.displayed[li] = to;
      this.readySinceTick[li] = -1;
      flipped += 1;
    };
    for (const li of readyShrink) {
      applyFlip(li, this.desired[li]);
    }
    // nearest-first so pool headroom goes to the leaves that matter most —
    // [ssog-25] nearest to the INTEREST point (orbit target) when the app set
    // one, else to the camera. Demotion above stays camera-ordered on
    // purpose (measured: target-ordering it coarsens the subject).
    eligibleGrow.sort((a, b) => this.orderKey(a) - this.orderKey(b));
    const subjectHalf = eligibleGrow.length >> 1;
    for (let gi = 0; gi < eligibleGrow.length; gi++) {
      const li = eligibleGrow[gi];
      const to = this.desired[li];
      const from = this.displayed[li];
      const delta =
        model.leafLods[(li * this.L + to) * 3 + 2] - this.displayedCount(li);
      if (this.displayedTotal + delta > this.splats.capacitySplats) {
        this.stats.capacityDeferrals += 1;
        if (gi < subjectHalf) {
          this.stats.subjectDeferrals += 1;
        }
        continue;
      }
      // tentative block accounting; revert on pool-guard overflow
      this.removeLeafRefs(li, from);
      this.addLeafRefs(li, to);
      if (this.chunkRefs.size > poolLimit) {
        this.removeLeafRefs(li, to);
        this.addLeafRefs(li, from);
        this.stats.poolDeferrals += 1;
        if (gi < subjectHalf) {
          this.stats.subjectDeferrals += 1;
        }
        continue;
      }
      // [ssog-24] past the pool guard the grow COMMITS — only now do these
      // chunks count as displayed (the reverted branch above must not).
      this.markDisplayed(li, to);
      this.displayedTotal += delta;
      this.displayed[li] = to;
      this.readySinceTick[li] = -1;
      flipped += 1;
    }
    this.stats.displayedChunkCount = this.chunkRefs.size;
    if (flipped === 0) {
      return;
    }
    this.stats.flips += flipped;
    this.compose();
  }

  // ---- composition ---------------------------------------------------------

  /**
   * Recompose the whole cut from displayed[] (per-leaf runs of consecutive
   * pool indices, ≤2 block-split sub-runs per §2.4), publish ONCE: row-padded
   * array (P0b writeTexture contract), numSplats together, mappingVersion
   * bump so both backends' same-frame-resort gates fire.
   */
  private compose() {
    const model = this.splats.model;
    const pager = this.splats.pager;
    if (!pager) {
      return;
    }
    const cut = this.cut;
    const capacity = this.splats.capacitySplats;
    let w = 0;
    for (let li = 0; li < this.NL; li++) {
      if (this.displayed[li] < 0) {
        continue; // [ssog-20] leaf displays nothing yet
      }
      const o = (li * this.L + this.displayed[li]) * 3;
      const file = model.leafLods[o];
      const offset = model.leafLods[o + 1];
      const count = model.leafLods[o + 2];
      if (count <= 0) {
        continue;
      }
      if (w + count > capacity) {
        // must be unreachable (flip guard) — never truncate a leaf mid-run
        this.stats.capacityOverflowInCompose += 1;
        break;
      }
      let row = offset;
      let remaining = count;
      while (remaining > 0) {
        const block = Math.floor(row / SSOG_PAGE_SPLATS);
        const chunk = model.blockBase[file] + block;
        const slot = row % SSOG_PAGE_SPLATS;
        const pageLru = pager.getSplatsChunk(this.splats, chunk);
        if (!pageLru) {
          // stale-cut guard: displayed blocks are tier-2 protected; a miss
          // here is a bug the soak gate must catch.
          this.stats.missingPagesInCompose += 1;
          if (this.stats.missingSamples.length < 20) {
            this.stats.missingSamples.push({
              tick: this.tickCount,
              li,
              level: this.displayed[li],
              chunk,
              mapped: false,
            });
          }
          break;
        }
        const base = pageLru.page * SSOG_PAGE_SPLATS + slot;
        const run = Math.min(remaining, SSOG_PAGE_SPLATS - slot);
        for (let i = 0; i < run; i++) {
          cut[w++] = base + i;
        }
        row += run;
        remaining -= run;
      }
    }
    cut.fill(0, w); // zero-padded tail — traverse-identical semantics (P0b)

    this.composedSplats = w;
    this.splats.update(w, cut, this.splats.capacityRows);
    this.mesh.updateMappingVersion();
    this.sparkRenderer.setDirty();
    this.stats.recomposes += 1;
    this.stats.composedSplats = w;
  }

  // ---- debug / harness -----------------------------------------------------

  /**
   * Soak-gate sweep: verify every leaf's displayed blocks still map to live
   * pages owned by (this.splats, that chunk) — zero stale entries expected.
   */
  verifyCut(): { checked: number; stale: number } {
    const model = this.splats.model;
    const pager = this.splats.pager;
    let checked = 0;
    let stale = 0;
    if (!pager || this.phase !== "run") {
      return { checked, stale };
    }
    for (let li = 0; li < this.NL; li++) {
      this.forEachLeafChunk(li, this.displayed[li], (chunk) => {
        checked += 1;
        const pageLru = pager.getSplatsChunk(this.splats, chunk);
        if (!pageLru) {
          stale += 1;
          return;
        }
        const owner = pager.pageToSplatsChunk[pageLru.page];
        if (!owner || owner.splats !== this.splats || owner.chunk !== chunk) {
          stale += 1;
        }
      });
    }
    return { checked, stale };
  }

  /** per-level displayed splat totals (HUD readout) */
  displayedByLevel(): number[] {
    const model = this.splats.model;
    const out = new Array<number>(this.L).fill(0);
    if (this.phase !== "run") {
      return out;
    }
    for (let li = 0; li < this.NL; li++) {
      const lvl = this.displayed[li];
      if (lvl < 0) {
        continue; // [ssog-20] not displayed
      }
      out[lvl] += model.leafLods[(li * this.L + lvl) * 3 + 2];
    }
    return out;
  }
}

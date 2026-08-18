// Kroscloud fork — ssog module [ssog-2]. See FORK-CHANGES.md.
//
// SsogLodController — the supersplat-equivalent runtime (plan §2.4, constants
// pinned; structural port of the P0d-proven balancer bench
// poc/ssog-p0/p0d-balancer.mjs where they overlap):
//   - FOV-compensated distance-band selection with the ×1→×5 behind-camera
//     penalty; d0 = lodBaseDistance·budgetScale with lodBaseDistance =
//     (5/16)·chunkExtent (C3); m′ = max(1.2, 3·budgetScale^−0.2);
//   - 64-√bucket balancer: farthest-first demote one level per leaf per pass
//     with early-exit, nearest-first promote with fit-check-before-apply and
//     stop-don't-skip (C9); d_bucket includes penalty AND fovScale AND
//     uniformScale (the pinned definition);
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
  /** builder --lod-chunk-extent (default 16) — feeds d0 = (5/16)·extent (C3) */
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

  /** pinned coarsest chunk ids (computed once) */
  private readonly pinnedChunks: number[];

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
  };

  constructor(options: SsogLodControllerOptions) {
    this.mesh = options.mesh;
    this.splats = options.splats;
    this.sparkRenderer = options.sparkRenderer;
    this.budget = options.budget ?? this.splats.budget;

    const chunkExtent = options.chunkExtent ?? 16;
    this.lodBaseDistance =
      options.lodBaseDistance ?? (5 / 16) * chunkExtent; // C3
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
    this.readySinceTick = new Int32Array(this.NL).fill(-1);

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
  }

  /** Q8: call once per rendered frame from the app rAF. */
  frame(camera: THREE.PerspectiveCamera) {
    if (this.detached) {
      return;
    }
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
    if (
      this.tmpPos.distanceTo(this.lastPose.pos) >
      this.moveGateFactor * this.lodBaseDistance
    ) {
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

  /** iterate global chunk ids of a (leaf, level) ref */
  private forEachLeafChunk(
    li: number,
    level: number,
    fn: (chunk: number) => void,
  ) {
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
    const model = this.splats.model;
    this.displayed.fill(this.L - 1);
    this.desired.set(this.displayed);
    this.displayedTotal = 0;
    this.chunkRefs.clear();
    for (const chunk of this.pinnedChunks) {
      this.chunkRefs.set(chunk, 1); // permanent pin ref
    }
    for (let li = 0; li < this.NL; li++) {
      this.displayedTotal +=
        model.leafLods[(li * this.L + this.L - 1) * 3 + 2];
      this.addLeafRefs(li, this.L - 1);
    }
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
    this.selectionAndBalance(camera, uniformScale);

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

    // tier 3 — desired blocks, nearest-first, headroom-asserted per leaf
    if (anyPending) {
      const pendingLeaves: number[] = [];
      for (let li = 0; li < this.NL; li++) {
        if (this.desired[li] !== this.displayed[li]) {
          pendingLeaves.push(li);
        }
      }
      pendingLeaves.sort((a, b) => this.dBucket[a] - this.dBucket[b]);

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
    for (const [chunk, t] of this.chunkLastNeeded) {
      if (this.tickCount - t >= this.cooldownTicks) {
        this.chunkLastNeeded.delete(chunk);
        continue;
      }
      if (priority.length < maxPages) {
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
    this.converged =
      (allAtTarget ||
        (this.ticksNoProgress >= 3 && pagerQuiet && !this.heldPending)) &&
      !this.scaleMoved;

    this.stats.ticks = this.tickCount;
    this.stats.budgetScale = this.budgetScale;
    this.stats.composedSplats = this.composedSplats;
    this.stats.lastTickMs = performance.now() - t0;
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

    const d0 = this.lodBaseDistance * this.budgetScale;
    const mPrime = Math.max(1.2, 3 * this.budgetScale ** -0.2);
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
      if (d > 1e-9) {
        dx /= d;
        dy /= d;
        dz /= d;
        const dot = fwd.x * dx + fwd.y * dy + fwd.z * dz;
        penalty = 1 + 4 * Math.max(0, -dot); // ×1 in view → ×5 straight behind
      }
      // §2.4 pinned: d_bucket = penalizedDistance·fovScale·uniformScale —
      // the SAME value drives selection AND bucketing.
      const db = d * penalty * fovScale * uniformScale;
      this.dBucket[li] = db;
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

    // ---- balancer (verbatim shape, C9) ------------------------------------
    this.balancedLevel.set(this.optimalLevel);
    let totalBalanced = totalOptimal;
    const budget = this.budget;
    if (totalBalanced > budget) {
      let passes = 0;
      demote: while (totalBalanced > budget && passes < L) {
        passes++;
        for (let b = 63; b >= 0; b--) {
          for (let li = 0; li < NL; li++) {
            if (this.bucketOf[li] !== b) {
              continue;
            }
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
    } else {
      promote: for (let b = 0; b < 64; b++) {
        for (let li = 0; li < NL; li++) {
          if (this.bucketOf[li] !== b) {
            continue;
          }
          const cur = this.balancedLevel[li];
          if (cur <= this.optimalLevel[li]) {
            continue; // never promote past optimal
          }
          const curCount = model.leafLods[(li * L + cur) * 3 + 2];
          const finer = model.leafLods[(li * L + cur - 1) * 3 + 2];
          if (totalBalanced - curCount + finer > budget) {
            break promote; // stop, don't skip
          }
          this.balancedLevel[li] = cur - 1;
          totalBalanced += finer - curCount;
        }
      }
    }

    // ---- budgetScale feedback (verbatim constants) ------------------------
    const ratio = totalOptimal / budget;
    if (ratio > 1.4 || ratio < 0.6) {
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
      const delta =
        model.leafLods[o + 2] -
        model.leafLods[(li * this.L + from) * 3 + 2];
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
        readyShrink.push(li);
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
      this.removeLeafRefs(li, this.displayed[li]);
      this.addLeafRefs(li, to);
      this.displayedTotal +=
        model.leafLods[(li * this.L + to) * 3 + 2] -
        model.leafLods[(li * this.L + this.displayed[li]) * 3 + 2];
      this.displayed[li] = to;
      this.readySinceTick[li] = -1;
      flipped += 1;
    };
    for (const li of readyShrink) {
      applyFlip(li, this.desired[li]);
    }
    // nearest-first so pool headroom goes to the leaves that matter most
    eligibleGrow.sort((a, b) => this.dBucket[a] - this.dBucket[b]);
    for (const li of eligibleGrow) {
      const to = this.desired[li];
      const from = this.displayed[li];
      const delta =
        model.leafLods[(li * this.L + to) * 3 + 2] -
        model.leafLods[(li * this.L + from) * 3 + 2];
      if (this.displayedTotal + delta > this.splats.capacitySplats) {
        this.stats.capacityDeferrals += 1;
        continue;
      }
      // tentative block accounting; revert on pool-guard overflow
      this.removeLeafRefs(li, from);
      this.addLeafRefs(li, to);
      if (this.chunkRefs.size > poolLimit) {
        this.removeLeafRefs(li, to);
        this.addLeafRefs(li, from);
        this.stats.poolDeferrals += 1;
        continue;
      }
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
      out[this.displayed[li]] +=
        model.leafLods[(li * this.L + this.displayed[li]) * 3 + 2];
    }
    return out;
  }
}

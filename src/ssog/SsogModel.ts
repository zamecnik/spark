// Kroscloud fork — ssog module [ssog-2]. See FORK-CHANGES.md.
//
// SsogModel: parse + validate a splat-transform `lod-meta.json` (Streamed-SOG
// bundle) into flat leaf/unit tables (Struct-of-Arrays). Structural port of
// the P0b-proven prototype (Viewme poc/ssog-p0/ssog-model.js) per
// ssog-lod-adoption-plan.md §2.3. Pinned contracts honored here:
//   - PRE-resolution per-leaf per-level counts are validated against
//     counts[] (resolved counts alias rows and MUST NOT be summed);
//   - per-unit splat counts are DERIVED (unit sizes are VARIABLE — write-lod
//     closes a unit only after overflow; never assume 524,288);
//   - pager chunk ids come from the blockBase prefix-sum, NEVER
//     `unitIndex*8 + block`;
//   - missing per-leaf levels are resolved AT LOAD to the nearest available
//     level (tie → coarser), so the runtime never sees -1;
//   - `tree.bound` root = scene AABB (the GetSplatSceneDimension feed).
//   - [prec-1] `packOrigin`: the robust content centre the unit decoder packs
//     centres against (fp16 precision far from the file origin), fixed for
//     the model's lifetime.
//
// This module is three-free and environment-agnostic.

export const SSOG_PAGE_SPLATS = 65536; // SplatPager pageSplats — chunk == one pool page

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
export function ssogPackOrigin(
  centers: ArrayLike<number>,
  weights: ArrayLike<number>,
): [number, number, number] | null {
  const n = weights.length;
  const idx: number[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const w = weights[i];
    if (Number.isFinite(w) && w > 0) {
      idx.push(i);
      total += w;
    }
  }
  if (idx.length === 0 || !(total > 0)) {
    return null;
  }
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const order = idx
      .slice()
      .sort((a, b) => centers[a * 3 + c] - centers[b * 3 + c]);
    let acc = 0;
    let median = centers[order[order.length - 1] * 3 + c];
    for (const i of order) {
      acc += weights[i];
      if (acc * 2 >= total) {
        median = centers[i * 3 + c];
        break;
      }
    }
    const r = Math.round(median);
    out[c] = Number.isFinite(r) && r !== 0 ? r : 0; // -0 -> 0
  }
  return out[0] === 0 && out[1] === 0 && out[2] === 0 ? null : out;
}

export interface SsogLodMetaBound {
  min: number[];
  max: number[];
}

interface SsogLodMetaNode {
  bound?: SsogLodMetaBound;
  children?: SsogLodMetaNode[];
  lods?: Record<string, { file: number; offset: number; count: number }>;
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
  tree: SsogLodMetaNode & { bound: SsogLodMetaBound };
}

export class SsogModel {
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

  readonly rootBound: { min: number[]; max: number[] };

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

  constructor(meta: SsogLodMeta, options: SsogModelOptions = {}) {
    if (meta.version !== 1) {
      throw new Error(`lod-meta version ${meta.version} !== 1`);
    }
    if (!Number.isInteger(meta.lodLevels) || meta.lodLevels <= 0) {
      throw new Error("bad lodLevels");
    }
    if (!Array.isArray(meta.counts) || meta.counts.length !== meta.lodLevels) {
      throw new Error("bad counts[]");
    }
    if (
      !Array.isArray(meta.filenames) ||
      meta.filenames.some((f) => typeof f !== "string")
    ) {
      throw new Error("bad filenames[]");
    }
    if (!meta.tree || typeof meta.tree !== "object") {
      throw new Error("bad tree");
    }
    this.hasEnvironment = meta.environment !== undefined;
    // [ssog-16] optional pipeline stamp — see SsogLodMeta.chunkExtent
    this.chunkExtent =
      typeof meta.chunkExtent === "number" &&
      Number.isFinite(meta.chunkExtent) &&
      meta.chunkExtent > 0
        ? meta.chunkExtent
        : null;
    // [ssog-27] unit container stamp — see SsogLodMeta.unitPack. Absent/0 is
    // classic, 1 is packed, anything else is a format this viewer cannot
    // read: fail loud here rather than 404 on every unit later.
    const up = meta.unitPack;
    if (up === undefined || up === 0) {
      this.unitPack = 0;
    } else if (up === 1) {
      this.unitPack = 1;
    } else {
      throw new Error(
        `lod-meta unitPack ${String(up)} is not supported by this viewer (expected absent, 0 or 1) — update the viewer`,
      );
    }

    const L = meta.lodLevels;
    const numUnits = meta.filenames.length;

    // unit dir names must be contiguous per-level indices "{lod}_{i}/meta.json"
    // (write-lod appends to the last unit only) — the invariant that makes
    // whitelist/signing/purge derivable from per-level unit counts (§2.2).
    const unitCountsPerLevel = new Array<number>(L).fill(0);
    const unitLevel = new Int32Array(numUnits);
    const unitIndexInLevel = new Int32Array(numUnits);
    meta.filenames.forEach((name, fi) => {
      const m = /^(\d+)_(\d+)\/meta\.json$/.exec(name);
      if (!m) {
        throw new Error(`unexpected filename shape: ${name}`);
      }
      const lod = +m[1];
      const idx = +m[2];
      if (lod < 0 || lod >= L) {
        throw new Error(`filename level out of range: ${name}`);
      }
      unitLevel[fi] = lod;
      unitIndexInLevel[fi] = idx;
      unitCountsPerLevel[lod] = Math.max(unitCountsPerLevel[lod], idx + 1);
    });
    {
      const seen = Array.from({ length: L }, () => new Set<number>());
      meta.filenames.forEach((_, fi) =>
        seen[unitLevel[fi]].add(unitIndexInLevel[fi]),
      );
      for (let l = 0; l < L; l++) {
        for (let i = 0; i < unitCountsPerLevel[l]; i++) {
          if (!seen[l].has(i)) {
            throw new Error(`level ${l} unit indices not contiguous (missing ${i})`);
          }
        }
      }
    }

    // ---- tree walk → leaves ------------------------------------------------
    const leaves: SsogLodMetaNode[] = [];
    (function walk(node: SsogLodMetaNode) {
      if (!node || typeof node !== "object") {
        throw new Error("bad tree node");
      }
      if (node.children !== undefined) {
        if (!Array.isArray(node.children)) {
          throw new Error("bad children");
        }
        for (const c of node.children) {
          walk(c);
        }
        return;
      }
      leaves.push(node);
    })(meta.tree);
    const numLeaves = leaves.length;

    // ---- SoA tables --------------------------------------------------------
    const boundsFlat = new Float32Array(6 * numLeaves);
    const leafLodsPre = new Int32Array(3 * L * numLeaves).fill(-1);
    leaves.forEach((leaf, li) => {
      const b = leaf.bound;
      if (!b || !Array.isArray(b.min) || !Array.isArray(b.max)) {
        throw new Error(`leaf ${li} missing bound`);
      }
      boundsFlat.set([...b.min, ...b.max], li * 6);
      for (const [key, ref] of Object.entries(leaf.lods ?? {})) {
        const lod = Number(key);
        if (!Number.isInteger(lod) || lod < 0 || lod >= L) {
          throw new Error(`leaf ${li} bad lod key ${key}`);
        }
        if (
          !Number.isInteger(ref.file) ||
          ref.file < 0 ||
          ref.file >= numUnits ||
          !Number.isInteger(ref.offset) ||
          ref.offset < 0 ||
          !Number.isInteger(ref.count) ||
          ref.count < 0
        ) {
          throw new Error(`leaf ${li} bad ref`);
        }
        if (unitLevel[ref.file] !== lod) {
          throw new Error(
            `leaf ${li} lod ${lod} points at unit of level ${unitLevel[ref.file]}`,
          );
        }
        const o = (li * L + lod) * 3;
        leafLodsPre[o] = ref.file;
        leafLodsPre[o + 1] = ref.offset;
        leafLodsPre[o + 2] = ref.count;
      }
    });

    // ---- PRE-resolution validation (plan hard rule) ------------------------
    const preLevelSums = new Array<number>(L).fill(0);
    for (let li = 0; li < numLeaves; li++) {
      for (let l = 0; l < L; l++) {
        const c = leafLodsPre[(li * L + l) * 3 + 2];
        if (c > 0) {
          preLevelSums[l] += c;
        }
      }
    }
    for (let l = 0; l < L; l++) {
      if (preLevelSums[l] !== meta.counts[l]) {
        throw new Error(
          `PRE-resolution level ${l} sum ${preLevelSums[l]} !== counts[${l}] ${meta.counts[l]}`,
        );
      }
    }
    const total = preLevelSums.reduce((a, b) => a + b, 0);
    if (total !== meta.count) {
      throw new Error(`total ${total} !== count ${meta.count}`);
    }

    // ---- per-unit splat counts (VARIABLE, not stored in lod-meta) ----------
    const unitSplats = new Float64Array(numUnits);
    for (let li = 0; li < numLeaves; li++) {
      for (let l = 0; l < L; l++) {
        const o = (li * L + l) * 3;
        if (leafLodsPre[o] >= 0) {
          unitSplats[leafLodsPre[o]] += leafLodsPre[o + 2];
        }
      }
    }
    for (let l = 0; l < L; l++) {
      let s = 0;
      for (let u = 0; u < numUnits; u++) {
        if (unitLevel[u] === l) {
          s += unitSplats[u];
        }
      }
      if (s !== meta.counts[l]) {
        throw new Error(`unit-derived level ${l} sum ${s} !== counts[${l}]`);
      }
    }
    // offsets must tile each unit exactly gaplessly from 0 (write-lod appends
    // leaf subunits contiguously)
    {
      const refsByUnit: [number, number][][] = Array.from(
        { length: numUnits },
        () => [],
      );
      for (let li = 0; li < numLeaves; li++) {
        for (let l = 0; l < L; l++) {
          const o = (li * L + l) * 3;
          if (leafLodsPre[o] >= 0) {
            refsByUnit[leafLodsPre[o]].push([
              leafLodsPre[o + 1],
              leafLodsPre[o + 2],
            ]);
          }
        }
      }
      for (let u = 0; u < numUnits; u++) {
        const refs = refsByUnit[u].sort((a, b) => a[0] - b[0]);
        let cursor = 0;
        for (const [off, cnt] of refs) {
          if (off !== cursor) {
            throw new Error(`unit ${u} refs not gapless at ${cursor} (got ${off})`);
          }
          cursor += cnt;
        }
        if (cursor !== unitSplats[u]) {
          throw new Error(`unit ${u} tiling ${cursor} !== ${unitSplats[u]}`);
        }
      }
    }

    // ---- blockBase prefix-sum: global pager chunk-id space -----------------
    const blockBase = new Int32Array(numUnits + 1);
    for (let u = 0; u < numUnits; u++) {
      blockBase[u + 1] =
        blockBase[u] + Math.ceil(unitSplats[u] / SSOG_PAGE_SPLATS);
    }

    // ---- missing-level resolution (AT LOAD) --------------------------------
    // nearest available level; tie → the coarser one (conservative for budget).
    // [ssog-31] EXCEPT the coarse suffix: a level coarser than the leaf's
    // coarsest real level stays EMPTY (file −1, offset 0, count 0 — the only
    // −1 the runtime ever sees, always with count 0, and every consumer
    // checks count first). The old rule resolved it to a FINER unit, so the
    // all-coarsest floor touched every unit those few-splat outskirts leaves
    // live in: 66 pool pages on the 76vx 20M scene against a 22-page pinned
    // tier (559 leaves with no L5 rows), ~80 pages on an 8-level ladder —
    // more than a phone pool holds (32 pages at 1M/pf 1.8), so the balancer
    // could never promote anything there. Middle gaps (never produced by the
    // builder: per-leaf counts halve monotonically) keep the nearest rule.
    const leafLods = leafLodsPre.slice();
    const leafLevelCount = new Uint32Array(numLeaves);
    for (let li = 0; li < numLeaves; li++) {
      const avail: number[] = [];
      for (let l = 0; l < L; l++) {
        if (leafLodsPre[(li * L + l) * 3] >= 0) {
          avail.push(l);
        }
      }
      leafLevelCount[li] = avail.length;
      if (avail.length === 0) {
        throw new Error(`leaf ${li} has no levels at all`);
      }
      const coarsestReal = avail[avail.length - 1];
      for (let l = 0; l < L; l++) {
        if (leafLodsPre[(li * L + l) * 3] >= 0) {
          continue;
        }
        if (l > coarsestReal) {
          const dst = (li * L + l) * 3;
          leafLods[dst] = -1;
          leafLods[dst + 1] = 0;
          leafLods[dst + 2] = 0;
          continue;
        }
        let best = avail[0];
        for (const a of avail) {
          const d = Math.abs(a - l);
          const bd = Math.abs(best - l);
          if (d < bd || (d === bd && a > best)) {
            best = a;
          }
        }
        const src = (li * L + best) * 3;
        const dst = (li * L + l) * 3;
        leafLods[dst] = leafLodsPre[src];
        leafLods[dst + 1] = leafLodsPre[src + 1];
        leafLods[dst + 2] = leafLodsPre[src + 2];
      }
      for (let l = 0; l < L; l++) {
        const o = (li * L + l) * 3;
        const emptySuffix =
          l > coarsestReal && leafLods[o] < 0 && leafLods[o + 2] === 0;
        if (
          !emptySuffix &&
          (leafLods[o] < 0 || leafLods[o + 1] < 0 || leafLods[o + 2] < 0)
        ) {
          throw new Error(`leaf ${li} level ${l} unresolved`);
        }
      }
    }

    // ---- quantified slack input (§2.3): max per-(leaf,level) block span ----
    let maxLeafBlockFootprint = 0;
    for (let li = 0; li < numLeaves; li++) {
      for (let l = 0; l < L; l++) {
        const o = (li * L + l) * 3;
        const count = leafLodsPre[o + 2];
        if (leafLodsPre[o] < 0 || count <= 0) {
          continue;
        }
        const offset = leafLodsPre[o + 1];
        const blocks =
          Math.floor((offset + count - 1) / SSOG_PAGE_SPLATS) -
          Math.floor(offset / SSOG_PAGE_SPLATS) +
          1;
        maxLeafBlockFootprint = Math.max(maxLeafBlockFootprint, blocks);
      }
    }

    // ---- [prec-1] runtime pack origin --------------------------------------
    // leaf bound centres from the manifest's own (float64) numbers, weighted
    // by the leaf's level-0 rows (pre-resolution; a missing L0 weighs 0)
    let packOrigin: [number, number, number] | null = null;
    if (options.packOrigin !== false) {
      const centers = new Float64Array(3 * numLeaves);
      const weights = new Float64Array(numLeaves);
      leaves.forEach((leaf, li) => {
        const b = leaf.bound as SsogLodMetaBound;
        for (let c = 0; c < 3; c++) {
          centers[li * 3 + c] = 0.5 * (Number(b.min[c]) + Number(b.max[c]));
        }
        weights[li] = Math.max(0, leafLodsPre[li * L * 3 + 2]);
      });
      packOrigin = ssogPackOrigin(centers, weights);
    }

    const root = meta.tree.bound;
    this.lodLevels = L;
    this.count = meta.count;
    this.counts = meta.counts.slice();
    this.filenames = meta.filenames.slice();
    this.numLeaves = numLeaves;
    this.boundsFlat = boundsFlat;
    this.leafLodsPre = leafLodsPre;
    this.leafLods = leafLods;
    this.leafLevelCount = leafLevelCount;
    this.numUnits = numUnits;
    this.unitLevel = unitLevel;
    this.unitIndexInLevel = unitIndexInLevel;
    this.unitSplats = unitSplats;
    this.blockBase = blockBase;
    this.totalBlocks = blockBase[numUnits];
    this.maxLeafBlockFootprint = maxLeafBlockFootprint;
    this.rootBound = { min: root.min.slice(), max: root.max.slice() };
    this.packOrigin = packOrigin;
  }

  /** unit dir name, e.g. "0_4" */
  unitDirName(unit: number): string {
    return `${this.unitLevel[unit]}_${this.unitIndexInLevel[unit]}`;
  }

  /** global pager chunk id + slot for (unit file index, row-in-unit) */
  rowToChunkSlot(
    file: number,
    row: number,
  ): { chunk: number; slot: number } {
    const block = Math.floor(row / SSOG_PAGE_SPLATS);
    return {
      chunk: this.blockBase[file] + block,
      slot: row % SSOG_PAGE_SPLATS,
    };
  }

  /** binary search: which unit owns a global chunk id */
  unitOfChunk(chunk: number): { unit: number; block: number } {
    let lo = 0;
    let hi = this.numUnits - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.blockBase[mid] <= chunk) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return { unit: lo, block: chunk - this.blockBase[lo] };
  }

  /**
   * Scene AABB from the lod-meta root bound — kills the rad bbox-empty trap;
   * feeds GetSplatSceneDimension (§2.7).
   */
  getSceneBounds(): { min: [number, number, number]; max: [number, number, number] } {
    const { min, max } = this.rootBound;
    return {
      min: [min[0], min[1], min[2]],
      max: [max[0], max[1], max[2]],
    };
  }
}

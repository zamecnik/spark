import { defines, workerPool, PagedSplats, isMobile, SplatPager, SplatFileType } from "@sparkjsdev/spark";
import * as THREE from "three";
const SSOG_PAGE_SPLATS = 65536;
class SsogModel {
  constructor(meta) {
    if (meta.version !== 1) {
      throw new Error(`lod-meta version ${meta.version} !== 1`);
    }
    if (!Number.isInteger(meta.lodLevels) || meta.lodLevels <= 0) {
      throw new Error("bad lodLevels");
    }
    if (!Array.isArray(meta.counts) || meta.counts.length !== meta.lodLevels) {
      throw new Error("bad counts[]");
    }
    if (!Array.isArray(meta.filenames) || meta.filenames.some((f) => typeof f !== "string")) {
      throw new Error("bad filenames[]");
    }
    if (!meta.tree || typeof meta.tree !== "object") {
      throw new Error("bad tree");
    }
    this.hasEnvironment = meta.environment !== void 0;
    this.chunkExtent = typeof meta.chunkExtent === "number" && Number.isFinite(meta.chunkExtent) && meta.chunkExtent > 0 ? meta.chunkExtent : null;
    const L = meta.lodLevels;
    const numUnits = meta.filenames.length;
    const unitCountsPerLevel = new Array(L).fill(0);
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
      const seen = Array.from({ length: L }, () => /* @__PURE__ */ new Set());
      meta.filenames.forEach(
        (_, fi) => seen[unitLevel[fi]].add(unitIndexInLevel[fi])
      );
      for (let l = 0; l < L; l++) {
        for (let i = 0; i < unitCountsPerLevel[l]; i++) {
          if (!seen[l].has(i)) {
            throw new Error(`level ${l} unit indices not contiguous (missing ${i})`);
          }
        }
      }
    }
    const leaves = [];
    (function walk(node) {
      if (!node || typeof node !== "object") {
        throw new Error("bad tree node");
      }
      if (node.children !== void 0) {
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
        if (!Number.isInteger(ref.file) || ref.file < 0 || ref.file >= numUnits || !Number.isInteger(ref.offset) || ref.offset < 0 || !Number.isInteger(ref.count) || ref.count < 0) {
          throw new Error(`leaf ${li} bad ref`);
        }
        if (unitLevel[ref.file] !== lod) {
          throw new Error(
            `leaf ${li} lod ${lod} points at unit of level ${unitLevel[ref.file]}`
          );
        }
        const o = (li * L + lod) * 3;
        leafLodsPre[o] = ref.file;
        leafLodsPre[o + 1] = ref.offset;
        leafLodsPre[o + 2] = ref.count;
      }
    });
    const preLevelSums = new Array(L).fill(0);
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
          `PRE-resolution level ${l} sum ${preLevelSums[l]} !== counts[${l}] ${meta.counts[l]}`
        );
      }
    }
    const total = preLevelSums.reduce((a, b) => a + b, 0);
    if (total !== meta.count) {
      throw new Error(`total ${total} !== count ${meta.count}`);
    }
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
    {
      const refsByUnit = Array.from(
        { length: numUnits },
        () => []
      );
      for (let li = 0; li < numLeaves; li++) {
        for (let l = 0; l < L; l++) {
          const o = (li * L + l) * 3;
          if (leafLodsPre[o] >= 0) {
            refsByUnit[leafLodsPre[o]].push([
              leafLodsPre[o + 1],
              leafLodsPre[o + 2]
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
    const blockBase = new Int32Array(numUnits + 1);
    for (let u = 0; u < numUnits; u++) {
      blockBase[u + 1] = blockBase[u] + Math.ceil(unitSplats[u] / SSOG_PAGE_SPLATS);
    }
    const leafLods = leafLodsPre.slice();
    const leafLevelCount = new Uint32Array(numLeaves);
    for (let li = 0; li < numLeaves; li++) {
      const avail = [];
      for (let l = 0; l < L; l++) {
        if (leafLodsPre[(li * L + l) * 3] >= 0) {
          avail.push(l);
        }
      }
      leafLevelCount[li] = avail.length;
      if (avail.length === 0) {
        throw new Error(`leaf ${li} has no levels at all`);
      }
      for (let l = 0; l < L; l++) {
        if (leafLodsPre[(li * L + l) * 3] >= 0) {
          continue;
        }
        let best = avail[0];
        for (const a of avail) {
          const d = Math.abs(a - l);
          const bd = Math.abs(best - l);
          if (d < bd || d === bd && a > best) {
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
        if (leafLods[o] < 0 || leafLods[o + 1] < 0 || leafLods[o + 2] < 0) {
          throw new Error(`leaf ${li} level ${l} unresolved`);
        }
      }
    }
    let maxLeafBlockFootprint = 0;
    for (let li = 0; li < numLeaves; li++) {
      for (let l = 0; l < L; l++) {
        const o = (li * L + l) * 3;
        const count = leafLodsPre[o + 2];
        if (leafLodsPre[o] < 0 || count <= 0) {
          continue;
        }
        const offset = leafLodsPre[o + 1];
        const blocks = Math.floor((offset + count - 1) / SSOG_PAGE_SPLATS) - Math.floor(offset / SSOG_PAGE_SPLATS) + 1;
        maxLeafBlockFootprint = Math.max(maxLeafBlockFootprint, blocks);
      }
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
  }
  /** unit dir name, e.g. "0_4" */
  unitDirName(unit) {
    return `${this.unitLevel[unit]}_${this.unitIndexInLevel[unit]}`;
  }
  /** global pager chunk id + slot for (unit file index, row-in-unit) */
  rowToChunkSlot(file, row) {
    const block = Math.floor(row / SSOG_PAGE_SPLATS);
    return {
      chunk: this.blockBase[file] + block,
      slot: row % SSOG_PAGE_SPLATS
    };
  }
  /** binary search: which unit owns a global chunk id */
  unitOfChunk(chunk) {
    let lo = 0;
    let hi = this.numUnits - 1;
    while (lo < hi) {
      const mid = lo + hi + 1 >> 1;
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
  getSceneBounds() {
    const { min, max } = this.rootBound;
    return {
      min: [min[0], min[1], min[2]],
      max: [max[0], max[1], max[2]]
    };
  }
}
class SsogUnitCache {
  constructor(options) {
    this.units = /* @__PURE__ */ new Map();
    this.stats = { fetches: 0, decodes: 0, evictions: 0, fetchErrors: 0 };
    this.model = options.model;
    this.baseUrl = options.baseUrl ?? "";
    this.withCredentials = options.withCredentials ?? false;
    this.maxUnits = Math.max(1, options.maxUnits ?? 3);
    this.splatEncoding = options.splatEncoding ?? defines.DEFAULT_SPLAT_ENCODING;
    this.resolver = options.resolveUrl ?? ((relativePath) => this.baseUrl + relativePath);
  }
  /** Memoized unit decode. Blocks of one unit share a single fetch+decode. */
  getUnit(unit) {
    const existing = this.units.get(unit);
    if (existing) {
      this.units.delete(unit);
      this.units.set(unit, existing);
      return existing.promise;
    }
    const record = {
      promise: void 0,
      settled: false
    };
    record.promise = this.fetchDecodeUnit(unit).then(
      (decoded) => {
        record.settled = true;
        return decoded;
      },
      (error) => {
        if (this.units.get(unit) === record) {
          this.units.delete(unit);
        }
        this.stats.fetchErrors += 1;
        throw error;
      }
    );
    this.units.set(unit, record);
    this.evictOverflow();
    return record.promise;
  }
  /** Drop settled entries beyond maxUnits, oldest-touched first. */
  evictOverflow() {
    if (this.units.size <= this.maxUnits) {
      return;
    }
    for (const [unit, record] of this.units) {
      if (this.units.size <= this.maxUnits) {
        break;
      }
      if (record.settled) {
        this.units.delete(unit);
        this.stats.evictions += 1;
      }
    }
  }
  clear() {
    this.units.clear();
  }
  async fetchFile(relativePath) {
    const resolved = await this.resolver(relativePath);
    const url = typeof resolved === "string" ? resolved : resolved.url;
    const headers = typeof resolved === "string" ? void 0 : resolved.headers;
    const request = new Request(url, {
      headers: headers ? new Headers(headers) : void 0,
      credentials: this.withCredentials ? "include" : "same-origin"
    });
    this.stats.fetches += 1;
    const response = await fetch(request);
    if (!response.ok || !response.body) {
      throw new Error(
        `Failed to fetch "${url}": ${response.status} ${response.statusText}`
      );
    }
    return await response.arrayBuffer();
  }
  async fetchDecodeUnit(unit) {
    var _a;
    const dir = this.model.unitDirName(unit);
    const metaBytes = await this.fetchFile(`${dir}/meta.json`);
    const json = JSON.parse(
      new TextDecoder().decode(metaBytes)
    );
    const names = [
      ...json.means.files,
      ...json.scales.files,
      ...json.quats.files,
      ...json.sh0.files,
      ...((_a = json.shN) == null ? void 0 : _a.files) ?? []
    ];
    const files = {};
    await Promise.all(
      names.map(async (name) => {
        files[name] = await this.fetchFile(`${dir}/${name}`);
      })
    );
    this.stats.decodes += 1;
    const decoded = await workerPool.withWorker(
      async (worker) => worker.call("unpackSsogUnit", {
        json,
        files,
        encoding: this.splatEncoding
      })
    );
    const expected = this.model.unitSplats[unit];
    if (decoded.numSplats !== expected) {
      throw new Error(
        `ssog unit ${dir}: decoded ${decoded.numSplats} splats, model derives ${expected}`
      );
    }
    return decoded;
  }
}
const CUT_ROW_SPLATS = 16384;
class SsogSplats extends PagedSplats {
  constructor(options) {
    const { model, cache, budget } = options;
    const maxSh = options.maxSh ?? 3;
    const numFetchers = options.numFetchers ?? (isMobile() ? 2 : 4);
    const L = model.lodLevels;
    const coarsestSplats = model.counts[L - 1];
    const maxCut = model.counts[0];
    const cutSplats = Math.min(budget * 1.15, maxCut);
    const slackSplats = (model.maxLeafBlockFootprint + numFetchers) * SSOG_PAGE_SPLATS;
    const poolFactor = options.poolFactor ?? 1;
    const MAX_POOL_PAGES = 256;
    const wantPages = Math.ceil(
      (cutSplats * poolFactor + coarsestSplats + slackSplats) / SSOG_PAGE_SPLATS
    );
    const poolPages = Math.min(wantPages, model.totalBlocks, MAX_POOL_PAGES);
    if (poolPages === MAX_POOL_PAGES && wantPages > MAX_POOL_PAGES && MAX_POOL_PAGES < model.totalBlocks) {
      console.warn(
        `[ssog] poolPages clamped ${wantPages} -> ${MAX_POOL_PAGES} (default maxTextureArrayLayers)`
      );
    }
    const pager = new SplatPager({
      renderer: options.renderer,
      extSplats: false,
      maxSplats: poolPages * SSOG_PAGE_SPLATS,
      maxSh,
      autoDrive: false,
      // the controller owns the §2.3 pump contract
      numFetchers
    });
    super({ pager, fileType: SplatFileType.SSOG, maxSh });
    this.externalLod = true;
    this.numShResolved = false;
    this.model = model;
    this.cache = cache;
    this.budget = budget;
    this.poolPages = poolPages;
    this.slackSplats = slackSplats;
    this.capacityRows = Math.ceil(
      Math.max(cutSplats, coarsestSplats) / CUT_ROW_SPLATS
    );
    this.capacitySplats = this.capacityRows * CUT_ROW_SPLATS;
    this.totalFileSplats = this.capacitySplats;
    const encoding = defines.DEFAULT_SPLAT_ENCODING;
    this.fixedEncoding = encoding;
    this.splatEncoding = encoding;
    this.lodOpacity.value = false;
    this.shMax.value.set(
      encoding.sh1Max ?? 1,
      encoding.sh2Max ?? 1,
      encoding.sh3Max ?? 1
    );
  }
  /**
   * Global pager chunk → exact-size block slice of the memoized unit decode.
   * NEVER `unitIndex*8 + block` — unit sizes are variable (P0a/P0b pinned).
   */
  async fetchDecodeChunk(chunk) {
    if (chunk < 0 || chunk >= this.model.totalBlocks) {
      throw new Error(`ssog chunk out of range: ${chunk}`);
    }
    const { unit, block } = this.model.unitOfChunk(chunk);
    const decoded = await this.cache.getUnit(unit);
    if (!this.numShResolved) {
      this.numShResolved = true;
      this.numSh = decoded.extra.sh3 ? 3 : decoded.extra.sh2 ? 2 : decoded.extra.sh1 ? 1 : 0;
    }
    const start = block * SSOG_PAGE_SPLATS;
    const n = Math.min(SSOG_PAGE_SPLATS, decoded.numSplats - start);
    if (n <= 0) {
      throw new Error(
        `ssog chunk ${chunk}: block ${block} beyond unit ${unit} (${decoded.numSplats} splats)`
      );
    }
    const extra = {};
    if (decoded.extra.sh1) {
      extra.sh1 = decoded.extra.sh1.subarray(start * 2, (start + n) * 2);
    }
    if (decoded.extra.sh2) {
      extra.sh2 = decoded.extra.sh2.subarray(start * 4, (start + n) * 4);
    }
    if (decoded.extra.sh3) {
      extra.sh3 = decoded.extra.sh3.subarray(start * 4, (start + n) * 4);
    }
    return {
      numSplats: n,
      packedArray: decoded.packedArray.subarray(start * 4, (start + n) * 4),
      extra,
      splatEncoding: this.fixedEncoding
    };
  }
  /**
   * Full teardown (final scene destruction only). Regular dispose() is
   * detach-only by inheritance — the pool outlives the view for warm
   * pano-roundtrip reattach (§2.7).
   */
  disposePool() {
    var _a;
    this.dispose();
    (_a = this.pager) == null ? void 0 : _a.dispose();
  }
}
class SsogLodController {
  constructor(options) {
    this.paramsDirty = false;
    this.budgetScale = 1;
    this.moveGateOverride = null;
    this.phase = "reveal";
    this.detached = false;
    this.heldPending = false;
    this.composedSplats = 0;
    this.displayedTotal = 0;
    this.frameCounter = 0;
    this.tickCount = 0;
    this.converged = false;
    this.flipRetryPending = false;
    this.flipRetryFrames = 0;
    this.scaleMoved = false;
    this.lastFlipsStat = 0;
    this.ticksNoProgress = 0;
    this.chunkLastNeeded = /* @__PURE__ */ new Map();
    this.chunkRefs = /* @__PURE__ */ new Map();
    this.priorityChunks = /* @__PURE__ */ new Set();
    this.lastPose = {
      valid: false,
      pos: new THREE.Vector3(),
      quat: new THREE.Quaternion(),
      fov: 0
    };
    this.tmpMat = new THREE.Matrix4();
    this.tmpPos = new THREE.Vector3();
    this.tmpFwd = new THREE.Vector3();
    this.tmpQuat = new THREE.Quaternion();
    this.tmpScale = new THREE.Vector3();
    this.stats = {
      phase: "reveal",
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
      /** [B4] wave-gather hold observations (per flip-scan pass, not unique) */
      batchHolds: 0,
      displayedChunkCount: 0,
      capacityOverflowInCompose: 0,
      missingSamples: [],
      deferredBySort: 0,
      missingPagesInCompose: 0,
      priorityLen: 0,
      lastTickMs: 0,
      revealResidentBlocks: 0,
      revealTotalBlocks: 0
    };
    this.mesh = options.mesh;
    this.splats = options.splats;
    this.sparkRenderer = options.sparkRenderer;
    this.budget = options.budget ?? this.splats.budget;
    const chunkExtent = options.chunkExtent ?? this.splats.model.chunkExtent ?? 16;
    this.lodBaseDistance = options.lodBaseDistance ?? 5 / 16 * chunkExtent;
    this.moveGateFactor = options.moveGateFactor ?? 0.2;
    this.metronomeFrames = options.metronomeFrames ?? 10;
    this.cooldownTicks = options.cooldownTicks ?? 100;
    this.flipBatchTicks = options.flipBatchTicks ?? 2;
    this.isWebGL2 = options.isWebGL2 ?? (this.splats.pager ? this.splats.pager.renderer.isWebGPURenderer !== true : true);
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
    const pinned = [];
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
    this.pageRefs = new Int32Array(model.totalBlocks);
    this.bucketOrder = new Int32Array(this.NL);
    this.bucketStart = new Int32Array(65);
    this.bucketCursor = new Int32Array(64);
    const pager = this.splats.pager;
    if (pager && pager.maxPages < model.totalBlocks) {
      const margin = model.maxLeafBlockFootprint + pager.numFetchers;
      const guard = this.poolGuardLimit();
      if (pinned.length + margin > guard) {
        console.warn(
          `[ssog] pool too small for page-aware balance: pinned ${pinned.length} + margin ${margin} > guard ${guard} — cut will rest at coarsest`
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
  bumpLeafPageRefs(li, level, refs, distinct, dir) {
    const model = this.splats.model;
    const o = (li * this.L + level) * 3;
    const file = model.leafLods[o];
    const offset = model.leafLods[o + 1];
    const count = model.leafLods[o + 2];
    if (count <= 0) {
      return distinct;
    }
    const first = model.blockBase[file] + Math.floor(offset / SSOG_PAGE_SPLATS);
    const last = model.blockBase[file] + Math.floor((offset + count - 1) / SSOG_PAGE_SPLATS);
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
  frame(camera) {
    if (this.detached) {
      return;
    }
    if (this.phase === "reveal") {
      this.revealTick(camera);
      return;
    }
    if (this.flipRetryPending) {
      this.flipRetryFrames += 1;
      if (!(this.isWebGL2 && this.sparkRenderer.sorting) || this.flipRetryFrames >= this.metronomeFrames) {
        this.flipRetryPending = false;
        this.flipRetryFrames = 0;
        this.flipReadyLeaves();
      }
    }
    this.frameCounter += 1;
    if (this.frameCounter < this.metronomeFrames) {
      return;
    }
    this.frameCounter = 0;
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
  get isConverged() {
    return this.phase === "run" && this.converged && !this.flipRetryPending;
  }
  /** Detach-only stop (pano roundtrip): state stays warm for reattach. */
  detach() {
    this.detached = true;
  }
  attach() {
    this.detached = false;
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
  setMoveGate(units) {
    this.moveGateOverride = typeof units === "number" && Number.isFinite(units) && units > 0 ? units : null;
    this.paramsDirty = true;
  }
  // ---- gates ---------------------------------------------------------------
  gatesPass(camera) {
    if (this.paramsDirty || !this.converged) {
      return true;
    }
    const pager = this.splats.pager;
    if (pager && (pager.fetched.length > 0 || pager.newUploads.length > 0 || pager.readyUploads.length > 0 || pager.fetchers.length > 0)) {
      return true;
    }
    if (!this.lastPose.valid) {
      return true;
    }
    this.cameraLocal(camera);
    const moveGate = this.moveGateOverride ?? this.moveGateFactor * this.lodBaseDistance;
    if (this.tmpPos.distanceTo(this.lastPose.pos) > moveGate) {
      return true;
    }
    if (Math.abs(this.tmpQuat.dot(this.lastPose.quat)) < Math.SQRT1_2) {
      return true;
    }
    if (Math.abs(camera.fov - this.lastPose.fov) > 0.02 * Math.max(1e-6, this.lastPose.fov)) {
      return true;
    }
    return false;
  }
  /** camera pose in mesh-local space → tmpPos/tmpFwd/tmpQuat + uniformScale */
  cameraLocal(camera) {
    this.tmpMat.copy(this.mesh.matrixWorld).invert();
    this.tmpPos.setFromMatrixPosition(camera.matrixWorld);
    this.tmpPos.applyMatrix4(this.tmpMat);
    this.tmpFwd.set(0, 0, -1).transformDirection(camera.matrixWorld);
    this.tmpFwd.transformDirection(this.tmpMat);
    this.tmpQuat.setFromRotationMatrix(camera.matrixWorld);
    this.mesh.getWorldScale(this.tmpScale);
    return this.tmpScale.x || 1;
  }
  markPose(camera) {
    this.lastPose.valid = true;
    this.lastPose.pos.copy(this.tmpPos);
    this.lastPose.quat.copy(this.tmpQuat);
    this.lastPose.fov = camera.fov;
  }
  // ---- §2.3 pump contract --------------------------------------------------
  pump(priority) {
    const pager = this.splats.pager;
    if (!pager) {
      return;
    }
    pager.fetchPriority = priority;
    pager.driveFetchers();
    pager.consumeLodTreeUpdates();
    pager.processUploads();
  }
  /** pages queued-but-not-yet-uploaded (recomputed per scan) */
  pendingUploadPages() {
    const pager = this.splats.pager;
    const pending = /* @__PURE__ */ new Set();
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
  chunkResidentUploaded(chunk, pending) {
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
  addLeafRefs(li, level) {
    this.forEachLeafChunk(li, level, (c) => {
      this.chunkRefs.set(c, (this.chunkRefs.get(c) ?? 0) + 1);
    });
  }
  removeLeafRefs(li, level) {
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
  poolGuardLimit() {
    const pager = this.splats.pager;
    if (!pager) {
      return 0;
    }
    if (pager.maxPages >= this.splats.model.totalBlocks) {
      return pager.maxPages;
    }
    return pager.maxPages - pager.numFetchers;
  }
  /** iterate global chunk ids of a (leaf, level) ref */
  forEachLeafChunk(li, level, fn) {
    const model = this.splats.model;
    const o = (li * this.L + level) * 3;
    const file = model.leafLods[o];
    const offset = model.leafLods[o + 1];
    const count = model.leafLods[o + 2];
    if (count <= 0) {
      return;
    }
    const first = model.blockBase[file] + Math.floor(offset / SSOG_PAGE_SPLATS);
    const last = model.blockBase[file] + Math.floor((offset + count - 1) / SSOG_PAGE_SPLATS);
    for (let c = first; c <= last; c++) {
      fn(c);
    }
  }
  // ---- reveal --------------------------------------------------------------
  revealTick(camera) {
    const priority = this.pinnedChunks.map((chunk) => ({
      splats: this.splats,
      chunk
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
    const model = this.splats.model;
    this.displayed.fill(this.L - 1);
    this.desired.set(this.displayed);
    this.displayedTotal = 0;
    this.chunkRefs.clear();
    for (const chunk of this.pinnedChunks) {
      this.chunkRefs.set(chunk, 1);
    }
    for (let li = 0; li < this.NL; li++) {
      this.displayedTotal += model.leafLods[(li * this.L + this.L - 1) * 3 + 2];
      this.addLeafRefs(li, this.L - 1);
    }
    this.compose();
    this.mesh.raycastIndices = {
      numSplats: this.composedSplats,
      indices: this.cut.slice(0, this.composedSplats)
    };
    this.phase = "run";
    this.stats.phase = "run";
    this.converged = false;
    this.cameraLocal(camera);
    this.markPose(camera);
  }
  // ---- the full LOD tick (§2.4) --------------------------------------------
  lodTick(camera) {
    const t0 = performance.now();
    this.paramsDirty = false;
    this.tickCount += 1;
    const uniformScale = this.cameraLocal(camera);
    this.selectionAndBalance(camera, uniformScale);
    let anyPending = false;
    for (let li = 0; li < this.NL; li++) {
      const target = this.balancedLevel[li];
      this.desired[li] = target;
      if (target !== this.displayed[li]) {
        anyPending = true;
      }
    }
    const pager = this.splats.pager;
    const maxPages = pager ? pager.maxPages : 0;
    const priority = [];
    const seen = /* @__PURE__ */ new Set();
    const pushChunk = (chunk, refreshCooldown) => {
      if (seen.has(chunk)) {
        return;
      }
      seen.add(chunk);
      priority.push({ splats: this.splats, chunk });
      if (refreshCooldown) {
        this.chunkLastNeeded.set(chunk, this.tickCount);
      }
    };
    for (const chunk of this.pinnedChunks) {
      pushChunk(chunk, true);
    }
    for (const chunk of this.chunkRefs.keys()) {
      pushChunk(chunk, true);
    }
    if (anyPending) {
      const pendingLeaves = [];
      for (let li = 0; li < this.NL; li++) {
        if (this.desired[li] !== this.displayed[li]) {
          pendingLeaves.push(li);
        }
      }
      pendingLeaves.sort((a, b) => this.dBucket[a] - this.dBucket[b]);
      const stage = [];
      let staged = true;
      for (const li of pendingLeaves) {
        stage.length = 0;
        this.forEachLeafChunk(li, this.desired[li], (c) => {
          if (!seen.has(c)) {
            stage.push(c);
          }
        });
        this.stats.headroomChecks += 1;
        const headroom = maxPages - seen.size;
        if (stage.length <= headroom) {
          for (const c of stage) {
            pushChunk(c, true);
          }
        } else {
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
      this.stats.headroomViolations += 1;
    }
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
    this.pump(priority);
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
    let allAtTarget = true;
    for (let li = 0; li < this.NL; li++) {
      if (this.displayed[li] !== this.balancedLevel[li]) {
        allAtTarget = false;
        break;
      }
    }
    const flipsSince = this.stats.flips - this.lastFlipsStat;
    this.lastFlipsStat = this.stats.flips;
    if (flipsSince > 0 || !anyPending) {
      this.ticksNoProgress = 0;
    } else {
      this.ticksNoProgress += 1;
    }
    const pagerQuiet = !pager || pager.fetchers.length === 0 && pager.newUploads.length === 0 && pager.readyUploads.length === 0;
    this.converged = (allAtTarget || this.ticksNoProgress >= 3 && pagerQuiet && !this.heldPending) && !this.scaleMoved;
    this.stats.ticks = this.tickCount;
    this.stats.budgetScale = this.budgetScale;
    this.stats.composedSplats = this.composedSplats;
    this.stats.lastTickMs = performance.now() - t0;
  }
  // ---- §2.4 selection + balancer + budgetScale (P0d structural port) -------
  selectionAndBalance(camera, uniformScale) {
    const model = this.splats.model;
    const L = this.L;
    const NL = this.NL;
    const bounds = model.boundsFlat;
    const cam = this.tmpPos;
    const fwd = this.tmpFwd;
    const tanHalfV = Math.tan(camera.fov / 2 * Math.PI / 180);
    const tanHalfH = tanHalfV * camera.aspect;
    const fovScale = Math.min(tanHalfV, tanHalfH) / Math.tan(22.5 * Math.PI / 180);
    const d0 = this.lodBaseDistance * this.budgetScale;
    const mPrime = Math.max(1.2, 3 * this.budgetScale ** -0.2);
    const logM = Math.log(mPrime);
    const rb = model.rootBound;
    const cx = (rb.min[0] + rb.max[0]) / 2;
    const cy = (rb.min[1] + rb.max[1]) / 2;
    const cz = (rb.min[2] + rb.max[2]) / 2;
    const radius = 0.5 * Math.hypot(
      rb.max[0] - rb.min[0],
      rb.max[1] - rb.min[1],
      rb.max[2] - rb.min[2]
    );
    const dMax = Math.max(
      1,
      Math.hypot(cam.x - cx, cam.y - cy, cam.z - cz) + radius
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
        penalty = 1 + 4 * Math.max(0, -dot);
      }
      const db = d * penalty * fovScale * uniformScale;
      this.dBucket[li] = db;
      this.bucketOf[li] = Math.min(
        63,
        Math.floor(64 * Math.sqrt(db) / sqrtDMax)
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
    this.balancedLevel.set(this.optimalLevel);
    let totalBalanced = totalOptimal;
    const budget = this.budget;
    if (totalBalanced > budget) {
      let passes2 = 0;
      demote: while (totalBalanced > budget && passes2 < L) {
        passes2++;
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
            totalBalanced += nextCount - curCount;
            if (totalBalanced <= budget) {
              break demote;
            }
          }
        }
      }
    }
    const pager = this.splats.pager;
    const wholeResident = !pager || pager.maxPages >= model.totalBlocks;
    const pageLimit = wholeResident ? Number.POSITIVE_INFINITY : this.poolGuardLimit() - (model.maxLeafBlockFootprint + pager.numFetchers);
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
        1
      );
    }
    if (distinctPages > pageLimit) {
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
          1
        );
      }
    }
    let passes = 0;
    promote: while (passes < L - 1) {
      passes++;
      let promoted = false;
      for (let b = 0; b < 64; b++) {
        for (let i = bucketStart[b]; i < bucketStart[b + 1]; i++) {
          const li = bucketOrder[i];
          const cur = this.balancedLevel[li];
          if (cur <= 0) {
            continue;
          }
          const curCount = model.leafLods[(li * L + cur) * 3 + 2];
          const finer = model.leafLods[(li * L + cur - 1) * 3 + 2];
          if (totalBalanced - curCount + finer > budget) {
            break promote;
          }
          if (pageLimit !== Number.POSITIVE_INFINITY) {
            distinctPages = this.bumpLeafPageRefs(
              li,
              cur - 1,
              pageRefs,
              distinctPages,
              1
            );
            distinctPages = this.bumpLeafPageRefs(
              li,
              cur,
              pageRefs,
              distinctPages,
              -1
            );
            if (distinctPages > pageLimit) {
              distinctPages = this.bumpLeafPageRefs(
                li,
                cur,
                pageRefs,
                distinctPages,
                1
              );
              distinctPages = this.bumpLeafPageRefs(
                li,
                cur - 1,
                pageRefs,
                distinctPages,
                -1
              );
              continue;
            }
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
    this.stats.balancedPages = distinctPages;
    this.stats.pageLimit = wholeResident ? 0 : pageLimit;
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
  flipReadyLeaves() {
    const model = this.splats.model;
    const pending = this.pendingUploadPages();
    const readyShrink = [];
    const readyGrow = [];
    const growPendingByFile = /* @__PURE__ */ new Map();
    const growReadyByFile = /* @__PURE__ */ new Map();
    for (let li = 0; li < this.NL; li++) {
      const to = this.desired[li];
      const from = this.displayed[li];
      if (to === from) {
        this.readySinceTick[li] = -1;
        continue;
      }
      const o = (li * this.L + to) * 3;
      const delta = model.leafLods[o + 2] - model.leafLods[(li * this.L + from) * 3 + 2];
      const grow = delta > 0;
      const file = grow && model.leafLods[o + 2] > 0 ? model.leafLods[o] : -1;
      if (file >= 0) {
        growPendingByFile.set(file, (growPendingByFile.get(file) ?? 0) + 1);
      }
      let ready = true;
      this.forEachLeafChunk(li, to, (c) => {
        if (ready && (!this.priorityChunks.has(c) || !this.chunkResidentUploaded(c, pending))) {
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
    const releaseTick = this.flipBatchTicks <= 0 || this.tickCount % this.flipBatchTicks === 0;
    let held = 0;
    const eligibleGrow = [];
    for (const li of readyGrow) {
      const o = (li * this.L + this.desired[li]) * 3;
      const file = model.leafLods[o + 2] > 0 ? model.leafLods[o] : -1;
      if (file < 0 || growReadyByFile.get(file) === growPendingByFile.get(file)) {
        eligibleGrow.push(li);
        continue;
      }
      if (this.readySinceTick[li] < 0) {
        this.readySinceTick[li] = this.tickCount;
      }
      if (releaseTick && this.tickCount - this.readySinceTick[li] >= this.flipBatchTicks) {
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
    const poolLimit = this.poolGuardLimit();
    let flipped = 0;
    const applyFlip = (li, to) => {
      this.removeLeafRefs(li, this.displayed[li]);
      this.addLeafRefs(li, to);
      this.displayedTotal += model.leafLods[(li * this.L + to) * 3 + 2] - model.leafLods[(li * this.L + this.displayed[li]) * 3 + 2];
      this.displayed[li] = to;
      this.readySinceTick[li] = -1;
      flipped += 1;
    };
    for (const li of readyShrink) {
      applyFlip(li, this.desired[li]);
    }
    eligibleGrow.sort((a, b) => this.dBucket[a] - this.dBucket[b]);
    for (const li of eligibleGrow) {
      const to = this.desired[li];
      const from = this.displayed[li];
      const delta = model.leafLods[(li * this.L + to) * 3 + 2] - model.leafLods[(li * this.L + from) * 3 + 2];
      if (this.displayedTotal + delta > this.splats.capacitySplats) {
        this.stats.capacityDeferrals += 1;
        continue;
      }
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
  compose() {
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
          this.stats.missingPagesInCompose += 1;
          if (this.stats.missingSamples.length < 20) {
            this.stats.missingSamples.push({
              tick: this.tickCount,
              li,
              level: this.displayed[li],
              chunk,
              mapped: false
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
    cut.fill(0, w);
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
  verifyCut() {
    this.splats.model;
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
  displayedByLevel() {
    const model = this.splats.model;
    const out = new Array(this.L).fill(0);
    if (this.phase !== "run") {
      return out;
    }
    for (let li = 0; li < this.NL; li++) {
      out[this.displayed[li]] += model.leafLods[(li * this.L + this.displayed[li]) * 3 + 2];
    }
    return out;
  }
}
export {
  SSOG_PAGE_SPLATS,
  SsogLodController,
  SsogModel,
  SsogSplats,
  SsogUnitCache
};
//# sourceMappingURL=spark-ssog.module.js.map

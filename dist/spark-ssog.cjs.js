"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const spark = require("@sparkjsdev/spark");
const browser = require("./browser-MOWB998F.cjs");
const THREE = require("three");
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const THREE__namespace = /* @__PURE__ */ _interopNamespaceDefault(THREE);
const SSOG_PAGE_SPLATS = 65536;
function ssogPackOrigin(centers, weights) {
  const n = weights.length;
  const idx = [];
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
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const order = idx.slice().sort((a, b) => centers[a * 3 + c] - centers[b * 3 + c]);
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
    out[c] = Number.isFinite(r) && r !== 0 ? r : 0;
  }
  return out[0] === 0 && out[1] === 0 && out[2] === 0 ? null : out;
}
class SsogModel {
  constructor(meta, options = {}) {
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
    const up = meta.unitPack;
    if (up === void 0 || up === 0) {
      this.unitPack = 0;
    } else if (up === 1) {
      this.unitPack = 1;
    } else {
      throw new Error(
        `lod-meta unitPack ${String(up)} is not supported by this viewer (expected absent, 0 or 1) — update the viewer`
      );
    }
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
      const coarsestReal = avail[avail.length - 1];
      for (let l = 0; l < L; l++) {
        if (leafLodsPre[(li * L + l) * 3] >= 0) {
          continue;
        }
        if (l > coarsestReal) {
          const dst2 = (li * L + l) * 3;
          leafLods[dst2] = -1;
          leafLods[dst2 + 1] = 0;
          leafLods[dst2 + 2] = 0;
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
        const emptySuffix = l > coarsestReal && leafLods[o] < 0 && leafLods[o + 2] === 0;
        if (!emptySuffix && (leafLods[o] < 0 || leafLods[o + 1] < 0 || leafLods[o + 2] < 0)) {
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
    let packOrigin = null;
    if (options.packOrigin !== false) {
      const centers = new Float64Array(3 * numLeaves);
      const weights = new Float64Array(numLeaves);
      leaves.forEach((leaf, li) => {
        const b = leaf.bound;
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
const SSOG_UNIT_PACK_FILE = "unit.bin";
const SSOG_UNIT_PACK_VERSION = 1;
const SSOG_UNIT_PACK_MEMBER_NAMES = /* @__PURE__ */ new Set([
  "meta.json",
  "means_l.webp",
  "means_u.webp",
  "quats.webp",
  "scales.webp",
  "sh0.webp",
  "shN_centroids.webp",
  "shN_labels.webp"
]);
const MAGIC = 1430736723;
const HEADER = 32;
const ENTRY = 48;
const NAME_BYTES = 32;
const MAX_MEMBERS = 16;
const ALIGN = 16;
const META_MAX = 4 << 20;
const META_NAME = "meta.json";
const MFLAG_DEFLATE = 1;
class SsogUnitPackError extends Error {
  constructor(label, reason) {
    super(`${label}: bad unit pack — ${reason}`);
    this.reason = reason;
    this.name = "SsogUnitPackError";
  }
}
function align16(n) {
  return Math.ceil(n / ALIGN) * ALIGN;
}
function hex(n, digits) {
  return `0x${n.toString(16).padStart(digits, "0")}`;
}
function parseUnitPack(buf, label) {
  const err = (reason) => new SsogUnitPackError(label, reason);
  const actual = buf.byteLength;
  if (actual < HEADER) {
    throw err(
      `file is ${actual} bytes, shorter than the ${HEADER}-byte header`
    );
  }
  const dv = new DataView(buf);
  const magic = dv.getUint32(0, true);
  if (magic !== MAGIC) {
    throw err(`magic ${hex(magic, 8)} is not "SOGU"`);
  }
  const version = dv.getUint16(4, true);
  if (version !== SSOG_UNIT_PACK_VERSION) {
    throw err(`version ${version} (expected ${SSOG_UNIT_PACK_VERSION})`);
  }
  const flags = dv.getUint16(6, true);
  if (flags !== 0) {
    throw err(`flags ${hex(flags, 4)} (expected 0)`);
  }
  const memberCount = dv.getUint32(8, true);
  const count = dv.getUint32(12, true);
  const payloadOffset = dv.getUint32(16, true);
  const fileLength = dv.getUint32(20, true);
  if (dv.getUint32(24, true) !== 0 || dv.getUint32(28, true) !== 0) {
    throw err("reserved header bytes are not zero");
  }
  if (memberCount < 1 || memberCount > MAX_MEMBERS) {
    throw err(`memberCount ${memberCount} outside 1..${MAX_MEMBERS}`);
  }
  const expectedPayload = align16(HEADER + ENTRY * memberCount);
  if (payloadOffset !== expectedPayload) {
    throw err(
      `payloadOffset ${payloadOffset} (expected ${expectedPayload} for ${memberCount} members)`
    );
  }
  if (payloadOffset > fileLength) {
    throw err(`payloadOffset ${payloadOffset} beyond fileLength ${fileLength}`);
  }
  if (fileLength !== actual) {
    throw err(`fileLength ${fileLength} but the file is ${actual} bytes`);
  }
  const bytes = new Uint8Array(buf);
  const names = [];
  const seen = /* @__PURE__ */ new Set();
  for (let i = 0; i < memberCount; i++) {
    const base = HEADER + ENTRY * i;
    let end = -1;
    for (let k = 0; k < NAME_BYTES; k++) {
      if (bytes[base + k] === 0) {
        end = k;
        break;
      }
    }
    if (end < 1) {
      throw err(
        `entry ${i}: name is empty or not NUL-terminated within ${NAME_BYTES} bytes`
      );
    }
    let name = "";
    for (let k = 0; k < end; k++) {
      const c = bytes[base + k];
      if (c < 33 || c > 126) {
        throw err(
          `entry ${i}: name byte ${k} (${hex(c, 2)}) is not printable ASCII`
        );
      }
      name += String.fromCharCode(c);
    }
    for (let k = end + 1; k < NAME_BYTES; k++) {
      if (bytes[base + k] !== 0) {
        throw err(`entry ${i} (${name}): name padding is not zero`);
      }
    }
    if (!SSOG_UNIT_PACK_MEMBER_NAMES.has(name)) {
      throw err(`entry ${i}: unknown member name "${name}"`);
    }
    if (seen.has(name)) {
      throw err(`entry ${i}: duplicate member name "${name}"`);
    }
    seen.add(name);
    names.push(name);
  }
  if (names[0] !== META_NAME) {
    throw err(`entry 0 is "${names[0]}", expected "${META_NAME}"`);
  }
  const members = /* @__PURE__ */ new Map();
  let cursor = payloadOffset;
  for (let i = 0; i < memberCount; i++) {
    const base = HEADER + ENTRY * i + NAME_BYTES;
    const name = names[i];
    const offset = dv.getUint32(base, true);
    const length = dv.getUint32(base + 4, true);
    const rawLength = dv.getUint32(base + 8, true);
    const mflags = dv.getUint32(base + 12, true);
    const tag = `entry ${i} (${name})`;
    if (length < 1) {
      throw err(`${tag}: length 0`);
    }
    if (offset % ALIGN !== 0) {
      throw err(`${tag}: offset ${offset} is not 16-byte aligned`);
    }
    if (offset < payloadOffset) {
      throw err(
        `${tag}: offset ${offset} before payloadOffset ${payloadOffset}`
      );
    }
    if (offset < cursor) {
      throw err(
        `${tag}: offset ${offset} overlaps the previous member ending at ${cursor}`
      );
    }
    if (offset + length > fileLength) {
      throw err(
        `${tag}: offset ${offset} + length ${length} exceeds fileLength ${fileLength}`
      );
    }
    if ((mflags & -2) !== 0) {
      throw err(`${tag}: mflags ${hex(mflags, 8)} has unknown bits set`);
    }
    const deflate = (mflags & MFLAG_DEFLATE) !== 0;
    if (deflate && i !== 0) {
      throw err(`${tag}: deflate is allowed only on entry 0 (meta.json)`);
    }
    if (!deflate && rawLength !== length) {
      throw err(
        `${tag}: rawLength ${rawLength} != length ${length} without deflate`
      );
    }
    members.set(name, { name, offset, length, rawLength, deflate });
    cursor = offset + length;
  }
  if (cursor !== fileLength) {
    throw err(
      `last member ends at ${cursor}, fileLength ${fileLength} (trailing bytes)`
    );
  }
  const meta = members.get(META_NAME);
  if (!meta) {
    throw err("container has no meta.json member");
  }
  if (meta.length > META_MAX) {
    throw err(
      `meta.json stored length ${meta.length} exceeds ${META_MAX} bytes`
    );
  }
  if (meta.rawLength > META_MAX) {
    throw err(
      `meta.json rawLength ${meta.rawLength} exceeds ${META_MAX} bytes`
    );
  }
  return { count, fileLength, members };
}
function readUnitPackMeta(buf, index, label) {
  const m = index.members.get(META_NAME);
  if (!m) {
    throw new SsogUnitPackError(label, "container has no meta.json member");
  }
  const stored = new Uint8Array(buf, m.offset, m.length);
  if (!m.deflate) {
    return stored;
  }
  let out;
  try {
    out = browser.inflateSync(stored);
  } catch (e) {
    throw new SsogUnitPackError(
      label,
      `meta.json inflate failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  if (out.length !== m.rawLength) {
    throw new SsogUnitPackError(
      label,
      `meta.json inflated to ${out.length} bytes, rawLength says ${m.rawLength}`
    );
  }
  return out;
}
function planeNames(json) {
  var _a;
  return [
    ...json.means.files,
    ...json.scales.files,
    ...json.quats.files,
    ...json.sh0.files,
    ...((_a = json.shN) == null ? void 0 : _a.files) ?? []
  ];
}
const UNIT_BYTES_MAX = 4096;
class SsogUnitCache {
  constructor(options) {
    this.units = /* @__PURE__ */ new Map();
    this.unitBytesMap = /* @__PURE__ */ new Map();
    this.recordSeq = 0;
    this.unitFailures = /* @__PURE__ */ new Map();
    this.stats = {
      fetches: 0,
      decodes: 0,
      evictions: 0,
      fetchErrors: 0,
      /** [ssog-24] unit downloads aborted (no in-flight chunk still wanted) */
      fetchCancels: 0,
      /**
       * [ssog-24] EXACT saving: Σ over aborted units of (known size − received),
       * counted ONLY for units whose every file size was already known at abort
       * time. Never estimated into — see cancelSavedEstimateBytes.
       */
      cancelSavedBytes: 0,
      /**
       * [ssog-24 fix E] Modelled saving, superset of cancelSavedBytes: when a
       * unit is aborted before its sizes are known (the common case — admitted
       * cancels happen early, before Content-Length headers exist, which is why
       * the exact counter reads 0 on a whole soak), the unit's total is
       * estimated as (running mean bytes-per-splat over COMPLETED units) ×
       * model.unitSplats[unit], minus what already arrived, clamped at ≥ 0.
       */
      cancelSavedEstimateBytes: 0,
      /**
       * [ssog-24 fix D] WIRE bytes: PerformanceResourceTiming.transferSize per
       * file (0 on an HTTP-cache hit, compressed octets otherwise), falling back
       * to the decoded body sum when no timing entry exists or transferSize is 0
       * while bytes were read (a cross-origin response exposes transferSize only
       * under Timing-Allow-Origin, which the CDN may not carry).
       */
      bytesReceived: 0,
      /**
       * [ssog-24 fix D] DECODED bytes read out of the response bodies — what
       * bytesReceived used to hold. Post-gunzip, and counted in full even for a
       * response served entirely from the HTTP cache, so it measures decode
       * volume, NOT network transfer.
       */
      decodedBytesReceived: 0,
      /**
       * [ssog-22 fix] shared SH palette files actually fetched. The build writes
       * one per level, so this should settle at the number of DISTINCT levels
       * the session touched; anything higher means the per-path memo is
       * thrashing and the ~1 MB centroids image is being re-downloaded.
       */
      paletteFetches: 0,
      /**
       * [ssog-24] responses that carried NO Content-Length (gzip'd meta.json is
       * chunked). While such a file is in flight the unit's progress is
       * unknowable, so unitProgress reports null and the pager treats the
       * transfer as cancellable. A large value here means the byte-progress
       * lever is measuring blind, not that there is nothing to save.
       */
      filesWithoutLength: 0,
      /**
       * [ssog-24 r4] settled files whose true wire size could not be read, so
       * the (higher) decoded body sum was billed instead: no PerformanceResource
       * Timing entry, or a cross-origin response without Timing-Allow-Origin.
       * bytesReceived is an OVER-estimate by exactly these files' compression
       * savings — a large value means the wire measurement is not working.
       */
      filesWithoutWireSize: 0,
      /** [ssog-27] units loaded through the ONE-file container path */
      packedFetches: 0,
      /** [ssog-27] containers rejected (magic/version/table/count/member set) — each also counts in fetchErrors */
      packErrors: 0,
      /** [ssog-27] non-abort unit failures (network, container, decode); drives the per-unit cool-down */
      unitStrikes: 0,
      /** [ssog-27] getUnit calls refused during a unit's cool-down (no request made) */
      fetchRefused: 0
    };
    this.palettes = /* @__PURE__ */ new Map();
    this.completedBytes = 0;
    this.completedSplats = 0;
    this.model = options.model;
    this.baseUrl = options.baseUrl ?? "";
    this.withCredentials = options.withCredentials ?? false;
    this.maxUnits = Math.max(1, options.maxUnits ?? 3);
    this.splatEncoding = options.splatEncoding ?? spark.defines.DEFAULT_SPLAT_ENCODING;
    this.resolver = options.resolveUrl ?? ((relativePath) => this.baseUrl + relativePath);
    prepareTimingBuffer();
  }
  getPalette(rel) {
    const existing = this.palettes.get(rel);
    if (existing) {
      return existing;
    }
    this.stats.paletteFetches += 1;
    const promise = this.fetchFile(rel);
    promise.catch(() => {
      if (this.palettes.get(rel) === promise) {
        this.palettes.delete(rel);
      }
    });
    this.palettes.set(rel, promise);
    return promise;
  }
  /**
   * Memoized unit decode. Blocks of one unit share a single fetch+decode.
   * [ssog-24] Every call on an IN-FLIGHT record registers one waiter; pair
   * it with `release(unit)` if the caller stops wanting the unit before it
   * settles (settled records ignore waiters).
   */
  getUnit(unit) {
    const existing = this.units.get(unit);
    if (existing) {
      this.units.delete(unit);
      this.units.set(unit, existing);
      if (!existing.settled) {
        existing.waiters += 1;
      }
      return existing.promise;
    }
    const failure = this.unitFailures.get(unit);
    if (failure && performance.now() < failure.until) {
      this.stats.fetchRefused += 1;
      return Promise.reject(
        new Error(
          `ssog unit ${this.model.unitDirName(unit)}: refused for ${Math.ceil((failure.until - performance.now()) / 1e3)} s after ${failure.strikes} failed attempt(s)`
        )
      );
    }
    const record = {
      id: ++this.recordSeq,
      promise: void 0,
      settled: false,
      controller: new AbortController(),
      waiters: 1,
      received: 0,
      receivedWire: 0,
      expected: 0,
      filesTotal: 0,
      filesWithLength: 0,
      fetchDone: false,
      aborted: false
    };
    record.promise = this.fetchDecodeUnit(unit, record).then(
      (decoded) => {
        record.settled = true;
        this.rememberUnitBytes(unit, record.receivedWire);
        this.unitFailures.delete(unit);
        return decoded;
      },
      (error) => {
        var _a;
        if (this.units.get(unit) === record) {
          this.units.delete(unit);
        }
        if (!record.aborted && !isAbortError(error)) {
          this.stats.fetchErrors += 1;
          if (error instanceof SsogUnitPackError) {
            this.stats.packErrors += 1;
          }
          const strikes = (((_a = this.unitFailures.get(unit)) == null ? void 0 : _a.strikes) ?? 0) + 1;
          this.stats.unitStrikes += 1;
          this.unitFailures.set(unit, {
            strikes,
            until: performance.now() + 1e3 * Math.min(300, 2 ** (strikes + 1))
          });
        }
        throw error;
      }
    );
    this.units.set(unit, record);
    this.evictOverflow();
    return record.promise;
  }
  /**
   * [ssog-24] Drop one waiter of an IN-FLIGHT unit. When the last waiter
   * leaves while bytes are still on the wire, the unit's downloads are
   * aborted, the record is removed (a later getUnit re-fetches cleanly) and
   * the saved bytes are accounted. A unit whose files have all arrived is
   * left to finish its decode — nothing is saved by aborting it, and the
   * settled decode stays useful in the LRU.
   */
  release(unit) {
    const record = this.units.get(unit);
    if (!record || record.settled) {
      return;
    }
    record.waiters = Math.max(0, record.waiters - 1);
    if (record.waiters > 0 || record.fetchDone) {
      return;
    }
    record.aborted = true;
    this.units.delete(unit);
    this.stats.fetchCancels += 1;
    const sizeKnown = record.filesTotal > 0 && record.filesWithLength >= record.filesTotal && record.expected > 0;
    const exact = Math.max(0, record.expected - record.received);
    this.stats.cancelSavedBytes += sizeKnown ? exact : 0;
    if (sizeKnown) {
      this.stats.cancelSavedEstimateBytes += exact;
    } else {
      const perSplat = this.bytesPerSplat();
      const splats = this.model.unitSplats[unit] ?? 0;
      const predicted = perSplat !== void 0 && splats > 0 ? perSplat * splats : 0;
      this.stats.cancelSavedEstimateBytes += Math.max(
        0,
        predicted - record.received
      );
    }
    record.controller.abort();
  }
  /**
   * [ssog-24] Identity of the CURRENT in-flight record of a unit, or
   * undefined when there is none (settled records are not leasable). Pair it
   * with `retain(unit, id)` across a cancel so a re-lease can tell "the
   * record I was awaiting" from "a new download of the same unit".
   */
  unitRecordId(unit) {
    const record = this.units.get(unit);
    return record && !record.settled ? record.id : void 0;
  }
  /**
   * [ssog-24] Re-lease an IN-FLIGHT unit whose waiter this caller previously
   * dropped (the pager's chunk became wanted again before its cancelled
   * fetcher rejected). Returns true when a waiter was added — pair it with
   * a later `release(unit)`. Returns false when the record is gone, settled
   * or already aborted, or when `id` names a different record: the caller
   * then stays cancelled and its chunk restarts through the normal path.
   */
  retain(unit, id) {
    const record = this.units.get(unit);
    if (!record || record.settled || record.aborted) {
      return false;
    }
    if (id !== void 0 && record.id !== id) {
      return false;
    }
    record.waiters += 1;
    return true;
  }
  /**
   * [ssog-24] Download progress of an in-flight unit: received/expected
   * (0..1) only while EVERY started-or-pending file's size is known; null
   * while any is not; 1 for a settled unit; null for a unit not in the
   * cache. Mixing wire Content-Length with received body bytes across a set
   * where some files report no length (a gzip'd meta.json is chunked, and
   * the plane list is not even known until it is parsed) reads as ~1.0 and
   * silently disables cancellation for the unit — the pager treats null as
   * 0, i.e. cancellable, which is the safe direction for a byte lever.
   */
  unitProgress(unit) {
    const record = this.units.get(unit);
    if (!record) {
      return null;
    }
    if (record.settled || record.fetchDone) {
      return 1;
    }
    if (record.filesTotal <= 0 || record.filesWithLength < record.filesTotal || record.expected <= 0) {
      return null;
    }
    return Math.min(1, record.received / record.expected);
  }
  /** [ssog-24] bytes received for a COMPLETED unit download, if remembered */
  unitBytes(unit) {
    return this.unitBytesMap.get(unit);
  }
  /** mean bytes per splat so far, or undefined until one unit has completed */
  bytesPerSplat() {
    return this.completedSplats > 0 ? this.completedBytes / this.completedSplats : void 0;
  }
  rememberUnitBytes(unit, bytes) {
    const splats = this.model.unitSplats[unit];
    if (bytes > 0 && splats > 0) {
      this.completedBytes += bytes;
      this.completedSplats += splats;
    }
    if (this.unitBytesMap.has(unit)) {
      this.unitBytesMap.delete(unit);
    }
    this.unitBytesMap.set(unit, bytes);
    if (this.unitBytesMap.size > UNIT_BYTES_MAX) {
      const oldest = this.unitBytesMap.keys().next();
      if (!oldest.done) {
        this.unitBytesMap.delete(oldest.value);
      }
    }
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
    this.unitBytesMap.clear();
    this.palettes.clear();
    this.unitFailures.clear();
  }
  /**
   * Fetch one file under the signing hook. [ssog-24] The body is read as a
   * stream so bytes are counted as they arrive (`stats.decodedBytesReceived`,
   * plus the caller's sink) and an abort mid-body stops the transfer; the
   * Content-Length, when the response carries one, is reported to the sink
   * once the headers arrive; when it carries none (a compressed JSON
   * response is chunked) `onEnd` reports the size the file turned out to
   * have, so the record can stop calling itself blind once it completes.
   * Aborts reject with the DOMException whose name is "AbortError".
   *
   * [ssog-24 fix D] The WIRE size is a separate question from the body size:
   * body bytes are POST-gunzip (this tier turned gzip on for every unit
   * meta.json) and count in full for a response served from the HTTP cache,
   * which transferred nothing. Once the file settles its
   * PerformanceResourceTiming.transferSize is preferred into
   * `stats.bytesReceived` — 0 on a cache hit, compressed octets otherwise —
   * and the body sum is the fallback when no entry exists or transferSize is
   * 0 while bytes were read (cross-origin responses expose transferSize only
   * with a Timing-Allow-Origin header, which the CDN may not carry).
   */
  async fetchFile(relativePath, signal, sink) {
    var _a, _b, _c, _d, _e;
    const resolved = await this.resolver(relativePath);
    if (signal == null ? void 0 : signal.aborted) {
      throw abortError();
    }
    const url = typeof resolved === "string" ? resolved : resolved.url;
    const headers = typeof resolved === "string" ? void 0 : resolved.headers;
    const request = new Request(url, {
      headers: headers ? new Headers(headers) : void 0,
      credentials: this.withCredentials ? "include" : "same-origin"
    });
    this.stats.fetches += 1;
    const startedAt = typeof performance !== "undefined" ? performance.now() : 0;
    const response = await fetch(request, signal ? { signal } : void 0);
    if (!response.ok || !response.body) {
      throw new Error(
        `Failed to fetch "${url}": ${response.status} ${response.statusText}`
      );
    }
    const lengthHeader = response.headers.get("content-length");
    const encodingHeader = (response.headers.get("content-encoding") ?? "").trim().toLowerCase();
    const encoded = encodingHeader !== "" && encodingHeader !== "identity";
    let hadLength = false;
    if (lengthHeader !== null && !encoded) {
      const length = Number.parseInt(lengthHeader, 10);
      if (Number.isFinite(length) && length >= 0) {
        hadLength = true;
        (_a = sink == null ? void 0 : sink.onLength) == null ? void 0 : _a.call(sink, length);
      }
    }
    if (!hadLength) {
      this.stats.filesWithoutLength += 1;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value && value.byteLength > 0) {
          chunks.push(value);
          total += value.byteLength;
          this.stats.decodedBytesReceived += value.byteLength;
          (_b = sink == null ? void 0 : sink.onBytes) == null ? void 0 : _b.call(sink, value.byteLength);
        }
      }
    } catch (error) {
      this.stats.bytesReceived += total;
      (_c = sink == null ? void 0 : sink.onWire) == null ? void 0 : _c.call(sink, total);
      throw error;
    }
    let wire = wireSize(url, startedAt, total);
    if (!wire.known) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      wire = wireSize(url, startedAt, total);
    }
    this.stats.bytesReceived += wire.bytes;
    if (!wire.known) {
      this.stats.filesWithoutWireSize += 1;
    }
    (_d = sink == null ? void 0 : sink.onWire) == null ? void 0 : _d.call(sink, wire.bytes);
    (_e = sink == null ? void 0 : sink.onEnd) == null ? void 0 : _e.call(sink, total, hadLength);
    if (chunks.length === 1 && chunks[0].byteOffset === 0 && chunks[0].byteLength === chunks[0].buffer.byteLength) {
      return chunks[0].buffer;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out.buffer;
  }
  async fetchDecodeUnit(unit, record) {
    const signal = record.controller.signal;
    const sink = {
      onLength: (bytes) => {
        record.expected += bytes;
        record.filesWithLength += 1;
      },
      onBytes: (delta) => {
        record.received += delta;
      },
      onWire: (delta) => {
        record.receivedWire += delta;
      },
      onEnd: (total, hadLength) => {
        if (!hadLength) {
          record.expected += total;
          record.filesWithLength += 1;
        }
      }
    };
    const dir = this.model.unitDirName(unit);
    const { json, files } = this.model.unitPack === 1 ? await this.fetchPackedUnit(unit, dir, record, signal, sink) : await this.fetchClassicUnit(dir, record, signal, sink);
    return this.decodeFetchedUnit(unit, dir, json, files, signal);
  }
  /**
   * Classic loose files: meta.json first (the plane list lives in it), then
   * every plane in parallel under the unit's abort signal.
   */
  async fetchClassicUnit(dir, record, signal, sink) {
    const metaBytes = await this.fetchFile(`${dir}/meta.json`, signal, sink);
    const json = JSON.parse(
      new TextDecoder().decode(metaBytes)
    );
    const names = planeNames(json);
    record.filesTotal = 1 + names.length;
    const files = {};
    await Promise.all(
      names.map(async (name) => {
        files[name] = await this.fetchFile(`${dir}/${name}`, signal, sink);
      })
    );
    record.fetchDone = true;
    return { json, files };
  }
  /**
   * [ssog-27] ONE file per unit, known BEFORE the request starts: filesTotal=1
   * now, expected on the first Content-Length header (identity octet-stream)
   * → unitProgress is real from the first byte, never null for the whole
   * transfer. A content-encoded response still counts as length-unknown
   * (fetchFile) and is settled by onEnd — the safe direction is preserved.
   * The container is verified (header, directory, meta bound) and its counts
   * are checked against the model BEFORE any decode; every violation rejects
   * with an SsogUnitPackError, which the strike/cool-down then bounds.
   */
  async fetchPackedUnit(unit, dir, record, signal, sink) {
    record.filesTotal = 1;
    const buf = await this.fetchFile(
      `${dir}/${SSOG_UNIT_PACK_FILE}`,
      signal,
      sink
    );
    record.fetchDone = true;
    const label = `ssog unit ${dir}`;
    const pack = parseUnitPack(buf, label);
    const rows = this.model.unitSplats[unit];
    if (pack.count !== rows) {
      throw new SsogUnitPackError(
        label,
        `header count ${pack.count}, model derives ${rows}`
      );
    }
    const metaText = new TextDecoder().decode(
      readUnitPackMeta(buf, pack, label)
    );
    let json;
    try {
      json = JSON.parse(metaText);
    } catch (e) {
      throw new SsogUnitPackError(
        label,
        `meta.json is not valid JSON: ${e.message}`
      );
    }
    if (json.count !== rows) {
      throw new SsogUnitPackError(
        label,
        `meta count ${json.count}, model derives ${rows}`
      );
    }
    const names = planeNames(json);
    if (pack.members.size !== names.length + 1) {
      throw new SsogUnitPackError(
        label,
        `${pack.members.size - 1} plane members, meta lists ${names.length}`
      );
    }
    const files = {};
    for (const name of names) {
      const m = pack.members.get(name);
      if (!m || m.deflate) {
        throw new SsogUnitPackError(
          label,
          `plane ${name} missing from container or compressed`
        );
      }
      files[name] = buf.slice(m.offset, m.offset + m.length);
    }
    this.stats.packedFetches += 1;
    return { json, files };
  }
  /** shared tail of both shapes: palette memo → worker decode → P0b count gate */
  async decodeFetchedUnit(unit, dir, json, files, signal) {
    var _a;
    const paletteRel = (_a = json.shN) == null ? void 0 : _a.palette;
    let palette;
    if (paletteRel) {
      const bytes = await this.getPalette(paletteRel);
      palette = { key: paletteRel, bytes: bytes.slice(0) };
    }
    if (signal.aborted) {
      throw abortError();
    }
    this.stats.decodes += 1;
    const origin = this.model.packOrigin;
    const decoded = await spark.workerPool.withWorker(
      async (worker) => worker.call("unpackSsogUnit", {
        json,
        files,
        encoding: this.splatEncoding,
        palette,
        ...origin ? { origin: [origin[0], origin[1], origin[2]] } : {}
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
function abortError() {
  return new DOMException("ssog unit fetch aborted", "AbortError");
}
let timingBufferPrepared = false;
function prepareTimingBuffer() {
  var _a, _b;
  if (timingBufferPrepared || typeof performance === "undefined") {
    return;
  }
  timingBufferPrepared = true;
  try {
    (_a = performance.setResourceTimingBufferSize) == null ? void 0 : _a.call(performance, 2e4);
    (_b = performance.addEventListener) == null ? void 0 : _b.call(performance, "resourcetimingbufferfull", () => {
      var _a2;
      try {
        (_a2 = performance.clearResourceTimings) == null ? void 0 : _a2.call(performance);
      } catch {
      }
    });
  } catch {
  }
}
function wireSize(url, startedAt, bodyBytes) {
  const fallback = { bytes: bodyBytes, known: false };
  try {
    if (typeof performance === "undefined" || !performance.getEntriesByName) {
      return fallback;
    }
    const name = typeof location !== "undefined" ? new URL(url, location.href).href : url;
    const entries = performance.getEntriesByName(
      name,
      "resource"
    );
    let entry;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].startTime >= startedAt - 1) {
        entry = entries[i];
        break;
      }
    }
    if (!entry) {
      return fallback;
    }
    const transferred = entry.transferSize;
    if (typeof transferred !== "number") {
      return fallback;
    }
    if (transferred === 0 && bodyBytes > 0) {
      return entry.encodedBodySize > 0 ? { bytes: 0, known: true } : fallback;
    }
    return { bytes: transferred, known: true };
  } catch {
    return fallback;
  }
}
function isAbortError(error) {
  return typeof error === "object" && error !== null && error.name === "AbortError";
}
const CUT_ROW_SPLATS = 16384;
class SsogSplats extends spark.PagedSplats {
  constructor(options) {
    const { model, cache, budget } = options;
    const maxSh = options.maxSh ?? 3;
    const numFetchers = options.numFetchers ?? (spark.isMobile() ? 2 : 4);
    const L = model.lodLevels;
    const coarsestSplats = model.counts[L - 1];
    const maxCut = model.counts[0];
    const cutSplats = Math.min(budget * 1.15, maxCut);
    const slackSplats = (model.maxLeafBlockFootprint + numFetchers) * SSOG_PAGE_SPLATS;
    const poolFactor = options.poolFactor ?? 1;
    const rawMaxPoolPages = options.maxPoolPages;
    const maxPoolPages = typeof rawMaxPoolPages === "number" && Number.isFinite(rawMaxPoolPages) && rawMaxPoolPages >= 1 ? Math.floor(rawMaxPoolPages) : 256;
    const wantPages = Math.ceil(
      (cutSplats * poolFactor + coarsestSplats + slackSplats) / SSOG_PAGE_SPLATS
    );
    const poolPages = Math.min(wantPages, model.totalBlocks, maxPoolPages);
    if (poolPages === maxPoolPages && wantPages > maxPoolPages && maxPoolPages < model.totalBlocks) {
      console.warn(
        `[ssog] poolPages clamped ${wantPages} -> ${maxPoolPages} (device maxTextureArrayLayers class)`
      );
    }
    const pager = new spark.SplatPager({
      renderer: options.renderer,
      extSplats: false,
      maxSplats: poolPages * SSOG_PAGE_SPLATS,
      maxSh,
      autoDrive: false,
      // the controller owns the §2.3 pump contract
      numFetchers
    });
    if (numFetchers > spark.workerPool.maxWorkers) {
      spark.workerPool.maxWorkers = numFetchers;
    }
    super({ pager, fileType: spark.SplatFileType.SSOG, maxSh });
    this.externalLod = true;
    this.numShResolved = false;
    this.leases = /* @__PURE__ */ new Map();
    this.releasedLeases = /* @__PURE__ */ new Map();
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
    const encoding = spark.defines.DEFAULT_SPLAT_ENCODING;
    this.fixedEncoding = encoding;
    this.splatEncoding = encoding;
    this.lodOpacity.value = false;
    this.shMax.value.set(
      encoding.sh1Max ?? 1,
      encoding.sh2Max ?? 1,
      encoding.sh3Max ?? 1
    );
    const origin = cache.model.packOrigin;
    if (cache.model !== model) {
      const mine = model.packOrigin;
      if (String(mine) !== String(origin)) {
        console.warn(
          `[ssog] SsogSplats model packOrigin ${String(mine)} != cache model ${String(origin)}; using the cache's (it decodes)`
        );
      }
    }
    this.centerOrigin = origin ? new THREE.Vector3(origin[0], origin[1], origin[2]) : null;
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
    const pending = this.cache.getUnit(unit);
    this.leases.set(chunk, unit);
    this.releasedLeases.delete(chunk);
    let decoded;
    try {
      decoded = await pending;
    } finally {
      if (this.leases.get(chunk) === unit) {
        this.leases.delete(chunk);
      }
      this.releasedLeases.delete(chunk);
    }
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
   * [ssog-24] The pager no longer wants this in-flight chunk: drop its
   * waiter on the unit download. The cache aborts the transfer when no
   * other in-flight chunk of the unit is still wanted.
   */
  cancelFetchChunk(chunk) {
    const unit = this.leases.get(chunk);
    if (unit === void 0) {
      return;
    }
    this.leases.delete(chunk);
    const id = this.cache.unitRecordId(unit);
    if (id !== void 0) {
      this.releasedLeases.set(chunk, { unit, id });
    }
    this.cache.release(unit);
  }
  /**
   * [ssog-24] The pager wants this cancelled-but-still-in-flight chunk
   * again. Re-lease the very unit download the fetcher is awaiting; true =
   * the lease is back and the fetcher may be un-cancelled. False = the
   * record is gone (aborted, settled, or replaced), so the fetcher stays
   * cancelled and the chunk restarts through the normal path.
   */
  resumeFetchChunk(chunk) {
    const released = this.releasedLeases.get(chunk);
    if (!released) {
      return this.leases.has(chunk);
    }
    if (!this.cache.retain(released.unit, released.id)) {
      return false;
    }
    this.releasedLeases.delete(chunk);
    this.leases.set(chunk, released.unit);
    return true;
  }
  /**
   * [ssog-24] fetch group of a chunk = its UNIT: every chunk of one unit
   * shares a single download, so cancelling that download for one chunk
   * also kills the transfer a sibling chunk in the same group is waiting
   * for. The pager uses this to keep a group alive while any chunk of it is
   * still wanted.
   */
  fetchGroup(chunk) {
    if (chunk < 0 || chunk >= this.model.totalBlocks) {
      return null;
    }
    return this.model.unitOfChunk(chunk).unit;
  }
  /** [ssog-24] download progress (0..1) of the chunk's unit, null = unknown */
  fetchProgress(chunk) {
    const unit = this.leases.get(chunk);
    if (unit === void 0) {
      return null;
    }
    return this.cache.unitProgress(unit);
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
    this.lastMotionMs = Number.NEGATIVE_INFINITY;
    this.ssePhase = "fine";
    this.moveGateOverride = null;
    this.fetchHold = false;
    this.phase = "reveal";
    this.detached = false;
    this.interest = null;
    this.tmpInterest = new THREE__namespace.Vector3();
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
    this.everDisplayed = /* @__PURE__ */ new Set();
    this.sseErrorBlend = 0;
    this.errPos = null;
    this.focusStrength = 0;
    this.focusRadius = 0.25;
    this.focusMul = null;
    this.subjectR = -1;
    this.tolPxAnchor = 0;
    this.priorityChunks = /* @__PURE__ */ new Set();
    this.lastPose = {
      valid: false,
      pos: new THREE__namespace.Vector3(),
      quat: new THREE__namespace.Quaternion(),
      fov: 0
    };
    this.tmpMat = new THREE__namespace.Matrix4();
    this.tmpPos = new THREE__namespace.Vector3();
    this.tmpFwd = new THREE__namespace.Vector3();
    this.tmpQuat = new THREE__namespace.Quaternion();
    this.tmpScale = new THREE__namespace.Vector3();
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
      /** [ssog-20] page cap the promote-to-fill leg spent (0 = not enforced) */
      fillPageCap: 0,
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
      revealTotalBlocks: 0,
      /** [ssog-20] leaves whose resolved-coarsest ref is outside the pin tier */
      revealHoleLeaves: 0,
      /** [ssog-23] selection policy in force */
      lodMode: "bands",
      /** [ssog-25] "target" while an interest point orders the fill, else "camera" */
      interestMode: "camera",
      /** [ssog-26] behind-camera penalty factor in force (4 = the ×5 legacy) */
      behindPenalty: 4,
      /** [ssog-31] graded budget in force */
      gradedBudget: true,
      /** [ssog-31] tolerance multiplier the last selection settled at (1 = the e-px cut fit) */
      sseTolMul: 1,
      /** [ssog-31] effective tolerance of the last selection (CSS px) = sseErrorPx × sseTolMul */
      sseTolPx: 0,
      /** [ssog-31] quarter-level steps the last tolerance search took */
      sseTolSteps: 0,
      /** [ssog-31] distinct pages of the all-coarsest cut (= the pinned tier since the empty coarse suffix) */
      floorPages: 0,
      /**
       * [ssog-25] grows deferred by capacity or the pool guard that sat in the
       * NEARER half of the ordered grow list — the subject's share of the
       * deferrals. Non-zero at rest means the subject is being held back by
       * the cap, not by the ordering.
       */
      subjectDeferrals: 0,
      /** [ssog-23] L1 geometric error (mesh-local units) the sse mode calibrated */
      sseErr1: 0,
      /** [ssog-32] per-unit error blend α in force (0 = uniform per-level error) */
      sseErrorBlend: 0,
      /** [ssog-33] target focus strength / radius in force */
      focusStrength: 0,
      focusRadius: 0.25,
      /** [ssog-33] true when the last selection applied the focus (interest set, sse + graded, g > 0) */
      focusActive: false,
      /** [ssog-23] error tolerance (CSS px) the last selection ran at */
      sseErrorPx: 0,
      /** [ssog-23] "base" while moving / before dwell, "fine" at rest */
      ssePhase: "fine",
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
      /** [ssog-27] units loaded through the ONE-file container path — cache mirror */
      packedFetches: 0,
      /** [ssog-27] containers rejected (magic/version/table/count/member set) — cache mirror */
      packErrors: 0,
      /** [ssog-27] non-abort unit failures that started a per-unit cool-down — cache mirror */
      unitStrikes: 0,
      /** [ssog-27] getUnit calls refused during a unit's cool-down (no request made) — cache mirror */
      fetchRefused: 0
    };
    this.mesh = options.mesh;
    this.splats = options.splats;
    this.sparkRenderer = options.sparkRenderer;
    this.budget = options.budget ?? this.splats.budget;
    const chunkExtent = options.chunkExtent ?? this.splats.model.chunkExtent ?? 16;
    this.lodBaseDistance = options.lodBaseDistance ?? 5 / 16 * chunkExtent;
    const rawFillCap = options.fillPageCap;
    this.fillPageCapOption = typeof rawFillCap === "number" && Number.isFinite(rawFillCap) && rawFillCap >= 1 ? Math.floor(rawFillCap) : null;
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
    this.tBucket = new Float64Array(this.NL);
    this.levelPos = new Float64Array(this.NL);
    this.readySinceTick = new Int32Array(this.NL).fill(-1);
    this.lodMode = options.lodMode === "sse" ? "sse" : "bands";
    this.behindPenalty = SsogLodController.clampBehindPenalty(
      options.behindPenalty
    );
    this.stats.behindPenalty = this.behindPenalty;
    this.gradedBudget = options.gradedBudget !== false;
    this.stats.gradedBudget = this.gradedBudget;
    this.sseErrorPx = Math.max(0.1, options.sseErrorPx ?? 2);
    this.sseBaseErrorPx = options.sseBaseErrorPx ?? 4;
    this.sseDwellMs = Math.max(0, options.sseDwellMs ?? 1500);
    this.viewportHeightPx = Math.max(64, options.viewportHeightPx ?? 1080);
    {
      const L = this.L;
      const spacings = [];
      const bounds = model.boundsFlat;
      for (let li = 0; li < this.NL; li++) {
        const o = li * 6;
        const ext = Math.max(
          bounds[o + 3] - bounds[o],
          bounds[o + 4] - bounds[o + 1],
          bounds[o + 5] - bounds[o + 2]
        );
        const n0 = model.leafLodsPre[li * L * 3] >= 0 ? model.leafLodsPre[li * L * 3 + 2] : 0;
        if (n0 > 0 && ext > 0) {
          spacings.push(ext / Math.sqrt(n0));
        }
      }
      spacings.sort((a, b) => a - b);
      const s0 = spacings.length > 0 ? spacings[spacings.length >> 1] : 1;
      this.sseS0 = s0;
      this.sseErr1 = 0.5 * s0 * Math.SQRT2;
      this.stats.sseErr1 = this.sseErr1;
      this.stats.lodMode = this.lodMode;
    }
    this.applySseErrorBlend(options.sseErrorBlend);
    this.applyFocus(options.focusStrength, options.focusRadius);
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
          `[ssog] pool too small for page-aware balance: pinned ${pinned.length} + margin ${margin} > guard ${guard} — cut will rest at coarsest`
        );
      }
    }
  }
  /**
   * [ssog-17]/[ssog-31] distinct pool pages of a cut — the pinned tier ∪
   * every leaf at `levels[li]` — leaving pageRefs holding that cut's
   * refcounts for the fill's incremental moves. Bump order (pinned, then
   * leaves ascending) is the one the inline passes used, so the refs are
   * bit-identical to kroscloud.38 on the non-graded path.
   */
  countCutPages(levels) {
    const refs = this.pageRefs;
    refs.fill(0);
    let distinct = 0;
    for (const c of this.pinnedChunks) {
      if (refs[c] === 0) {
        distinct++;
      }
      refs[c]++;
    }
    for (let li = 0; li < this.NL; li++) {
      distinct = this.bumpLeafPageRefs(li, levels[li], refs, distinct, 1);
    }
    return distinct;
  }
  /** [ssog-31] pages of the all-coarsest cut (the reset floor) — HUD/diagnostics, computed once. */
  countFloorPages() {
    const levels = new Int32Array(this.NL).fill(this.L - 1);
    return this.countCutPages(levels);
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
    this.syncByteStats();
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
    const refillPager = this.splats.pager;
    if (!this.converged && refillPager && refillPager.fetchPriority.length > 0 && refillPager.fetchers.length < refillPager.numFetchers) {
      refillPager.driveFetchers();
    }
    if (this.lodMode === "sse" && this.ssePhase === "base" && performance.now() - this.lastMotionMs >= this.sseDwellMs) {
      this.paramsDirty = true;
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
  subjectProgress() {
    if (!this.interest || this.phase !== "run" || this.fetchHold || !(this.subjectR > 0)) {
      return -1;
    }
    const lods = this.splats.model.leafLods;
    const L = this.L;
    const R = this.subjectR;
    let target = 0;
    let shown = 0;
    for (let li = 0; li < this.NL; li++) {
      if (this.tBucket[li] > R) {
        continue;
      }
      const t = lods[(li * L + this.balancedLevel[li]) * 3 + 2];
      target += t;
      shown += Math.min(t, this.displayedCount(li));
    }
    return target > 0 ? shown / target : -1;
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
  setBehindPenalty(k) {
    const next = SsogLodController.clampBehindPenalty(k);
    if (next === this.behindPenalty) {
      return;
    }
    this.behindPenalty = next;
    this.stats.behindPenalty = next;
    this.paramsDirty = true;
  }
  static clampBehindPenalty(k) {
    return typeof k === "number" && Number.isFinite(k) ? Math.min(16, Math.max(0, k)) : 4;
  }
  /** [ssog-31] graded budget on/off (see the option); takes effect next tick. */
  setGradedBudget(on) {
    const next = on !== false;
    if (next === this.gradedBudget) {
      return;
    }
    this.gradedBudget = next;
    this.stats.gradedBudget = next;
    this.paramsDirty = true;
  }
  /** [ssog-33] target focus strength g and radius (see the options); takes effect next tick. */
  setFocus(strength, radius) {
    const s0 = this.focusStrength;
    const r0 = this.focusRadius;
    this.applyFocus(strength, radius ?? this.focusRadius);
    if (this.focusStrength !== s0 || this.focusRadius !== r0) {
      this.paramsDirty = true;
    }
  }
  applyFocus(strength, radius) {
    this.focusStrength = typeof strength === "number" && Number.isFinite(strength) ? Math.min(8, Math.max(0, strength)) : 0;
    this.focusRadius = typeof radius === "number" && Number.isFinite(radius) && radius > 0 ? Math.min(100, radius) : 0.25;
    this.stats.focusStrength = this.focusStrength;
    this.stats.focusRadius = this.focusRadius;
  }
  /** [ssog-32] per-unit error blend α (see the option); takes effect next tick. */
  setSseErrorBlend(alpha) {
    const before = this.sseErrorBlend;
    this.applySseErrorBlend(alpha);
    if (this.sseErrorBlend !== before) {
      this.paramsDirty = true;
    }
  }
  applySseErrorBlend(alpha) {
    const a = typeof alpha === "number" && Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 0;
    this.sseErrorBlend = a;
    this.stats.sseErrorBlend = a;
    this.errPos = a > 0 ? this.buildErrPos(a) : null;
  }
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
  buildErrPos(alpha) {
    const model = this.splats.model;
    const L = this.L;
    const NL = this.NL;
    const pre = model.leafLodsPre;
    const b = model.boundsFlat;
    const ext = new Float64Array(NL);
    for (let li = 0; li < NL; li++) {
      const o = li * 6;
      ext[li] = Math.max(b[o + 3] - b[o], b[o + 4] - b[o + 1], b[o + 5] - b[o + 2]);
    }
    const sumExt2 = new Float64Array(model.numUnits);
    const sumRows = new Float64Array(model.numUnits);
    const real = (li, l) => pre[(li * L + l) * 3] >= 0 && pre[(li * L + l) * 3 + 2] > 0;
    for (let li = 0; li < NL; li++) {
      for (let l = 0; l < L; l++) {
        if (!real(li, l)) {
          continue;
        }
        const u = pre[(li * L + l) * 3];
        sumExt2[u] += ext[li] * ext[li];
        sumRows[u] += pre[(li * L + l) * 3 + 2];
      }
    }
    const unitErr = new Float64Array(L);
    const out = new Float64Array(NL * L);
    const s0 = this.sseS0;
    const logM = Math.log(Math.SQRT2);
    const floorErr = 1e-9 * Math.max(s0, 1e-9);
    for (let li = 0; li < NL; li++) {
      let coarsest = 0;
      for (let l = 0; l < L; l++) {
        if (real(li, l)) {
          coarsest = l;
        }
      }
      unitErr.fill(0);
      for (let l = 1; l <= coarsest; l++) {
        if (real(li, l)) {
          const u = pre[(li * L + l) * 3];
          unitErr[l] = 0.5 * Math.sqrt(sumExt2[u] / sumRows[u]);
        }
      }
      for (let l = 1; l <= coarsest; l++) {
        if (real(li, l)) {
          continue;
        }
        let best = -1;
        for (let a = 0; a <= coarsest; a++) {
          if (!real(li, a)) {
            continue;
          }
          const da = Math.abs(a - l);
          const db = Math.abs(best - l);
          if (best < 0 || da < db || da === db && a > best) {
            best = a;
          }
        }
        unitErr[l] = best >= 0 ? unitErr[best] : 0.5 * ext[li];
      }
      for (let l = coarsest + 1; l < L; l++) {
        unitErr[l] = Math.max(
          unitErr[coarsest] * Math.SQRT2 ** (l - coarsest),
          0.5 * ext[li]
        );
      }
      const o = li * L;
      out[o] = Number.NEGATIVE_INFINITY;
      for (let l = 1; l < L; l++) {
        const uniform = 0.5 * s0 * Math.SQRT2 ** l;
        const err = uniform ** (1 - alpha) * unitErr[l] ** alpha;
        out[o + l] = Math.log(Math.max(floorErr, err)) / logM;
      }
    }
    return out;
  }
  /** [ssog-32] coarsest level l >= 1 with errPos[li,l] <= x, else 0 */
  levelAtPos(li, x) {
    const t = this.errPos;
    const o = li * this.L;
    for (let l = this.L - 1; l >= 1; l--) {
      if (t[o + l] <= x) {
        return l;
      }
    }
    return 0;
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
  setInterest(point) {
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z)) {
      if (!this.interest) {
        this.interest = new THREE__namespace.Vector3(point.x, point.y, point.z);
      } else {
        this.interest.set(point.x, point.y, point.z);
      }
    } else {
      this.interest = null;
    }
  }
  /** [ssog-25] ordering key: interest distance when set, else camera distance */
  orderKey(li) {
    return this.interest ? this.tBucket[li] : this.dBucket[li];
  }
  /**
   * [ssog-19] Hold/release tier-3 fetch staging across a scripted camera
   * flight (see the fetchHold field). Release forces a tick so the arrival
   * cut stages without waiting for a motion gate.
   */
  setFetchHold(hold) {
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
  setViewportHeight(px) {
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
  setSseError(finePx, basePx, dwellMs) {
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
  sseTolerance() {
    const baseActive = this.sseDwellMs > 0 && this.sseBaseErrorPx > this.sseErrorPx && performance.now() - this.lastMotionMs < this.sseDwellMs;
    this.ssePhase = baseActive ? "base" : "fine";
    return baseActive ? this.sseBaseErrorPx : this.sseErrorPx;
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
  /**
   * [ssog-24] mirror the byte counters of the unit cache and the pager into
   * stats every frame (not per tick: downloads finish and abort between
   * ticks, and a converged controller stops ticking while transfers drain).
   */
  syncByteStats() {
    const cs = this.splats.cache.stats;
    this.stats.fetchCancels = cs.fetchCancels;
    this.stats.cancelSavedBytes = cs.cancelSavedBytes;
    this.stats.cancelSavedEstimateBytes = cs.cancelSavedEstimateBytes;
    this.stats.bytesReceived = cs.bytesReceived;
    this.stats.decodedBytesReceived = cs.decodedBytesReceived;
    this.stats.paletteFetches = cs.paletteFetches;
    this.stats.filesWithoutLength = cs.filesWithoutLength;
    this.stats.filesWithoutWireSize = cs.filesWithoutWireSize;
    this.stats.packedFetches = cs.packedFetches;
    this.stats.packErrors = cs.packErrors;
    this.stats.unitStrikes = cs.unitStrikes;
    this.stats.fetchRefused = cs.fetchRefused;
    const pager = this.splats.pager;
    if (pager) {
      this.stats.chunkCancels = pager.fetchCancels;
      this.stats.cancelRefetches = pager.cancelRefetches;
    }
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
  /**
   * [ssog-24] Mark a (leaf, level) ref's chunks as HAVING BEEN DISPLAYED.
   * Deliberately NOT folded into addLeafRefs: the grow path adds refs
   * TENTATIVELY and reverts them when the block-aware pool guard rejects the
   * flip, so marking there counted chunks that were never composed and made
   * wastedChunks/wastedBytes undercount exactly in the near, pool-limited
   * regime the metric exists to measure. Only committed flips mark.
   */
  markDisplayed(li, level) {
    this.forEachLeafChunk(li, level, (c) => {
      this.everDisplayed.add(c);
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
  /**
   * [ssog-20] splat count a leaf currently contributes to the cut; 0 when the
   * leaf displays nothing (level −1: a reveal hole not yet laddered in).
   */
  displayedCount(li) {
    const lvl = this.displayed[li];
    return lvl < 0 ? 0 : this.splats.model.leafLods[(li * this.L + lvl) * 3 + 2];
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
  netPageDelta(li, to, from, refs) {
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
      toLast = model.blockBase[file] + Math.floor((offset + toCount - 1) / SSOG_PAGE_SPLATS);
    }
    let fromFirst = 0;
    let fromLast = -1;
    const fromOff = (li * L + from) * 3;
    const fromCount = from >= 0 ? model.leafLods[fromOff + 2] : 0;
    if (fromCount > 0) {
      const file = model.leafLods[fromOff];
      const offset = model.leafLods[fromOff + 1];
      fromFirst = model.blockBase[file] + Math.floor(offset / SSOG_PAGE_SPLATS);
      fromLast = model.blockBase[file] + Math.floor((offset + fromCount - 1) / SSOG_PAGE_SPLATS);
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
  forEachLeafChunk(li, level, fn) {
    if (level < 0) {
      return;
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
    this.displayedTotal = 0;
    this.chunkRefs.clear();
    for (const chunk of this.pinnedChunks) {
      this.chunkRefs.set(chunk, 1);
      this.everDisplayed.add(chunk);
    }
    let holes = 0;
    for (let li = 0; li < this.NL; li++) {
      const o = (li * this.L + this.L - 1) * 3;
      const pinnedResident = model.leafLods[o + 2] <= 0 || model.unitLevel[model.leafLods[o]] === this.L - 1;
      if (!pinnedResident) {
        this.displayed[li] = -1;
        holes += 1;
        continue;
      }
      this.displayed[li] = this.L - 1;
      this.displayedTotal += model.leafLods[(li * this.L + this.L - 1) * 3 + 2];
      this.addLeafRefs(li, this.L - 1);
      this.markDisplayed(li, this.L - 1);
    }
    this.desired.set(this.displayed);
    this.stats.revealHoleLeaves = holes;
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
    if (this.lodMode === "sse" && this.lastPose.valid) {
      const moveGate = this.moveGateOverride ?? this.moveGateFactor * this.lodBaseDistance;
      if (this.tmpPos.distanceTo(this.lastPose.pos) > moveGate || Math.abs(this.tmpQuat.dot(this.lastPose.quat)) < Math.SQRT1_2 || Math.abs(camera.fov - this.lastPose.fov) > 0.02 * Math.max(1e-6, this.lastPose.fov)) {
        this.lastMotionMs = performance.now();
      }
    }
    this.selectionAndBalance(camera, uniformScale);
    if (this.scaleMoved && !this.fetchHold) {
      this.settleBudgetScale(camera, uniformScale);
      this.selectionAndBalance(camera, uniformScale);
    }
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
    if (anyPending && !this.fetchHold) {
      const pendingLeaves = [];
      for (let li = 0; li < this.NL; li++) {
        if (this.desired[li] !== this.displayed[li]) {
          pendingLeaves.push(li);
        }
      }
      pendingLeaves.sort((a, b) => this.orderKey(a) - this.orderKey(b));
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
      if (priority.length < maxPages && pager && pager.getSplatsChunk(this.splats, chunk)) {
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
    this.converged = !this.fetchHold && (allAtTarget || this.ticksNoProgress >= 3 && pagerQuiet && !this.heldPending) && !this.scaleMoved;
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
  totalOptimalAt(camera, uniformScale, scale) {
    const model = this.splats.model;
    const L = this.L;
    const NL = this.NL;
    const bounds = model.boundsFlat;
    const cam = this.tmpPos;
    const fwd = this.tmpFwd;
    const tanHalfV = Math.tan(camera.fov / 2 * Math.PI / 180);
    const tanHalfH = tanHalfV * camera.aspect;
    const fovScale = Math.min(tanHalfV, tanHalfH) / Math.tan(22.5 * Math.PI / 180);
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
  settleBudgetScale(camera, uniformScale) {
    let scale = this.budgetScale;
    for (let i = 0; i < 64; i++) {
      const totalOptimal = this.totalOptimalAt(camera, uniformScale, scale);
      const ratio = totalOptimal / this.budget;
      if (ratio <= 1.4 && ratio >= 0.6) {
        break;
      }
      const next = Math.max(
        0.01,
        Math.min(100, scale * (1 + (1 / Math.sqrt(ratio) - 1) * 0.3))
      );
      if (next === scale) {
        break;
      }
      scale = next;
    }
    this.budgetScale = scale;
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
    const interest = this.interest ? this.tmpInterest.copy(this.interest).applyMatrix4(this.tmpMat) : null;
    this.stats.interestMode = interest ? "target" : "camera";
    const sse = this.lodMode === "sse";
    let sseD0 = 0;
    if (sse) {
      const e = this.sseTolerance();
      const fpxRef = this.viewportHeightPx / 2 / Math.tan(22.5 * Math.PI / 180);
      sseD0 = this.sseErr1 * uniformScale * fpxRef / e;
      this.stats.sseErrorPx = e;
      this.stats.ssePhase = this.ssePhase;
      this.stats.sseD0 = sseD0;
    }
    const d0 = sse ? sseD0 : this.lodBaseDistance * this.budgetScale;
    const mPrime = sse ? Math.SQRT2 : Math.max(1.2, 3 * this.budgetScale ** -0.2);
    const logM = Math.log(mPrime);
    const errPos = sse ? this.errPos : null;
    const dRef = errPos ? sseD0 / this.sseErr1 : d0;
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
        penalty = 1 + behind * Math.max(0, -dot);
      }
      const db = d * penalty * fovScale * uniformScale;
      this.dBucket[li] = db;
      if (interest) {
        const tx = Math.max(bounds[o], Math.min(interest.x, bounds[o + 3])) - interest.x;
        const ty = Math.max(bounds[o + 1], Math.min(interest.y, bounds[o + 4])) - interest.y;
        const tz = Math.max(bounds[o + 2], Math.min(interest.z, bounds[o + 5])) - interest.z;
        this.tBucket[li] = Math.hypot(tx, ty, tz);
      }
      this.bucketOf[li] = Math.min(
        63,
        Math.floor(64 * Math.sqrt(db) / sqrtDMax)
      );
      const pos = db > 0 ? Math.log(db / dRef) / logM : Number.NEGATIVE_INFINITY;
      this.levelPos[li] = pos;
      let lvl = errPos ? this.levelAtPos(li, pos) : db <= d0 ? 0 : 1 + Math.floor(pos);
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
    const pager = this.splats.pager;
    const wholeResident = !pager || pager.maxPages >= model.totalBlocks;
    const pageLimit = wholeResident ? Number.POSITIVE_INFINITY : this.poolGuardLimit() - (model.maxLeafBlockFootprint + pager.numFetchers);
    const pageRefs = this.pageRefs;
    if (this.stats.floorPages === 0) {
      this.stats.floorPages = this.countFloorPages();
    }
    let tolShift = 0;
    let tolSteps = 0;
    this.subjectR = interest ? Math.max(
      1e-6,
      this.focusRadius * Math.hypot(cam.x - interest.x, cam.y - interest.y, cam.z - interest.z)
    ) : -1;
    let focusMul = null;
    if (sse && this.gradedBudget && interest && this.focusStrength > 0) {
      const R = this.subjectR;
      const g = this.focusStrength;
      if (!this.focusMul) {
        this.focusMul = new Float64Array(NL);
      }
      focusMul = this.focusMul;
      for (let li = 0; li < NL; li++) {
        const t = this.tBucket[li];
        focusMul[li] = t > R ? 1 + g * Math.log2(t / R) : 1;
      }
    }
    this.stats.focusActive = focusMul !== null;
    if (sse && this.gradedBudget) {
      const K = 256;
      const pageSlack = wholeResident ? 0 : Math.max(1, Math.round(0.04 * pageLimit));
      const evalK = (k2, slack) => {
        tolSteps++;
        const shift = k2 / 4;
        let total = 0;
        for (let li = 0; li < NL; li++) {
          const x = this.levelPos[li] + (focusMul ? shift * focusMul[li] : shift);
          let lvl = errPos ? this.levelAtPos(li, x) : x <= 0 ? 0 : 1 + Math.floor(x);
          if (lvl >= L) {
            lvl = L - 1;
          }
          this.balancedLevel[li] = lvl;
          total += model.leafLods[(li * L + lvl) * 3 + 2];
        }
        totalBalanced = total;
        if (total > (slack ? 0.97 * budget : budget)) {
          return false;
        }
        return wholeResident || this.countCutPages(this.balancedLevel) <= (slack ? pageLimit - pageSlack : pageLimit);
      };
      const e = this.stats.sseErrorPx;
      let k = this.tolPxAnchor > 0 && e > 0 ? Math.min(K, Math.max(0, Math.round(8 * Math.log2(this.tolPxAnchor / e)))) : 0;
      if (evalK(k, false)) {
        if (k > 0 && evalK(k - 1, true)) {
          let lo = -1;
          let hi = k - 1;
          while (hi - lo > 1) {
            const mid = lo + hi >> 1;
            if (evalK(mid, true)) {
              hi = mid;
            } else {
              lo = mid;
            }
          }
          k = hi;
        }
        evalK(k, false);
      } else if (evalK(K, false)) {
        let lo = k;
        let hi = K;
        while (hi - lo > 1) {
          const mid = lo + hi >> 1;
          if (evalK(mid, false)) {
            hi = mid;
          } else {
            lo = mid;
          }
        }
        k = hi;
        evalK(k, false);
      } else {
        k = K;
      }
      tolShift = k / 4;
      this.tolPxAnchor = e * mPrime ** tolShift;
    }
    this.stats.sseTolMul = sse ? mPrime ** tolShift : 1;
    this.stats.sseTolPx = sse ? this.stats.sseErrorPx * this.stats.sseTolMul : 0;
    this.stats.sseTolSteps = tolSteps;
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
            totalBalanced += nextCount - curCount;
            if (totalBalanced <= budget) {
              break demote;
            }
          }
        }
      }
    }
    let distinctPages = this.countCutPages(this.balancedLevel);
    if (distinctPages > pageLimit) {
      totalBalanced = 0;
      for (let li = 0; li < NL; li++) {
        this.balancedLevel[li] = L - 1;
        totalBalanced += model.leafLods[(li * L + L - 1) * 3 + 2];
      }
      distinctPages = this.countCutPages(this.balancedLevel);
    }
    const FILL_UTILIZATION = 0.78;
    const avgPageSplats = model.count / Math.max(1, model.totalBlocks);
    const autoFillCap = Math.ceil(
      this.budget / Math.max(1, avgPageSplats * FILL_UTILIZATION)
    );
    const fillPageCap = wholeResident ? Number.POSITIVE_INFINITY : Math.min(pageLimit, this.fillPageCapOption ?? autoFillCap);
    const basePages = distinctPages;
    const runFill = (cap) => {
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
            if (sse && cur - 1 < this.optimalLevel[li]) {
              continue;
            }
            const curCount = model.leafLods[(li * L + cur) * 3 + 2];
            const finer = model.leafLods[(li * L + cur - 1) * 3 + 2];
            if (totalBalanced - curCount + finer > budget) {
              break promote;
            }
            if (cap !== Number.POSITIVE_INFINITY) {
              if (distinctPages + this.netPageDelta(li, cur - 1, cur, pageRefs) > cap) {
                continue;
              }
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
      runFill(Number.POSITIVE_INFINITY);
    } else {
      runFill(basePages);
      if (fillPageCap > basePages) {
        runFill(fillPageCap);
      }
    }
    this.stats.balancedPages = distinctPages;
    this.stats.fillPageCap = fillPageCap === Number.POSITIVE_INFINITY ? 0 : fillPageCap;
    this.stats.pageLimit = wholeResident ? 0 : pageLimit;
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
      const delta = model.leafLods[o + 2] - this.displayedCount(li);
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
      this.markDisplayed(li, to);
      this.displayedTotal += model.leafLods[(li * this.L + to) * 3 + 2] - this.displayedCount(li);
      this.displayed[li] = to;
      this.readySinceTick[li] = -1;
      flipped += 1;
    };
    for (const li of readyShrink) {
      applyFlip(li, this.desired[li]);
    }
    eligibleGrow.sort((a, b) => this.orderKey(a) - this.orderKey(b));
    const subjectHalf = eligibleGrow.length >> 1;
    for (let gi = 0; gi < eligibleGrow.length; gi++) {
      const li = eligibleGrow[gi];
      const to = this.desired[li];
      const from = this.displayed[li];
      const delta = model.leafLods[(li * this.L + to) * 3 + 2] - this.displayedCount(li);
      if (this.displayedTotal + delta > this.splats.capacitySplats) {
        this.stats.capacityDeferrals += 1;
        if (gi < subjectHalf) {
          this.stats.subjectDeferrals += 1;
        }
        continue;
      }
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
      if (this.displayed[li] < 0) {
        continue;
      }
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
      const lvl = this.displayed[li];
      if (lvl < 0) {
        continue;
      }
      out[lvl] += model.leafLods[(li * this.L + lvl) * 3 + 2];
    }
    return out;
  }
}
exports.SSOG_PAGE_SPLATS = SSOG_PAGE_SPLATS;
exports.SSOG_UNIT_PACK_FILE = SSOG_UNIT_PACK_FILE;
exports.SSOG_UNIT_PACK_MEMBER_NAMES = SSOG_UNIT_PACK_MEMBER_NAMES;
exports.SSOG_UNIT_PACK_VERSION = SSOG_UNIT_PACK_VERSION;
exports.SsogLodController = SsogLodController;
exports.SsogModel = SsogModel;
exports.SsogSplats = SsogSplats;
exports.SsogUnitCache = SsogUnitCache;
exports.SsogUnitPackError = SsogUnitPackError;
exports.parseUnitPack = parseUnitPack;
exports.planeNames = planeNames;
exports.readUnitPackMeta = readUnitPackMeta;
exports.ssogPackOrigin = ssogPackOrigin;
//# sourceMappingURL=spark-ssog.cjs.js.map

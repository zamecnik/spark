// Kroscloud fork — ssog module [ssog-2]. See FORK-CHANGES.md.
//
// SsogSplats: the Streamed-SOG paged source (plan §2.3, C1 = subclass of
// PagedSplats so the fetcher/LRU/upload machinery is inherited, not just the
// consumed shape). It:
//   - constructs its OWN SplatPager (renderer, §2.3-sized pool with
//     QUANTIFIED slack, maxSh) — driveLod's pager-creation path is bypassed
//     and the mesh is excluded from driveLod via `externalLod` [ssog-3];
//   - overrides fetchDecodeChunk: global chunk id → (unit, block) through the
//     blockBase prefix-sum (unit sizes are VARIABLE), memoized unit decode in
//     SsogUnitCache, EXACT-SIZE block subarrays back to the pager
//     (uploadPage writes `packedArray.length` — an oversized array would
//     bleed into the next page);
//   - carries the §2.4 capacity policy: cut rows =
//     ceil(max(budget·1.15, counts[coarsest])/16384), allocated ONCE — no
//     regrow ever (kroscloud.5 doctrine);
//   - dispose stays DETACH-ONLY (inherited: releases the cut texture, pool
//     outlives the view — pano roundtrip contract §2.7); `disposePool()` is
//     the explicit full-teardown for final scene destruction.

import {
  PagedSplats,
  SplatFileType,
  SplatPager,
  defines,
  isMobile,
} from "@sparkjsdev/spark";
import type { SplatEncoding } from "../defines";
import type { SsogModel } from "./SsogModel";
import { SSOG_PAGE_SPLATS } from "./SsogModel";
import type { SsogUnitCache } from "./SsogUnitCache";

const CUT_ROW_SPLATS = 16384; // 4096 texels × RGBA32UI = indices per cut row

export interface SsogSplatsOptions {
  /** three renderer (WebGLRenderer or WebGPURenderer) — passed to the pager */
  // biome-ignore lint/suspicious/noExplicitAny: duck-typed like SplatPager
  renderer: any;
  model: SsogModel;
  cache: SsogUnitCache;
  /** splat budget (app ComputeSplatBudget product, phone 1M-class) */
  budget: number;
  /** pool SH plane ALLOCATION cap (kroscloud.6 pagedMaxSh; default 3) */
  maxSh?: number;
  /** parallel unit-block fetchers; device-tiered default (mobile 2, else 4) */
  numFetchers?: number;
}

export class SsogSplats extends PagedSplats {
  override readonly externalLod: boolean = true;

  readonly model: SsogModel;
  readonly cache: SsogUnitCache;
  readonly budget: number;

  /** §2.3 pool sizing (pages) with quantified slack — recorded for the HUD */
  readonly poolPages: number;
  readonly slackSplats: number;

  /** §2.4 capacity policy: fixed cut-texture size, allocated once */
  readonly capacityRows: number;
  readonly capacitySplats: number;

  private numShResolved = false;
  private readonly fixedEncoding: SplatEncoding;

  constructor(options: SsogSplatsOptions) {
    const { model, cache, budget } = options;
    const maxSh = options.maxSh ?? 3;
    const numFetchers = options.numFetchers ?? (isMobile() ? 2 : 4);

    const L = model.lodLevels;
    const coarsestSplats = model.counts[L - 1];

    // Scene-size clamps: the composed cut can never exceed the finest level
    // (counts[0] — levels are alternatives, not additive), and the pool can
    // never hold more distinct chunks than the artifact has blocks. An
    // oversized budget (e.g. a rad leaf-class ceiling leaking in) must not
    // inflate the padded sort capacity or the pool textures past the scene.
    const maxCut = model.counts[0];
    const cutSplats = Math.min(budget * 1.15, maxCut);

    // Slack is QUANTIFIED, not vibes (§2.3): ≥ the max per-(leaf,level) block
    // footprint (a single near leaf can stage ~binSize ≈ 8+ pages of finer
    // blocks at once) plus an in-flight staging margin of one block per
    // fetcher. An unquantified headroom can livelock the keep-old protocol.
    const slackSplats =
      (model.maxLeafBlockFootprint + numFetchers) * SSOG_PAGE_SPLATS;
    const poolPages = Math.min(
      Math.ceil(
        (cutSplats + coarsestSplats + slackSplats) / SSOG_PAGE_SPLATS,
      ),
      model.totalBlocks,
    );

    const pager = new SplatPager({
      renderer: options.renderer,
      extSplats: false,
      maxSplats: poolPages * SSOG_PAGE_SPLATS,
      maxSh,
      autoDrive: false, // the controller owns the §2.3 pump contract
      numFetchers,
    });

    super({ pager, fileType: SplatFileType.SSOG, maxSh });

    this.model = model;
    this.cache = cache;
    this.budget = budget;
    this.poolPages = poolPages;
    this.slackSplats = slackSplats;

    // §2.4 capacity policy: allocated once at scene init from lod-meta
    // counts[] — the coarsest term covers the balancer's soft-target worst
    // case (all-at-coarsest), the counts[0] clamp bounds it by the scene;
    // NO regrow ever, ≤1 pipeline build per scene.
    this.capacityRows = Math.ceil(
      Math.max(cutSplats, coarsestSplats) / CUT_ROW_SPLATS,
    );
    this.capacitySplats = this.capacityRows * CUT_ROW_SPLATS;
    // Feeds PagedSplats.update's pre-size clamp (sceneRows) consistently.
    this.totalFileSplats = this.capacitySplats;

    // One fixed encoding for every unit (plan §2.3): DEFAULT_SPLAT_ENCODING,
    // lodOpacity:false — every a>1 gate stays dormant by construction. The
    // dyno uniforms default to the same ranges; shMax must be (1,1,1), not
    // the constructor's zero vector.
    const encoding: SplatEncoding = defines.DEFAULT_SPLAT_ENCODING;
    this.fixedEncoding = encoding;
    this.splatEncoding = encoding;
    this.lodOpacity.value = false;
    this.shMax.value.set(
      encoding.sh1Max ?? 1,
      encoding.sh2Max ?? 1,
      encoding.sh3Max ?? 1,
    );
  }

  /**
   * Global pager chunk → exact-size block slice of the memoized unit decode.
   * NEVER `unitIndex*8 + block` — unit sizes are variable (P0a/P0b pinned).
   */
  override async fetchDecodeChunk(chunk: number) {
    if (chunk < 0 || chunk >= this.model.totalBlocks) {
      throw new Error(`ssog chunk out of range: ${chunk}`);
    }
    const { unit, block } = this.model.unitOfChunk(chunk);
    const decoded = await this.cache.getUnit(unit);

    if (!this.numShResolved) {
      this.numShResolved = true;
      this.numSh = decoded.extra.sh3
        ? 3
        : decoded.extra.sh2
          ? 2
          : decoded.extra.sh1
            ? 1
            : 0;
    }

    const start = block * SSOG_PAGE_SPLATS;
    const n = Math.min(SSOG_PAGE_SPLATS, decoded.numSplats - start);
    if (n <= 0) {
      throw new Error(
        `ssog chunk ${chunk}: block ${block} beyond unit ${unit} (${decoded.numSplats} splats)`,
      );
    }

    const extra: Record<string, unknown> = {};
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
      splatEncoding: this.fixedEncoding,
    };
  }

  /**
   * Full teardown (final scene destruction only). Regular dispose() is
   * detach-only by inheritance — the pool outlives the view for warm
   * pano-roundtrip reattach (§2.7).
   */
  disposePool() {
    this.dispose();
    this.pager?.dispose();
  }
}

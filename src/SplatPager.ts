// Modified by Kroscloud, 2026 — see FORK-CHANGES.md
import * as THREE from "three";

import init_wasm, { decode_rad_header } from "spark-rs";

// Kroscloud fork: WebGPU path detection. Two r185 WebGPU facts drive the
// branches below (P0/S1): (a) a WebGL internalFormat string SILENTLY
// disables the WebGPU texture upload (all-zero reads, no errors), so it must
// never be set there; (b) raw gl.texSubImage2D has no WebGPU equivalent —
// the cut-index re-upload uses the standard needsUpdate path instead
// (~6.5 ms per lodDirty @ 8.4 MB, traverse-cadence-bounded).
function isWebGPURenderer(renderer: unknown): boolean {
  return (
    (renderer as { isWebGPURenderer?: boolean }).isWebGPURenderer === true
  );
}
import { LN_SCALE_MAX, LN_SCALE_MIN, dyno } from ".";
import { evaluateExtSH } from "./ExtSplats";
import {
  kcDisposeGrownTexture,
  kcGrowthCapRows,
  kcInitialCutRows,
  kcRegrowLog,
} from "./kcRegrowDebug";
import { evaluatePackedSH } from "./PackedSplats";
import { getSplatFileType, getSplatFileTypeFromPath } from "./SplatLoader";
import type { SplatSource } from "./SplatMesh";
import { workerPool } from "./SplatWorker";
import {
  DEFAULT_SPLAT_ENCODING,
  type ExtResult,
  type PackedResult,
  type RadMeta,
  type SplatEncoding,
  SplatFileType,
} from "./defines";
import { pagedSplatTexCoord } from "./dyno";
import { decodeExtSplat, getTextureSize, unpackSplat } from "./utils";

export interface PagedSplatsOptions {
  pager?: SplatPager;
  rootUrl?: string;
  requestHeader?: Record<string, string>;
  withCredentials?: boolean;
  fileBytes?: Uint8Array;
  fileType?: SplatFileType;
  maxSh?: number;
}

export class PagedSplats implements SplatSource {
  // Kroscloud fork [ssog-3]: when true, an EXTERNAL controller owns paging +
  // cut composition for this source (SsogLodController) — SparkRenderer's
  // driveLod must skip the mesh entirely (lodMeshes filter guard).
  readonly externalLod: boolean = false;

  pager?: SplatPager;
  rootUrl: string;
  requestHeader?: Record<string, string>;
  withCredentials?: boolean;
  fileBytes?: Uint8Array;
  fileType?: SplatFileType;

  numSh: number;
  maxSh: number;
  sh1Codes?: Uint32Array;
  sh2Codes?: Uint32Array;
  sh3Codes?: Uint32Array | [Uint32Array, Uint32Array];

  numSplats: number;
  splatEncoding?: SplatEncoding;
  radMetaPromise?: Promise<{ meta: RadMeta; chunksStart: number }>;
  // Kroscloud fork: RadMeta.count captured at meta resolution — upper bound
  // on any cut size, used to clamp the cut-texture pre-size (0 = unknown).
  totalFileSplats = 0;
  // Kroscloud fork [prec-1]: the pool's centre words hold fp16(c - o) for
  // this origin o (file frame; null = none). SplatMesh / the WebGPU backend
  // fold it into the mesh transform and forEachSplat re-adds it, so
  // mesh.matrixWorld keeps mapping the FILE frame to world. Set before the
  // mesh first renders (SsogSplats: the model's packOrigin).
  centerOrigin: THREE.Vector3 | null = null;

  dynoNumSplats: dyno.DynoInt<"numSplats">;
  dynoIndices: dyno.DynoUsampler2D<"indices", THREE.DataTexture>;
  rgbMinMaxLnScaleMinMax: dyno.DynoVec4<
    THREE.Vector4,
    "rgbMinMaxLnScaleMinMax"
  >;
  lodOpacity: dyno.DynoBool<"lodOpacity">;
  dynoNumSh: dyno.DynoInt<"numSh">;
  shMax: dyno.DynoVec3<THREE.Vector3, "shMax">;

  constructor(options: PagedSplatsOptions) {
    this.pager = options.pager;
    this.rootUrl = options.rootUrl ?? "";
    this.requestHeader = options.requestHeader;
    this.withCredentials = options.withCredentials;
    this.numSh = 0;
    this.maxSh = options.pager?.maxSh ?? 3;

    this.numSplats = 0;

    this.dynoNumSplats = new dyno.DynoInt({ value: 0 });
    this.dynoIndices = new dyno.DynoUsampler2D({
      value: SplatPager.emptyIndicesTexture,
    });

    this.rgbMinMaxLnScaleMinMax = new dyno.DynoVec4({
      value: new THREE.Vector4(0.0, 1.0, LN_SCALE_MIN, LN_SCALE_MAX),
    });
    this.lodOpacity = new dyno.DynoBool({
      value: false,
    });

    this.dynoNumSh = new dyno.DynoInt({ value: 0 });
    this.shMax = new dyno.DynoVec3({ value: new THREE.Vector3() });

    this.fileBytes = options.fileBytes;
    this.fileType = options.fileType;
    if (!this.fileType && this.fileBytes) {
      this.fileType = getSplatFileType(this.fileBytes);
    }
    if (!this.fileType && this.rootUrl) {
      this.fileType = getSplatFileTypeFromPath(this.rootUrl);
    }
    if (!this.fileType) {
      throw new Error("Unable to determine file type");
    }
    if (this.fileType === SplatFileType.RAD) {
      this.radMetaPromise = this.getRadMeta();
    }
  }

  dispose() {
    if (this.dynoIndices.value !== SplatPager.emptyIndicesTexture) {
      this.dynoIndices.value.dispose();
      this.dynoIndices.value = SplatPager.emptyIndicesTexture;
    }
  }

  setMaxSh(maxSh: number) {
    this.maxSh = maxSh;
  }

  getRadMeta(): Promise<{ meta: RadMeta; chunksStart: number }> {
    if (this.radMetaPromise) {
      return this.radMetaPromise;
    }

    this.radMetaPromise = (async () => {
      await wasmInitialized;

      if (this.fileBytes) {
        // Shouldn't be more than 1 MB, so don't send more data than that.
        const metaStart = decode_rad_header(this.fileBytes.slice(0, 1048576));
        if (metaStart) {
          return metaStart;
        }
        throw new Error("Failed to decode RAD header");
      }
      if (!this.rootUrl) {
        throw new Error("No url or fileBytes provided");
      }

      // We don't know how big the header will be. Most likely 64KB will be enough,
      // but try larger blocks in backoff if it wasn't enough.
      for (const tryBytes of [65536, 256 * 1024, 1024 * 1024]) {
        const bytes = await fetchRange({
          url: this.rootUrl,
          requestHeader: this.requestHeader,
          withCredentials: this.withCredentials,
          offset: 0,
          bytes: tryBytes,
        });
        const metaStart = decode_rad_header(bytes);
        if (metaStart) {
          return metaStart;
        }
      }
      throw new Error("Failed to decode RAD header");
    })().then((metaStart) => {
      // console.log("RAD meta: ", metaStart.meta);
      // Kroscloud fork: total file entry count (leaves + ancestors) — the
      // cut-texture pre-size clamp (any cut ≤ leaf count ≤ this).
      this.totalFileSplats = metaStart.meta.count || 0;
      return metaStart;
    });

    this.radMetaPromise.catch((error) => {
      console.error(error);
      // Allow it to be tried again
      // this.radMetaPromise = undefined;
    });

    return this.radMetaPromise;
  }

  chunkUrl(chunk: number): string {
    return this.rootUrl.replace(/-lod-0\./, `-lod-${chunk}.`);
  }

  // Kroscloud fork [ssog-24]: optional request-side cancellation hooks. A
  // source that can abort an in-flight fetchDecodeChunk implements
  // cancelFetchChunk (the pager calls it for fetchers whose chunk left
  // fetchPriority) and fetchProgress (0..1 download progress of that chunk's
  // transfer, null = unknown; the pager skips cancelling nearly-complete
  // transfers). Upstream sources implement neither and are never cancelled.
  //
  // fetchGroup reports the SHARED TRANSFER a chunk rides on (ssog: its unit
  // file set). Cancelling a fetcher kills the whole group, so the pager
  // never cancels while another chunk of the same group is still wanted —
  // that "saving" would re-download the group from byte 0. null / absent =
  // the chunk has a transfer of its own.
  //
  // resumeFetchChunk re-acquires the transfer of a chunk that was cancelled
  // and then became wanted again before its fetch rejected; true = the
  // in-flight transfer is the caller's again (the pager clears the cancelled
  // flag so a later sibling cancel cannot abort it out from under a wanted
  // fetcher), false = it is gone and the fetcher stays cancelled.
  cancelFetchChunk?(chunk: number): void;
  fetchProgress?(chunk: number): number | null;
  fetchGroup?(chunk: number): number | null;
  resumeFetchChunk?(chunk: number): boolean;

  async fetchDecodeChunk(chunk: number) {
    let decodeBytes = undefined;

    if (this.fileType === SplatFileType.RAD) {
      const { meta, chunksStart } = await this.getRadMeta();
      if (chunk < 0 || chunk >= meta.chunks.length) {
        throw new Error(
          `Chunk index out of range: ${chunk} (max: ${meta.chunks.length - 1})`,
        );
      }
      let { offset, bytes, filename } = meta.chunks[chunk];

      if (filename) {
        if (this.fileBytes) {
          throw new Error("Chunked RAD file not supported with fileBytes");
        }
        const resolvedRoot = new URL(
          this.rootUrl,
          window.location.href,
        ).toString();
        const chunkUrl = new URL(filename, resolvedRoot).toString();
        decodeBytes = await fetchRange({
          url: chunkUrl,
          requestHeader: this.requestHeader,
          withCredentials: this.withCredentials,
        });
      } else {
        offset += chunksStart;
        // console.log(`Fetching chunk ${chunk} at offset ${offset} with bytes ${bytes}`);
        if (this.fileBytes) {
          if (offset < 0 || offset + bytes > this.fileBytes.length) {
            throw new Error(
              `Invalid chunk offset or bytes: ${offset} + ${bytes} > ${this.fileBytes.length}`,
            );
          }
          decodeBytes = this.fileBytes.slice(offset, offset + bytes);
        } else if (this.rootUrl) {
          decodeBytes = await fetchRange({
            url: this.rootUrl,
            requestHeader: this.requestHeader,
            withCredentials: this.withCredentials,
            offset,
            bytes,
          });
        } else {
          throw new Error("No url or fileBytes provided");
        }
      }
    } else if (this.fileBytes) {
      // Fall through
    } else if (this.rootUrl) {
      const url = this.chunkUrl(chunk);
      const request = new Request(url, {
        headers: this.requestHeader
          ? new Headers(this.requestHeader)
          : undefined,
        credentials: this.withCredentials ? "include" : "same-origin",
      });
      const response = await fetch(request);
      if (!response.ok || !response.body) {
        throw new Error(
          `Failed to fetch "${url}": ${response.status} ${response.statusText}`,
        );
      }
      decodeBytes = new Uint8Array(await response.arrayBuffer());
    } else {
      throw new Error("No url or fileBytes provided");
    }

    return await workerPool.withWorker(async (worker) => {
      if (!this.pager) {
        throw new Error("PagedSplats.pager not set");
      }
      if (!this.pager.extSplats) {
        const result = (await worker.call("loadPackedSplats", {
          fileBytes: decodeBytes,
          pathName: this.chunkUrl(chunk),
          sh1Codes: this.sh1Codes?.slice(),
          sh2Codes: this.sh2Codes?.slice(),
          sh3Codes: this.sh3Codes?.slice(),
        })) as { lodSplats: PackedResult };
        const lodSplats = result.lodSplats;
        if (!this.splatEncoding) {
          this.splatEncoding = lodSplats.splatEncoding;

          this.numSh = lodSplats.extra.sh3
            ? 3
            : lodSplats.extra.sh2
              ? 2
              : lodSplats.extra.sh1
                ? 1
                : 0;

          this.rgbMinMaxLnScaleMinMax.value.set(
            this.splatEncoding.rgbMin ?? 0.0,
            this.splatEncoding.rgbMax ?? 1.0,
            this.splatEncoding.lnScaleMin ?? LN_SCALE_MIN,
            this.splatEncoding.lnScaleMax ?? LN_SCALE_MAX,
          );

          this.lodOpacity.value = this.splatEncoding.lodOpacity ?? false;

          this.shMax.value.set(
            this.splatEncoding.sh1Max ?? 1.0,
            this.splatEncoding.sh2Max ?? 1.0,
            this.splatEncoding.sh3Max ?? 1.0,
          );
        }
        this.sh1Codes = lodSplats.extra.sh1Codes ?? this.sh1Codes;
        this.sh2Codes = lodSplats.extra.sh2Codes ?? this.sh2Codes;
        this.sh3Codes = lodSplats.extra.sh3Codes ?? this.sh3Codes;
        return lodSplats;
      }

      const sh3Codes = this.sh3Codes as [Uint32Array, Uint32Array] | undefined;
      const result = (await worker.call("loadExtSplats", {
        fileBytes: decodeBytes,
        pathName: this.chunkUrl(chunk),
        sh1Codes: this.sh1Codes?.slice(),
        sh2Codes: this.sh2Codes?.slice(),
        sh3Codes: sh3Codes
          ? [sh3Codes[0].slice(), sh3Codes[1].slice()]
          : undefined,
      })) as { lodSplats: ExtResult };
      const lodSplats = result.lodSplats;
      if (!this.splatEncoding) {
        this.splatEncoding = DEFAULT_SPLAT_ENCODING;
        this.numSh =
          lodSplats.extra.sh3a && lodSplats.extra.sh3b
            ? 3
            : lodSplats.extra.sh2
              ? 2
              : lodSplats.extra.sh1
                ? 1
                : 0;
      }
      this.sh1Codes = lodSplats.extra.sh1Codes ?? this.sh1Codes;
      this.sh2Codes = lodSplats.extra.sh2Codes ?? this.sh2Codes;
      this.sh3Codes = lodSplats.extra.sh3Codes ?? this.sh3Codes;
      return lodSplats;
    });
  }

  update(numSplats: number, indices: Uint32Array, presizeRows?: number) {
    if (!this.pager) {
      throw new Error("PagedSplats.pager not set");
    }

    const renderer = this.pager.renderer;
    this.numSplats = numSplats;
    this.dynoNumSplats.value = this.numSplats;
    const rows = Math.ceil(numSplats / 16384);

    let indicesTexture =
      this.dynoIndices.value === SplatPager.emptyIndicesTexture
        ? undefined
        : this.dynoIndices.value;
    let prevRows = 0;
    if (indicesTexture && rows > indicesTexture.image.height) {
      prevRows = indicesTexture.image.height;
      // P6 diagnosis lever: dispose policy for the old texture is runtime-
      // selectable (baseline/leak/defer) — see kcRegrowDebug.ts.
      kcDisposeGrownTexture(renderer, indicesTexture);
      indicesTexture = undefined;
    }

    if (!indicesTexture) {
      // Kroscloud fork: on WebGPU, recreating this texture forces the
      // backend to rebuild its material + sort pipelines (a main-thread WGSL
      // recompile of ~25 pipelines — live-tested as a seconds-long browser
      // freeze when the cut grew row-by-row during streaming). Allocate with
      // headroom so growth recreations happen at most ~once per scene:
      // floor 128 rows (2M-splat class, 8.4 MB) and geometric ×2 growth,
      // capped at 512 rows. The padded tail is zero-filled — identical
      // semantics to the traverse's own zero-padding (consumers bound by
      // numSplats, never by texture size).
      let texRows = rows;
      let texData: Uint32Array = indices;
      if (isWebGPURenderer(renderer)) {
        // Pre-size to min(session budget, scene size): a fixed-budget
        // session can then NEVER hit the mid-session regrow — the
        // anomalously heavy transition (whole-texture upload +
        // ~25-pipeline WGSL recompile, 2.7–11 s stall, the 2026-08-06 TDR
        // aggravator) — and small scenes don't pay budget-sized keygen
        // scans (capacity-bound sort cost). Regrow remains only for
        // runtime lodSplatCount raises, with ×2 geometric growth and
        // DEFERRED old-resource disposal (kcRegrowDebug).
        const sceneRows =
          this.totalFileSplats > 0
            ? Math.ceil(this.totalFileSplats / 16384)
            : Number.POSITIVE_INFINITY;
        const floorRows = Math.min(
          presizeRows ?? kcInitialCutRows(0),
          sceneRows,
        );
        texRows = Math.min(
          Math.max(rows, prevRows * 2, floorRows),
          Math.max(rows, kcGrowthCapRows()),
        );
        if (texRows !== rows) {
          texData = new Uint32Array(texRows * 16384);
          texData.set(indices);
        }
        if (prevRows > 0) {
          kcRegrowLog("regrowCreate", { prevRows, rows, texRows });
        }
      }
      indicesTexture = new THREE.DataTexture(
        texData,
        4096,
        texRows,
        THREE.RGBAIntegerFormat,
        THREE.UnsignedIntType,
      );
      if (!isWebGPURenderer(renderer)) {
        // Kroscloud fork: never on WebGPU — silently kills the upload
        indicesTexture.internalFormat = "RGBA32UI";
      }
      indicesTexture.needsUpdate = true;
      renderer.initTexture(indicesTexture);
      this.dynoIndices.value = indicesTexture;
    } else if (isWebGPURenderer(renderer)) {
      // Kroscloud fork: standard mirror-write + needsUpdate re-upload; the
      // image.data array stays the raycast CPU mirror.
      const textureIndices = indicesTexture.image.data as Uint32Array;
      textureIndices.set(indices.subarray(0, textureIndices.length));
      indicesTexture.needsUpdate = true;
    } else {
      const textureIndices = indicesTexture.image.data as Uint32Array;
      textureIndices.set(indices.subarray(0, numSplats));

      const gl = renderer.getContext() as WebGL2RenderingContext;
      renderer.state.activeTexture(gl.TEXTURE0);
      renderer.state.bindTexture(
        gl.TEXTURE_2D,
        getGlTexture(renderer, indicesTexture),
      );
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        4096,
        rows,
        gl.RGBA_INTEGER,
        gl.UNSIGNED_INT,
        indices,
      );
      renderer.state.bindTexture(gl.TEXTURE_2D, null);
    }
  }

  prepareFetchSplat() {}

  getNumSplats(): number {
    return this.numSplats;
  }

  hasRgbDir(): boolean {
    if (!this.pager) {
      return false;
    }
    return Math.min(this.numSh, this.pager.maxSh) > 0;
  }

  getNumSh(): number {
    return this.numSh;
  }

  fetchSplat({
    index,
    viewOrigin,
  }: {
    index: dyno.DynoVal<"int">;
    viewOrigin?: dyno.DynoVal<"vec3">;
  }): dyno.DynoVal<typeof dyno.Gsplat> {
    if (!this.pager) {
      throw new Error("PagedSplats.pager not set");
    }

    const splatIndex = this.pager.readIndex.apply({
      index,
      numSplats: this.dynoNumSplats,
      indices: this.dynoIndices,
    }).index;

    if (!this.pager.extSplats) {
      if (this.hasRgbDir() && viewOrigin) {
        this.dynoNumSh.value = Math.min(
          this.numSh,
          this.maxSh,
          this.pager.maxSh,
        );
        return this.pager.readSplatDir.apply({
          index: splatIndex,
          rgbMinMaxLnScaleMinMax: this.rgbMinMaxLnScaleMinMax,
          lodOpacity: this.lodOpacity,
          viewOrigin,
          numSh: this.dynoNumSh,
          shMax: this.shMax,
        }).gsplat;
      }
      return this.pager.readSplat.apply({
        index: splatIndex,
        rgbMinMaxLnScaleMinMax: this.rgbMinMaxLnScaleMinMax,
        lodOpacity: this.lodOpacity,
      }).gsplat;
    }

    if (this.hasRgbDir() && viewOrigin) {
      this.dynoNumSh.value = Math.min(this.numSh, this.maxSh, this.pager.maxSh);
      return this.pager.readSplatExtDir.apply({
        index: splatIndex,
        viewOrigin,
        numSh: this.dynoNumSh,
      }).gsplat;
    }
    return this.pager.readSplatExt.apply({ index: splatIndex }).gsplat;
  }

  // Iterate over Gsplats index 0..=(this.numSplats-1), unpack each Gsplat
  // and invoke the callback function with the Gsplat attributes.
  forEachSplat(
    callback: (
      index: number,
      center: THREE.Vector3,
      scales: THREE.Vector3,
      quaternion: THREE.Quaternion,
      opacity: number,
      color: THREE.Color,
    ) => void,
  ) {
    if (!this.pager || !this.numSplats) {
      return;
    }
    const extSplats = this.pager.extSplats;
    const indices = this.dynoIndices.value.image.data as Uint32Array;
    const packedSplatArray = this.pager.packedTexture.value.image
      .data as Uint32Array;
    const extPackedSplatArray = this.pager.extTexture.value.image
      .data as Uint32Array;
    const extArrays: [Uint32Array, Uint32Array] = [
      packedSplatArray,
      extPackedSplatArray,
    ];
    // Kroscloud fork [prec-1]: centres are reported in the FILE frame
    const origin = this.centerOrigin;

    for (let i = 0; i < this.numSplats; ++i) {
      const splatIndex = indices[i];
      const unpacked = extSplats
        ? decodeExtSplat(extArrays, splatIndex)
        : unpackSplat(packedSplatArray, splatIndex, this.splatEncoding);
      if (origin) {
        unpacked.center.add(origin);
      }
      callback(
        i,
        unpacked.center,
        unpacked.scales,
        unpacked.quaternion,
        unpacked.opacity,
        unpacked.color,
      );
    }
  }
}

export interface SplatPagerOptions {
  /**
   * THREE.WebGLRenderer instance to upload texture data
   */
  renderer: THREE.WebGLRenderer;
  /**
   * Whether to use extended Gsplat encoding for paged splats.
   * @default false
   */
  extSplats?: boolean;
  /**
   * Maximum size of splat page pool
   * @default 65536 * 256 = 16777216
   */
  maxSplats?: number;
  /**
   * Maximum number of spherical harmonics to keep
   * @default 3
   */
  maxSh?: number;
  /**
   * Automatically drive page fetching, or poll via drive()
   * @default true
   */
  autoDrive?: boolean;
  /**
   * Number of parallel chunk fetchers
   * @default 3
   */
  numFetchers?: number;
}

export class SplatPager {
  renderer: THREE.WebGLRenderer;

  extSplats: boolean;
  maxPages: number;
  maxSplats: number;
  pageSplats: number;

  maxSh: number;
  curSh: number;

  autoDrive: boolean;
  numFetchers: number;
  fetchPause = 0;

  splatsChunkToPage: Map<
    PagedSplats,
    ({ page: number; lru: number } | undefined)[]
  > = new Map();
  pageToSplatsChunk: (
    | { splats: PagedSplats; chunk: number; time: number }
    | undefined
  )[] = [];
  pageFreelist: number[];
  pageLru: Set<{ page: number; lru: number }>;
  freeablePages: number[];
  newUploads: {
    page: number;
    numSplats: number;
    packedArray: Uint32Array;
    extArray?: Uint32Array;
    extra: Record<string, unknown>;
  }[];
  readyUploads: {
    page: number;
    numSplats: number;
    packedArray: Uint32Array;
    extArray?: Uint32Array;
    extra: Record<string, unknown>;
  }[];
  lodTreeUpdates: {
    splats: PagedSplats;
    page: number;
    chunk: number;
    numSplats: number;
    lodTree?: Uint32Array;
  }[];

  fetchers: {
    splats: PagedSplats;
    chunk: number;
    promise: Promise<void>;
    /** [ssog-24] consecutive fetchPriority lists that did not want the chunk */
    missCount: number;
    /** [ssog-24] cancelFetchChunk was issued for this fetcher */
    cancelled: boolean;
  }[];
  fetched: {
    splats: PagedSplats;
    chunk: number;
    data: PackedResult | ExtResult;
  }[];
  fetchPriority: { splats: PagedSplats; chunk: number }[];

  packedTexture: dyno.DynoUsampler2DArray<
    "packedTexture",
    THREE.DataArrayTexture
  >;
  extTexture: dyno.DynoUsampler2DArray<"extTexture", THREE.DataArrayTexture>;

  sh1Texture: dyno.DynoUsampler2DArray<"sh1", THREE.DataArrayTexture>;
  sh2Texture: dyno.DynoUsampler2DArray<"sh2", THREE.DataArrayTexture>;
  sh3Texture: dyno.DynoUsampler2DArray<"sh3", THREE.DataArrayTexture>;
  sh3TextureB: dyno.DynoUsampler2DArray<"sh3b", THREE.DataArrayTexture>;

  readIndex: dyno.DynoBlock<
    { index: "int"; numSplats: "int"; indices: "usampler2D" },
    { index: "int" }
  >;
  readSplat: dyno.DynoBlock<
    { index: "int"; rgbMinMaxLnScaleMinMax: "vec4"; lodOpacity: "bool" },
    { gsplat: typeof dyno.Gsplat }
  >;
  readSplatExt: dyno.DynoBlock<
    { index: "int" },
    { gsplat: typeof dyno.Gsplat }
  >;
  readSplatDir: dyno.DynoBlock<
    {
      index: "int";
      rgbMinMaxLnScaleMinMax: "vec4";
      lodOpacity: "bool";
      viewOrigin: "vec3";
      numSh: "int";
      shMax: "vec3";
    },
    { gsplat: typeof dyno.Gsplat }
  >;
  readSplatExtDir: dyno.DynoBlock<
    { index: "int"; viewOrigin: "vec3"; numSh: "int" },
    { gsplat: typeof dyno.Gsplat }
  >;

  constructor(options: SplatPagerOptions) {
    this.renderer = options.renderer;
    this.extSplats = options.extSplats ?? false;

    this.pageSplats = 65536;
    this.maxSplats = options.maxSplats ?? 16777216;
    this.maxPages = Math.ceil(this.maxSplats / this.pageSplats);
    this.maxSplats = this.maxPages * this.pageSplats;

    this.maxSh = options.maxSh ?? 3;
    this.curSh = 0;

    this.autoDrive = options.autoDrive ?? true;
    this.numFetchers = options.numFetchers ?? 3;

    this.splatsChunkToPage = new Map();
    this.pageToSplatsChunk = new Array(this.maxPages);
    this.pageFreelist = Array.from({ length: this.maxPages }, (_, i) => i);
    this.pageLru = new Set();
    this.freeablePages = [];
    this.newUploads = [];
    this.readyUploads = [];
    this.lodTreeUpdates = [];

    this.fetchers = [];
    this.fetched = [];
    this.fetchPriority = [];

    this.packedTexture = new dyno.DynoUsampler2DArray({
      value: this.newUint32ArrayTexture(
        new Uint32Array(this.maxPages * 256 * 256 * 4),
        256,
        256,
        this.maxPages,
        THREE.RGBAIntegerFormat,
        THREE.UnsignedIntType,
        "RGBA32UI",
      ),
    });
    this.extTexture = new dyno.DynoUsampler2DArray({
      value: this.extSplats
        ? this.newUint32ArrayTexture(
            new Uint32Array(this.maxPages * 256 * 256 * 4),
            256,
            256,
            this.maxPages,
            THREE.RGBAIntegerFormat,
            THREE.UnsignedIntType,
            "RGBA32UI",
          )
        : SplatPager.emptyExtTexture,
    });
    this.sh1Texture = new dyno.DynoUsampler2DArray({
      value: this.extSplats
        ? SplatPager.emptyExtSh1Texture
        : SplatPager.emptySh1Texture,
    });
    this.sh2Texture = new dyno.DynoUsampler2DArray({
      value: this.extSplats
        ? SplatPager.emptyExtSh2Texture
        : SplatPager.emptySh2Texture,
    });
    this.sh3Texture = new dyno.DynoUsampler2DArray({
      value: this.extSplats
        ? SplatPager.emptyExtSh3Texture
        : SplatPager.emptySh3Texture,
    });
    this.sh3TextureB = new dyno.DynoUsampler2DArray({
      value: SplatPager.emptyExtSh3BTexture,
    });

    this.readIndex = dyno.dynoBlock(
      { index: "int", numSplats: "int", indices: "usampler2D" },
      { index: "int" },
      ({ index, numSplats, indices }) => {
        return new dyno.Dyno({
          inTypes: {
            index: "int",
            numSplats: "int",
            indices: "usampler2D",
          },
          outTypes: { index: "int" },
          inputs: {
            index,
            numSplats,
            indices,
          },
          statements: ({ inputs, outputs }) =>
            dyno.unindentLines(`
            if (${inputs.index} >= ${inputs.numSplats}) {
              return;
            }

            ivec2 indexCoord = ivec2((${inputs.index} >> 2) & 4095, ${inputs.index} >> 14);
            uint index = texelFetch(${inputs.indices}, indexCoord, 0)[${inputs.index} & 3];
            ${outputs.index} = int(index);
          `),
        }).outputs;
      },
    );

    this.readSplat = dyno.dynoBlock(
      { index: "int", rgbMinMaxLnScaleMinMax: "vec4", lodOpacity: "bool" },
      { gsplat: dyno.Gsplat },
      ({ index, rgbMinMaxLnScaleMinMax, lodOpacity }) => {
        return new dyno.Dyno({
          inTypes: {
            index: "int",
            packedTexture: "usampler2DArray",
            rgbMinMaxLnScaleMinMax: "vec4",
            lodOpacity: "bool",
          },
          outTypes: { gsplat: dyno.Gsplat },
          inputs: {
            index,
            packedTexture: this.packedTexture,
            rgbMinMaxLnScaleMinMax,
            lodOpacity,
          },
          globals: () => [dyno.defineGsplat],
          statements: ({ inputs, outputs }) =>
            dyno.unindentLines(`
            int index = ${inputs.index};
            ivec3 splatCoord = pagedSplatTexCoord(index);
            uvec4 packedData = texelFetch(${inputs.packedTexture}, splatCoord, 0);

            unpackSplatEncoding(packedData, ${outputs.gsplat}.center, ${outputs.gsplat}.scales, ${outputs.gsplat}.quaternion, ${outputs.gsplat}.rgba, ${inputs.rgbMinMaxLnScaleMinMax});
            if ((${outputs.gsplat}.rgba.a == 0.0) || all(equal(${outputs.gsplat}.scales, vec3(0.0, 0.0, 0.0)))) {
              return;
            }
            
            ${outputs.gsplat}.index = index;
            ${outputs.gsplat}.flags = GSPLAT_FLAG_ACTIVE;
            if (${inputs.lodOpacity}) {
              ${outputs.gsplat}.rgba.a *= 2.0;
            }
          `),
        }).outputs;
      },
    );

    this.readSplatDir = dyno.dynoBlock(
      {
        index: "int",
        rgbMinMaxLnScaleMinMax: "vec4",
        lodOpacity: "bool",
        viewOrigin: "vec3",
        numSh: "int",
        shMax: "vec3",
      },
      { gsplat: dyno.Gsplat },
      ({
        index,
        rgbMinMaxLnScaleMinMax,
        lodOpacity,
        viewOrigin,
        numSh,
        shMax,
      }) => {
        if (
          !index ||
          !rgbMinMaxLnScaleMinMax ||
          !lodOpacity ||
          !viewOrigin ||
          !numSh ||
          !shMax
        ) {
          throw new Error("index and viewOrigin are required");
        }
        let gsplat = this.readSplat.apply({
          index,
          rgbMinMaxLnScaleMinMax,
          lodOpacity,
        }).gsplat;

        const splatCenter = dyno.splitGsplat(gsplat).outputs.center;
        const viewDir = dyno.normalize(dyno.sub(splatCenter, viewOrigin));
        let rgb = evaluatePackedSH({
          coord: pagedSplatTexCoord(index),
          viewDir,
          numSh,
          sh1Texture: this.sh1Texture,
          sh2Texture: this.sh2Texture,
          sh3Texture: this.sh3Texture,
          shMax,
        }).rgb;
        rgb = dyno.add(rgb, dyno.splitGsplat(gsplat).outputs.rgb);
        gsplat = dyno.combineGsplat({ gsplat, rgb });
        return { gsplat };
      },
    );

    this.readSplatExt = dyno.dynoBlock(
      { index: "int" },
      { gsplat: dyno.Gsplat },
      ({ index }) => {
        return new dyno.Dyno({
          inTypes: {
            index: "int",
            extTexture1: "usampler2DArray",
            extTexture2: "usampler2DArray",
          },
          outTypes: { gsplat: dyno.Gsplat },
          inputs: {
            index,
            extTexture1: this.packedTexture,
            extTexture2: this.extTexture,
          },
          globals: () => [dyno.defineGsplat],
          statements: ({ inputs, outputs }) =>
            dyno.unindentLines(`
            int index = ${inputs.index};
            ivec3 splatCoord = ivec3(index & 255, (index >> 8) & 255, index >> 16);
            uvec4 ext1 = texelFetch(${inputs.extTexture1}, splatCoord, 0);
            float alpha = unpackSplatExtAlpha(ext1);
            if (alpha == 0.0) {
              return;
            }

            uvec4 ext2 = texelFetch(${inputs.extTexture2}, splatCoord, 0);
            unpackSplatExt(ext1, ext2, ${outputs.gsplat}.center, ${outputs.gsplat}.scales, ${outputs.gsplat}.quaternion, ${outputs.gsplat}.rgba);
            if (all(equal(${outputs.gsplat}.scales, vec3(0.0, 0.0, 0.0)))) {
              return;
            }

            ${outputs.gsplat}.index = index;
            ${outputs.gsplat}.flags = GSPLAT_FLAG_ACTIVE;
          `),
        }).outputs;
      },
    );

    this.readSplatExtDir = dyno.dynoBlock(
      {
        index: "int",
        viewOrigin: "vec3",
        numSh: "int",
      },
      { gsplat: dyno.Gsplat },
      ({ index, viewOrigin, numSh }) => {
        if (!index || !viewOrigin || !numSh) {
          throw new Error("index and viewOrigin are required");
        }
        let gsplat = this.readSplatExt.apply({ index }).gsplat;

        const splatCenter = dyno.splitGsplat(gsplat).outputs.center;
        const viewDir = dyno.normalize(dyno.sub(splatCenter, viewOrigin));
        let rgb = evaluateExtSH({
          coord: pagedSplatTexCoord(index),
          viewDir,
          numSh,
          sh1Texture: this.sh1Texture,
          sh2Texture: this.sh2Texture,
          sh3TextureA: this.sh3Texture,
          sh3TextureB: this.sh3TextureB,
        }).rgb;
        rgb = dyno.add(rgb, dyno.splitGsplat(gsplat).outputs.rgb);
        gsplat = dyno.combineGsplat({ gsplat, rgb });
        return { gsplat };
      },
    );
  }

  dispose() {
    this.autoDrive = false;
    this.numFetchers = 0;

    this.packedTexture.value.dispose();
    this.packedTexture.value.source.data = null;
    if (this.extTexture.value !== SplatPager.emptyExtTexture) {
      this.extTexture.value.dispose();
      this.extTexture.value.source.data = null;
    }

    if (!this.extSplats) {
      if (this.sh1Texture.value !== SplatPager.emptySh1Texture) {
        this.sh1Texture.value.dispose();
        this.sh1Texture.value.source.data = null;
      }
      if (this.sh2Texture.value !== SplatPager.emptySh2Texture) {
        this.sh2Texture.value.dispose();
        this.sh2Texture.value.source.data = null;
      }
      if (this.sh3Texture.value !== SplatPager.emptySh3Texture) {
        this.sh3Texture.value.dispose();
        this.sh3Texture.value.source.data = null;
      }
    } else {
      if (this.sh1Texture.value !== SplatPager.emptyExtSh1Texture) {
        this.sh1Texture.value.dispose();
        this.sh1Texture.value.source.data = null;
      }
      if (this.sh2Texture.value !== SplatPager.emptyExtSh2Texture) {
        this.sh2Texture.value.dispose();
        this.sh2Texture.value.source.data = null;
      }
      if (this.sh3Texture.value !== SplatPager.emptyExtSh3Texture) {
        this.sh3Texture.value.dispose();
        this.sh3Texture.value.source.data = null;
      }
      if (this.sh3TextureB.value !== SplatPager.emptyExtSh3BTexture) {
        this.sh3TextureB.value.dispose();
        this.sh3TextureB.value.source.data = null;
      }
    }
  }

  private ensureShTextures(numSh: number) {
    // maxSh caps ALLOCATION, not just evaluation: bands above it never get
    // their maxPages-deep plane textures, and the per-band upload blocks below
    // skip automatically (their `!== empty` guard stays false). Evaluation is
    // already capped downstream via min(numSh, maxSh, pager.maxSh).
    this.curSh = Math.max(this.curSh, Math.min(numSh, this.maxSh));
    if (!this.extSplats) {
      if (
        this.curSh >= 1 &&
        this.sh1Texture.value === SplatPager.emptySh1Texture
      ) {
        this.sh1Texture.value = this.newUint32ArrayTexture(
          new Uint32Array(this.maxPages * 256 * 256 * 2),
          256,
          256,
          this.maxPages,
          THREE.RGIntegerFormat,
          THREE.UnsignedIntType,
          "RG32UI",
        );
      }
    } else {
      if (
        this.curSh >= 1 &&
        this.sh1Texture.value === SplatPager.emptyExtSh1Texture
      ) {
        this.sh1Texture.value = this.newUint32ArrayTexture(
          new Uint32Array(this.maxPages * 256 * 256 * 4),
          256,
          256,
          this.maxPages,
          THREE.RGBAIntegerFormat,
          THREE.UnsignedIntType,
          "RGBA32UI",
        );
      }
    }
    if (
      this.curSh >= 2 &&
      this.sh2Texture.value ===
        (!this.extSplats
          ? SplatPager.emptySh2Texture
          : SplatPager.emptyExtSh2Texture)
    ) {
      this.sh2Texture.value = this.newUint32ArrayTexture(
        new Uint32Array(this.maxPages * 256 * 256 * 4),
        256,
        256,
        this.maxPages,
        THREE.RGBAIntegerFormat,
        THREE.UnsignedIntType,
        "RGBA32UI",
      );
    }
    if (!this.extSplats) {
      if (
        this.curSh >= 3 &&
        this.sh3Texture.value === SplatPager.emptySh3Texture
      ) {
        this.sh3Texture.value = this.newUint32ArrayTexture(
          new Uint32Array(this.maxPages * 256 * 256 * 4),
          256,
          256,
          this.maxPages,
          THREE.RGBAIntegerFormat,
          THREE.UnsignedIntType,
          "RGBA32UI",
        );
      }
    } else {
      if (this.curSh >= 3) {
        if (this.sh3Texture.value === SplatPager.emptyExtSh3Texture) {
          this.sh3Texture.value = this.newUint32ArrayTexture(
            new Uint32Array(this.maxPages * 256 * 256 * 4),
            256,
            256,
            this.maxPages,
            THREE.RGBAIntegerFormat,
            THREE.UnsignedIntType,
            "RGBA32UI",
          );
        }
        if (this.sh3TextureB.value === SplatPager.emptyExtSh3BTexture) {
          this.sh3TextureB.value = this.newUint32ArrayTexture(
            new Uint32Array(this.maxPages * 256 * 256 * 4),
            256,
            256,
            this.maxPages,
            THREE.RGBAIntegerFormat,
            THREE.UnsignedIntType,
            "RGBA32UI",
          );
        }
      }
    }
  }

  private allocatePage(): number | undefined {
    return this.pageFreelist.shift();
  }

  private freePage(page: number) {
    this.pageFreelist.push(page);
  }

  getSplatsChunk(splats: PagedSplats, chunk: number) {
    const chunks = this.splatsChunkToPage.get(splats);
    if (!chunks) {
      return undefined;
    }
    return chunks[chunk];
  }

  private insertSplatsChunkPage(
    splats: PagedSplats,
    chunk: number,
    page: number,
    now: number,
  ) {
    if (!this.splatsChunkToPage.has(splats)) {
      this.splatsChunkToPage.set(splats, []);
    }
    const chunks = this.splatsChunkToPage.get(splats);
    if (!chunks) {
      throw new Error("impossible");
    }
    if (chunk >= chunks.length) {
      chunks.length = chunk + 1;
    }
    const pageLru = { page, lru: now };
    chunks[chunk] = pageLru;
    this.pageLru.add(pageLru);

    this.pageToSplatsChunk[page] = { splats, chunk, time: performance.now() };
    return this.pageToSplatsChunk[page];
  }

  private removeSplatsChunkPage(
    splats: PagedSplats,
    chunk: number,
    page: number,
  ) {
    const chunks = this.splatsChunkToPage.get(splats);
    if (!chunks) {
      throw new Error("impossible");
    }

    const pageLru = chunks[chunk];
    if (!pageLru) {
      throw new Error(
        `pageLru not found for splats: ${splats}, chunk: ${chunk}, page: ${page}`,
      );
    }
    this.pageLru.delete(pageLru);

    chunks[chunk] = undefined;

    while (chunks.length > 0 && chunks[chunks.length - 1] === undefined) {
      chunks.pop();
    }
    if (chunks.length === 0) {
      this.splatsChunkToPage.delete(splats);
    }

    this.pageToSplatsChunk[page] = undefined;
    while (
      this.pageToSplatsChunk.length > 0 &&
      this.pageToSplatsChunk[this.pageToSplatsChunk.length - 1] === undefined
    ) {
      this.pageToSplatsChunk.pop();
    }
  }

  private uploadPage(
    page: number,
    packedArray: Uint32Array,
    extra: Record<string, unknown>,
    extArray?: Uint32Array,
  ) {
    const pageBase = page * this.pageSplats;

    // const gl = this.renderer.getContext() as WebGL2RenderingContext;

    // this.renderer.state.activeTexture(gl.TEXTURE0);
    // this.renderer.state.bindTexture(
    //   gl.TEXTURE_2D_ARRAY,
    //   this.getGlTexture(this.packedTexture.value),
    // );
    // gl.texSubImage3D(
    //   gl.TEXTURE_2D_ARRAY,
    //   0,
    //   0,
    //   0,
    //   page,
    //   256,
    //   256,
    //   1,
    //   gl.RGBA_INTEGER,
    //   gl.UNSIGNED_INT,
    //   packedArray,
    // );

    const array = this.packedTexture.value.image.data;
    array
      .subarray(pageBase * 4, pageBase * 4 + packedArray.length)
      .set(packedArray);
    this.packedTexture.value.addLayerUpdate(page);
    this.packedTexture.value.needsUpdate = true;

    if (extArray) {
      const array = this.extTexture.value.image.data;
      array
        .subarray(pageBase * 4, pageBase * 4 + extArray.length)
        .set(extArray);
      this.extTexture.value.addLayerUpdate(page);
      this.extTexture.value.needsUpdate = true;
    }

    const numSh = this.extSplats
      ? extra.sh3a && extra.sh3b
        ? 3
        : extra.sh2
          ? 2
          : extra.sh1
            ? 1
            : 0
      : extra.sh3
        ? 3
        : extra.sh2
          ? 2
          : extra.sh1
            ? 1
            : 0;
    this.ensureShTextures(numSh);

    if (!this.extSplats) {
      if (this.sh1Texture.value !== SplatPager.emptySh1Texture && extra.sh1) {
        // this.renderer.state.bindTexture(
        //   gl.TEXTURE_2D_ARRAY,
        //   this.getGlTexture(this.sh1Texture.value),
        // );
        // gl.texSubImage3D(
        //   gl.TEXTURE_2D_ARRAY,
        //   0,
        //   0,
        //   0,
        //   page,
        //   256,
        //   256,
        //   1,
        //   gl.RG_INTEGER,
        //   gl.UNSIGNED_INT,
        //   extra.sh1 as Uint32Array<ArrayBuffer>,
        // );
        const sh1 = extra.sh1 as Uint32Array<ArrayBuffer>;
        const array = this.sh1Texture.value.image.data;
        array.subarray(pageBase * 2, pageBase * 2 + sh1.length).set(sh1);
        this.sh1Texture.value.addLayerUpdate(page);
        this.sh1Texture.value.needsUpdate = true;
      }
    } else {
      if (
        this.sh1Texture.value !== SplatPager.emptyExtSh1Texture &&
        extra.sh1
      ) {
        const sh1 = extra.sh1 as Uint32Array<ArrayBuffer>;
        const array = this.sh1Texture.value.image.data;
        array.subarray(pageBase * 4, pageBase * 4 + sh1.length).set(sh1);
        this.sh1Texture.value.addLayerUpdate(page);
        this.sh1Texture.value.needsUpdate = true;
      }
    }

    if (this.sh2Texture.value !== SplatPager.emptySh2Texture && extra.sh2) {
      // this.renderer.state.bindTexture(
      //   gl.TEXTURE_2D_ARRAY,
      //   this.getGlTexture(this.sh2Texture.value),
      // );
      // gl.texSubImage3D(
      //   gl.TEXTURE_2D_ARRAY,
      //   0,
      //   0,
      //   0,
      //   page,
      //   256,
      //   256,
      //   1,
      //   gl.RGBA_INTEGER,
      //   gl.UNSIGNED_INT,
      //   extra.sh2 as Uint32Array<ArrayBuffer>,
      // );
      const sh2 = extra.sh2 as Uint32Array<ArrayBuffer>;
      const array = this.sh2Texture.value.image.data;
      array.subarray(pageBase * 4, pageBase * 4 + sh2.length).set(sh2);
      this.sh2Texture.value.addLayerUpdate(page);
      this.sh2Texture.value.needsUpdate = true;
    }

    if (!this.extSplats) {
      if (this.sh3Texture.value !== SplatPager.emptySh3Texture && extra.sh3) {
        // this.renderer.state.bindTexture(
        //   gl.TEXTURE_2D_ARRAY,
        //   this.getGlTexture(this.sh3Texture.value),
        // );
        // gl.texSubImage3D(
        //   gl.TEXTURE_2D_ARRAY,
        //   0,
        //   0,
        //   0,
        //   page,
        //   256,
        //   256,
        //   1,
        //   gl.RGBA_INTEGER,
        //   gl.UNSIGNED_INT,
        //   extra.sh3 as Uint32Array<ArrayBuffer>,
        // );
        const sh3 = extra.sh3 as Uint32Array<ArrayBuffer>;
        const array = this.sh3Texture.value.image.data;
        array.subarray(pageBase * 4, pageBase * 4 + sh3.length).set(sh3);
        this.sh3Texture.value.addLayerUpdate(page);
        this.sh3Texture.value.needsUpdate = true;
      }
    } else {
      if (
        this.sh3Texture.value !== SplatPager.emptyExtSh3Texture &&
        extra.sh3a
      ) {
        const sh3a = extra.sh3a as Uint32Array<ArrayBuffer>;
        const array = this.sh3Texture.value.image.data;
        array.subarray(pageBase * 4, pageBase * 4 + sh3a.length).set(sh3a);
        this.sh3Texture.value.addLayerUpdate(page);
        this.sh3Texture.value.needsUpdate = true;
      }
      if (
        this.sh3TextureB.value !== SplatPager.emptyExtSh3BTexture &&
        extra.sh3b
      ) {
        const sh3b = extra.sh3b as Uint32Array<ArrayBuffer>;
        const array = this.sh3TextureB.value.image.data;
        array.subarray(pageBase * 4, pageBase * 4 + sh3b.length).set(sh3b);
        this.sh3TextureB.value.addLayerUpdate(page);
        this.sh3TextureB.value.needsUpdate = true;
      }
    }

    // this.renderer.state.bindTexture(gl.TEXTURE_2D_ARRAY, null);
  }

  private getGlTexture(texture: THREE.Texture): WebGLTexture {
    return getGlTexture(this.renderer, texture);
  }

  private newUint32ArrayTexture(
    data: Uint32Array<ArrayBuffer> | null,
    width: number,
    height: number,
    depth: number,
    format: THREE.AnyPixelFormat,
    type: THREE.TextureDataType,
    internalFormat: THREE.PixelFormatGPU,
  ): THREE.DataArrayTexture {
    const texture = new THREE.DataArrayTexture(data, width, height, depth);
    texture.format = format;
    texture.type = type;
    if (!isWebGPURenderer(this.renderer)) {
      // Kroscloud fork: never on WebGPU — silently kills the upload (P0/S1)
      texture.internalFormat = internalFormat;
    }
    texture.needsUpdate = true;
    this.renderer.initTexture(texture);
    return texture;
  }

  driveFetchers() {
    const needed = [];
    const overflow = [];
    let numPages = 0;

    for (const { splats, chunk } of this.fetchPriority) {
      const pageLru = this.getSplatsChunk(splats, chunk);
      if (pageLru) {
        if (numPages >= this.maxPages) {
          overflow.push(pageLru);
        } else {
          needed.push(pageLru);
        }
        numPages += 1;
        continue;
      }

      if (
        this.fetched.some(
          ({ splats: s, chunk: c }) => splats === s && chunk === c,
        ) ||
        this.fetchers.some(
          ({ splats: s, chunk: c }) => splats === s && chunk === c,
        )
      ) {
        numPages += 1;
        continue;
      }

      if (numPages < this.maxPages && this.fetchers.length < this.numFetchers) {
        numPages += 1;
        this.noteFetchStart(splats, chunk);
        const fetcher = {
          splats,
          chunk,
          promise: undefined as unknown as Promise<void>,
          missCount: 0,
          cancelled: false,
        };
        const promise = splats
          .fetchDecodeChunk(chunk)
          .then(
            async (data) => {
              // Place data in ready queue and remove self from active fetchers list
              this.fetched.push({ splats, chunk, data });
              if (this.fetchPause > 0) {
                await new Promise((resolve) =>
                  setTimeout(resolve, this.fetchPause),
                );
              }
            },
            async (error) => {
              // [ssog-24] a cancelled fetch rejects by design (AbortError):
              // free the slot at once — no warning, no backoff.
              if (
                fetcher.cancelled ||
                (error as { name?: unknown } | null)?.name === "AbortError"
              ) {
                return;
              }
              console.warn(error);
              const backoff = 250 + 500 * Math.random();
              await new Promise((resolve) => setTimeout(resolve, backoff));
            },
          )
          .finally(() => {
            this.fetchers = this.fetchers.filter(
              ({ splats: s, chunk: c }) => splats !== s || chunk !== c,
            );
            this.processFetched();
          });
        fetcher.promise = promise;
        // Add self to active fetchers list
        this.fetchers.push(fetcher);

        promise.then((data) => {
          if (this.autoDrive) {
            this.driveFetchers();
          }
        });
      }
    }

    // [ssog-24] request-side cancellation: an in-flight fetcher whose chunk
    // is absent from the CURRENT fetchPriority is a superseded target (the
    // controller lists tiers 1-2 every tick, so displayed/pinned chunks can
    // never qualify). Misses are counted once per DISTINCT priority list —
    // the completion-driven refill re-drives the same list several times
    // per tick — and a chunk must be missing from two consecutive lists
    // (grace against single-tick jitter) before its source is asked to
    // abort; transfers ≥ 75% received are left to finish (their bytes are
    // spent, and the arrival is dropped on the floor by [ssog-21] if still
    // unwanted). Only sources implementing cancelFetchChunk take part.
    //
    // [ssog-24 fix B] A cancel kills the fetcher's whole fetchGroup (the ssog
    // unit download every chunk of the unit shares), so a fetcher is spared
    // whenever ANY chunk of the CURRENT wanted set belongs to its group —
    // otherwise the wanted sibling that has not been given a fetcher slot yet
    // would restart the group from byte 0, a "saving" that costs bytes.
    // [ssog-24 fix C] A cancelled fetcher whose chunk is wanted again is
    // re-leased (resumeFetchChunk) and un-cancelled, so a later sibling
    // cancel cannot abort a transfer a wanted fetcher depends on.
    {
      const list = this.fetchPriority;
      if (this.wantedCache?.list !== list) {
        const wanted = new Map<PagedSplats, Set<number>>();
        const groups = new Map<PagedSplats, Set<number>>();
        for (const { splats, chunk } of list) {
          let set = wanted.get(splats);
          if (!set) {
            set = new Set();
            wanted.set(splats, set);
          }
          set.add(chunk);
          // [ssog-24 fix B2] Only a chunk that still NEEDS a transfer may
          // protect its group. A resident chunk (already in the pool) and one
          // whose data is sitting in the fetched queue await nothing — letting
          // them into the group set suppressed cancels that would have cost
          // nothing, over-shooting fix B's "never abort a transfer a wanted
          // sibling rides on" into "never abort anything near a wanted
          // sibling". The wanted-CHUNK set above stays complete: it drives
          // missCount, which must reflect the real priority list.
          if (splats.fetchGroup && !this.getSplatsChunk(splats, chunk)) {
            const alreadyFetched = this.fetched.some(
              ({ splats: s, chunk: c }) => splats === s && chunk === c,
            );
            if (!alreadyFetched) {
              const group = splats.fetchGroup(chunk);
              if (group !== null && group !== undefined) {
                let gset = groups.get(splats);
                if (!gset) {
                  gset = new Set();
                  groups.set(splats, gset);
                }
                gset.add(group);
              }
            }
          }
        }
        this.wantedCache = { list, wanted, groups };
        this.listTick += 1;
        for (const fetcher of this.fetchers) {
          if (wanted.get(fetcher.splats)?.has(fetcher.chunk)) {
            fetcher.missCount = 0;
            if (fetcher.cancelled) {
              // wanted again before the abort surfaced: take the transfer back
              if (fetcher.splats.resumeFetchChunk?.(fetcher.chunk)) {
                fetcher.cancelled = false;
                // [ssog-24 fix F] the cancel was taken back and cost nothing:
                // drop its stamp so noteFetchStart cannot later score this
                // chunk as cancel→refetch thrash it never was.
                this.clearCancelTick(fetcher.splats, fetcher.chunk);
              }
            }
            continue;
          }
          fetcher.missCount += 1;
          if (
            fetcher.missCount < 2 ||
            fetcher.cancelled ||
            !fetcher.splats.cancelFetchChunk
          ) {
            continue;
          }
          const group = fetcher.splats.fetchGroup?.(fetcher.chunk);
          if (
            group !== null &&
            group !== undefined &&
            groups.get(fetcher.splats)?.has(group)
          ) {
            continue; // a wanted chunk still rides this transfer
          }
          if ((fetcher.splats.fetchProgress?.(fetcher.chunk) ?? 0) >= 0.75) {
            continue;
          }
          fetcher.cancelled = true;
          fetcher.splats.cancelFetchChunk(fetcher.chunk);
          this.fetchCancels += 1;
          this.noteCancelTick(fetcher.splats, fetcher.chunk);
        }
      }
    }

    // Update LRU ordering in reverse priority order
    const now = performance.now();

    for (const pageLru of overflow.reverse()) {
      pageLru.lru = now;
      this.pageLru.delete(pageLru);
      this.pageLru.add(pageLru);
    }

    // Create set of pages not needed
    const extraPages = new Set(this.pageLru);
    for (const pageLru of needed.reverse()) {
      extraPages.delete(pageLru);

      pageLru.lru = now;
      this.pageLru.delete(pageLru);
      this.pageLru.add(pageLru);
    }
    this.freeablePages = Array.from(extraPages).map(({ page }) => page);
  }

  /**
   * [ssog-21] pages evicted to make room for an arriving fetch, and chunks
   * fetched again after having been resident. Pool eviction was invisible —
   * the ssog cache's `evictions` counts the DECODE LRU, not this.
   */
  pageEvictions = 0;
  chunkRefetches = 0;
  private everResident: WeakMap<object, Set<number>> = new WeakMap();

  /**
   * [ssog-24] in-flight fetchers asked to cancel (chunk-level requests; the
   * ssog cache's `fetchCancels` counts the UNIT downloads actually aborted).
   */
  fetchCancels = 0;
  /**
   * [ssog-24] cancel→refetch thrash: a chunk whose fetch was cancelled and
   * that is fetched AGAIN within `cancelCooldownTicks` pager ticks (distinct
   * fetchPriority lists) of that cancel. Under continuous motion a cancel
   * lever can churn instead of save; without this counter that churn hides
   * inside the bandwidth total and looks like ordinary streaming.
   */
  cancelRefetches = 0;
  /** [ssog-24] window (in distinct fetchPriority lists) for cancelRefetches */
  cancelCooldownTicks = 8;
  /** [ssog-24] distinct fetchPriority lists seen — the pager's tick clock */
  private listTick = 0;
  /** [ssog-24] splats → chunk → listTick at which its fetch was cancelled */
  private cancelTick: WeakMap<object, Map<number, number>> = new WeakMap();

  private noteCancelTick(splats: PagedSplats, chunk: number) {
    let map = this.cancelTick.get(splats as object);
    if (!map) {
      map = new Map<number, number>();
      this.cancelTick.set(splats as object, map);
    }
    map.set(chunk, this.listTick);
    if (map.size > 1024) {
      // bounded: entries older than the cooldown can never score a refetch
      for (const [c, tick] of map) {
        if (this.listTick - tick > this.cancelCooldownTicks) {
          map.delete(c);
        }
      }
    }
  }

  /**
   * [ssog-24 fix F] Forget a chunk's cancel stamp — used when a cancel is
   * TAKEN BACK (resumeFetchChunk succeeded): no bytes were lost, so a later
   * fetch of that chunk must not be scored as cancel→refetch thrash.
   */
  private clearCancelTick(splats: PagedSplats, chunk: number) {
    this.cancelTick.get(splats as object)?.delete(chunk);
  }

  /** [ssog-24] a fetcher slot is being opened for (splats, chunk) */
  private noteFetchStart(splats: PagedSplats, chunk: number) {
    const map = this.cancelTick.get(splats as object);
    if (!map) {
      return;
    }
    const tick = map.get(chunk);
    if (tick === undefined) {
      return;
    }
    map.delete(chunk);
    if (this.listTick - tick <= this.cancelCooldownTicks) {
      this.cancelRefetches += 1;
    }
  }
  /**
   * [ssog-24] eviction hook: called with the (splats, chunk) of every
   * resident page freed to make room for an arrival — never for
   * clear/dispose. The ssog controller prices never-displayed evictions.
   */
  onPageEvicted?: (splats: PagedSplats, chunk: number) => void;
  /** [ssog-24] wanted-set of the last DISTINCT fetchPriority list seen */
  private wantedCache?: {
    list: { splats: PagedSplats; chunk: number }[];
    wanted: Map<PagedSplats, Set<number>>;
    /** [ssog-24] fetchGroup ids covered by the wanted set, per source */
    groups: Map<PagedSplats, Set<number>>;
  };

  private allocateFreeable(): number | undefined {
    const page = this.freeablePages.shift();
    if (page === undefined) {
      // No freeable pages available
      return undefined;
    }
    this.pageEvictions += 1;

    const splatsChunk = this.pageToSplatsChunk[page];
    if (!splatsChunk) {
      throw new Error(`splatsChunk not found for page: ${page}`);
    }

    const { splats, chunk } = splatsChunk;
    this.onPageEvicted?.(splats, chunk);
    this.removeSplatsChunkPage(splats, chunk, page);
    this.lodTreeUpdates.push({
      splats,
      page,
      chunk,
      numSplats: this.pageSplats,
    });
    return page;
  }

  private processFetched() {
    const now = performance.now();
    while (true) {
      const fetched = this.fetched.shift();
      if (!fetched) {
        break;
      }
      const { splats, chunk, data } = fetched;

      let page = this.allocatePage();
      if (page === undefined) {
        // [ssog-21] A fetch that completed for a target the controller has
        // since abandoned must NOT evict a live page to install itself: the
        // arrival then has to re-download whatever it displaced (measured on
        // a 3-pose tour: superseded fetches evicting useful pages was a
        // large share of ~1,030 MB of excess transfer). A chunk still wanted
        // is in the CURRENT fetchPriority; one that is not is dropped on the
        // floor — its bytes are already spent either way, and it re-enters
        // normally if a later tick wants it again.
        if (
          this.fetchPriority.length > 0 &&
          !this.fetchPriority.some(
            (e) => e.splats === splats && e.chunk === chunk,
          )
        ) {
          continue;
        }
        page = this.allocateFreeable();
        if (page === undefined) {
          // No pages available, stop for now
          return;
        }
      }

      // [ssog-21] refetch telemetry: a chunk arriving that was resident
      // before is a byte we paid for twice.
      let seen = this.everResident.get(splats as object);
      if (!seen) {
        seen = new Set<number>();
        this.everResident.set(splats as object, seen);
      }
      if (seen.has(chunk)) {
        this.chunkRefetches += 1;
      } else {
        seen.add(chunk);
      }

      this.insertSplatsChunkPage(splats, chunk, page, now);
      const { numSplats, extra } = data;
      this.lodTreeUpdates.push({
        splats,
        page,
        chunk,
        numSplats,
        lodTree: extra.lodTree as Uint32Array,
      });

      if (!this.extSplats) {
        const packedArray = (data as PackedResult).packedArray;
        this.newUploads.push({ page, numSplats, packedArray, extra });
      } else {
        const extArrays = (data as ExtResult).extArrays;
        const packedArray = extArrays[0];
        const extArray = extArrays[1];
        this.newUploads.push({ page, numSplats, packedArray, extArray, extra });
      }
    }
  }

  processUploads() {
    while (true) {
      const upload = this.readyUploads.shift();
      if (!upload) {
        break;
      }
      const { page, numSplats, packedArray, extArray, extra } = upload;
      this.uploadPage(page, packedArray, extra, extArray);
    }
  }

  consumeLodTreeUpdates() {
    const updates = this.lodTreeUpdates;
    this.lodTreeUpdates = [];

    this.readyUploads.push(...this.newUploads);
    this.newUploads = [];
    return updates;
  }

  static emptyUint32x4 = (() => {
    const { width, height, depth, maxSplats } = getTextureSize(1);
    const emptyArray = new Uint32Array(maxSplats * 4);
    const texture = new THREE.DataArrayTexture(
      emptyArray,
      width,
      height,
      depth,
    );
    texture.format = THREE.RGBAIntegerFormat;
    texture.type = THREE.UnsignedIntType;
    texture.internalFormat = "RGBA32UI";
    texture.needsUpdate = true;
    return texture;
  })();

  static emptyUint32x2 = (() => {
    const { width, height, depth, maxSplats } = getTextureSize(1);
    const emptyArray = new Uint32Array(maxSplats * 2);
    const texture = new THREE.DataArrayTexture(
      emptyArray,
      width,
      height,
      depth,
    );
    texture.format = THREE.RGIntegerFormat;
    texture.type = THREE.UnsignedIntType;
    texture.internalFormat = "RG32UI";
    texture.needsUpdate = true;
    return texture;
  })();

  static emptyIndicesTexture = (() => {
    const emptyArray = new Uint32Array(4096 * 4);
    const texture = new THREE.DataTexture(emptyArray, 4096, 1);
    texture.format = THREE.RGBAIntegerFormat;
    texture.type = THREE.UnsignedIntType;
    texture.internalFormat = "RGBA32UI";
    texture.needsUpdate = true;
    return texture;
  })();

  static emptyPackedTexture = this.emptyUint32x4;
  static emptyExtTexture = this.emptyUint32x4;
  static emptySh1Texture = this.emptyUint32x2;
  static emptySh2Texture = this.emptyUint32x4;
  static emptySh3Texture = this.emptyUint32x4;
  static emptyExtSh1Texture = this.emptyUint32x4;
  static emptyExtSh2Texture = this.emptyUint32x4;
  static emptyExtSh3Texture = this.emptyUint32x4;
  static emptyExtSh3BTexture = this.emptyUint32x4;
}

function getGlTexture(
  renderer: THREE.WebGLRenderer,
  texture: THREE.Texture,
): WebGLTexture {
  if (!renderer.properties.has(texture)) {
    throw new Error("texture not found");
  }
  const props = renderer.properties.get(texture) as {
    __webglTexture: WebGLTexture;
  };
  const glTexture = props.__webglTexture;
  if (!glTexture) {
    throw new Error("texture not found");
  }
  return glTexture;
}

const wasmInitialized = init_wasm();

async function fetchRange({
  url,
  requestHeader,
  withCredentials,
  offset,
  bytes,
}: {
  url: string;
  requestHeader?: Record<string, string>;
  withCredentials?: boolean;
  offset?: number;
  bytes?: number;
}): Promise<Uint8Array> {
  const request = new Request(url, {
    headers: requestHeader ? new Headers(requestHeader) : undefined,
    credentials: withCredentials ? "include" : "same-origin",
  });
  if (offset !== undefined && bytes !== undefined) {
    request.headers.set("Range", `bytes=${offset}-${offset + bytes - 1}`);
  }
  const response = await fetch(request);
  if (!response.ok || !response.body) {
    throw new Error(
      `Failed to fetch "${url}": ${response.status} ${response.statusText}`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

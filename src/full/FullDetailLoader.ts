// Kroscloud fork (2026) — see FORK-CHANGES.md [full-1].
//
// Full-detail (no-LOD) loader for a plain `scene.sog`: ONE streamed download,
// the browser's WebP decoder in K workers (overlapped with the download),
// table-driven packing into Spark's 16-byte splat words in the same workers,
// then an ordinary static SplatMesh. Every splat, no LOD, nothing on screen
// until the file has arrived (like superspl.at's plain path).
//
// Isolation: this module imports the CORE by package name (class identity
// with the consumer's PackedSplats / SplatMesh, exactly like the ssog entry)
// and the pure helpers by relative path. It never touches src/ssog/*, the
// core worker (src/worker.ts), the unit decoder or the pager. (Those files
// changed once since, for [prec-1] - a cross-path precision fix with
// defaults that keep every existing caller's words - never for this loader.)
//
// [prec-1] / [prec-2] (kroscloud.48) centre precision: Spark packs centres as
// fp16, so content far from the file origin is quantised coarsely (18ss: real
// altitude z ~ 465, fp16 step 0.25 -> horizontal stripes). After the plane
// decodes the loader takes o_rel = the rounded per-axis median of the mean
// codes (sogOrigin.ts; `packOrigin: false` = no o_rel), the workers' centre
// tables subtract it, and the PackedSplats gets centerOrigin = kcOrigin +
// o_rel (kcOrigin = what a recentring build already subtracted, meta.json;
// always applied - it is correctness, not a lever). The mesh transform
// re-adds it, so mesh.matrixWorld still maps the FILE frame to world and
// `bounds` stay file-frame.
//
// This loader performs NO capability check (owner decision 2026-09-11): a
// machine that cannot hold ~1.6 GB of GPU textures plus their CPU mirrors
// crashes, as it does on superspl.at. What it DOES handle are its own
// failures - a failed download, a corrupt zip, a decode or worker error - as
// typed errors the app turns into a silent fallback to the stream.

import { PackedSplats, SplatMesh } from "@sparkjsdev/spark";
import { DEFAULT_SPLAT_ENCODING, type SplatEncoding } from "../defines";
import { computeMaxSplats } from "../packedEncode";
import FullWorker from "./fullWorker?worker&inline";
import {
  type SogMeta,
  type SogPlaneName,
  SogMetaError,
  boundsFromMeta,
  parseSogMeta,
  planeSize,
} from "./sogMeta";
import {
  SogMeanCodeHistogram,
  composeCenterOrigin,
  sogPackOrigin,
} from "./sogOrigin";
import {
  type SogWalkedEntry,
  SogStreamWalker,
  SogZipError,
  indexSogZip,
  sliceSogEntries,
} from "./sogZip";

export const FULL_DETAIL_VERSION = "full-1";

export type FullDetailErrorCode =
  | "fetch"
  | "bytes"
  | "zip"
  | "meta"
  | "decode"
  | "pack"
  | "alloc"
  | "worker"
  | "cancel"
  | "forkversion";

export class FullDetailError extends Error {
  readonly code: FullDetailErrorCode;
  readonly cause?: unknown;
  constructor(code: FullDetailErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "FullDetailError";
    this.code = code;
    this.cause = cause;
  }
}

export type FullDetailPhase = "download" | "decode" | "pack" | "upload" | "done";

export type FullDetailProgress = {
  phase: FullDetailPhase;
  /** bytes for download, planes for decode, bands for pack */
  loaded: number;
  total: number;
};

export type FullDetailOptions = {
  url: string;
  /** Tried once when the primary fetch itself fails (network / HTTP error). */
  fallbackUrl?: string;
  /** Exact byte size when known (Content-Length is used otherwise). */
  expectedBytes?: number;
  /** SH bands to pack and allocate (0..3, clamped to what the file has). Default 3. */
  maxSh?: number;
  /** Worker count (default clamp(hardwareConcurrency - 2, 2, 6)). */
  workers?: number;
  /** Horizontal bands per plane (default 16). */
  bands?: number;
  /** false = buffer the whole file, then index it (no decode/download overlap). */
  stream?: boolean;
  signal?: AbortSignal;
  onProgress?: (p: FullDetailProgress) => void;
  requestHeader?: Record<string, string>;
  withCredentials?: boolean;
  splatEncoding?: SplatEncoding;
  /**
   * [prec-1] pack the centres relative to the runtime pack origin o_rel (the
   * rounded per-axis median of the mean codes). Default true; false = o_rel
   * [0, 0, 0] (the app's `?splatorigin=off` A/B lever). A meta.json kcOrigin
   * is applied either way.
   */
  packOrigin?: boolean;
};

export type FullDetailStats = {
  bytes: number;
  numSplats: number;
  maxSplats: number;
  bands: number;
  maxSh: number;
  workers: number;
  streamed: boolean;
  badLabels: number;
  planeWidth: number;
  planeHeight: number;
  geometryMatchesRule: boolean;
  ms: {
    download: number;
    decodeTail: number;
    /** [prec-1] the mean-code histogram + median (0 with packOrigin false) */
    origin: number;
    tables: number;
    pack: number;
    total: number;
  };
  perPlane: Record<string, { bytes: number; decodeMs: number; readMs: number }>;
};

export type FullDetailResult = {
  /** centerOrigin = kcOrigin + packOrigin (null when both are zero) */
  packedSplats: PackedSplats;
  meta: SogMeta;
  numSplats: number;
  /** FILE frame (kcOrigin added back) - what mesh.matrixWorld maps to world */
  bounds: { min: [number, number, number]; max: [number, number, number] };
  /**
   * [prec-1] the RUNTIME part of the centre origin (o_rel: the rounded
   * per-axis median the tables subtracted), null when zero or disabled.
   * Diagnostics; the full origin is packedSplats.centerOrigin.
   */
  packOrigin: [number, number, number] | null;
  stats: FullDetailStats;
};

// ---- worker pool -----------------------------------------------------

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };

class FullWorkerHandle {
  readonly worker: Worker;
  busy = false;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  constructor() {
    this.worker = new FullWorker();
    this.worker.onmessage = (ev: MessageEvent) => {
      const { id, result, error } = ev.data as { id: number; result?: unknown; error?: unknown };
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (error !== undefined) p.reject(new Error(String(error)));
      else p.resolve(result);
    };
    this.worker.onerror = (ev: ErrorEvent) => {
      const err = new Error(`full worker crashed: ${ev.message}`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
  }
  call<T>(name: string, args: unknown, transfer: Transferable[] = []): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ id, name, args }, transfer);
    });
  }
  terminate(): void {
    const err = new Error("full worker terminated");
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.worker.terminate();
  }
}

class FullWorkerPool {
  readonly workers: FullWorkerHandle[];
  private waiters: ((w: FullWorkerHandle) => void)[] = [];
  constructor(n: number) {
    this.workers = Array.from({ length: n }, () => new FullWorkerHandle());
  }
  private acquire(): Promise<FullWorkerHandle> {
    const free = this.workers.find((w) => !w.busy);
    if (free) {
      free.busy = true;
      return Promise.resolve(free);
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  private release(w: FullWorkerHandle): void {
    const next = this.waiters.shift();
    if (next) next(w);
    else w.busy = false;
  }
  /** Run one RPC on the next free worker. */
  async run<T>(name: string, args: unknown, transfer: Transferable[] = []): Promise<T> {
    const w = await this.acquire();
    try {
      return await w.call<T>(name, args, transfer);
    } finally {
      this.release(w);
    }
  }
  /** Run one RPC on EVERY worker (tables are per-worker state). */
  broadcast<T>(name: string, args: unknown): Promise<T[]> {
    return Promise.all(this.workers.map((w) => w.call<T>(name, args)));
  }
  terminate(): void {
    for (const w of this.workers) w.terminate();
    this.waiters = [];
  }
}

// ---- the loader ------------------------------------------------------

type DecodedPlane = {
  name: string;
  width: number;
  height: number;
  bands: Uint8Array[];
  rowStart: number[];
  rows: number[];
  decodeMs: number;
  readMs: number;
};

const PER_SPLAT_PLANES: SogPlaneName[] = ["means_l", "means_u", "quats", "scales", "sh0", "shN_labels"];

function defaultWorkers(): number {
  const hc = typeof navigator !== "undefined" && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4;
  return Math.max(2, Math.min(6, hc - 2));
}

function baseName(entryName: string): string {
  const i = Math.max(entryName.lastIndexOf("/"), entryName.lastIndexOf("\\"));
  return i >= 0 ? entryName.slice(i + 1) : entryName;
}

export async function loadFullDetailSog(options: FullDetailOptions): Promise<FullDetailResult> {
  const t0 = performance.now();
  const maxShRequested = Math.max(0, Math.min(3, options.maxSh ?? 3));
  const nBands = Math.max(1, Math.min(64, options.bands ?? 16));
  const nWorkers = Math.max(1, Math.min(16, options.workers ?? defaultWorkers()));
  const streamed = options.stream !== false;
  const encoding = options.splatEncoding ?? { ...DEFAULT_SPLAT_ENCODING };
  const signal = options.signal;
  const progress = (phase: FullDetailPhase, loaded: number, total: number) =>
    options.onProgress?.({ phase, loaded, total });

  const pool = new FullWorkerPool(nWorkers);
  const decodes = new Map<string, Promise<DecodedPlane>>();
  const entryBytes = new Map<string, number>();
  let meta: SogMeta | null = null;
  let metaError: unknown = null;
  let bytesTotal = options.expectedBytes ?? 0;
  let bytesLoaded = 0;

  const throwIfAborted = () => {
    if (signal?.aborted) throw new FullDetailError("cancel", "full-detail load cancelled");
  };
  const onAbort = () => pool.terminate();
  signal?.addEventListener("abort", onAbort, { once: true });

  // an entry (plane or manifest) is complete: hand planes to a worker at once
  const onEntry = (name: string, bytes: Uint8Array) => {
    const base = baseName(name);
    entryBytes.set(base, bytes.length);
    if (base === "meta.json") {
      try {
        meta = parseSogMeta(JSON.parse(new TextDecoder("utf-8").decode(bytes)));
      } catch (e) {
        metaError = e;
      }
      return;
    }
    if (!/\.webp$/i.test(base)) return; // ignore anything else silently
    const isCentroids = /centroids/i.test(base);
    const p = pool.run<DecodedPlane>(
      "decodePlane",
      { name: base, bytes, bands: isCentroids ? 1 : nBands },
      [bytes.buffer],
    );
    decodes.set(base, p);
    p.then(
      () => progress("decode", decodes.size, 7),
      () => {},
    );
  };

  try {
    // ---- 1. download (+ decode overlapped) --------------------------------
    const fetchOnce = async (url: string): Promise<Response> => {
      const headers: Record<string, string> = { ...(options.requestHeader ?? {}) };
      const resp = await fetch(url, {
        headers,
        credentials: options.withCredentials ? "include" : "same-origin",
        signal,
      });
      if (!resp.ok) throw new FullDetailError("fetch", `HTTP ${resp.status} for ${url}`);
      return resp;
    };
    let resp: Response;
    try {
      resp = await fetchOnce(options.url);
    } catch (e) {
      if (signal?.aborted) throw new FullDetailError("cancel", "cancelled", e);
      if (!options.fallbackUrl) throw e instanceof FullDetailError ? e : new FullDetailError("fetch", String(e), e);
      resp = await fetchOnce(options.fallbackUrl);
    }
    const contentLength = Number(resp.headers.get("content-length") ?? 0);
    if (!bytesTotal && contentLength > 0) bytesTotal = contentLength;
    if (!resp.body) throw new FullDetailError("fetch", "response has no body");

    const tDownload0 = performance.now();
    if (streamed) {
      const walker = new SogStreamWalker((e: SogWalkedEntry) => onEntry(e.name, e.bytes));
      const reader = resp.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        throwIfAborted();
        bytesLoaded += value.length;
        walker.push(value);
        progress("download", bytesLoaded, bytesTotal);
      }
      walker.finish();
    } else {
      const chunks: Uint8Array[] = [];
      const reader = resp.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        throwIfAborted();
        bytesLoaded += value.length;
        chunks.push(value);
        progress("download", bytesLoaded, bytesTotal);
      }
      const all = new Uint8Array(bytesLoaded);
      let o = 0;
      for (const c of chunks) {
        all.set(c, o);
        o += c.length;
      }
      const index = indexSogZip(all);
      for (const [name, view] of sliceSogEntries(all, index)) {
        // decodePlane transfers its input; give each plane its own buffer
        onEntry(name, view.slice());
      }
    }
    const msDownload = performance.now() - tDownload0;
    if (bytesTotal > 0 && bytesLoaded !== bytesTotal) {
      throw new FullDetailError("bytes", `downloaded ${bytesLoaded} bytes, expected ${bytesTotal}`);
    }
    if (metaError) throw metaError;
    if (!meta) throw new FullDetailError("meta", "the archive has no meta.json");
    const m: SogMeta = meta;

    // ---- 2. wait for the decodes, validate the planes ------------------
    const tDecode0 = performance.now();
    const need: SogPlaneName[] = ["means_l", "means_u", "quats", "scales", "sh0"];
    const wantSh = maxShRequested > 0 && m.bands > 0;
    if (wantSh) need.push("shN_centroids", "shN_labels");
    const planes = new Map<SogPlaneName, DecodedPlane>();
    for (const role of need) {
      const file = m.files[role];
      if (!file) throw new FullDetailError("meta", `manifest names no ${role} plane`);
      const p = decodes.get(baseName(file));
      if (!p) throw new FullDetailError("zip", `plane ${file} (${role}) is not in the archive`);
      try {
        planes.set(role, await p);
      } catch (e) {
        throw new FullDetailError("decode", `decoding ${file} failed: ${String((e as Error)?.message ?? e)}`, e);
      }
      throwIfAborted();
    }
    const msDecodeTail = performance.now() - tDecode0;
    const ref = planes.get("means_l") as DecodedPlane;
    for (const role of PER_SPLAT_PLANES) {
      const pl = planes.get(role);
      if (!pl) continue;
      if (pl.width !== ref.width || pl.height !== ref.height || pl.bands.length !== ref.bands.length) {
        throw new FullDetailError(
          "decode",
          `plane ${role} is ${pl.width}x${pl.height}/${pl.bands.length} bands, means_l is ${ref.width}x${ref.height}/${ref.bands.length}`,
        );
      }
    }
    if (ref.width * ref.height < m.count) {
      throw new FullDetailError("decode", `planes hold ${ref.width * ref.height} pixels for ${m.count} splats`);
    }
    const rule = planeSize(m.count);
    const geometryMatchesRule = rule.width === ref.width && rule.height === ref.height;

    // ---- 2b. [prec-1] the runtime pack origin ----------------------------
    // o_rel = the rounded per-axis median of the 16-bit mean codes over every
    // splat (one 65,536-bin histogram per axis). Here, BEFORE step 3, because
    // step 5 transfers the means bands to the workers. One synchronous pass
    // (measured in Node: ~2.7 ns per splat for all 3 axes - 5M 15 ms, a 19.9M
    // scene 54 ms); deliberately NO timer yields between bands: chained
    // setTimeout(0)s are throttled in a hidden tab (review 2026-10-07).
    // means_u has means_l's geometry (checked above).
    const tOrigin0 = performance.now();
    let oRel: [number, number, number] = [0, 0, 0];
    if (options.packOrigin !== false) {
      const meansU = planes.get("means_u") as DecodedPlane;
      const hist = new SogMeanCodeHistogram();
      throwIfAborted();
      for (let k = 0; k < ref.bands.length; ++k) {
        const offset = ref.rowStart[k] * ref.width;
        const count = Math.min(ref.rows[k] * ref.width, m.count - offset);
        if (count <= 0) break;
        hist.add(ref.bands[k], meansU.bands[k], count);
      }
      oRel = sogPackOrigin(m, hist);
    }
    // packed + centerOrigin = the original (file-frame) centre
    const centerOrigin = composeCenterOrigin(m.origin, oRel);
    const msOrigin = performance.now() - tOrigin0;

    // ---- 3. tables on every worker ---------------------------------------
    const tTables0 = performance.now();
    const centroids = wantSh ? (planes.get("shN_centroids") as DecodedPlane) : null;
    const tableInfo = await pool.broadcast<{ maxSh: number; paletteEntries: number }>("buildTables", {
      meta: { ...m, json: undefined },
      centroids: centroids ? { rgba: centroids.bands[0], width: centroids.width, height: centroids.height } : null,
      maxSh: maxShRequested,
      encoding,
      origin: oRel,
    });
    const maxSh = tableInfo[0]?.maxSh ?? 0;
    const msTables = performance.now() - tTables0;
    throwIfAborted();

    // ---- 4. outputs (padded to the texture size so nothing is re-copied) --
    const maxSplats = computeMaxSplats(m.count);
    let packed: Uint32Array;
    let sh1: Uint32Array | undefined;
    let sh2: Uint32Array | undefined;
    let sh3: Uint32Array | undefined;
    try {
      packed = new Uint32Array(maxSplats * 4);
      if (maxSh >= 1) sh1 = new Uint32Array(maxSplats * 2);
      if (maxSh >= 2) sh2 = new Uint32Array(maxSplats * 4);
      if (maxSh >= 3) sh3 = new Uint32Array(maxSplats * 4);
    } catch (e) {
      throw new FullDetailError("alloc", `cannot allocate ${maxSplats} splats of output: ${String(e)}`, e);
    }

    // ---- 5. pack band by band, K at a time ------------------------------
    const tPack0 = performance.now();
    const W = ref.width;
    let badLabels = 0;
    let bandsDone = 0;
    const labelsPlane = wantSh ? (planes.get("shN_labels") as DecodedPlane) : null;
    const jobs: Promise<void>[] = [];
    for (let k = 0; k < ref.bands.length; ++k) {
      const offset = ref.rowStart[k] * W;
      const count = Math.min(ref.rows[k] * W, m.count - offset);
      if (count <= 0) break;
      const take = (role: SogPlaneName) => (planes.get(role) as DecodedPlane).bands[k];
      const bandPlanes = {
        meansL: take("means_l"),
        meansU: take("means_u"),
        quats: take("quats"),
        scales: take("scales"),
        sh0: take("sh0"),
        labels: labelsPlane ? labelsPlane.bands[k] : null,
      };
      const transfer = [bandPlanes.meansL, bandPlanes.meansU, bandPlanes.quats, bandPlanes.scales, bandPlanes.sh0, bandPlanes.labels]
        .filter((b): b is Uint8Array => !!b)
        .map((b) => b.buffer as ArrayBuffer);
      const job = pool
        .run<{ packed: Uint32Array; sh1: Uint32Array | null; sh2: Uint32Array | null; sh3: Uint32Array | null; badLabels: number }>(
          "packBand",
          { planes: bandPlanes, count },
          transfer,
        )
        .then((res) => {
          packed.set(res.packed, offset * 4);
          if (sh1 && res.sh1) sh1.set(res.sh1, offset * 2);
          if (sh2 && res.sh2) sh2.set(res.sh2, offset * 4);
          if (sh3 && res.sh3) sh3.set(res.sh3, offset * 4);
          badLabels += res.badLabels;
          progress("pack", ++bandsDone, ref.bands.length);
        });
      jobs.push(job);
    }
    try {
      await Promise.all(jobs);
    } catch (e) {
      throw new FullDetailError("pack", `packing failed: ${String((e as Error)?.message ?? e)}`, e);
    }
    throwIfAborted();
    const msPack = performance.now() - tPack0;

    // ---- 6. the PackedSplats (synchronous construction path) -------------
    const extra: Record<string, unknown> = {};
    if (sh1) extra.sh1 = sh1;
    if (sh2) extra.sh2 = sh2;
    if (sh3) extra.sh3 = sh3;
    const packedSplats = new PackedSplats({
      packedArray: packed,
      numSplats: m.count,
      extra,
      splatEncoding: encoding,
      // [prec-1] / [prec-2] kcOrigin + o_rel; the mesh transform re-adds it
      centerOrigin,
    });

    const perPlane: FullDetailStats["perPlane"] = {};
    for (const [role, pl] of planes) {
      perPlane[role] = { bytes: entryBytes.get(pl.name) ?? 0, decodeMs: Math.round(pl.decodeMs), readMs: Math.round(pl.readMs) };
    }
    const stats: FullDetailStats = {
      bytes: bytesLoaded,
      numSplats: m.count,
      maxSplats,
      bands: ref.bands.length,
      maxSh,
      workers: nWorkers,
      streamed,
      badLabels,
      planeWidth: ref.width,
      planeHeight: ref.height,
      geometryMatchesRule,
      ms: {
        download: Math.round(msDownload),
        decodeTail: Math.round(msDecodeTail),
        origin: Math.round(msOrigin),
        tables: Math.round(msTables),
        pack: Math.round(msPack),
        total: Math.round(performance.now() - t0),
      },
      perPlane,
    };
    progress("done", 1, 1);
    const packOrigin =
      oRel[0] !== 0 || oRel[1] !== 0 || oRel[2] !== 0 ? oRel : null;
    // bounds: FILE frame (boundsFromMeta adds kcOrigin back)
    return {
      packedSplats,
      meta: m,
      numSplats: m.count,
      bounds: boundsFromMeta(m),
      packOrigin,
      stats,
    };
  } catch (e) {
    if (e instanceof FullDetailError) throw e;
    if (signal?.aborted || (e as Error)?.name === "AbortError") throw new FullDetailError("cancel", "cancelled", e);
    if (e instanceof SogZipError) throw new FullDetailError("zip", e.message, e);
    if (e instanceof SogMetaError) throw new FullDetailError("meta", e.message, e);
    if (e instanceof RangeError) throw new FullDetailError("alloc", e.message, e);
    throw new FullDetailError("worker", String((e as Error)?.message ?? e), e);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    pool.terminate();
  }
}

/** The ordinary static mesh over the loaded splats; the app adds it to the scene. */
export function createFullDetailMesh(
  result: FullDetailResult,
  options?: { maxSh?: number },
): SplatMesh {
  const mesh = new SplatMesh({ packedSplats: result.packedSplats });
  if (options?.maxSh !== undefined) mesh.maxSh = options.maxSh;
  return mesh;
}

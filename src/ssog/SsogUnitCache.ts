// Kroscloud fork — ssog module [ssog-2]. See FORK-CHANGES.md.
//
// SsogUnitCache: fetch + decode of Streamed-SOG units (unbundled files, plan
// C6) with a small decode LRU (2–3 units in flight, plan §2.3/R16) and the
// app signing hook (`resolveUrl` → UnlockController-signed URLs for protected
// scenes, plain CDN URLs public, origin+cookies editor). Decode runs in the
// core worker pool via the `unpackSsogUnit` RPC (the pcsogsDecode carve-out);
// all units decode with one fixed DEFAULT_SPLAT_ENCODING, lodOpacity:false —
// ssog payloads are valid α ≤ 1 gaussians (MPMM opacity clamp).

import { workerPool } from "@sparkjsdev/spark";
import { defines } from "@sparkjsdev/spark";
import type { PcSogsJson, PcSogsV2Json } from "../SplatLoader";
import type { SplatEncoding } from "../defines";
import type { SsogModel } from "./SsogModel";

export type SsogResolvedUrl =
  | string
  | { url: string; headers?: Record<string, string> };

export interface SsogUnitCacheOptions {
  model: SsogModel;
  /** base URL of the ssog dir (".../ssog/"); relative paths resolve under it */
  baseUrl?: string;
  /**
   * Signing hook: relativePath ("0_4/means_l.webp") → URL (+ headers).
   * Defaults to plain `baseUrl + relativePath`.
   */
  resolveUrl?: (relativePath: string) => Promise<SsogResolvedUrl> | SsogResolvedUrl;
  withCredentials?: boolean;
  /** decode LRU size in units (default 3 — plan §2.3 "2–3 units in flight") */
  maxUnits?: number;
  splatEncoding?: SplatEncoding;
}

export interface SsogDecodedUnit {
  numSplats: number;
  packedArray: Uint32Array;
  extra: {
    sh1?: Uint32Array;
    sh2?: Uint32Array;
    sh3?: Uint32Array;
  };
}

export class SsogUnitCache {
  readonly model: SsogModel;
  readonly baseUrl: string;
  readonly withCredentials: boolean;
  readonly maxUnits: number;
  readonly splatEncoding: SplatEncoding;
  private readonly resolver: (
    relativePath: string,
  ) => Promise<SsogResolvedUrl> | SsogResolvedUrl;

  /** unit → in-flight-or-settled decode; insertion order refreshed on touch */
  private units: Map<
    number,
    { promise: Promise<SsogDecodedUnit>; settled: boolean }
  > = new Map();

  /** counters for the HUD/harness */
  stats = { fetches: 0, decodes: 0, evictions: 0, fetchErrors: 0 };

  constructor(options: SsogUnitCacheOptions) {
    this.model = options.model;
    this.baseUrl = options.baseUrl ?? "";
    this.withCredentials = options.withCredentials ?? false;
    this.maxUnits = Math.max(1, options.maxUnits ?? 3);
    this.splatEncoding =
      options.splatEncoding ?? defines.DEFAULT_SPLAT_ENCODING;
    this.resolver =
      options.resolveUrl ?? ((relativePath) => this.baseUrl + relativePath);
  }

  /** Memoized unit decode. Blocks of one unit share a single fetch+decode. */
  getUnit(unit: number): Promise<SsogDecodedUnit> {
    const existing = this.units.get(unit);
    if (existing) {
      // LRU touch: re-insert at map tail
      this.units.delete(unit);
      this.units.set(unit, existing);
      return existing.promise;
    }

    const record = {
      promise: undefined as unknown as Promise<SsogDecodedUnit>,
      settled: false,
    };
    record.promise = this.fetchDecodeUnit(unit).then(
      (decoded) => {
        record.settled = true;
        return decoded;
      },
      (error) => {
        // failed decode must not poison the cache — allow retry
        if (this.units.get(unit) === record) {
          this.units.delete(unit);
        }
        this.stats.fetchErrors += 1;
        throw error;
      },
    );
    this.units.set(unit, record);
    this.evictOverflow();
    return record.promise;
  }

  /** Drop settled entries beyond maxUnits, oldest-touched first. */
  private evictOverflow() {
    if (this.units.size <= this.maxUnits) {
      return;
    }
    for (const [unit, record] of this.units) {
      if (this.units.size <= this.maxUnits) {
        break;
      }
      // never evict in-flight decodes (their blocks are about to be consumed)
      if (record.settled) {
        this.units.delete(unit);
        this.stats.evictions += 1;
      }
    }
  }

  clear() {
    this.units.clear();
  }

  private async fetchFile(relativePath: string): Promise<ArrayBuffer> {
    const resolved = await this.resolver(relativePath);
    const url = typeof resolved === "string" ? resolved : resolved.url;
    const headers =
      typeof resolved === "string" ? undefined : resolved.headers;
    const request = new Request(url, {
      headers: headers ? new Headers(headers) : undefined,
      credentials: this.withCredentials ? "include" : "same-origin",
    });
    this.stats.fetches += 1;
    const response = await fetch(request);
    if (!response.ok || !response.body) {
      throw new Error(
        `Failed to fetch "${url}": ${response.status} ${response.statusText}`,
      );
    }
    return await response.arrayBuffer();
  }

  private async fetchDecodeUnit(unit: number): Promise<SsogDecodedUnit> {
    const dir = this.model.unitDirName(unit);
    const metaBytes = await this.fetchFile(`${dir}/meta.json`);
    const json = JSON.parse(
      new TextDecoder().decode(metaBytes),
    ) as PcSogsJson | PcSogsV2Json;

    const names: string[] = [
      ...json.means.files,
      ...json.scales.files,
      ...json.quats.files,
      ...json.sh0.files,
      ...(json.shN?.files ?? []),
    ];
    const files: Record<string, ArrayBuffer> = {};
    await Promise.all(
      names.map(async (name) => {
        files[name] = await this.fetchFile(`${dir}/${name}`);
      }),
    );

    this.stats.decodes += 1;
    const decoded = (await workerPool.withWorker(async (worker) =>
      worker.call("unpackSsogUnit", {
        json,
        files,
        encoding: this.splatEncoding,
      }),
    )) as SsogDecodedUnit;

    // decoded count must equal the model-DERIVED per-unit count (P0b gate)
    const expected = this.model.unitSplats[unit];
    if (decoded.numSplats !== expected) {
      throw new Error(
        `ssog unit ${dir}: decoded ${decoded.numSplats} splats, model derives ${expected}`,
      );
    }
    return decoded;
  }
}

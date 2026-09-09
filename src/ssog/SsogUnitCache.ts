// Kroscloud fork — ssog module [ssog-2]. See FORK-CHANGES.md.
//
// SsogUnitCache: fetch + decode of Streamed-SOG units (unbundled files, plan
// C6) with a small decode LRU (2–3 units in flight, plan §2.3/R16) and the
// app signing hook (`resolveUrl` → UnlockController-signed URLs for protected
// scenes, plain CDN URLs public, origin+cookies editor). Decode runs in the
// core worker pool via the `unpackSsogUnit` RPC (the pcsogsDecode carve-out);
// all units decode with one fixed DEFAULT_SPLAT_ENCODING, lodOpacity:false —
// ssog payloads are valid α ≤ 1 gaussians (MPMM opacity clamp).
//
// [ssog-24] request-side tier: every in-flight unit carries an AbortController
// and a waiter count (one per pager chunk awaiting it). `release(unit)` from
// the last waiter aborts the unit's downloads mid-stream (the pager calls it
// for fetchers whose chunk fell out of fetchPriority); `retain(unit, id)`
// takes a lease back when the chunk becomes wanted again before the abort
// surfaces (the id pins WHICH download, so a re-lease can never attach to a
// fresh record of the same unit). Bytes are counted as they arrive so the
// HUD/harness can see received vs. saved vs. wasted; `unitProgress` reports
// null — cancellable — until EVERY file of the unit has a known size, so a
// chunked (gzip'd, Content-Length-less) response can never read as ~1.0 and
// silently switch cancellation off for that unit.
//
// [ssog-27] one file per unit: when the manifest is stamped `unitPack: 1`
// every unit is ONE container `{dir}/unit.bin` (SsogUnitPack.ts, SOGU v1)
// instead of meta.json + planes. `fetchPackedUnit` sets `filesTotal = 1`
// BEFORE the request starts, so `unitProgress` is real from the first
// Content-Length header (identity octet-stream) instead of null for most of
// the unit's life; the container is parsed on the main thread (header +
// directory, meta.json inflated with fflate), header count and meta count
// are checked against `unitSplats` before any decode, and every plane is
// `slice()`d into a standalone ArrayBuffer for the UNCHANGED `unpackSsogUnit`
// RPC. The classic path is the previous code verbatim. Any non-abort failure
// of a unit (network, container, decode) now records a strike and refuses
// that unit for 4/8/16…300 s (`fetchRefused`, `unitStrikes`), so a
// permanently bad container never loops the pager's transient-retry at full
// bandwidth. `stats.fetches` therefore counts units + palettes on a packed
// scene (the "÷8 = units" framing is retired).

import { workerPool } from "@sparkjsdev/spark";
import { defines } from "@sparkjsdev/spark";
import type { PcSogsJson, PcSogsV2Json } from "../SplatLoader";
import type { SplatEncoding } from "../defines";
import type { SsogModel } from "./SsogModel";
import {
  SSOG_UNIT_PACK_FILE,
  SsogUnitPackError,
  parseUnitPack,
  planeNames,
  readUnitPackMeta,
} from "./SsogUnitPack";

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

/** [ssog-24] per-unit fetch/decode record (in-flight or settled) */
interface UnitRecord {
  /**
   * Monotonic record identity. A unit id alone does NOT identify a record:
   * an aborted record is dropped and a later getUnit(unit) makes a NEW one.
   * `retain(unit, id)` therefore refuses to lease a record that is not the
   * one the caller was awaiting (it would leak an unreleasable waiter and
   * make that unit permanently uncancellable).
   */
  id: number;
  promise: Promise<SsogDecodedUnit>;
  settled: boolean;
  /** aborts every unit-file fetch of this record (never the shared palette) */
  controller: AbortController;
  /** pager chunks awaiting this unit; meaningful only while in flight */
  waiters: number;
  /** bytes received so far over the unit's files (meta + planes), DECODED */
  received: number;
  /**
   * [ssog-24 r4] WIRE bytes of this unit's files (transferSize where the
   * browser exposes it, else the body sum, 0 for an HTTP-cache hit). The
   * bytes-per-unit history — and therefore cancelSavedEstimateBytes and
   * wastedBytes — are driven off THIS, so a claimed saving is never measured
   * against a transfer that never happened (a warm-cache repeat run would
   * otherwise report megabytes 'saved' beside ~0 bytes received).
   */
  receivedWire: number;
  /**
   * Σ of the KNOWN size of every started file: its Content-Length when the
   * response carried one, else its final received size once it completed.
   */
  expected: number;
  /**
   * Files this unit will fetch: 0 = NOT YET KNOWN (classic: meta.json not
   * parsed, so the plane list is still unknown), else 1 (meta) + plane
   * files; [ssog-27] a packed unit sets 1 before the request starts.
   */
  filesTotal: number;
  /** files of this unit whose size is known (header or completion) */
  filesWithLength: number;
  /** all unit files fully received (decode may still be running) */
  fetchDone: boolean;
  /** release() aborted this record */
  aborted: boolean;
}

/** [ssog-24] per-file byte callbacks `fetchFile` reports into a unit record */
interface FetchSink {
  onLength?: (bytes: number) => void;
  onBytes?: (delta: number) => void;
  /** file settled; delta = its WIRE size (0 for an HTTP-cache hit) */
  onWire?: (delta: number) => void;
  /** file finished; hadLength = a Content-Length header was seen */
  onEnd?: (total: number, hadLength: boolean) => void;
}

/** a unit's meta + plane bytes, whichever shape they were fetched in */
interface FetchedUnit {
  json: PcSogsJson | PcSogsV2Json;
  files: Record<string, ArrayBuffer>;
}

/** bytes-per-unit memory for the wasted-bytes estimate (bounded) */
const UNIT_BYTES_MAX = 4096;

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
  private units: Map<number, UnitRecord> = new Map();

  /**
   * [ssog-24] unit → bytes received for a COMPLETED unit download, kept
   * beyond the decode LRU so the controller can price an evicted page
   * (bytes / blocks) long after the decode was dropped. Bounded FIFO.
   */
  private unitBytesMap: Map<number, number> = new Map();

  /** [ssog-24] monotonic UnitRecord id source (see UnitRecord.id) */
  private recordSeq = 0;

  /**
   * [ssog-27] unit → {strikes, until(ms)}: after a non-abort failure the unit
   * is refused for min(300 s, 2^(strikes+1) s). The pager treats every
   * non-abort rejection as transient (warn, short backoff, re-issue) and the
   * failed record is dropped, so without this a permanently bad unit would
   * be re-downloaded whole every ~0.5 s; a dead unit now costs zero network
   * after the 3rd attempt and shows up in `fetchRefused` / `unitStrikes`.
   */
  private unitFailures: Map<number, { strikes: number; until: number }> =
    new Map();

  /** counters for the HUD/harness (all cumulative since construction) */
  stats = {
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
    fetchRefused: 0,
  };

  /**
   * [ssog-22 fix] shared SH palettes, keyed by relative path. The build writes
   * ONE PALETTE PER LEVEL ("palette/L<n>/shN_centroids.webp"; each unit's
   * meta.json names its own level's file), and a camera pose streams units of
   * SEVERAL levels at once — so this is a map with one entry per level (a
   * handful, bounded by the level count), not a single memo slot. A single
   * slot thrashed: every level alternation re-downloaded the ~1 MB centroids
   * image, silently adding transfer to every pose. A failed fetch evicts its
   * own key so the next unit retries; `clear()` drops them all. NEVER aborted
   * — every unit of a level shares its palette.
   */
  private palettes: Map<string, Promise<ArrayBuffer>> = new Map();

  private getPalette(rel: string): Promise<ArrayBuffer> {
    const existing = this.palettes.get(rel);
    if (existing) {
      return existing;
    }
    this.stats.paletteFetches += 1;
    const promise = this.fetchFile(rel);
    promise.catch(() => {
      // a failed palette fetch must not poison the scene — the next unit retries
      if (this.palettes.get(rel) === promise) {
        this.palettes.delete(rel);
      }
    });
    this.palettes.set(rel, promise);
    return promise;
  }

  constructor(options: SsogUnitCacheOptions) {
    this.model = options.model;
    this.baseUrl = options.baseUrl ?? "";
    this.withCredentials = options.withCredentials ?? false;
    this.maxUnits = Math.max(1, options.maxUnits ?? 3);
    this.splatEncoding =
      options.splatEncoding ?? defines.DEFAULT_SPLAT_ENCODING;
    this.resolver =
      options.resolveUrl ?? ((relativePath) => this.baseUrl + relativePath);
    prepareTimingBuffer();
  }

  /**
   * Memoized unit decode. Blocks of one unit share a single fetch+decode.
   * [ssog-24] Every call on an IN-FLIGHT record registers one waiter; pair
   * it with `release(unit)` if the caller stops wanting the unit before it
   * settles (settled records ignore waiters).
   */
  getUnit(unit: number): Promise<SsogDecodedUnit> {
    const existing = this.units.get(unit);
    if (existing) {
      // LRU touch: re-insert at map tail
      this.units.delete(unit);
      this.units.set(unit, existing);
      if (!existing.settled) {
        existing.waiters += 1;
      }
      return existing.promise;
    }

    // [ssog-27] cool-down after repeated failures: refuse without a request
    const failure = this.unitFailures.get(unit);
    if (failure && performance.now() < failure.until) {
      this.stats.fetchRefused += 1;
      return Promise.reject(
        new Error(
          `ssog unit ${this.model.unitDirName(unit)}: refused for ${Math.ceil((failure.until - performance.now()) / 1000)} s after ${failure.strikes} failed attempt(s)`,
        ),
      );
    }

    const record: UnitRecord = {
      id: ++this.recordSeq,
      promise: undefined as unknown as Promise<SsogDecodedUnit>,
      settled: false,
      controller: new AbortController(),
      waiters: 1,
      received: 0,
      receivedWire: 0,
      expected: 0,
      filesTotal: 0,
      filesWithLength: 0,
      fetchDone: false,
      aborted: false,
    };
    record.promise = this.fetchDecodeUnit(unit, record).then(
      (decoded) => {
        record.settled = true;
        // [ssog-24 r4] wire, not decoded: see UnitRecord.receivedWire
        this.rememberUnitBytes(unit, record.receivedWire);
        // [ssog-27] a success clears the unit's strike history
        this.unitFailures.delete(unit);
        return decoded;
      },
      (error) => {
        // failed decode must not poison the cache — allow retry
        if (this.units.get(unit) === record) {
          this.units.delete(unit);
        }
        // [ssog-24] an abort is a deliberate cancel, not a fetch error
        if (!record.aborted && !isAbortError(error)) {
          this.stats.fetchErrors += 1;
          // [ssog-27] strike + exponential cool-down (4, 8, 16 … 300 s)
          if (error instanceof SsogUnitPackError) {
            this.stats.packErrors += 1;
          }
          const strikes = (this.unitFailures.get(unit)?.strikes ?? 0) + 1;
          this.stats.unitStrikes += 1;
          this.unitFailures.set(unit, {
            strikes,
            until: performance.now() + 1000 * Math.min(300, 2 ** (strikes + 1)),
          });
        }
        throw error;
      },
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
  release(unit: number) {
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
    // [ssog-24 fix E] EXACT when every file size of the record is already
    // known (same condition unitProgress uses), otherwise 0 into the exact
    // counter and a history-based estimate into the modelled one.
    const sizeKnown =
      record.filesTotal > 0 &&
      record.filesWithLength >= record.filesTotal &&
      record.expected > 0;
    const exact = Math.max(0, record.expected - record.received);
    this.stats.cancelSavedBytes += sizeKnown ? exact : 0;
    if (sizeKnown) {
      this.stats.cancelSavedEstimateBytes += exact;
    } else {
      const perSplat = this.bytesPerSplat();
      const splats = this.model.unitSplats[unit] ?? 0;
      const predicted =
        perSplat !== undefined && splats > 0 ? perSplat * splats : 0;
      this.stats.cancelSavedEstimateBytes += Math.max(
        0,
        predicted - record.received,
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
  unitRecordId(unit: number): number | undefined {
    const record = this.units.get(unit);
    return record && !record.settled ? record.id : undefined;
  }

  /**
   * [ssog-24] Re-lease an IN-FLIGHT unit whose waiter this caller previously
   * dropped (the pager's chunk became wanted again before its cancelled
   * fetcher rejected). Returns true when a waiter was added — pair it with
   * a later `release(unit)`. Returns false when the record is gone, settled
   * or already aborted, or when `id` names a different record: the caller
   * then stays cancelled and its chunk restarts through the normal path.
   */
  retain(unit: number, id?: number): boolean {
    const record = this.units.get(unit);
    if (!record || record.settled || record.aborted) {
      return false;
    }
    if (id !== undefined && record.id !== id) {
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
  unitProgress(unit: number): number | null {
    const record = this.units.get(unit);
    if (!record) {
      return null;
    }
    if (record.settled || record.fetchDone) {
      return 1;
    }
    // filesTotal 0 = meta.json not parsed yet, so the plane files are pending
    // with unknown sizes; any started file without a known size is the same.
    if (
      record.filesTotal <= 0 ||
      record.filesWithLength < record.filesTotal ||
      record.expected <= 0
    ) {
      return null;
    }
    return Math.min(1, record.received / record.expected);
  }

  /** [ssog-24] bytes received for a COMPLETED unit download, if remembered */
  unitBytes(unit: number): number | undefined {
    return this.unitBytesMap.get(unit);
  }

  /**
   * [ssog-24 fix E] Estimator behind cancelSavedEstimateBytes: a running mean
   * of bytes-per-splat over COMPLETED unit downloads, in the same units as
   * `record.received` (body bytes), so mean × unitSplats[unit] − received is
   * the modelled remainder an abort saved.
   */
  private completedBytes = 0;
  private completedSplats = 0;

  /** mean bytes per splat so far, or undefined until one unit has completed */
  private bytesPerSplat(): number | undefined {
    return this.completedSplats > 0
      ? this.completedBytes / this.completedSplats
      : undefined;
  }

  private rememberUnitBytes(unit: number, bytes: number) {
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
  private async fetchFile(
    relativePath: string,
    signal?: AbortSignal,
    sink?: FetchSink,
  ): Promise<ArrayBuffer> {
    const resolved = await this.resolver(relativePath);
    if (signal?.aborted) {
      throw abortError();
    }
    const url = typeof resolved === "string" ? resolved : resolved.url;
    const headers =
      typeof resolved === "string" ? undefined : resolved.headers;
    const request = new Request(url, {
      headers: headers ? new Headers(headers) : undefined,
      credentials: this.withCredentials ? "include" : "same-origin",
    });
    this.stats.fetches += 1;
    // [ssog-24 fix D] mark the wall clock so the resource-timing lookup below
    // picks THIS request's entry, not an earlier fetch of the same URL.
    const startedAt =
      typeof performance !== "undefined" ? performance.now() : 0;
    const response = await fetch(request, signal ? { signal } : undefined);
    if (!response.ok || !response.body) {
      throw new Error(
        `Failed to fetch "${url}": ${response.status} ${response.statusText}`,
      );
    }
    const lengthHeader = response.headers.get("content-length");
    // [ssog-24 r4] A content-encoded response declares its COMPRESSED length
    // while the reader below counts DECODED bytes. Feeding that length into
    // `expected` would put the two halves of `expected - received` in different
    // units (understating the exact cancel saving and reading progress high),
    // so an encoded response counts as length-UNKNOWN and `onEnd` supplies its
    // true decoded size when it completes. This tier gzips every unit
    // meta.json, so the case is the rule here, not an edge case.
    const encodingHeader = (response.headers.get("content-encoding") ?? "")
      .trim()
      .toLowerCase();
    const encoded = encodingHeader !== "" && encodingHeader !== "identity";
    let hadLength = false;
    if (lengthHeader !== null && !encoded) {
      const length = Number.parseInt(lengthHeader, 10);
      if (Number.isFinite(length) && length >= 0) {
        hadLength = true;
        sink?.onLength?.(length);
      }
    }
    if (!hadLength) {
      this.stats.filesWithoutLength += 1;
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
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
          sink?.onBytes?.(value.byteLength);
        }
      }
    } catch (error) {
      // aborted or torn mid-body: no usable timing entry, so the partial body
      // sum is the only wire figure available.
      this.stats.bytesReceived += total;
      sink?.onWire?.(total);
      throw error;
    }
    // [ssog-24 r4] The PerformanceResourceTiming entry is added by a TASK queued
    // when the response completes, so a lookup in the same turn as the last
    // reader.read() usually races it and finds nothing (measured: 25 of 32 files
    // on the local harness fell back to the body sum). Give the entry one task
    // to land before giving up — the retry costs a macrotask only on a miss, and
    // the fetchers run in parallel so it is off the critical path.
    let wire = wireSize(url, startedAt, total);
    if (!wire.known) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      wire = wireSize(url, startedAt, total);
    }
    this.stats.bytesReceived += wire.bytes;
    if (!wire.known) {
      this.stats.filesWithoutWireSize += 1;
    }
    sink?.onWire?.(wire.bytes);
    sink?.onEnd?.(total, hadLength);
    if (
      chunks.length === 1 &&
      chunks[0].byteOffset === 0 &&
      chunks[0].byteLength === chunks[0].buffer.byteLength
    ) {
      return chunks[0].buffer as ArrayBuffer;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out.buffer;
  }

  private async fetchDecodeUnit(
    unit: number,
    record: UnitRecord,
  ): Promise<SsogDecodedUnit> {
    const signal = record.controller.signal;
    // [ssog-24] size bookkeeping for unitProgress. A file counts as "known"
    // when its Content-Length header arrives OR when it completes (its final
    // size is then a fact, not an estimate) — so a chunked/gzip'd file makes
    // the unit blind only while it is actually on the wire.
    const sink = {
      onLength: (bytes: number) => {
        record.expected += bytes;
        record.filesWithLength += 1;
      },
      onBytes: (delta: number) => {
        record.received += delta;
      },
      onWire: (delta: number) => {
        record.receivedWire += delta;
      },
      onEnd: (total: number, hadLength: boolean) => {
        if (!hadLength) {
          record.expected += total;
          record.filesWithLength += 1;
        }
      },
    };
    const dir = this.model.unitDirName(unit);
    // [ssog-27] the manifest stamp decides the shape; the decode is shared
    const { json, files } =
      this.model.unitPack === 1
        ? await this.fetchPackedUnit(unit, dir, record, signal, sink)
        : await this.fetchClassicUnit(dir, record, signal, sink);
    return this.decodeFetchedUnit(unit, dir, json, files, signal);
  }

  /**
   * Classic loose files: meta.json first (the plane list lives in it), then
   * every plane in parallel under the unit's abort signal.
   */
  private async fetchClassicUnit(
    dir: string,
    record: UnitRecord,
    signal: AbortSignal,
    sink: FetchSink,
  ): Promise<FetchedUnit> {
    const metaBytes = await this.fetchFile(`${dir}/meta.json`, signal, sink);
    const json = JSON.parse(
      new TextDecoder().decode(metaBytes),
    ) as PcSogsJson | PcSogsV2Json;

    const names = planeNames(json);
    // the plane list is known only now: until this line unitProgress has to
    // report null (filesTotal 0), whatever meta.json's own length said.
    record.filesTotal = 1 + names.length;
    const files: Record<string, ArrayBuffer> = {};
    await Promise.all(
      names.map(async (name) => {
        files[name] = await this.fetchFile(`${dir}/${name}`, signal, sink);
      }),
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
  private async fetchPackedUnit(
    unit: number,
    dir: string,
    record: UnitRecord,
    signal: AbortSignal,
    sink: FetchSink,
  ): Promise<FetchedUnit> {
    record.filesTotal = 1;
    const buf = await this.fetchFile(
      `${dir}/${SSOG_UNIT_PACK_FILE}`,
      signal,
      sink,
    );
    // nothing left to save by aborting; the parse below is synchronous
    record.fetchDone = true;
    const label = `ssog unit ${dir}`;
    const pack = parseUnitPack(buf, label); // throws SsogUnitPackError with the reason
    const rows = this.model.unitSplats[unit];
    // pre-decode gate: header count vs the model-derived per-unit count
    if (pack.count !== rows) {
      throw new SsogUnitPackError(
        label,
        `header count ${pack.count}, model derives ${rows}`,
      );
    }
    // a container whose meta inflates but is not JSON is a CONTAINER defect
    // (packErrors), same reason string as the packer's readUnitPack
    const metaText = new TextDecoder().decode(
      readUnitPackMeta(buf, pack, label),
    );
    let json: PcSogsJson | PcSogsV2Json;
    try {
      json = JSON.parse(metaText) as PcSogsJson | PcSogsV2Json;
    } catch (e) {
      throw new SsogUnitPackError(
        label,
        `meta.json is not valid JSON: ${(e as Error).message}`,
      );
    }
    if ((json as PcSogsV2Json).count !== rows) {
      throw new SsogUnitPackError(
        label,
        `meta count ${(json as PcSogsV2Json).count}, model derives ${rows}`,
      );
    }
    const names = planeNames(json);
    if (pack.members.size !== names.length + 1) {
      throw new SsogUnitPackError(
        label,
        `${pack.members.size - 1} plane members, meta lists ${names.length}`,
      );
    }
    const files: Record<string, ArrayBuffer> = {};
    for (const name of names) {
      const m = pack.members.get(name);
      if (!m || m.deflate) {
        throw new SsogUnitPackError(
          label,
          `plane ${name} missing from container or compressed`,
        );
      }
      // one standalone ArrayBuffer per plane: the worker pool TRANSFERS every
      // buffer in the call args and getTransferable dedups VIEWS, not buffers
      files[name] = buf.slice(m.offset, m.offset + m.length);
    }
    this.stats.packedFetches += 1;
    return { json, files };
  }

  /** shared tail of both shapes: palette memo → worker decode → P0b count gate */
  private async decodeFetchedUnit(
    unit: number,
    dir: string,
    json: PcSogsJson | PcSogsV2Json,
    files: Record<string, ArrayBuffer>,
    signal: AbortSignal,
  ): Promise<SsogDecodedUnit> {
    // [ssog-22] units written against the scene palette carry labels only and
    // name the shared centroids file (relative to the ssog root). The worker
    // pool TRANSFERS every ArrayBuffer in the call args, so hand over a COPY of
    // the palette bytes; the worker memoizes the decoded image by key, so the
    // per-unit cost is one ~1 MB copy, not a decode. [ssog-24] The palette
    // fetch is shared across units and takes NO abort signal.
    const paletteRel = (json as PcSogsV2Json).shN?.palette;
    let palette: { key: string; bytes: ArrayBuffer } | undefined;
    if (paletteRel) {
      const bytes = await this.getPalette(paletteRel);
      palette = { key: paletteRel, bytes: bytes.slice(0) };
    }
    if (signal.aborted) {
      throw abortError();
    }

    this.stats.decodes += 1;
    const decoded = (await workerPool.withWorker(async (worker) =>
      worker.call("unpackSsogUnit", {
        json,
        files,
        encoding: this.splatEncoding,
        palette,
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

function abortError(): Error {
  return new DOMException("ssog unit fetch aborted", "AbortError");
}

/**
 * [ssog-24 r4] The resource-timing buffer holds 250 entries by default, and
 * `performance.getEntriesByName` returns nothing once it overflows — on a
 * 20M-splat tour (thousands of unit files) every later lookup would silently
 * fall back to the decoded body sum, which is exactly the over-count the wire
 * measurement exists to remove. Raise the buffer once per document and drop
 * consumed entries when it fills; a lookup happens microseconds after its own
 * entry is created, so clearing costs at most a handful of measurements
 * (which are then counted in `filesWithoutWireSize`, never hidden).
 */
let timingBufferPrepared = false;

function prepareTimingBuffer() {
  if (timingBufferPrepared || typeof performance === "undefined") {
    return;
  }
  timingBufferPrepared = true;
  try {
    performance.setResourceTimingBufferSize?.(20000);
    performance.addEventListener?.("resourcetimingbufferfull", () => {
      try {
        performance.clearResourceTimings?.();
      } catch {
        // a browser without the API keeps the default buffer; the fallback
        // path below stays correct, only less precise
      }
    });
  } catch {
    // Safari/older engines: leave the buffer alone
  }
}

/**
 * [ssog-24 fix D] True octets on the wire for a settled response.
 * PerformanceResourceTiming.transferSize is the compressed, header-inclusive
 * transfer — and exactly 0 for an HTTP-cache hit, which is the honest answer
 * the summed body bytes cannot give. It is withheld on a cross-origin
 * response without a Timing-Allow-Origin header, where it also reads 0. The
 * two 0s are told apart by `encodedBodySize`: a cache hit still reports the
 * body size, a TAO-less response reports 0 there too — so only the former is
 * trusted as a real 0 and the latter falls back to the (conservative, higher)
 * body sum. The server emits Timing-Allow-Origin on both splat routes; the
 * CDN may not carry it, so the fallback must stay.
 *
 * `known` says whether the returned figure is a MEASUREMENT (true) or the
 * body-sum fallback (false) — the caller tallies the fallbacks so a blind
 * measurement can never be mistaken for a small one.
 */
function wireSize(
  url: string,
  startedAt: number,
  bodyBytes: number,
): { bytes: number; known: boolean } {
  const fallback = { bytes: bodyBytes, known: false };
  try {
    if (typeof performance === "undefined" || !performance.getEntriesByName) {
      return fallback;
    }
    const name =
      typeof location !== "undefined" ? new URL(url, location.href).href : url;
    const entries = performance.getEntriesByName(
      name,
      "resource",
    ) as PerformanceResourceTiming[];
    let entry: PerformanceResourceTiming | undefined;
    for (let i = entries.length - 1; i >= 0; i--) {
      // the LAST entry started at-or-after this fetch began is this request's
      // (the same URL may have been fetched before, e.g. a retried unit file)
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
      // cache hit (true 0) or TAO-less cross-origin (withheld): keep the
      // conservative body figure — the CDN may never carry the header.
      return entry.encodedBodySize > 0
        ? { bytes: 0, known: true }
        : fallback;
    }
    return { bytes: transferred, known: true };
  } catch {
    return fallback;
  }
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

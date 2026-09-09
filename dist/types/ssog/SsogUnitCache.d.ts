import { SplatEncoding } from '../defines';
import { SsogModel } from './SsogModel';
export type SsogResolvedUrl = string | {
    url: string;
    headers?: Record<string, string>;
};
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
export declare class SsogUnitCache {
    readonly model: SsogModel;
    readonly baseUrl: string;
    readonly withCredentials: boolean;
    readonly maxUnits: number;
    readonly splatEncoding: SplatEncoding;
    private readonly resolver;
    /** unit → in-flight-or-settled decode; insertion order refreshed on touch */
    private units;
    /**
     * [ssog-24] unit → bytes received for a COMPLETED unit download, kept
     * beyond the decode LRU so the controller can price an evicted page
     * (bytes / blocks) long after the decode was dropped. Bounded FIFO.
     */
    private unitBytesMap;
    /** [ssog-24] monotonic UnitRecord id source (see UnitRecord.id) */
    private recordSeq;
    /**
     * [ssog-27] unit → {strikes, until(ms)}: after a non-abort failure the unit
     * is refused for min(300 s, 2^(strikes+1) s). The pager treats every
     * non-abort rejection as transient (warn, short backoff, re-issue) and the
     * failed record is dropped, so without this a permanently bad unit would
     * be re-downloaded whole every ~0.5 s; a dead unit now costs zero network
     * after the 3rd attempt and shows up in `fetchRefused` / `unitStrikes`.
     */
    private unitFailures;
    /** counters for the HUD/harness (all cumulative since construction) */
    stats: {
        fetches: number;
        decodes: number;
        evictions: number;
        fetchErrors: number;
        /** [ssog-24] unit downloads aborted (no in-flight chunk still wanted) */
        fetchCancels: number;
        /**
         * [ssog-24] EXACT saving: Σ over aborted units of (known size − received),
         * counted ONLY for units whose every file size was already known at abort
         * time. Never estimated into — see cancelSavedEstimateBytes.
         */
        cancelSavedBytes: number;
        /**
         * [ssog-24 fix E] Modelled saving, superset of cancelSavedBytes: when a
         * unit is aborted before its sizes are known (the common case — admitted
         * cancels happen early, before Content-Length headers exist, which is why
         * the exact counter reads 0 on a whole soak), the unit's total is
         * estimated as (running mean bytes-per-splat over COMPLETED units) ×
         * model.unitSplats[unit], minus what already arrived, clamped at ≥ 0.
         */
        cancelSavedEstimateBytes: number;
        /**
         * [ssog-24 fix D] WIRE bytes: PerformanceResourceTiming.transferSize per
         * file (0 on an HTTP-cache hit, compressed octets otherwise), falling back
         * to the decoded body sum when no timing entry exists or transferSize is 0
         * while bytes were read (a cross-origin response exposes transferSize only
         * under Timing-Allow-Origin, which the CDN may not carry).
         */
        bytesReceived: number;
        /**
         * [ssog-24 fix D] DECODED bytes read out of the response bodies — what
         * bytesReceived used to hold. Post-gunzip, and counted in full even for a
         * response served entirely from the HTTP cache, so it measures decode
         * volume, NOT network transfer.
         */
        decodedBytesReceived: number;
        /**
         * [ssog-22 fix] shared SH palette files actually fetched. The build writes
         * one per level, so this should settle at the number of DISTINCT levels
         * the session touched; anything higher means the per-path memo is
         * thrashing and the ~1 MB centroids image is being re-downloaded.
         */
        paletteFetches: number;
        /**
         * [ssog-24] responses that carried NO Content-Length (gzip'd meta.json is
         * chunked). While such a file is in flight the unit's progress is
         * unknowable, so unitProgress reports null and the pager treats the
         * transfer as cancellable. A large value here means the byte-progress
         * lever is measuring blind, not that there is nothing to save.
         */
        filesWithoutLength: number;
        /**
         * [ssog-24 r4] settled files whose true wire size could not be read, so
         * the (higher) decoded body sum was billed instead: no PerformanceResource
         * Timing entry, or a cross-origin response without Timing-Allow-Origin.
         * bytesReceived is an OVER-estimate by exactly these files' compression
         * savings — a large value means the wire measurement is not working.
         */
        filesWithoutWireSize: number;
        /** [ssog-27] units loaded through the ONE-file container path */
        packedFetches: number;
        /** [ssog-27] containers rejected (magic/version/table/count/member set) — each also counts in fetchErrors */
        packErrors: number;
        /** [ssog-27] non-abort unit failures (network, container, decode); drives the per-unit cool-down */
        unitStrikes: number;
        /** [ssog-27] getUnit calls refused during a unit's cool-down (no request made) */
        fetchRefused: number;
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
    private palettes;
    private getPalette;
    constructor(options: SsogUnitCacheOptions);
    /**
     * Memoized unit decode. Blocks of one unit share a single fetch+decode.
     * [ssog-24] Every call on an IN-FLIGHT record registers one waiter; pair
     * it with `release(unit)` if the caller stops wanting the unit before it
     * settles (settled records ignore waiters).
     */
    getUnit(unit: number): Promise<SsogDecodedUnit>;
    /**
     * [ssog-24] Drop one waiter of an IN-FLIGHT unit. When the last waiter
     * leaves while bytes are still on the wire, the unit's downloads are
     * aborted, the record is removed (a later getUnit re-fetches cleanly) and
     * the saved bytes are accounted. A unit whose files have all arrived is
     * left to finish its decode — nothing is saved by aborting it, and the
     * settled decode stays useful in the LRU.
     */
    release(unit: number): void;
    /**
     * [ssog-24] Identity of the CURRENT in-flight record of a unit, or
     * undefined when there is none (settled records are not leasable). Pair it
     * with `retain(unit, id)` across a cancel so a re-lease can tell "the
     * record I was awaiting" from "a new download of the same unit".
     */
    unitRecordId(unit: number): number | undefined;
    /**
     * [ssog-24] Re-lease an IN-FLIGHT unit whose waiter this caller previously
     * dropped (the pager's chunk became wanted again before its cancelled
     * fetcher rejected). Returns true when a waiter was added — pair it with
     * a later `release(unit)`. Returns false when the record is gone, settled
     * or already aborted, or when `id` names a different record: the caller
     * then stays cancelled and its chunk restarts through the normal path.
     */
    retain(unit: number, id?: number): boolean;
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
    unitProgress(unit: number): number | null;
    /** [ssog-24] bytes received for a COMPLETED unit download, if remembered */
    unitBytes(unit: number): number | undefined;
    /**
     * [ssog-24 fix E] Estimator behind cancelSavedEstimateBytes: a running mean
     * of bytes-per-splat over COMPLETED unit downloads, in the same units as
     * `record.received` (body bytes), so mean × unitSplats[unit] − received is
     * the modelled remainder an abort saved.
     */
    private completedBytes;
    private completedSplats;
    /** mean bytes per splat so far, or undefined until one unit has completed */
    private bytesPerSplat;
    private rememberUnitBytes;
    /** Drop settled entries beyond maxUnits, oldest-touched first. */
    private evictOverflow;
    clear(): void;
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
    private fetchFile;
    private fetchDecodeUnit;
    /**
     * Classic loose files: meta.json first (the plane list lives in it), then
     * every plane in parallel under the unit's abort signal.
     */
    private fetchClassicUnit;
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
    private fetchPackedUnit;
    /** shared tail of both shapes: palette memo → worker decode → P0b count gate */
    private decodeFetchedUnit;
}

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
    /** counters for the HUD/harness */
    stats: {
        fetches: number;
        decodes: number;
        evictions: number;
        fetchErrors: number;
    };
    constructor(options: SsogUnitCacheOptions);
    /** Memoized unit decode. Blocks of one unit share a single fetch+decode. */
    getUnit(unit: number): Promise<SsogDecodedUnit>;
    /** Drop settled entries beyond maxUnits, oldest-touched first. */
    private evictOverflow;
    clear(): void;
    private fetchFile;
    private fetchDecodeUnit;
}

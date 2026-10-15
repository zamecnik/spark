import { PackedSplats, SplatMesh } from '../index.ts';
import { SplatEncoding } from '../defines';
import { SogMeta } from './sogMeta';
export declare const FULL_DETAIL_VERSION = "full-1";
export type FullDetailErrorCode = "fetch" | "bytes" | "zip" | "meta" | "decode" | "pack" | "alloc" | "worker" | "cancel" | "forkversion";
export declare class FullDetailError extends Error {
    readonly code: FullDetailErrorCode;
    readonly cause?: unknown;
    constructor(code: FullDetailErrorCode, message: string, cause?: unknown);
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
    perPlane: Record<string, {
        bytes: number;
        decodeMs: number;
        readMs: number;
    }>;
};
export type FullDetailResult = {
    /** centerOrigin = kcOrigin + packOrigin (null when both are zero) */
    packedSplats: PackedSplats;
    meta: SogMeta;
    numSplats: number;
    /** FILE frame (kcOrigin added back) - what mesh.matrixWorld maps to world */
    bounds: {
        min: [number, number, number];
        max: [number, number, number];
    };
    /**
     * [prec-1] the RUNTIME part of the centre origin (o_rel: the rounded
     * per-axis median the tables subtracted), null when zero or disabled.
     * Diagnostics; the full origin is packedSplats.centerOrigin.
     */
    packOrigin: [number, number, number] | null;
    stats: FullDetailStats;
};
export declare function loadFullDetailSog(options: FullDetailOptions): Promise<FullDetailResult>;
/** The ordinary static mesh over the loaded splats; the app adds it to the scene. */
export declare function createFullDetailMesh(result: FullDetailResult, options?: {
    maxSh?: number;
}): SplatMesh;

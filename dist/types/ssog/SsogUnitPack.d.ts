import { PcSogsJson, PcSogsV2Json } from '../SplatLoader';
/** container file name inside the unit dir — a pinned constant, NOT carried in the stamp */
export declare const SSOG_UNIT_PACK_FILE = "unit.bin";
/** the only container version this reader accepts */
export declare const SSOG_UNIT_PACK_VERSION = 1;
/** member alphabet = the classic loose file names of a unit (never unit.bin itself) */
export declare const SSOG_UNIT_PACK_MEMBER_NAMES: ReadonlySet<string>;
export interface UnitPackMember {
    name: string;
    /** absolute byte offset of the stored member */
    offset: number;
    /** stored bytes */
    length: number;
    /** decoded bytes (== length unless deflate) */
    rawLength: number;
    /** stored as raw DEFLATE (RFC 1951, no zlib/gzip wrapper) — v1: entry 0 only */
    deflate: boolean;
}
export interface UnitPackIndex {
    /** header count = splat rows of the unit; the caller checks it against the model */
    count: number;
    fileLength: number;
    /** members in directory order (entry 0 = meta.json) */
    members: Map<string, UnitPackMember>;
}
/** any integrity violation of a container; `reason` names the failed check */
export declare class SsogUnitPackError extends Error {
    readonly reason: string;
    constructor(label: string, reason: string);
}
/**
 * Parse + verify the header and directory of a SOGU v1 container (checks
 * 1–5 of the format contract: header fields, payloadOffset/fileLength,
 * names, entry geometry, meta.json bound). Pure DataView reads — no member
 * is decoded here. Throws `SsogUnitPackError(label, reason)` on the first
 * violation; `label` prefixes the message (e.g. "ssog unit 3_12").
 */
export declare function parseUnitPack(buf: ArrayBuffer, label: string): UnitPackIndex;
/**
 * Bytes of entry 0 (meta.json): a view into `buf` when stored identity, else
 * the fflate `inflateSync` output, which MUST be exactly `rawLength` bytes.
 */
export declare function readUnitPackMeta(buf: ArrayBuffer, index: UnitPackIndex, label: string): Uint8Array;
/**
 * Plane file names of a unit in the runtime's order (means, scales, quats,
 * sh0, shN) — the classic fetch list and the packed member order alike.
 */
export declare function planeNames(json: PcSogsJson | PcSogsV2Json): string[];

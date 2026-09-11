export type SogZipEntry = {
    name: string;
    /** Absolute offset of the entry's DATA (after the local header). */
    dataOffset: number;
    size: number;
    crc32: number;
    /** Absolute offset of the local file header. */
    headerOffset: number;
};
export type SogZipIndex = {
    entries: SogZipEntry[];
    byName: Map<string, SogZipEntry>;
    /** Offset of the central directory (= end of the last entry's data + descriptor). */
    centralDirectoryOffset: number;
};
export declare class SogZipError extends Error {
    readonly code: "no-eocd" | "zip64" | "deflated" | "bad-header" | "bad-riff" | "bad-descriptor" | "cd-mismatch" | "truncated";
    constructor(code: SogZipError["code"], message: string);
}
/**
 * Tail-first index of a fully buffered `scene.sog`. Throws on Zip64, on any
 * compressed entry, on a missing EOCD, and when a local header disagrees
 * with the central directory.
 */
export declare function indexSogZip(bytes: Uint8Array): SogZipIndex;
/** Zero-copy views of every entry of an indexed, fully buffered archive. */
export declare function sliceSogEntries(bytes: Uint8Array, index: SogZipIndex): Map<string, Uint8Array>;
/** The plane (or manifest) an emitted entry carries, with its bytes. */
export type SogWalkedEntry = {
    name: string;
    bytes: Uint8Array;
    /** Entry length, recorded at emit time: `bytes` may be TRANSFERRED to a
     * worker (and detached, length 0) by the time the tail is cross-checked. */
    size: number;
    headerOffset: number;
    dataOffset: number;
    /** crc32 from the data descriptor / local header (not verified here). */
    crc32: number;
};
/**
 * Push-based STORED-zip walker. Call `push()` with each chunk in order,
 * `finish()` after the last one. `onEntry` fires as soon as an entry's bytes
 * are complete (during the download for every plane but the last).
 *
 * Bytes are copied exactly once, into the entry's own buffer, allocated at
 * its known length; only header/descriptor scraps and the tail (central
 * directory + EOCD, a few hundred bytes) are queued.
 */
export declare class SogStreamWalker {
    private readonly onEntry;
    private queue;
    private queued;
    /** Absolute file offset of the first queued byte. */
    private offset;
    private state;
    private finished;
    private name;
    private headerOffset;
    private dataOffset;
    private hasDescriptor;
    private headerCrc;
    private target;
    private written;
    private scanParts;
    private scanLength;
    readonly walked: SogWalkedEntry[];
    private tail;
    private tailOffset;
    constructor(onEntry: (entry: SogWalkedEntry) => void);
    get bytesConsumed(): number;
    push(chunk: Uint8Array): void;
    /** Parse the tail (central directory + EOCD) and cross-check the walk. */
    finish(): SogZipIndex;
    /** Materialise the next n queued bytes without consuming them. */
    private peek;
    private drop;
    /** Copy up to n queued bytes into target at `written`, consuming them. */
    private copyInto;
    private process;
    private emit;
}

// Kroscloud fork (2026) — see FORK-CHANGES.md [full-1].
//
// ZIP container handling for a plain `scene.sog` (SOG v2 as written by
// splat-transform 3.x and the Viewme build worker): every entry is STORED,
// the local headers carry no sizes (flag bit 3, a 16-byte data descriptor
// follows each entry), and `meta.json` is the LAST entry. Pure: no I/O, no
// three, Node-testable.
//
// Two ways in:
//   - `SogStreamWalker`: push-based. Feed the response chunks as they
//     arrive; complete entries are emitted while the download is still
//     running, so each WebP plane can be decoded in a worker while the next
//     one is still on the wire, and nothing ever holds the whole 271 MB
//     file. Entry length comes from the RIFF header of each WebP (size + 8,
//     verified against the descriptor's csize); `meta.json` (no RIFF) ends
//     at its descriptor signature, which JSON text cannot contain.
//   - `indexSogZip`: the classic tail-first parse (EOCD -> central
//     directory -> local headers) over a fully buffered file. The fallback,
//     the cross-check the walker runs at the end, and the unit-test oracle.

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

export class SogZipError extends Error {
  readonly code:
    | "no-eocd"
    | "zip64"
    | "deflated"
    | "bad-header"
    | "bad-riff"
    | "bad-descriptor"
    | "cd-mismatch"
    | "truncated";
  constructor(code: SogZipError["code"], message: string) {
    super(message);
    this.name = "SogZipError";
    this.code = code;
  }
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_DESCRIPTOR = 0x08074b50;
const FLAG_DESCRIPTOR = 0x0008;

const utf8 = new TextDecoder("utf-8");

function u16(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}
function u32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

/**
 * Tail-first index of a fully buffered `scene.sog`. Throws on Zip64, on any
 * compressed entry, on a missing EOCD, and when a local header disagrees
 * with the central directory.
 */
export function indexSogZip(bytes: Uint8Array): SogZipIndex {
  const n = bytes.length;
  // EOCD: 22 bytes + comment (<= 65535); scan backwards over the last 64 KiB
  const minEocd = Math.max(0, n - 22 - 65535);
  let eocd = -1;
  for (let i = n - 22; i >= minEocd; --i) {
    if (u32(bytes, i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new SogZipError("no-eocd", "end of central directory record not found");
  }
  if (eocd >= 20 && u32(bytes, eocd - 20) === SIG_EOCD64_LOC) {
    throw new SogZipError("zip64", "Zip64 archives are not supported");
  }
  const entryCount = u16(bytes, eocd + 10);
  const cdSize = u32(bytes, eocd + 12);
  const cdOffset = u32(bytes, eocd + 16);
  if (
    entryCount === 0xffff ||
    cdSize === 0xffffffff ||
    cdOffset === 0xffffffff
  ) {
    throw new SogZipError("zip64", "Zip64 field markers in the EOCD");
  }
  if (cdOffset + cdSize > eocd) {
    throw new SogZipError("truncated", "central directory extends past the EOCD");
  }

  const entries: SogZipEntry[] = [];
  let p = cdOffset;
  for (let k = 0; k < entryCount; ++k) {
    if (p + 46 > n || u32(bytes, p) !== SIG_CENTRAL) {
      throw new SogZipError("bad-header", `central directory entry ${k} is malformed`);
    }
    const method = u16(bytes, p + 10);
    const crc32 = u32(bytes, p + 16);
    const csize = u32(bytes, p + 20);
    const usize = u32(bytes, p + 24);
    const fnLen = u16(bytes, p + 28);
    const exLen = u16(bytes, p + 30);
    const cmLen = u16(bytes, p + 32);
    const headerOffset = u32(bytes, p + 42);
    const name = utf8.decode(bytes.subarray(p + 46, p + 46 + fnLen));
    if (method !== 0) {
      throw new SogZipError("deflated", `entry ${name} uses compression method ${method}`);
    }
    if (csize !== usize) {
      throw new SogZipError("bad-header", `entry ${name}: stored sizes differ (${csize} vs ${usize})`);
    }
    if (headerOffset + 30 > n || u32(bytes, headerOffset) !== SIG_LOCAL) {
      throw new SogZipError("bad-header", `entry ${name}: local header not at ${headerOffset}`);
    }
    const lfnLen = u16(bytes, headerOffset + 26);
    const lexLen = u16(bytes, headerOffset + 28);
    const dataOffset = headerOffset + 30 + lfnLen + lexLen;
    if (dataOffset + csize > n) {
      throw new SogZipError("truncated", `entry ${name}: data extends past the end of the file`);
    }
    entries.push({ name, dataOffset, size: csize, crc32, headerOffset });
    p += 46 + fnLen + exLen + cmLen;
  }
  const byName = new Map(entries.map((e) => [e.name, e]));
  return { entries, byName, centralDirectoryOffset: cdOffset };
}

/** Zero-copy views of every entry of an indexed, fully buffered archive. */
export function sliceSogEntries(
  bytes: Uint8Array,
  index: SogZipIndex,
): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const e of index.entries) {
    out.set(e.name, bytes.subarray(e.dataOffset, e.dataOffset + e.size));
  }
  return out;
}

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

type WalkerState =
  | "header"
  | "data-known"
  | "data-riff"
  | "data-scan"
  | "descriptor"
  | "tail";

/**
 * Push-based STORED-zip walker. Call `push()` with each chunk in order,
 * `finish()` after the last one. `onEntry` fires as soon as an entry's bytes
 * are complete (during the download for every plane but the last).
 *
 * Bytes are copied exactly once, into the entry's own buffer, allocated at
 * its known length; only header/descriptor scraps and the tail (central
 * directory + EOCD, a few hundred bytes) are queued.
 */
export class SogStreamWalker {
  private readonly onEntry: (entry: SogWalkedEntry) => void;
  private queue: Uint8Array[] = [];
  private queued = 0;
  /** Absolute file offset of the first queued byte. */
  private offset = 0;
  private state: WalkerState = "header";
  private finished = false;

  // current entry
  private name = "";
  private headerOffset = 0;
  private dataOffset = 0;
  private hasDescriptor = false;
  private headerCrc = 0;
  private target: Uint8Array | null = null;
  private written = 0;
  private scanParts: Uint8Array[] = [];
  private scanLength = 0;

  readonly walked: SogWalkedEntry[] = [];
  private tail: Uint8Array[] = [];
  private tailOffset = 0;

  constructor(onEntry: (entry: SogWalkedEntry) => void) {
    this.onEntry = onEntry;
  }

  get bytesConsumed(): number {
    return this.offset;
  }

  push(chunk: Uint8Array): void {
    if (this.finished) throw new SogZipError("bad-header", "push after finish");
    if (chunk.length === 0) return;
    if (this.state === "tail") {
      this.tail.push(chunk.slice());
      this.offset += chunk.length;
      return;
    }
    this.queue.push(chunk);
    this.queued += chunk.length;
    this.process();
  }

  /** Parse the tail (central directory + EOCD) and cross-check the walk. */
  finish(): SogZipIndex {
    if (this.finished) throw new SogZipError("bad-header", "finish called twice");
    this.finished = true;
    if (this.state !== "tail") {
      throw new SogZipError(
        "truncated",
        `stream ended in state ${this.state} at offset ${this.offset}` +
          (this.name ? ` inside entry ${this.name}` : ""),
      );
    }
    let total = 0;
    for (const t of this.tail) total += t.length;
    const tail = new Uint8Array(total);
    let o = 0;
    for (const t of this.tail) {
      tail.set(t, o);
      o += t.length;
    }
    // Build a virtual archive view: the central directory is parsed with its
    // absolute offsets, but we only hold the tail, so offset arithmetic is
    // done against tailOffset. Re-implementing the EOCD/CD parse here would
    // duplicate indexSogZip; instead, materialise a sparse buffer that maps
    // the tail at its true position and the local headers we recorded.
    const index = parseCentralDirectory(tail, this.tailOffset);
    // cross-check against the walk
    if (index.entries.length !== this.walked.length) {
      throw new SogZipError(
        "cd-mismatch",
        `central directory lists ${index.entries.length} entries, walked ${this.walked.length}`,
      );
    }
    for (let i = 0; i < index.entries.length; ++i) {
      const c = index.entries[i];
      const w = this.walked[i];
      if (
        c.name !== w.name ||
        c.headerOffset !== w.headerOffset ||
        c.size !== w.size ||
        (c.crc32 !== 0 && w.crc32 !== 0 && c.crc32 !== w.crc32)
      ) {
        throw new SogZipError(
          "cd-mismatch",
          `entry ${i} (${c.name}): central directory says offset ${c.headerOffset} size ${c.size}, ` +
            `walked ${w.name} at ${w.headerOffset} size ${w.size}`,
        );
      }
      // fill the data offsets the CD parse could not see (local headers are
      // not in the tail)
      c.dataOffset = w.dataOffset;
    }
    return index;
  }

  // ---- internals -----------------------------------------------------

  /** Materialise the next n queued bytes without consuming them. */
  private peek(n: number): Uint8Array | null {
    if (this.queued < n) return null;
    if (n === 0) return new Uint8Array(0);
    const first = this.queue[0];
    if (first.length >= n) return first.subarray(0, n);
    const out = new Uint8Array(n);
    let o = 0;
    for (const q of this.queue) {
      const take = Math.min(n - o, q.length);
      out.set(q.subarray(0, take), o);
      o += take;
      if (o === n) break;
    }
    return out;
  }

  private drop(n: number): void {
    let left = n;
    while (left > 0) {
      const q = this.queue[0];
      if (q.length <= left) {
        this.queue.shift();
        left -= q.length;
      } else {
        this.queue[0] = q.subarray(left);
        left = 0;
      }
    }
    this.queued -= n;
    this.offset += n;
  }

  /** Copy up to n queued bytes into target at `written`, consuming them. */
  private copyInto(target: Uint8Array, at: number, n: number): number {
    let left = n;
    let o = at;
    while (left > 0 && this.queue.length) {
      const q = this.queue[0];
      const take = Math.min(left, q.length);
      target.set(q.subarray(0, take), o);
      o += take;
      left -= take;
      if (take === q.length) this.queue.shift();
      else this.queue[0] = q.subarray(take);
    }
    const done = n - left;
    this.queued -= done;
    this.offset += done;
    return done;
  }

  private process(): void {
    for (;;) {
      switch (this.state) {
        case "header": {
          const h = this.peek(30);
          if (!h) return;
          const sig = u32(h, 0);
          if (sig === SIG_CENTRAL || sig === SIG_EOCD) {
            // everything from here on is the tail
            this.state = "tail";
            this.tailOffset = this.offset;
            const rest = new Uint8Array(this.queued);
            this.copyInto(rest, 0, this.queued);
            this.tail.push(rest);
            return;
          }
          if (sig !== SIG_LOCAL) {
            throw new SogZipError(
              "bad-header",
              `expected a local file header at offset ${this.offset}, found 0x${sig.toString(16)}`,
            );
          }
          const flag = u16(h, 6);
          const method = u16(h, 8);
          const crc = u32(h, 14);
          const csize = u32(h, 18);
          const fnLen = u16(h, 26);
          const exLen = u16(h, 28);
          const full = this.peek(30 + fnLen + exLen);
          if (!full) return;
          const name = utf8.decode(full.subarray(30, 30 + fnLen));
          if (method !== 0) {
            throw new SogZipError("deflated", `entry ${name} uses compression method ${method}`);
          }
          this.name = name;
          this.headerOffset = this.offset;
          this.hasDescriptor = (flag & FLAG_DESCRIPTOR) !== 0;
          this.headerCrc = crc;
          this.drop(30 + fnLen + exLen);
          this.dataOffset = this.offset;
          this.written = 0;
          this.target = null;
          this.scanParts = [];
          this.scanLength = 0;
          if (!this.hasDescriptor) {
            this.target = new Uint8Array(csize);
            this.state = "data-known";
          } else if (/\.webp$/i.test(name)) {
            this.state = "data-riff";
          } else {
            this.state = "data-scan";
          }
          break;
        }
        case "data-riff": {
          const r = this.peek(12);
          if (!r) return;
          const isRiff =
            r[0] === 0x52 && r[1] === 0x49 && r[2] === 0x46 && r[3] === 0x46 && // RIFF
            r[8] === 0x57 && r[9] === 0x45 && r[10] === 0x42 && r[11] === 0x50; // WEBP
          if (!isRiff) {
            throw new SogZipError("bad-riff", `entry ${this.name} does not start with a RIFF/WEBP header`);
          }
          const length = u32(r, 4) + 8;
          this.target = new Uint8Array(length);
          this.state = "data-known";
          break;
        }
        case "data-known": {
          const target = this.target as Uint8Array;
          if (this.written < target.length) {
            this.written += this.copyInto(target, this.written, target.length - this.written);
            if (this.written < target.length) return;
          }
          this.state = this.hasDescriptor ? "descriptor" : "header";
          if (!this.hasDescriptor) this.emit(target, this.headerCrc);
          break;
        }
        case "data-scan": {
          // meta.json: no length anywhere before the descriptor. JSON text
          // contains no 0x07/0x08 bytes, so the descriptor signature cannot
          // occur inside it; keep a 3-byte carry so a signature straddling
          // two chunks is still found.
          if (this.queued === 0) return;
          const avail = this.peek(this.queued) as Uint8Array;
          let hit = -1;
          for (let i = 0; i + 4 <= avail.length; ++i) {
            if (avail[i] === 0x50 && avail[i + 1] === 0x4b && avail[i + 2] === 0x07 && avail[i + 3] === 0x08) {
              hit = i;
              break;
            }
          }
          if (hit < 0) {
            const keep = Math.min(3, avail.length);
            const take = avail.length - keep;
            if (take > 0) {
              const part = new Uint8Array(take);
              this.copyInto(part, 0, take);
              this.scanParts.push(part);
              this.scanLength += take;
            }
            return;
          }
          if (hit > 0) {
            const part = new Uint8Array(hit);
            this.copyInto(part, 0, hit);
            this.scanParts.push(part);
            this.scanLength += hit;
          }
          const target = new Uint8Array(this.scanLength);
          let o = 0;
          for (const p of this.scanParts) {
            target.set(p, o);
            o += p.length;
          }
          this.target = target;
          this.written = target.length;
          this.state = "descriptor";
          break;
        }
        case "descriptor": {
          const d = this.peek(16);
          if (!d) return;
          const target = this.target as Uint8Array;
          let crc: number;
          let csize: number;
          let len: number;
          if (u32(d, 0) === SIG_DESCRIPTOR) {
            crc = u32(d, 4);
            csize = u32(d, 8);
            len = 16;
          } else {
            // 12-byte descriptor without the (optional) signature
            crc = u32(d, 0);
            csize = u32(d, 4);
            len = 12;
          }
          if (csize !== target.length) {
            throw new SogZipError(
              "bad-descriptor",
              `entry ${this.name}: descriptor size ${csize} does not match the ${target.length} bytes walked`,
            );
          }
          this.drop(len);
          this.state = "header";
          this.emit(target, crc);
          break;
        }
        case "tail":
          return;
      }
    }
  }

  private emit(bytes: Uint8Array, crc32: number): void {
    const entry: SogWalkedEntry = {
      name: this.name,
      bytes,
      size: bytes.length,
      headerOffset: this.headerOffset,
      dataOffset: this.dataOffset,
      crc32,
    };
    this.walked.push(entry);
    this.name = "";
    this.target = null;
    this.onEntry(entry);
  }
}

/**
 * Parse a central directory + EOCD that sit in `tail`, whose first byte is
 * at absolute file offset `tailOffset`. Local headers are not available
 * here, so `dataOffset` is left at -1 for the caller to fill in.
 */
function parseCentralDirectory(tail: Uint8Array, tailOffset: number): SogZipIndex {
  const n = tail.length;
  let eocd = -1;
  for (let i = n - 22; i >= 0; --i) {
    if (u32(tail, i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new SogZipError("no-eocd", "end of central directory record not found in the tail");
  if (eocd >= 20 && u32(tail, eocd - 20) === SIG_EOCD64_LOC) {
    throw new SogZipError("zip64", "Zip64 archives are not supported");
  }
  const entryCount = u16(tail, eocd + 10);
  const cdSize = u32(tail, eocd + 12);
  const cdOffset = u32(tail, eocd + 16);
  if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new SogZipError("zip64", "Zip64 field markers in the EOCD");
  }
  if (cdOffset !== tailOffset) {
    throw new SogZipError(
      "cd-mismatch",
      `central directory offset ${cdOffset} but the walk reached it at ${tailOffset}`,
    );
  }
  const entries: SogZipEntry[] = [];
  let p = 0;
  for (let k = 0; k < entryCount; ++k) {
    if (p + 46 > n || u32(tail, p) !== SIG_CENTRAL) {
      throw new SogZipError("bad-header", `central directory entry ${k} is malformed`);
    }
    const method = u16(tail, p + 10);
    const crc32 = u32(tail, p + 16);
    const csize = u32(tail, p + 20);
    const fnLen = u16(tail, p + 28);
    const exLen = u16(tail, p + 30);
    const cmLen = u16(tail, p + 32);
    const headerOffset = u32(tail, p + 42);
    const name = utf8.decode(tail.subarray(p + 46, p + 46 + fnLen));
    if (method !== 0) throw new SogZipError("deflated", `entry ${name} uses compression method ${method}`);
    entries.push({ name, dataOffset: -1, size: csize, crc32, headerOffset });
    p += 46 + fnLen + exLen + cmLen;
  }
  return {
    entries,
    byName: new Map(entries.map((e) => [e.name, e])),
    centralDirectoryOffset: cdOffset,
  };
}

// Kroscloud fork — ssog module [ssog-27]. See FORK-CHANGES.md.
//
// SsogUnitPack: reader for the ONE-file-per-unit container ("SOGU" v1,
// `ssog/{L}_{i}/unit.bin`) that the Viewme build pipeline writes
// (tools/gpu-build-worker/ssog-pack.mjs) when lod-meta.json is stamped
// `unitPack: 1`. A container holds the unit's meta.json (entry 0, stored as
// raw DEFLATE or identity) followed by its WebP planes, each 16-byte
// aligned, so ONE request replaces the serial meta.json hop plus 6–7
// parallel plane fetches. Three readers share this format and its integrity
// rules (this file, the packer's self-verify, the server validator
// IdentityServer/Services/SsogUnitPack.cs); every violation is rejected with
// a NAMED reason (`SsogUnitPackError.reason`) so the harness negative corpus
// can tell the checks apart. Never sniffed: the manifest stamp decides.
//
// Layout (all integers little-endian):
//   HEADER 32 B: magic "SOGU" (u32 0x55474F53) | u16 version 1 | u16 flags 0
//     | u32 memberCount 1..16 | u32 count (splat rows of the unit)
//     | u32 payloadOffset (= align16(32 + 48·N)) | u32 fileLength
//     | 8 B reserved (0)
//   DIRECTORY at 32: N × 48 B = name[32] (ASCII, NUL-padded, one of the 8
//     loose member names, unique, entry 0 = meta.json) | u32 offset
//     (absolute, 16-aligned, ≥ payloadOffset, ascending, non-overlapping)
//     | u32 length (≥ 1) | u32 rawLength (== length unless deflate)
//     | u32 mflags (bit0 = raw DEFLATE, RFC 1951; v1 allows it on entry 0
//     only; every other bit 0)
//   PAYLOAD: members in directory order, zero-padded to 16 B; the last
//     member ends EXACTLY at fileLength (no trailing bytes).
// No payload CRC (decided): a corrupt WebP fails loudly in the worker decode
// and is bounded by the unit cache's per-unit strike/cool-down.
//
// Dependency: fflate only (already bundled by the core for SOG zips) — no
// DecompressionStream, so no new browser floor for the thumbnail rig or
// WebViews.

import { inflateSync } from "fflate";
import type { PcSogsJson, PcSogsV2Json } from "../SplatLoader";

/** container file name inside the unit dir — a pinned constant, NOT carried in the stamp */
export const SSOG_UNIT_PACK_FILE = "unit.bin";
/** the only container version this reader accepts */
export const SSOG_UNIT_PACK_VERSION = 1;
/** member alphabet = the classic loose file names of a unit (never unit.bin itself) */
export const SSOG_UNIT_PACK_MEMBER_NAMES: ReadonlySet<string> = new Set([
  "meta.json",
  "means_l.webp",
  "means_u.webp",
  "quats.webp",
  "scales.webp",
  "sh0.webp",
  "shN_centroids.webp",
  "shN_labels.webp",
]);

/** ASCII "SOGU" read as a little-endian u32 */
const MAGIC = 0x55474f53;
const HEADER = 32;
const ENTRY = 48;
const NAME_BYTES = 32;
const MAX_MEMBERS = 16;
const ALIGN = 16;
/** meta.json bound (stored AND decoded), checked BEFORE any inflate / JSON parse */
const META_MAX = 4 << 20;
const META_NAME = "meta.json";
const MFLAG_DEFLATE = 1;

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
export class SsogUnitPackError extends Error {
  constructor(
    label: string,
    readonly reason: string,
  ) {
    super(`${label}: bad unit pack — ${reason}`);
    this.name = "SsogUnitPackError";
  }
}

function align16(n: number): number {
  return Math.ceil(n / ALIGN) * ALIGN;
}

function hex(n: number, digits: number): string {
  return `0x${n.toString(16).padStart(digits, "0")}`;
}

/**
 * Parse + verify the header and directory of a SOGU v1 container (checks
 * 1–5 of the format contract: header fields, payloadOffset/fileLength,
 * names, entry geometry, meta.json bound). Pure DataView reads — no member
 * is decoded here. Throws `SsogUnitPackError(label, reason)` on the first
 * violation; `label` prefixes the message (e.g. "ssog unit 3_12").
 */
export function parseUnitPack(buf: ArrayBuffer, label: string): UnitPackIndex {
  const err = (reason: string) => new SsogUnitPackError(label, reason);
  const actual = buf.byteLength;

  // ---- 1. header ---------------------------------------------------------
  if (actual < HEADER) {
    throw err(
      `file is ${actual} bytes, shorter than the ${HEADER}-byte header`,
    );
  }
  const dv = new DataView(buf);
  const magic = dv.getUint32(0, true);
  if (magic !== MAGIC) {
    throw err(`magic ${hex(magic, 8)} is not "SOGU"`);
  }
  const version = dv.getUint16(4, true);
  if (version !== SSOG_UNIT_PACK_VERSION) {
    throw err(`version ${version} (expected ${SSOG_UNIT_PACK_VERSION})`);
  }
  const flags = dv.getUint16(6, true);
  if (flags !== 0) {
    throw err(`flags ${hex(flags, 4)} (expected 0)`);
  }
  const memberCount = dv.getUint32(8, true);
  const count = dv.getUint32(12, true);
  const payloadOffset = dv.getUint32(16, true);
  const fileLength = dv.getUint32(20, true);
  if (dv.getUint32(24, true) !== 0 || dv.getUint32(28, true) !== 0) {
    throw err("reserved header bytes are not zero");
  }
  if (memberCount < 1 || memberCount > MAX_MEMBERS) {
    throw err(`memberCount ${memberCount} outside 1..${MAX_MEMBERS}`);
  }

  // ---- 2. payload offset / file length -----------------------------------
  const expectedPayload = align16(HEADER + ENTRY * memberCount);
  if (payloadOffset !== expectedPayload) {
    throw err(
      `payloadOffset ${payloadOffset} (expected ${expectedPayload} for ${memberCount} members)`,
    );
  }
  if (payloadOffset > fileLength) {
    throw err(`payloadOffset ${payloadOffset} beyond fileLength ${fileLength}`);
  }
  if (fileLength !== actual) {
    throw err(`fileLength ${fileLength} but the file is ${actual} bytes`);
  }
  // from here on the whole directory (32 + 48·N ≤ payloadOffset ≤ actual) is in bounds

  // ---- 3. names ----------------------------------------------------------
  const bytes = new Uint8Array(buf);
  const names: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < memberCount; i++) {
    const base = HEADER + ENTRY * i;
    let end = -1;
    for (let k = 0; k < NAME_BYTES; k++) {
      if (bytes[base + k] === 0) {
        end = k;
        break;
      }
    }
    if (end < 1) {
      throw err(
        `entry ${i}: name is empty or not NUL-terminated within ${NAME_BYTES} bytes`,
      );
    }
    let name = "";
    for (let k = 0; k < end; k++) {
      const c = bytes[base + k];
      if (c < 0x21 || c > 0x7e) {
        throw err(
          `entry ${i}: name byte ${k} (${hex(c, 2)}) is not printable ASCII`,
        );
      }
      name += String.fromCharCode(c);
    }
    for (let k = end + 1; k < NAME_BYTES; k++) {
      if (bytes[base + k] !== 0) {
        throw err(`entry ${i} (${name}): name padding is not zero`);
      }
    }
    if (!SSOG_UNIT_PACK_MEMBER_NAMES.has(name)) {
      throw err(`entry ${i}: unknown member name "${name}"`);
    }
    if (seen.has(name)) {
      throw err(`entry ${i}: duplicate member name "${name}"`);
    }
    seen.add(name);
    names.push(name);
  }
  if (names[0] !== META_NAME) {
    throw err(`entry 0 is "${names[0]}", expected "${META_NAME}"`);
  }

  // ---- 4. entry geometry -------------------------------------------------
  const members = new Map<string, UnitPackMember>();
  let cursor = payloadOffset;
  for (let i = 0; i < memberCount; i++) {
    const base = HEADER + ENTRY * i + NAME_BYTES;
    const name = names[i];
    const offset = dv.getUint32(base, true);
    const length = dv.getUint32(base + 4, true);
    const rawLength = dv.getUint32(base + 8, true);
    const mflags = dv.getUint32(base + 12, true);
    const tag = `entry ${i} (${name})`;
    if (length < 1) {
      throw err(`${tag}: length 0`);
    }
    if (offset % ALIGN !== 0) {
      throw err(`${tag}: offset ${offset} is not 16-byte aligned`);
    }
    if (offset < payloadOffset) {
      throw err(
        `${tag}: offset ${offset} before payloadOffset ${payloadOffset}`,
      );
    }
    if (offset < cursor) {
      throw err(
        `${tag}: offset ${offset} overlaps the previous member ending at ${cursor}`,
      );
    }
    if (offset + length > fileLength) {
      throw err(
        `${tag}: offset ${offset} + length ${length} exceeds fileLength ${fileLength}`,
      );
    }
    if ((mflags & ~MFLAG_DEFLATE) !== 0) {
      throw err(`${tag}: mflags ${hex(mflags, 8)} has unknown bits set`);
    }
    const deflate = (mflags & MFLAG_DEFLATE) !== 0;
    if (deflate && i !== 0) {
      throw err(`${tag}: deflate is allowed only on entry 0 (meta.json)`);
    }
    if (!deflate && rawLength !== length) {
      throw err(
        `${tag}: rawLength ${rawLength} != length ${length} without deflate`,
      );
    }
    members.set(name, { name, offset, length, rawLength, deflate });
    cursor = offset + length;
  }
  if (cursor !== fileLength) {
    throw err(
      `last member ends at ${cursor}, fileLength ${fileLength} (trailing bytes)`,
    );
  }

  // ---- 5. meta.json bound (before any inflate / parse) -------------------
  const meta = members.get(META_NAME);
  if (!meta) {
    throw err("container has no meta.json member");
  }
  if (meta.length > META_MAX) {
    throw err(
      `meta.json stored length ${meta.length} exceeds ${META_MAX} bytes`,
    );
  }
  if (meta.rawLength > META_MAX) {
    throw err(
      `meta.json rawLength ${meta.rawLength} exceeds ${META_MAX} bytes`,
    );
  }

  return { count, fileLength, members };
}

/**
 * Bytes of entry 0 (meta.json): a view into `buf` when stored identity, else
 * the fflate `inflateSync` output, which MUST be exactly `rawLength` bytes.
 */
export function readUnitPackMeta(
  buf: ArrayBuffer,
  index: UnitPackIndex,
  label: string,
): Uint8Array {
  const m = index.members.get(META_NAME);
  if (!m) {
    throw new SsogUnitPackError(label, "container has no meta.json member");
  }
  const stored = new Uint8Array(buf, m.offset, m.length);
  if (!m.deflate) {
    return stored;
  }
  let out: Uint8Array;
  try {
    out = inflateSync(stored);
  } catch (e) {
    throw new SsogUnitPackError(
      label,
      `meta.json inflate failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (out.length !== m.rawLength) {
    throw new SsogUnitPackError(
      label,
      `meta.json inflated to ${out.length} bytes, rawLength says ${m.rawLength}`,
    );
  }
  return out;
}

/**
 * Plane file names of a unit in the runtime's order (means, scales, quats,
 * sh0, shN) — the classic fetch list and the packed member order alike.
 */
export function planeNames(json: PcSogsJson | PcSogsV2Json): string[] {
  return [
    ...json.means.files,
    ...json.scales.files,
    ...json.quats.files,
    ...json.sh0.files,
    ...(json.shN?.files ?? []),
  ];
}

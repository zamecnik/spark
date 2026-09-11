// Kroscloud fork (2026) — see FORK-CHANGES.md [full-1].
//
// SOG v2 `meta.json` validation for the full-detail (no-LOD) loader. Pure:
// no I/O, no three, Node-testable. The loader REFUSES what the stream's
// decoder (pcsogsDecode.ts) would not decode identically — the parity
// contract of the mode is "the words the stream writes", so a file that
// would need a patch (a null codebook slot, a v1 layout, a missing plane) is
// refused with a typed error instead of being repaired.

import type { PcSogsV2Json } from "../SplatLoader";

export type SogPlaneName =
  | "means_l"
  | "means_u"
  | "quats"
  | "scales"
  | "sh0"
  | "shN_centroids"
  | "shN_labels";

/** The parts of a validated v2 manifest the packer and the loader read. */
export type SogMeta = {
  count: number;
  /** SH bands carried by the file (0 = no shN section). */
  bands: 0 | 1 | 2 | 3;
  /** Number of palette centroids (shN.count), 0 without SH. */
  centroidCount: number;
  means: { mins: [number, number, number]; maxs: [number, number, number] };
  scalesCodebook: Float64Array;
  sh0Codebook: Float64Array;
  shNCodebook: Float64Array | null;
  /** File names by role, as written in the manifest (no directory prefix). */
  files: Record<SogPlaneName, string | null>;
  /** The manifest, verbatim (the reference decoder's input shape). */
  json: PcSogsV2Json;
};

export class SogMetaError extends Error {
  readonly code:
    | "not-v2"
    | "count"
    | "means"
    | "codebook"
    | "codebook-null"
    | "files"
    | "bands";
  constructor(code: SogMetaError["code"], message: string) {
    super(message);
    this.name = "SogMetaError";
    this.code = code;
  }
}

function isNumArray(a: unknown, n?: number): a is number[] {
  return (
    Array.isArray(a) &&
    (n === undefined || a.length === n) &&
    a.every((v) => typeof v === "number" && Number.isFinite(v))
  );
}

function codebook(
  raw: unknown,
  what: string,
): Float64Array {
  if (!Array.isArray(raw) || raw.length !== 256) {
    throw new SogMetaError(
      "codebook",
      `${what}.codebook must have 256 entries (got ${
        Array.isArray(raw) ? raw.length : typeof raw
      })`,
    );
  }
  // superspl.at patches a null slot 0 (`cb[1] + (cb[1]-cb[255])/255`); the
  // stream's decoder does not, and neither does the Rust static decoder, so
  // a patched file would not be the words the stream writes. Refuse.
  for (let i = 0; i < 256; ++i) {
    const v = raw[i];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new SogMetaError(
        "codebook-null",
        `${what}.codebook[${i}] is ${v === null ? "null" : typeof v}; ` +
          "the reference decoders do not patch codebooks",
      );
    }
  }
  return Float64Array.from(raw as number[]);
}

/**
 * Validate a parsed `meta.json` and extract what the loader needs. Throws
 * SogMetaError; never repairs.
 */
export function parseSogMeta(json: unknown): SogMeta {
  const j = json as PcSogsV2Json;
  if (!j || typeof j !== "object" || j.version !== 2) {
    throw new SogMetaError(
      "not-v2",
      `expected a SOG v2 manifest (version 2), got ${
        j && typeof j === "object" ? String((j as { version?: unknown }).version) : typeof j
      }`,
    );
  }
  if (!Number.isInteger(j.count) || j.count <= 0) {
    throw new SogMetaError("count", `count must be a positive integer (got ${j.count})`);
  }
  if (
    !j.means ||
    !isNumArray(j.means.mins, 3) ||
    !isNumArray(j.means.maxs, 3) ||
    !Array.isArray(j.means.files) ||
    j.means.files.length !== 2
  ) {
    throw new SogMetaError("means", "means needs mins[3], maxs[3] and files[2]");
  }
  const one = (sec: { files?: string[] } | undefined, what: string): string => {
    if (!sec || !Array.isArray(sec.files) || sec.files.length !== 1 || typeof sec.files[0] !== "string") {
      throw new SogMetaError("files", `${what}.files must name exactly one plane`);
    }
    return sec.files[0];
  };
  const files: SogMeta["files"] = {
    means_l: j.means.files[0],
    means_u: j.means.files[1],
    quats: one(j.quats, "quats"),
    scales: one(j.scales, "scales"),
    sh0: one(j.sh0, "sh0"),
    shN_centroids: null,
    shN_labels: null,
  };
  const scalesCodebook = codebook(j.scales?.codebook, "scales");
  const sh0Codebook = codebook(j.sh0?.codebook, "sh0");

  let bands: SogMeta["bands"] = 0;
  let centroidCount = 0;
  let shNCodebook: Float64Array | null = null;
  if (j.shN) {
    const b = j.shN.bands;
    if (b !== 1 && b !== 2 && b !== 3) {
      throw new SogMetaError("bands", `shN.bands must be 1, 2 or 3 (got ${b})`);
    }
    if (!Number.isInteger(j.shN.count) || j.shN.count <= 0 || j.shN.count > 65536) {
      throw new SogMetaError("bands", `shN.count must be 1..65536 (got ${j.shN.count})`);
    }
    // The full-detail loader reads the whole file: a palette-referencing unit
    // shape ([labels] + shN.palette) is a stream artefact, not a scene.sog.
    if (!Array.isArray(j.shN.files) || j.shN.files.length !== 2 || j.shN.palette) {
      throw new SogMetaError(
        "files",
        "shN.files must be [centroids, labels] (a scene.sog carries its own palette)",
      );
    }
    bands = b;
    centroidCount = j.shN.count;
    shNCodebook = codebook(j.shN.codebook, "shN");
    files.shN_centroids = j.shN.files[0];
    files.shN_labels = j.shN.files[1];
  }

  return {
    count: j.count,
    bands,
    centroidCount,
    means: {
      mins: [j.means.mins[0], j.means.mins[1], j.means.mins[2]],
      maxs: [j.means.maxs[0], j.means.maxs[1], j.means.maxs[2]],
    },
    scalesCodebook,
    sh0Codebook,
    shNCodebook,
    files,
    json: j,
  };
}

/**
 * The plane geometry rule of splat-transform 3.x: W = roundUp4(ceil(sqrt n)),
 * H = roundUp4(ceil(n / W)). Used to cross-check the decoded bitmap size (a
 * plane of the wrong size means the file is not what the manifest says) and
 * to size band reads before the bitmap exists.
 */
export function planeSize(count: number): { width: number; height: number } {
  const up4 = (v: number) => Math.ceil(v / 4) * 4;
  const width = up4(Math.ceil(Math.sqrt(count)));
  const height = up4(Math.ceil(count / width));
  return { width, height };
}

/**
 * Scene bounds straight from the manifest: the means are stored as
 * sign(v)·log(1+|v|) in [mins, maxs], so the corners of the decoded box are
 * sign(v)·(exp|v|−1) of the stored corners. Exact, and available before a
 * single texel is decoded — the loader hands these to the app so it never
 * has to walk 20M packed centers on the main thread.
 */
export function boundsFromMeta(meta: SogMeta): {
  min: [number, number, number];
  max: [number, number, number];
} {
  const un = (v: number) => Math.sign(v) * (Math.exp(Math.abs(v)) - 1);
  const min: [number, number, number] = [0, 0, 0];
  const max: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; ++c) {
    const a = un(meta.means.mins[c]);
    const b = un(meta.means.maxs[c]);
    min[c] = Math.min(a, b);
    max[c] = Math.max(a, b);
  }
  return { min, max };
}

/**
 * Centroid image stride rule ([ssog-10]): writers pack 64 centroids per row
 * at `64 * coeffsPerCentroid` px (3 / 8 / 15 for bands 1 / 2 / 3); the image
 * width is authoritative. Returns the stride, or throws when width and bands
 * disagree (a wrong stride reads every SH lookup off by one centroid).
 */
export function centroidStride(width: number, bands: number): number {
  const stride = Math.max(1, Math.floor(width / 64));
  const expected = bands >= 3 ? 15 : bands === 2 ? 8 : 3;
  if (stride !== expected) {
    throw new SogMetaError(
      "bands",
      `shN_centroids width ${width} implies stride ${stride}, but bands ${bands} needs ${expected}`,
    );
  }
  return stride;
}

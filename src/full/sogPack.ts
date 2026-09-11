// Kroscloud fork (2026) — see FORK-CHANGES.md [full-1].
//
// SOG v2 planes -> Spark PackedSplats words, table-driven. Pure: typed arrays
// in, typed arrays out, no I/O, no three, Node-testable.
//
// PARITY CONTRACT: the words written here are the words the streamed-LOD
// unit decoder writes (pcsogsDecode.ts unpackPcSogs). Every table entry is
// produced by the SAME packedEncode.ts helper the reference path calls per
// splat (toHalf, setPackedSplatScales, setPackedSplatRgba, encodeQuat...,
// encodeSh1/2/3Rgb), and every per-splat formula is copied from
// unpackPcSogs, so the output is word-for-word identical by construction —
// the unit test test/full/sogPack.test.ts checks exactly that against the
// per-splat reference path on a real SH3 fixture. Nothing here is a
// re-derivation of the SOG format from its spec.
//
// Why tables: at 19.9M splats the per-splat helper path costs ~21 s single-
// threaded (measured: quats 2.0 s, means 1.3 s, scales 2.0 s, sh0 0.9 s,
// shN 14.5 s naive); the center/scale/color/palette lookups below bring it to
// ~4 s, and the quaternion (an acos per splat, kept exact) dominates what is
// left. The palette lever is the big one: a label's 10 SH words are computed
// once per centroid (65,536 x 10) and copied per splat.

import { DEFAULT_SPLAT_ENCODING, type SplatEncoding } from "../defines";
import {
  encodeQuatOctXy88R8,
  encodeSh1Rgb,
  encodeSh2Rgb,
  encodeSh3Rgb,
  setPackedSplatRgba,
  setPackedSplatScales,
  toHalf,
} from "../packedEncode";
import { type SogMeta, centroidStride } from "./sogMeta";

const SH_C0 = 0.28209479177387814;
const SQRT2 = Math.sqrt(2);

export type SogPlaneRgba = { rgba: Uint8Array; width: number; height: number };

export type PackTables = {
  /** toHalf(center_c(n)) for every 16-bit mean value n, per axis. */
  centerHalf: [Uint16Array, Uint16Array, Uint16Array];
  /** The packed scale byte for every scales-plane byte. */
  scaleByte: Uint8Array;
  /** The packed color byte for every sh0-plane color byte. */
  rgbByte: Uint8Array;
  /** The packed alpha byte for every sh0-plane alpha byte. */
  alphaByte: Uint8Array;
  /** (b / 255 - 0.5) * sqrt2 for every quats-plane component byte. */
  quatComp: Float64Array;
  /** Bands actually packed (min of the file's bands and the requested clamp). */
  maxSh: 0 | 1 | 2 | 3;
  /** Number of labels the palette tables cover (rows x 64 of the centroid image). */
  paletteEntries: number;
  paletteSh1: Uint32Array | null;
  paletteSh2: Uint32Array | null;
  paletteSh3: Uint32Array | null;
};

/**
 * Build every lookup the packer needs, once per scene. `centroids` is the
 * decoded shN_centroids plane (required when maxSh > 0 and the file has SH).
 */
export function buildPackTables(
  meta: SogMeta,
  centroids: SogPlaneRgba | null,
  maxShRequested: number,
  encoding: SplatEncoding = DEFAULT_SPLAT_ENCODING,
): PackTables {
  const maxSh = Math.max(0, Math.min(3, meta.bands, Math.floor(maxShRequested))) as 0 | 1 | 2 | 3;
  const scratch = new Uint32Array(4);

  // centers: fx = n / 65535; v = mins + (maxs - mins) * fx; sign(v)(exp|v| - 1)
  const centerHalf: [Uint16Array, Uint16Array, Uint16Array] = [
    new Uint16Array(65536),
    new Uint16Array(65536),
    new Uint16Array(65536),
  ];
  for (let c = 0; c < 3; ++c) {
    const mn = meta.means.mins[c];
    const mx = meta.means.maxs[c];
    const t = centerHalf[c];
    for (let n = 0; n < 65536; ++n) {
      const f = n / 65535;
      let v = mn + (mx - mn) * f;
      v = Math.sign(v) * (Math.exp(Math.abs(v)) - 1);
      t[n] = toHalf(v);
    }
  }

  // scales: exp(codebook[b]) through the real encoder (ln round trip kept)
  const scaleByte = new Uint8Array(256);
  for (let b = 0; b < 256; ++b) {
    const s = Math.exp(meta.scalesCodebook[b]);
    scratch[3] = 0;
    setPackedSplatScales(scratch, 0, s, s, s, encoding);
    scaleByte[b] = scratch[3] & 0xff;
  }

  // sh0 color: SH_C0 * codebook[b] + 0.5 through the real encoder; alpha b/255
  const rgbByte = new Uint8Array(256);
  const alphaByte = new Uint8Array(256);
  for (let b = 0; b < 256; ++b) {
    const r = SH_C0 * meta.sh0Codebook[b] + 0.5;
    scratch[0] = 0;
    setPackedSplatRgba(scratch, 0, r, r, r, 0, encoding);
    rgbByte[b] = scratch[0] & 0xff;
    scratch[0] = 0;
    setPackedSplatRgba(scratch, 0, 0, 0, 0, b / 255, encoding);
    alphaByte[b] = (scratch[0] >>> 24) & 0xff;
  }

  const quatComp = new Float64Array(256);
  for (let b = 0; b < 256; ++b) quatComp[b] = (b / 255 - 0.5) * SQRT2;

  let paletteEntries = 0;
  let paletteSh1: Uint32Array | null = null;
  let paletteSh2: Uint32Array | null = null;
  let paletteSh3: Uint32Array | null = null;
  if (maxSh > 0) {
    if (!centroids || !meta.shNCodebook) {
      throw new Error("buildPackTables: SH requested but no centroid plane / codebook");
    }
    const stride = centroidStride(centroids.width, meta.bands);
    const width = centroids.width;
    // Labels are 16-bit; the reference decoder indexes the centroid image
    // with row = label >> 6, col = (label & 63) * stride, so every label that
    // lands inside the image decodes to SOMETHING (a stale or padding
    // centroid past shN.count included) and every label past the last row
    // reads undefined -> NaN -> zero words. The table covers exactly the
    // in-image labels; the packer zeroes the rest and counts them.
    paletteEntries = Math.min(65536, centroids.height * 64);
    const lookup = meta.shNCodebook;
    const px = centroids.rgba;
    const sh1 = new Float32Array(9);
    const sh2 = new Float32Array(15);
    const sh3 = new Float32Array(21);
    if (maxSh >= 1) paletteSh1 = new Uint32Array(paletteEntries * 2);
    if (maxSh >= 2) paletteSh2 = new Uint32Array(paletteEntries * 4);
    if (maxSh >= 3) paletteSh3 = new Uint32Array(paletteEntries * 4);
    for (let label = 0; label < paletteEntries; ++label) {
      const col = (label & 63) * stride;
      const row = label >>> 6;
      const offset = row * width + col;
      for (let d = 0; d < 3; ++d) {
        if (maxSh >= 1) {
          for (let k = 0; k < 3; ++k) sh1[k * 3 + d] = lookup[px[(offset + k) * 4 + d]];
        }
        if (maxSh >= 2) {
          for (let k = 0; k < 5; ++k) sh2[k * 3 + d] = lookup[px[(offset + 3 + k) * 4 + d]];
        }
        if (maxSh >= 3) {
          for (let k = 0; k < 7; ++k) sh3[k * 3 + d] = lookup[px[(offset + 8 + k) * 4 + d]];
        }
      }
      // the encoders OR-accumulate: the palette arrays are fresh (zeroed)
      if (paletteSh1) encodeSh1Rgb(paletteSh1, label, sh1, encoding);
      if (paletteSh2) encodeSh2Rgb(paletteSh2, label, sh2, encoding);
      if (paletteSh3) encodeSh3Rgb(paletteSh3, label, sh3, encoding);
    }
  }

  return {
    centerHalf,
    scaleByte,
    rgbByte,
    alphaByte,
    quatComp,
    maxSh,
    paletteEntries,
    paletteSh1,
    paletteSh2,
    paletteSh3,
  };
}

/** RGBA pixels of the six per-splat planes for one contiguous splat range. */
export type PackPlanes = {
  meansL: Uint8Array;
  meansU: Uint8Array;
  quats: Uint8Array;
  scales: Uint8Array;
  sh0: Uint8Array;
  /** Required when tables.maxSh > 0. */
  labels: Uint8Array | null;
};

export type PackOutput = {
  packed: Uint32Array;
  sh1: Uint32Array | null;
  sh2: Uint32Array | null;
  sh3: Uint32Array | null;
};

/**
 * Pack `count` splats whose plane pixels start at element 0 of each plane
 * into `out` at splat index `outIndex`. Returns the number of labels that
 * fell outside the palette (encoded as zero SH, like the reference path).
 */
export function packRange(
  planes: PackPlanes,
  count: number,
  tables: PackTables,
  out: PackOutput,
  outIndex: number,
): { badLabels: number } {
  const { meansL, meansU, quats, scales, sh0 } = planes;
  const [tx, ty, tz] = tables.centerHalf;
  const scaleByte = tables.scaleByte;
  const rgbByte = tables.rgbByte;
  const alphaByte = tables.alphaByte;
  const quatComp = tables.quatComp;
  const packed = out.packed;
  const q = { x: 0, y: 0, z: 0, w: 1 };

  for (let i = 0; i < count; ++i) {
    const i4 = i * 4;
    const o4 = (outIndex + i) * 4;

    // word0: rgba (setPackedSplatRgba)
    packed[o4] =
      rgbByte[sh0[i4]] |
      (rgbByte[sh0[i4 + 1]] << 8) |
      (rgbByte[sh0[i4 + 2]] << 16) |
      (alphaByte[sh0[i4 + 3]] << 24);

    // word1 + low half of word2: fp16 center (setPackedSplatCenter)
    const nx = meansL[i4] | (meansU[i4] << 8);
    const ny = meansL[i4 + 1] | (meansU[i4 + 1] << 8);
    const nz = meansL[i4 + 2] | (meansU[i4 + 2] << 8);
    packed[o4 + 1] = tx[nx] | (ty[ny] << 16);

    // quaternion (the reference's r0..r2 / rr / rOrder ternaries, then the
    // real octahedral encoder - no acos table, kept exact)
    const r0 = quatComp[quats[i4]];
    const r1 = quatComp[quats[i4 + 1]];
    const r2 = quatComp[quats[i4 + 2]];
    const rr = Math.sqrt(Math.max(0, 1.0 - r0 * r0 - r1 * r1 - r2 * r2));
    const rOrder = quats[i4 + 3] - 252;
    q.x = rOrder === 0 ? r0 : rOrder === 1 ? rr : r1;
    q.y = rOrder <= 1 ? r1 : rOrder === 2 ? rr : r2;
    q.z = rOrder <= 2 ? r2 : rr;
    q.w = rOrder === 0 ? rr : r0;
    const uQuat = encodeQuatOctXy88R8(q);
    const uQuatX = uQuat & 0xff;
    const uQuatY = (uQuat >>> 8) & 0xff;
    const uQuatZ = (uQuat >>> 16) & 0xff;
    packed[o4 + 2] = tz[nz] | (uQuatX << 16) | (uQuatY << 24);

    // word3: scales + the third quat byte
    packed[o4 + 3] =
      scaleByte[scales[i4]] |
      (scaleByte[scales[i4 + 1]] << 8) |
      (scaleByte[scales[i4 + 2]] << 16) |
      (uQuatZ << 24);
  }

  let badLabels = 0;
  if (tables.maxSh > 0) {
    const labels = planes.labels;
    if (!labels) throw new Error("packRange: labels plane missing");
    const n = tables.paletteEntries;
    const p1 = tables.paletteSh1;
    const p2 = tables.paletteSh2;
    const p3 = tables.paletteSh3;
    const s1 = out.sh1;
    const s2 = out.sh2;
    const s3 = out.sh3;
    for (let i = 0; i < count; ++i) {
      const i4 = i * 4;
      const label = labels[i4] | (labels[i4 + 1] << 8);
      const o = outIndex + i;
      if (label < n) {
        if (p1 && s1) {
          s1[o * 2] = p1[label * 2];
          s1[o * 2 + 1] = p1[label * 2 + 1];
        }
        if (p2 && s2) {
          s2[o * 4] = p2[label * 4];
          s2[o * 4 + 1] = p2[label * 4 + 1];
          s2[o * 4 + 2] = p2[label * 4 + 2];
          s2[o * 4 + 3] = p2[label * 4 + 3];
        }
        if (p3 && s3) {
          s3[o * 4] = p3[label * 4];
          s3[o * 4 + 1] = p3[label * 4 + 1];
          s3[o * 4 + 2] = p3[label * 4 + 2];
          s3[o * 4 + 3] = p3[label * 4 + 3];
        }
      } else {
        badLabels++;
        if (s1) {
          s1[o * 2] = 0;
          s1[o * 2 + 1] = 0;
        }
        if (s2) s2.fill(0, o * 4, o * 4 + 4);
        if (s3) s3.fill(0, o * 4, o * 4 + 4);
      }
    }
  }
  return { badLabels };
}

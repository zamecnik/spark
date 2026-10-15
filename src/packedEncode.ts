// Kroscloud fork (ssog carve-out) — see FORK-CHANGES.md [ssog-1].
//
// Pure packed-splat encode helpers MOVED VERBATIM out of utils.ts so the SOG
// decode path (pcsogsDecode.ts) can run inside the inline worker bundle
// without pulling three (utils.ts evaluates THREE.REVISION and allocates
// Vector3/Quaternion/Color temps at module scope). utils.ts re-exports every
// symbol here, so its public surface is unchanged. This module must NEVER
// import three.
//
// The only non-verbatim function is encodeQuatOctXy88R8: the original took a
// THREE.Quaternion and normalized via a module-level temp; this port operates
// on a plain {x,y,z,w} record with the same normalization semantics
// (THREE.Quaternion.normalize: zero-length → identity), bit-identical output.
//
// [prec-1] (kroscloud.48) toHalfJS — the fallback for browsers without
// Float16Array, e.g. the thumbnail server's Chromium 101 — no longer
// truncates: it rounds to nearest, ties to even, straight from the float64,
// exactly what Float16Array / Math.f16round produce (test/packedEncode.test.ts
// compares it against both). toHalfNative and fromHalf are unchanged.

import { LN_SCALE_MAX, LN_SCALE_MIN, SCALE_ZERO } from "./defines.js";
import {
  SPLAT_TEX_HEIGHT,
  SPLAT_TEX_MIN_HEIGHT,
  SPLAT_TEX_WIDTH,
} from "./defines.js";

const f32buffer = new Float32Array(1);
const u32buffer = new Uint32Array(f32buffer.buffer);
const supportsFloat16Array = "Float16Array" in globalThis;
const f16buffer = supportsFloat16Array
  ? new globalThis["Float16Array" as keyof typeof globalThis](1)
  : null;
const u16buffer = new Uint16Array(f16buffer?.buffer);

export const toHalf = supportsFloat16Array ? toHalfNative : toHalfJS;
export const fromHalf = supportsFloat16Array ? fromHalfNative : fromHalfJS;

// Encode a number as a float16, stored as a uint16 number.
function toHalfNative(f: number): number {
  f16buffer[0] = f;
  return u16buffer[0];
}

// [prec-1] float64 view for toHalfJS: the sign and the exponent come from the
// double's own high word (index 1 on little-endian platforms).
const f64buffer = new Float64Array(1);
const u32of64buffer = new Uint32Array(f64buffer.buffer);
const f64HighWord =
  new Uint8Array(new Uint32Array([1]).buffer)[0] === 1 ? 1 : 0;
// 2^(10 - e) for the normal fp16 exponents e = -14..15, at index e + 14: the
// scale that puts a value of exponent e in [1024, 2048) fp16 mantissa units.
const halfMantissaScale = Array.from({ length: 30 }, (_, k) => 2 ** (24 - k));

// m rounded to the nearest integer, ties to even. m - floor(m) is exact for
// the m this module produces (m < 2^12).
function roundHalfEven(m: number): number {
  const fl = Math.floor(m);
  const d = m - fl;
  return d > 0.5 || (d === 0.5 && (fl & 1) === 1) ? fl + 1 : fl;
}

// Encode a number as a float16, stored as a uint16 number.
// [prec-1] Round to nearest, ties to even, from the float64 directly (no
// float32 step, which would round twice): subnormals in units of 2^-24, a
// mantissa that rounds up to 2048 carries into the exponent (at exponent 15
// that carry IS 0x7c00 = Infinity, so every value >= 65520 overflows), NaN
// keeps its sign as a quiet NaN (0x7e00 / 0xfe00, what V8's Float16Array
// stores), and -0 / tiny negatives give 0x8000. The upstream version
// truncated the mantissa (frac >> 13) after a float32 round trip, so on a
// browser without Float16Array every centre sat up to one fp16 step below
// where the native encoder puts it.
export function toHalfJS(f: number): number {
  f64buffer[0] = f;
  const hi = u32of64buffer[f64HighWord];
  const sign = (hi >>> 16) & 0x8000;
  const exp64 = (hi >>> 20) & 0x7ff;
  if (exp64 === 0x7ff) {
    // NaN or Infinity
    return sign | (Number.isNaN(f) ? 0x7e00 : 0x7c00);
  }
  const a = Math.abs(f);
  // floor(log2(a)) for a normal double; double subnormals land at -1023 and
  // take the subnormal branch (they round to a signed zero)
  const e = exp64 - 1023;
  if (e >= 16) {
    return sign | 0x7c00; // >= 65536: Infinity
  }
  if (e < -14) {
    // fp16 subnormal or zero; a result of 1024 is the smallest normal 0x0400
    return sign | roundHalfEven(a * 16777216);
  }
  // normal: the rounded mantissa is in [1024, 2048]; 2048 adds one exponent
  return (
    sign |
    (((e + 15) << 10) + roundHalfEven(a * halfMantissaScale[e + 14]) - 1024)
  );
}

// Convert a float16 stored as a uint16 number back to a float32.
function fromHalfNative(u: number): number {
  u16buffer[0] = u;
  return f16buffer[0];
}

// Convert a float16 stored as a uint16 number back to a float32.
// [prec-1] exported (unchanged) for test/packedEncode.test.ts.
export function fromHalfJS(h: number): number {
  // Extract the sign (1 bit), exponent (5 bits), and fraction (10 bits)
  const sign = (h >> 15) & 0x1;
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;

  let f32bits: number;

  if (exp === 0) {
    if (frac === 0) {
      // Zero (positive or negative)
      f32bits = sign << 31;
    } else {
      // Subnormal half-precision number.
      // Normalize the subnormal number:
      let mant = frac;
      let e = -14; // For half, the exponent for subnormals is fixed at -14.
      // Shift left until the implicit leading 1 is in place.
      while ((mant & 0x400) === 0) {
        // 0x400 === 1 << 10
        mant <<= 1;
        e--;
      }
      // Remove the leading 1 (which is now implicit)
      mant &= 0x3ff;
      // Convert the half exponent (e) to the 32-bit float exponent:
      const newExp = e + 127; // 32-bit float bias is 127.
      const newFrac = mant << 13; // Align to 23-bit fraction (23 - 10 = 13)
      f32bits = (sign << 31) | (newExp << 23) | newFrac;
    }
  } else if (exp === 0x1f) {
    // Handle special cases for Infinity and NaN.
    if (frac === 0) {
      // Infinity
      f32bits = (sign << 31) | 0x7f800000;
    } else {
      // NaN (we choose a quiet NaN)
      f32bits = (sign << 31) | 0x7fc00000;
    }
  } else {
    // Normalized half-precision number.
    // Adjust exponent from half (bias 15) to float32 (bias 127)
    const newExp = exp - 15 + 127;
    const newFrac = frac << 13;
    f32bits = (sign << 31) | (newExp << 23) | newFrac;
  }

  // Write the 32-bit bit pattern to the shared buffer,
  // then read it as a float32 to return a JavaScript number.
  u32buffer[0] = f32bits;
  return f32buffer[0];
}

// Convert a number 0..1 to a 0..255 uint
export function floatToUint8(v: number): number {
  // Converts from 0..1 float to 0..255 uint8
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

// Minimal structural quaternion — THREE.Quaternion satisfies it.
export type QuatXyzw = { x: number; y: number; z: number; w: number };

/**
 * Encodes a quaternion into 24 bits via folded octahedral axis mapping +
 * 8-bit angle quantization. Same bit layout and math as the pre-carve-out
 * utils.ts implementation (which used THREE.Quaternion temps); decode stays
 * in utils.ts (`decodeQuatOctXy88R8` needs a THREE.Quaternion out-param).
 */
export function encodeQuatOctXy88R8(q: QuatXyzw): number {
  // Normalize (THREE.Quaternion.normalize semantics: zero length → identity)
  let { x, y, z, w } = q;
  const len = Math.sqrt(x * x + y * y + z * z + w * w);
  if (len === 0) {
    x = 0;
    y = 0;
    z = 0;
    w = 1;
  } else {
    const inv = 1 / len;
    x *= inv;
    y *= inv;
    z *= inv;
    w *= inv;
  }
  // Force the minimal representation (w >= 0)
  if (w < 0) {
    x = -x;
    y = -y;
    z = -z;
    w = -w;
  }
  // Compute the rotation angle θ in [0, π]
  const theta = 2 * Math.acos(w);
  // Recover the rotation axis (default to (1,0,0) for near-zero rotation)
  const xyz_norm = Math.sqrt(x * x + y * y + z * z);
  let axisX: number;
  let axisY: number;
  let axisZ: number;
  if (xyz_norm < 1e-6) {
    axisX = 1;
    axisY = 0;
    axisZ = 0;
  } else {
    axisX = x / xyz_norm;
    axisY = y / xyz_norm;
    axisZ = z / xyz_norm;
  }

  // --- Folded Octahedral Mapping (inline) ---
  // Compute p = (axis.x, axis.y) / (|axis.x|+|axis.y|+|axis.z|)
  const sum = Math.abs(axisX) + Math.abs(axisY) + Math.abs(axisZ);
  let p_x = axisX / sum;
  let p_y = axisY / sum;
  // Fold the lower hemisphere.
  if (axisZ < 0) {
    const tmp = p_x;
    p_x = (1 - Math.abs(p_y)) * (p_x >= 0 ? 1 : -1);
    p_y = (1 - Math.abs(tmp)) * (p_y >= 0 ? 1 : -1);
  }
  // Remap from [-1,1] to [0,1]
  const u_f = p_x * 0.5 + 0.5;
  const v_f = p_y * 0.5 + 0.5;
  // Quantize to 8 bits (0..255)
  const quantU = Math.round(u_f * 255);
  const quantV = Math.round(v_f * 255);
  // --- Angle Quantization: Quantize θ ∈ [0,π] to 8 bits (0..255) ---
  const angleInt = Math.round(theta * (255 / Math.PI));

  // Pack into 24 bits: bits [0–7]: quantU, [8–15]: quantV, [16–23]: angleInt.
  return (angleInt << 16) | (quantV << 8) | quantU;
}

// Encode the center coordinates x,y,z in the packedSplats Uint32Array,
// leaving all other fields as is.
export function setPackedSplatCenter(
  packedSplats: Uint32Array,
  index: number,
  x: number,
  y: number,
  z: number,
) {
  const uCenterX = toHalf(x);
  const uCenterY = toHalf(y);
  const uCenterZ = toHalf(z);

  const i4 = index * 4;
  packedSplats[i4 + 1] = uCenterX | (uCenterY << 16);
  packedSplats[i4 + 2] = uCenterZ | (packedSplats[i4 + 2] & 0xffff0000);
}

// Encode the scales x,y,z in the packedSplats Uint32Array, leaving all other fields as is.
export function setPackedSplatScales(
  packedSplats: Uint32Array,
  index: number,
  scaleX: number,
  scaleY: number,
  scaleZ: number,
  encoding?: {
    lnScaleMin?: number;
    lnScaleMax?: number;
  },
) {
  // Allow scales below LN_SCALE_MIN to be encoded as 0, which signifies a 2DGS
  const lnScaleMin = encoding?.lnScaleMin ?? LN_SCALE_MIN;
  const lnScaleMax = encoding?.lnScaleMax ?? LN_SCALE_MAX;
  const lnScaleScale = 254.0 / (lnScaleMax - lnScaleMin);
  const uScaleX =
    scaleX < SCALE_ZERO
      ? 0
      : Math.min(
          255,
          Math.max(
            1,
            Math.round((Math.log(scaleX) - lnScaleMin) * lnScaleScale) + 1,
          ),
        );
  const uScaleY =
    scaleY < SCALE_ZERO
      ? 0
      : Math.min(
          255,
          Math.max(
            1,
            Math.round((Math.log(scaleY) - lnScaleMin) * lnScaleScale) + 1,
          ),
        );
  const uScaleZ =
    scaleZ < SCALE_ZERO
      ? 0
      : Math.min(
          255,
          Math.max(
            1,
            Math.round((Math.log(scaleZ) - lnScaleMin) * lnScaleScale) + 1,
          ),
        );

  const i4 = index * 4;
  packedSplats[i4 + 3] =
    uScaleX |
    (uScaleY << 8) |
    (uScaleZ << 16) |
    (packedSplats[i4 + 3] & 0xff000000);
}

// Encode the rotation quatX, quatY, quatZ, quatW in the packedSplats Uint32Array,
// leaving all other fields as is.
export function setPackedSplatQuat(
  packedSplats: Uint32Array,
  index: number,
  quatX: number,
  quatY: number,
  quatZ: number,
  quatW: number,
) {
  const uQuat = encodeQuatOctXy88R8({
    x: quatX,
    y: quatY,
    z: quatZ,
    w: quatW,
  });
  const uQuatX = uQuat & 0xff;
  const uQuatY = (uQuat >>> 8) & 0xff;
  const uQuatZ = (uQuat >>> 16) & 0xff;

  const i4 = index * 4;
  packedSplats[i4 + 2] =
    (packedSplats[i4 + 2] & 0x0000ffff) | (uQuatX << 16) | (uQuatY << 24);
  packedSplats[i4 + 3] = (packedSplats[i4 + 3] & 0x00ffffff) | (uQuatZ << 24);
}

// Encode the RGBA color in the packedSplats Uint32Array, leaving other fields alone.
export function setPackedSplatRgba(
  packedSplats: Uint32Array,
  index: number,
  r: number,
  g: number,
  b: number,
  a: number,
  encoding?: {
    rgbMin?: number;
    rgbMax?: number;
    lodOpacity?: boolean;
  },
) {
  const rgbMin = encoding?.rgbMin ?? 0.0;
  const rgbMax = encoding?.rgbMax ?? 1.0;
  const rgbRange = rgbMax - rgbMin;
  const uR = floatToUint8((r - rgbMin) / rgbRange);
  const uG = floatToUint8((g - rgbMin) / rgbRange);
  const uB = floatToUint8((b - rgbMin) / rgbRange);
  const uA = floatToUint8(encoding?.lodOpacity ? 0.5 * a : a);
  const i4 = index * 4;
  packedSplats[i4] = uR | (uG << 8) | (uB << 16) | (uA << 24);
}

// Compute a texture array size (2048x2048xD) that can fit numSplats splats and
// return the total number of splats that can be stored in such a texture.
export function computeMaxSplats(numSplats: number): number {
  const width = SPLAT_TEX_WIDTH;
  const height = Math.max(
    SPLAT_TEX_MIN_HEIGHT,
    Math.min(SPLAT_TEX_HEIGHT, Math.ceil(numSplats / width)),
  );
  const depth = Math.ceil(numSplats / (width * height));
  return width * height * depth;
}

// Pack four signed 8-bit values into a single uint32.
function packSint8Bytes(
  b0: number,
  b1: number,
  b2: number,
  b3: number,
): number {
  const clampedB0 = Math.round(Math.max(-127, Math.min(127, b0 * 127)));
  const clampedB1 = Math.round(Math.max(-127, Math.min(127, b1 * 127)));
  const clampedB2 = Math.round(Math.max(-127, Math.min(127, b2 * 127)));
  const clampedB3 = Math.round(Math.max(-127, Math.min(127, b3 * 127)));
  return (
    (clampedB0 & 0xff) |
    ((clampedB1 & 0xff) << 8) |
    ((clampedB2 & 0xff) << 16) |
    ((clampedB3 & 0xff) << 24)
  );
}

// Encode an array of 9 signed RGB SH1 coefficients (clamped to [-1,1]) into
// a pair of uint32 values, where each coefficient is stored as a sint7
export function encodeSh1Rgb(
  sh1Array: Uint32Array,
  index: number,
  sh1Rgb: Float32Array,
  encoding?: {
    sh1Max?: number;
  },
) {
  const sh1Max = encoding?.sh1Max ?? 1;
  const sh1Scale = 63 / sh1Max;

  // Pack sint7 values into 2 x uint32
  const base = index * 2;
  for (let i = 0; i < 9; ++i) {
    const s = sh1Rgb[i] * sh1Scale;
    const value = Math.round(Math.max(-63, Math.min(63, s))) & 0x7f;
    const bitStart = i * 7;
    const bitEnd = bitStart + 7;

    const wordStart = Math.floor(bitStart / 32);
    const bitOffset = bitStart - wordStart * 32;
    const firstWord = (value << bitOffset) & 0xffffffff;
    sh1Array[base + wordStart] |= firstWord;

    if (bitEnd > wordStart * 32 + 32) {
      const secondWord = (value >>> (32 - bitOffset)) & 0xffffffff;
      sh1Array[base + wordStart + 1] |= secondWord;
    }
  }
}

// Encode an array of 15 signed RGB SH2 coefficients (clamped to [-1,1]) into
// an array of 4 uint32 values, where each coefficient is stored as a sint8.
export function encodeSh2Rgb(
  sh2Array: Uint32Array,
  index: number,
  sh2Rgb: Float32Array,
  encoding?: {
    sh2Max?: number;
  },
) {
  const sh2Max = encoding?.sh2Max ?? 1;
  const sh2Scale = 1 / sh2Max;

  // Pack sint8 values into 4 x uint32
  sh2Array[index * 4 + 0] = packSint8Bytes(
    sh2Rgb[0] * sh2Scale,
    sh2Rgb[1] * sh2Scale,
    sh2Rgb[2] * sh2Scale,
    sh2Rgb[3] * sh2Scale,
  );
  sh2Array[index * 4 + 1] = packSint8Bytes(
    sh2Rgb[4] * sh2Scale,
    sh2Rgb[5] * sh2Scale,
    sh2Rgb[6] * sh2Scale,
    sh2Rgb[7] * sh2Scale,
  );
  sh2Array[index * 4 + 2] = packSint8Bytes(
    sh2Rgb[8] * sh2Scale,
    sh2Rgb[9] * sh2Scale,
    sh2Rgb[10] * sh2Scale,
    sh2Rgb[11] * sh2Scale,
  );
  sh2Array[index * 4 + 3] = packSint8Bytes(
    sh2Rgb[12] * sh2Scale,
    sh2Rgb[13] * sh2Scale,
    sh2Rgb[14] * sh2Scale,
    0,
  );
}

// Encode an array of 21 signed RGB SH3 coefficients (clamped to [-1,1]) into
// an array of 4 uint32 values, where each coefficient is stored as a sint6.
export function encodeSh3Rgb(
  sh3Array: Uint32Array,
  index: number,
  sh3Rgb: Float32Array,
  encoding?: {
    sh3Max?: number;
  },
) {
  const sh3Max = encoding?.sh3Max ?? 1;
  const sh3Scale = 31 / sh3Max;

  // Pack sint6 values into 4 x uint32
  const base = index * 4;
  for (let i = 0; i < 21; ++i) {
    const s = sh3Rgb[i] * sh3Scale;
    const value = Math.round(Math.max(-31, Math.min(31, s))) & 0x3f;
    const bitStart = i * 6;
    const bitEnd = bitStart + 6;

    const wordStart = Math.floor(bitStart / 32);
    const bitOffset = bitStart - wordStart * 32;
    const firstWord = (value << bitOffset) & 0xffffffff;
    sh3Array[base + wordStart] |= firstWord;

    if (bitEnd > wordStart * 32 + 32) {
      const secondWord = (value >>> (32 - bitOffset)) & 0xffffffff;
      sh3Array[base + wordStart + 1] |= secondWord;
    }
  }
}

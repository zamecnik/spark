const LN_SCALE_MIN = -12;
const LN_SCALE_MAX = 9;
const SCALE_MIN = Math.exp(LN_SCALE_MIN);
const SCALE_MAX = Math.exp(LN_SCALE_MAX);
const LN_SCALE_ZERO = -30;
const SCALE_ZERO = Math.exp(LN_SCALE_ZERO);
const SPLAT_TEX_WIDTH_BITS = 11;
const SPLAT_TEX_HEIGHT_BITS = 11;
const SPLAT_TEX_DEPTH_BITS = 11;
const SPLAT_TEX_LAYER_BITS = SPLAT_TEX_WIDTH_BITS + SPLAT_TEX_HEIGHT_BITS;
const SPLAT_TEX_WIDTH = 1 << SPLAT_TEX_WIDTH_BITS;
const SPLAT_TEX_HEIGHT = 1 << SPLAT_TEX_HEIGHT_BITS;
const SPLAT_TEX_DEPTH = 1 << SPLAT_TEX_DEPTH_BITS;
const SPLAT_TEX_MIN_HEIGHT = 1;
const SPLAT_TEX_WIDTH_MASK = SPLAT_TEX_WIDTH - 1;
const SPLAT_TEX_HEIGHT_MASK = SPLAT_TEX_HEIGHT - 1;
const SPLAT_TEX_DEPTH_MASK = SPLAT_TEX_DEPTH - 1;
const WASM_SPLAT_SORT = true;
const USE_COMPILED_PARSER_FUNCTION = true;
var SplatFileType = /* @__PURE__ */ ((SplatFileType2) => {
  SplatFileType2["PLY"] = "ply";
  SplatFileType2["SPZ"] = "spz";
  SplatFileType2["SPLAT"] = "splat";
  SplatFileType2["KSPLAT"] = "ksplat";
  SplatFileType2["PCSOGS"] = "pcsogs";
  SplatFileType2["PCSOGSZIP"] = "pcsogszip";
  SplatFileType2["RAD"] = "rad";
  SplatFileType2["SSOG"] = "ssog";
  return SplatFileType2;
})(SplatFileType || {});
const DEFAULT_SPLAT_ENCODING = {
  rgbMin: 0,
  rgbMax: 1,
  lnScaleMin: LN_SCALE_MIN,
  lnScaleMax: LN_SCALE_MAX,
  sh1Max: 1,
  sh2Max: 1,
  sh3Max: 1,
  lodOpacity: false
};
const defines = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  DEFAULT_SPLAT_ENCODING,
  LN_SCALE_MAX,
  LN_SCALE_MIN,
  LN_SCALE_ZERO,
  SCALE_MAX,
  SCALE_MIN,
  SCALE_ZERO,
  SPLAT_TEX_DEPTH,
  SPLAT_TEX_DEPTH_BITS,
  SPLAT_TEX_DEPTH_MASK,
  SPLAT_TEX_HEIGHT,
  SPLAT_TEX_HEIGHT_BITS,
  SPLAT_TEX_HEIGHT_MASK,
  SPLAT_TEX_LAYER_BITS,
  SPLAT_TEX_MIN_HEIGHT,
  SPLAT_TEX_WIDTH,
  SPLAT_TEX_WIDTH_BITS,
  SPLAT_TEX_WIDTH_MASK,
  SplatFileType,
  USE_COMPILED_PARSER_FUNCTION,
  WASM_SPLAT_SORT
}, Symbol.toStringTag, { value: "Module" }));
const f32buffer = new Float32Array(1);
const u32buffer = new Uint32Array(f32buffer.buffer);
const supportsFloat16Array = "Float16Array" in globalThis;
const f16buffer = supportsFloat16Array ? new globalThis["Float16Array"](1) : null;
const u16buffer = new Uint16Array(f16buffer == null ? void 0 : f16buffer.buffer);
const toHalf = supportsFloat16Array ? toHalfNative : toHalfJS;
const fromHalf = supportsFloat16Array ? fromHalfNative : fromHalfJS;
function toHalfNative(f) {
  f16buffer[0] = f;
  return u16buffer[0];
}
function toHalfJS(f) {
  f32buffer[0] = f;
  const bits = u32buffer[0];
  const sign = bits >> 31 & 1;
  const exp = bits >> 23 & 255;
  const frac = bits & 8388607;
  const halfSign = sign << 15;
  if (exp === 255) {
    if (frac !== 0) {
      return halfSign | 32767;
    }
    return halfSign | 31744;
  }
  const newExp = exp - 127 + 15;
  if (newExp >= 31) {
    return halfSign | 31744;
  }
  if (newExp <= 0) {
    if (newExp < -10) {
      return halfSign;
    }
    const subFrac = (frac | 8388608) >> 1 - newExp + 13;
    return halfSign | subFrac;
  }
  const halfFrac = frac >> 13;
  return halfSign | newExp << 10 | halfFrac;
}
function fromHalfNative(u) {
  u16buffer[0] = u;
  return f16buffer[0];
}
function fromHalfJS(h) {
  const sign = h >> 15 & 1;
  const exp = h >> 10 & 31;
  const frac = h & 1023;
  let f32bits;
  if (exp === 0) {
    if (frac === 0) {
      f32bits = sign << 31;
    } else {
      let mant = frac;
      let e = -14;
      while ((mant & 1024) === 0) {
        mant <<= 1;
        e--;
      }
      mant &= 1023;
      const newExp = e + 127;
      const newFrac = mant << 13;
      f32bits = sign << 31 | newExp << 23 | newFrac;
    }
  } else if (exp === 31) {
    if (frac === 0) {
      f32bits = sign << 31 | 2139095040;
    } else {
      f32bits = sign << 31 | 2143289344;
    }
  } else {
    const newExp = exp - 15 + 127;
    const newFrac = frac << 13;
    f32bits = sign << 31 | newExp << 23 | newFrac;
  }
  u32buffer[0] = f32bits;
  return f32buffer[0];
}
function floatToUint8(v) {
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}
function encodeQuatOctXy88R8(q) {
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
  if (w < 0) {
    x = -x;
    y = -y;
    z = -z;
    w = -w;
  }
  const theta = 2 * Math.acos(w);
  const xyz_norm = Math.sqrt(x * x + y * y + z * z);
  let axisX;
  let axisY;
  let axisZ;
  if (xyz_norm < 1e-6) {
    axisX = 1;
    axisY = 0;
    axisZ = 0;
  } else {
    axisX = x / xyz_norm;
    axisY = y / xyz_norm;
    axisZ = z / xyz_norm;
  }
  const sum = Math.abs(axisX) + Math.abs(axisY) + Math.abs(axisZ);
  let p_x = axisX / sum;
  let p_y = axisY / sum;
  if (axisZ < 0) {
    const tmp = p_x;
    p_x = (1 - Math.abs(p_y)) * (p_x >= 0 ? 1 : -1);
    p_y = (1 - Math.abs(tmp)) * (p_y >= 0 ? 1 : -1);
  }
  const u_f = p_x * 0.5 + 0.5;
  const v_f = p_y * 0.5 + 0.5;
  const quantU = Math.round(u_f * 255);
  const quantV = Math.round(v_f * 255);
  const angleInt = Math.round(theta * (255 / Math.PI));
  return angleInt << 16 | quantV << 8 | quantU;
}
function setPackedSplatCenter(packedSplats, index, x, y, z) {
  const uCenterX = toHalf(x);
  const uCenterY = toHalf(y);
  const uCenterZ = toHalf(z);
  const i4 = index * 4;
  packedSplats[i4 + 1] = uCenterX | uCenterY << 16;
  packedSplats[i4 + 2] = uCenterZ | packedSplats[i4 + 2] & 4294901760;
}
function setPackedSplatScales(packedSplats, index, scaleX, scaleY, scaleZ, encoding) {
  const lnScaleMin = (encoding == null ? void 0 : encoding.lnScaleMin) ?? LN_SCALE_MIN;
  const lnScaleMax = (encoding == null ? void 0 : encoding.lnScaleMax) ?? LN_SCALE_MAX;
  const lnScaleScale = 254 / (lnScaleMax - lnScaleMin);
  const uScaleX = scaleX < SCALE_ZERO ? 0 : Math.min(
    255,
    Math.max(
      1,
      Math.round((Math.log(scaleX) - lnScaleMin) * lnScaleScale) + 1
    )
  );
  const uScaleY = scaleY < SCALE_ZERO ? 0 : Math.min(
    255,
    Math.max(
      1,
      Math.round((Math.log(scaleY) - lnScaleMin) * lnScaleScale) + 1
    )
  );
  const uScaleZ = scaleZ < SCALE_ZERO ? 0 : Math.min(
    255,
    Math.max(
      1,
      Math.round((Math.log(scaleZ) - lnScaleMin) * lnScaleScale) + 1
    )
  );
  const i4 = index * 4;
  packedSplats[i4 + 3] = uScaleX | uScaleY << 8 | uScaleZ << 16 | packedSplats[i4 + 3] & 4278190080;
}
function setPackedSplatQuat(packedSplats, index, quatX, quatY, quatZ, quatW) {
  const uQuat = encodeQuatOctXy88R8({
    x: quatX,
    y: quatY,
    z: quatZ,
    w: quatW
  });
  const uQuatX = uQuat & 255;
  const uQuatY = uQuat >>> 8 & 255;
  const uQuatZ = uQuat >>> 16 & 255;
  const i4 = index * 4;
  packedSplats[i4 + 2] = packedSplats[i4 + 2] & 65535 | uQuatX << 16 | uQuatY << 24;
  packedSplats[i4 + 3] = packedSplats[i4 + 3] & 16777215 | uQuatZ << 24;
}
function setPackedSplatRgba(packedSplats, index, r, g, b, a, encoding) {
  const rgbMin = (encoding == null ? void 0 : encoding.rgbMin) ?? 0;
  const rgbMax = (encoding == null ? void 0 : encoding.rgbMax) ?? 1;
  const rgbRange = rgbMax - rgbMin;
  const uR = floatToUint8((r - rgbMin) / rgbRange);
  const uG = floatToUint8((g - rgbMin) / rgbRange);
  const uB = floatToUint8((b - rgbMin) / rgbRange);
  const uA = floatToUint8((encoding == null ? void 0 : encoding.lodOpacity) ? 0.5 * a : a);
  const i4 = index * 4;
  packedSplats[i4] = uR | uG << 8 | uB << 16 | uA << 24;
}
function computeMaxSplats(numSplats) {
  const width = SPLAT_TEX_WIDTH;
  const height = Math.max(
    SPLAT_TEX_MIN_HEIGHT,
    Math.min(SPLAT_TEX_HEIGHT, Math.ceil(numSplats / width))
  );
  const depth = Math.ceil(numSplats / (width * height));
  return width * height * depth;
}
function packSint8Bytes(b0, b1, b2, b3) {
  const clampedB0 = Math.round(Math.max(-127, Math.min(127, b0 * 127)));
  const clampedB1 = Math.round(Math.max(-127, Math.min(127, b1 * 127)));
  const clampedB2 = Math.round(Math.max(-127, Math.min(127, b2 * 127)));
  const clampedB3 = Math.round(Math.max(-127, Math.min(127, b3 * 127)));
  return clampedB0 & 255 | (clampedB1 & 255) << 8 | (clampedB2 & 255) << 16 | (clampedB3 & 255) << 24;
}
function encodeSh1Rgb(sh1Array, index, sh1Rgb, encoding) {
  const sh1Max = (encoding == null ? void 0 : encoding.sh1Max) ?? 1;
  const sh1Scale = 63 / sh1Max;
  const base = index * 2;
  for (let i = 0; i < 9; ++i) {
    const s = sh1Rgb[i] * sh1Scale;
    const value = Math.round(Math.max(-63, Math.min(63, s))) & 127;
    const bitStart = i * 7;
    const bitEnd = bitStart + 7;
    const wordStart = Math.floor(bitStart / 32);
    const bitOffset = bitStart - wordStart * 32;
    const firstWord = value << bitOffset & 4294967295;
    sh1Array[base + wordStart] |= firstWord;
    if (bitEnd > wordStart * 32 + 32) {
      const secondWord = value >>> 32 - bitOffset & 4294967295;
      sh1Array[base + wordStart + 1] |= secondWord;
    }
  }
}
function encodeSh2Rgb(sh2Array, index, sh2Rgb, encoding) {
  const sh2Max = (encoding == null ? void 0 : encoding.sh2Max) ?? 1;
  const sh2Scale = 1 / sh2Max;
  sh2Array[index * 4 + 0] = packSint8Bytes(
    sh2Rgb[0] * sh2Scale,
    sh2Rgb[1] * sh2Scale,
    sh2Rgb[2] * sh2Scale,
    sh2Rgb[3] * sh2Scale
  );
  sh2Array[index * 4 + 1] = packSint8Bytes(
    sh2Rgb[4] * sh2Scale,
    sh2Rgb[5] * sh2Scale,
    sh2Rgb[6] * sh2Scale,
    sh2Rgb[7] * sh2Scale
  );
  sh2Array[index * 4 + 2] = packSint8Bytes(
    sh2Rgb[8] * sh2Scale,
    sh2Rgb[9] * sh2Scale,
    sh2Rgb[10] * sh2Scale,
    sh2Rgb[11] * sh2Scale
  );
  sh2Array[index * 4 + 3] = packSint8Bytes(
    sh2Rgb[12] * sh2Scale,
    sh2Rgb[13] * sh2Scale,
    sh2Rgb[14] * sh2Scale,
    0
  );
}
function encodeSh3Rgb(sh3Array, index, sh3Rgb, encoding) {
  const sh3Max = (encoding == null ? void 0 : encoding.sh3Max) ?? 1;
  const sh3Scale = 31 / sh3Max;
  const base = index * 4;
  for (let i = 0; i < 21; ++i) {
    const s = sh3Rgb[i] * sh3Scale;
    const value = Math.round(Math.max(-31, Math.min(31, s))) & 63;
    const bitStart = i * 6;
    const bitEnd = bitStart + 6;
    const wordStart = Math.floor(bitStart / 32);
    const bitOffset = bitStart - wordStart * 32;
    const firstWord = value << bitOffset & 4294967295;
    sh3Array[base + wordStart] |= firstWord;
    if (bitEnd > wordStart * 32 + 32) {
      const secondWord = value >>> 32 - bitOffset & 4294967295;
      sh3Array[base + wordStart + 1] |= secondWord;
    }
  }
}
export {
  DEFAULT_SPLAT_ENCODING as D,
  LN_SCALE_MIN as L,
  SPLAT_TEX_WIDTH as S,
  SPLAT_TEX_MIN_HEIGHT as a,
  SPLAT_TEX_HEIGHT as b,
  LN_SCALE_MAX as c,
  floatToUint8 as d,
  encodeQuatOctXy88R8 as e,
  fromHalf as f,
  SCALE_ZERO as g,
  computeMaxSplats as h,
  encodeSh1Rgb as i,
  encodeSh2Rgb as j,
  encodeSh3Rgb as k,
  setPackedSplatQuat as l,
  setPackedSplatRgba as m,
  setPackedSplatScales as n,
  SplatFileType as o,
  defines as p,
  setPackedSplatCenter as s,
  toHalf as t
};
//# sourceMappingURL=packedEncode-B2G8iOqc.js.map

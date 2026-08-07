// Kroscloud WebGPU fork (2026) — see FORK-CHANGES.md.
//
// TSL port of the packed-splat unpack half of shaders/splatDefines.glsl.
// Every function here is a mechanical, line-for-line port of its GLSL
// namesake; do not "improve" the math — pixel parity with the WebGL2 path
// depends on it staying literal (fork plan §4.3, parity rows 1/3-9).
//
// The helpers are plain functions that inline node expressions into the
// caller's graph (no Fn() indirection), so they can be used from compute
// kernels and vertex stages alike.

import type * as THREE from "three";
import * as TSL from "three/tsl";
import {
  exp,
  float,
  int,
  ivec3,
  max,
  normalize,
  select,
  uint,
  vec2,
  vec3,
  vec4,
} from "three/tsl";

// Exists in the r185 runtime and matches THREE.DataUtils halves exactly
// (P0/S2); missing from the 0.180 type declarations only.
// biome-ignore lint/suspicious/noExplicitAny: types lag the runtime
const unpackHalf2x16: (node: unknown) => any = (TSL as any).unpackHalf2x16;

// TSL node handles are structurally untyped here; the runtime graph builder
// carries the real types.
// biome-ignore-all lint/suspicious/noExplicitAny: TSL graph nodes
export type TslNode = any;

// splatDefines.glsl constants (splatTexCoord tiling)
export const SPLAT_TEX_WIDTH_BITS = 11;
export const SPLAT_TEX_LAYER_BITS = 22;
export const SPLAT_TEX_MASK = 2047;

// ivec3 splatTexCoord(int index) — 2048-wide tiling of the non-paged source
// texture. Index math MUST stay identical to the GLSL: the SH textures are
// co-indexed with the packed texture through this same function.
export function splatTexCoordTsl(index: TslNode): TslNode {
  const u = uint(index);
  const x = u.bitAnd(uint(SPLAT_TEX_MASK));
  const y = u.shiftRight(uint(SPLAT_TEX_WIDTH_BITS)).bitAnd(uint(SPLAT_TEX_MASK));
  const z = u.shiftRight(uint(SPLAT_TEX_LAYER_BITS));
  return ivec3(int(x), int(y), int(z));
}

// ivec3 pagedSplatTexCoord(int index) — 256-wide tiling of the pager pool
// (page = index >> 16, slot = index & 0xFFFF). Used by the paged path (P3).
export function pagedSplatTexCoordTsl(index: TslNode): TslNode {
  const i = uint(index);
  return ivec3(
    int(i.bitAnd(uint(255))),
    int(i.shiftRight(uint(8)).bitAnd(uint(255))),
    int(i.shiftRight(uint(16))),
  );
}

// vec4 decodeQuatOctXy88R8(uint encoded) — folded octahedral axis (8+8 bits)
// + angle (8 bits). Literal port including the 3.14159265359 literal (the
// GLSL decoder uses that literal, not the higher-precision PI constant).
export function decodeQuatOctXy88R8Tsl(encoded: TslNode): TslNode {
  const quantU = encoded.bitAnd(uint(0xff));
  const quantV = encoded.shiftRight(uint(8)).bitAnd(uint(0xff));
  const angleInt = encoded.shiftRight(uint(16));

  const uF = float(quantU).div(255.0);
  const vF = float(quantV).div(255.0);
  const f = vec2(uF.mul(2.0).sub(1.0), vF.mul(2.0).sub(1.0));

  const az = float(1.0).sub(f.x.abs()).sub(f.y.abs());
  const t = max(az.negate(), 0.0);
  const ax = f.x.add(select(f.x.greaterThanEqual(0.0), t.negate(), t));
  const ay = f.y.add(select(f.y.greaterThanEqual(0.0), t.negate(), t));
  const axis = normalize(vec3(ax, ay, az));

  const theta = float(angleInt).div(255.0).mul(3.14159265359);
  const halfTheta = theta.mul(0.5);
  const s = halfTheta.sin();
  const w = halfTheta.cos();
  return vec4(axis.mul(s), w);
}

export type UnpackedSplatTsl = {
  center: TslNode; // vec3
  scales: TslNode; // vec3
  quaternion: TslNode; // vec4
  rgba: TslNode; // vec4 (rgb mapped through rgbMin/rgbMax; alpha raw u8/255)
};

// void unpackSplatEncoding(uvec4, out..., vec4 rgbMinMaxLnScaleMinMax)
// packedData is the uvec4 texel; rgbMinMaxLnScaleMinMax is (rgbMin, rgbMax,
// lnScaleMin, lnScaleMax) — pass the PackedSplats encoding uniform.
export function unpackSplatEncodingTsl(
  packedData: TslNode,
  rgbMinMaxLnScaleMinMax: TslNode,
): UnpackedSplatTsl {
  const word0 = packedData.x;
  const word1 = packedData.y;
  const word2 = packedData.z;
  const word3 = packedData.w;

  const rgbMin = rgbMinMaxLnScaleMinMax.x;
  const rgbMax = rgbMinMaxLnScaleMinMax.y;
  const uR = float(word0.bitAnd(uint(0xff)));
  const uG = float(word0.shiftRight(uint(8)).bitAnd(uint(0xff)));
  const uB = float(word0.shiftRight(uint(16)).bitAnd(uint(0xff)));
  const uA = float(word0.shiftRight(uint(24)).bitAnd(uint(0xff)));
  const rgb = vec3(uR, uG, uB)
    .div(255.0)
    .mul(rgbMax.sub(rgbMin))
    .add(rgbMin);
  const rgba = vec4(rgb, uA.div(255.0));

  const xy = unpackHalf2x16(word1);
  const zw = unpackHalf2x16(word2.bitAnd(uint(0xffff)));
  const center = vec3(xy.x, xy.y, zw.x);

  const uSx = word3.bitAnd(uint(0xff));
  const uSy = word3.shiftRight(uint(8)).bitAnd(uint(0xff));
  const uSz = word3.shiftRight(uint(16)).bitAnd(uint(0xff));
  const lnScaleMin = rgbMinMaxLnScaleMinMax.z;
  const lnScaleMax = rgbMinMaxLnScaleMinMax.w;
  const lnScaleScale = lnScaleMax.sub(lnScaleMin).div(254.0);
  // (uScale == 0) is the zero-size sentinel; the subtraction underflows in
  // the unselected lane, which select() masks out.
  const decodeScale = (uS: TslNode) =>
    select(
      uS.equal(uint(0)),
      float(0.0),
      exp(lnScaleMin.add(float(uS.sub(uint(1))).mul(lnScaleScale))),
    );
  const scales = vec3(decodeScale(uSx), decodeScale(uSy), decodeScale(uSz));

  const uQuat = word2
    .shiftRight(uint(16))
    .bitAnd(uint(0xffff))
    .bitOr(word3.shiftRight(uint(8)).bitAnd(uint(0xff0000)));
  const quaternion = decodeQuatOctXy88R8Tsl(uQuat);

  return { center, scales, quaternion, rgba };
}

// vec3 quatVec(vec4 q, vec3 v) — rotate v by quaternion q.
export function quatVecTsl(q: TslNode, v: TslNode): TslNode {
  const qxyz = vec3(q.x, q.y, q.z);
  const t = qxyz.cross(v).mul(2.0);
  return v.add(t.mul(q.w)).add(qxyz.cross(t));
}

// vec4 quatQuat(vec4 q1, vec4 q2) — apply q1 after q2.
export function quatQuatTsl(q1: TslNode, q2: TslNode): TslNode {
  return vec4(
    q1.w.mul(q2.x).add(q1.x.mul(q2.w)).add(q1.y.mul(q2.z)).sub(q1.z.mul(q2.y)),
    q1.w.mul(q2.y).sub(q1.x.mul(q2.z)).add(q1.y.mul(q2.w)).add(q1.z.mul(q2.x)),
    q1.w.mul(q2.z).add(q1.x.mul(q2.y)).sub(q1.y.mul(q2.x)).add(q1.z.mul(q2.w)),
    q1.w.mul(q2.w).sub(q1.x.mul(q2.x)).sub(q1.y.mul(q2.y)).sub(q1.z.mul(q2.z)),
  );
}

// mat3 scaleQuaternionToMatrix(vec3 s, vec4 q) — scale by s then rotate by q.
// Returns the three COLUMNS (GLSL mat3 fills columns first); the caller
// assembles the mat3 so compute kernels can also use raw columns.
export function scaleQuaternionToMatrixColumnsTsl(
  s: TslNode,
  q: TslNode,
): [TslNode, TslNode, TslNode] {
  const two = float(2.0);
  const col0 = vec3(
    s.x.mul(float(1.0).sub(two.mul(q.y.mul(q.y).add(q.z.mul(q.z))))),
    s.x.mul(two.mul(q.x.mul(q.y).add(q.w.mul(q.z)))),
    s.x.mul(two.mul(q.x.mul(q.z).sub(q.w.mul(q.y)))),
  );
  const col1 = vec3(
    s.y.mul(two.mul(q.x.mul(q.y).sub(q.w.mul(q.z)))),
    s.y.mul(float(1.0).sub(two.mul(q.x.mul(q.x).add(q.z.mul(q.z))))),
    s.y.mul(two.mul(q.y.mul(q.z).add(q.w.mul(q.x)))),
  );
  const col2 = vec3(
    s.z.mul(two.mul(q.x.mul(q.z).add(q.w.mul(q.y)))),
    s.z.mul(two.mul(q.y.mul(q.z).sub(q.w.mul(q.x)))),
    s.z.mul(float(1.0).sub(two.mul(q.x.mul(q.x).add(q.y.mul(q.y))))),
  );
  return [col0, col1, col2];
}

// r185 WebGPU backend trap (P0 diag D7): a WebGL internalFormat string like
// 'RGBA32UI' silently disables the WebGPU texture upload (all-zero reads,
// zero validation errors). Spark sets internalFormat in PackedSplats and
// SplatPager; every texture handed to the WebGPU path must pass through here.
export function stripWebGLInternalFormat<T extends THREE.Texture>(tex: T): T {
  if ((tex as { internalFormat?: string | null }).internalFormat != null) {
    (tex as { internalFormat?: string | null }).internalFormat = null;
    tex.needsUpdate = true;
  }
  return tex;
}

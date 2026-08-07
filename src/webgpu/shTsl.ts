// Kroscloud WebGPU fork (2026) — see FORK-CHANGES.md.
//
// TSL port of the packed spherical-harmonics evaluation from
// PackedSplats.ts (defineEvalPackedSH1/2/3): sign-extending, word-straddling
// extraction of sint7 (SH1, 2×u32), sint8 (SH2, 4×u32) and sint6 (SH3,
// 4×u32) coefficient triplets, dequantized by shMax/{63,127,31}. Bit-exact
// port — the shift/straddle table below IS the file format (fork plan §2/Q2,
// parity rows implemented here). SH textures are co-indexed with the packed
// splat texture via the same splatTexCoord tiling.

import type * as THREE from "three";
import { float, int, textureLoad, uint, vec3 } from "three/tsl";
import type { TslNode } from "./packedSplatsTsl";

// float(int(word << shl) >> sr) — the GLSL sign-extension idiom. WGSL's
// i32(u32) conversion wraps modulo 2^32 (bit reinterpretation), matching
// GLSL int(uint); >> on i32 is arithmetic, so the sign bit propagates.
function sext(word: TslNode, shl: number, sr: number): TslNode {
  const shifted = shl === 0 ? word : word.shiftLeft(uint(shl));
  return float(int(shifted).shiftRight(uint(sr)));
}

// straddle: float(int((lo >> shr) | (hi << shl)) >> sr)
function sextStraddle(
  lo: TslNode,
  loShr: number,
  hi: TslNode,
  hiShl: number,
  sr: number,
): TslNode {
  const combined = lo.shiftRight(uint(loShr)).bitOr(hi.shiftLeft(uint(hiShl)));
  return float(int(combined).shiftRight(uint(sr)));
}

// vec3 evaluatePackedSH1(uvec2 packedData, vec3 viewDir, float sh1Max)
export function evaluatePackedSH1Tsl(
  packedData: TslNode, // .x/.y = the RG32UI texel words
  viewDir: TslNode,
  sh1Max: TslNode,
): TslNode {
  const px = packedData.x;
  const py = packedData.y;
  const sh1_0 = vec3(sext(px, 25, 25), sext(px, 18, 25), sext(px, 11, 25));
  const sh1_1 = vec3(
    sext(px, 4, 25),
    sextStraddle(px, 3, py, 29, 25),
    sext(py, 22, 25),
  );
  const sh1_2 = vec3(sext(py, 15, 25), sext(py, 8, 25), sext(py, 1, 25));

  const rgb = sh1_0
    .mul(viewDir.y.mul(-0.4886025))
    .add(sh1_1.mul(viewDir.z.mul(0.4886025)))
    .add(sh1_2.mul(viewDir.x.mul(-0.4886025)));
  return rgb.mul(sh1Max.div(63.0));
}

// vec3 evaluatePackedSH2(uvec4 packedData, vec3 viewDir, float sh2Max)
export function evaluatePackedSH2Tsl(
  packedData: TslNode,
  viewDir: TslNode,
  sh2Max: TslNode,
): TslNode {
  const px = packedData.x;
  const py = packedData.y;
  const pz = packedData.z;
  const pw = packedData.w;
  const sh2_0 = vec3(sext(px, 24, 24), sext(px, 16, 24), sext(px, 8, 24));
  const sh2_1 = vec3(sext(px, 0, 24), sext(py, 24, 24), sext(py, 16, 24));
  const sh2_2 = vec3(sext(py, 8, 24), sext(py, 0, 24), sext(pz, 24, 24));
  const sh2_3 = vec3(sext(pz, 16, 24), sext(pz, 8, 24), sext(pz, 0, 24));
  const sh2_4 = vec3(sext(pw, 24, 24), sext(pw, 16, 24), sext(pw, 8, 24));

  const x = viewDir.x;
  const y = viewDir.y;
  const z = viewDir.z;
  const rgb = sh2_0
    .mul(x.mul(y).mul(1.0925484))
    .add(sh2_1.mul(y.mul(z).mul(-1.0925484)))
    .add(
      sh2_2.mul(
        z.mul(z).mul(2.0).sub(x.mul(x)).sub(y.mul(y)).mul(0.3153915),
      ),
    )
    .add(sh2_3.mul(x.mul(z).mul(-1.0925484)))
    .add(sh2_4.mul(x.mul(x).sub(y.mul(y)).mul(0.5462742)));
  return rgb.mul(sh2Max.div(127.0));
}

// vec3 evaluatePackedSH3(uvec4 packedData, vec3 viewDir, float sh3Max)
export function evaluatePackedSH3Tsl(
  packedData: TslNode,
  viewDir: TslNode,
  sh3Max: TslNode,
): TslNode {
  const px = packedData.x;
  const py = packedData.y;
  const pz = packedData.z;
  const pw = packedData.w;
  const sh3_0 = vec3(sext(px, 26, 26), sext(px, 20, 26), sext(px, 14, 26));
  const sh3_1 = vec3(
    sext(px, 8, 26),
    sext(px, 2, 26),
    sextStraddle(px, 4, py, 28, 26),
  );
  const sh3_2 = vec3(sext(py, 22, 26), sext(py, 16, 26), sext(py, 10, 26));
  const sh3_3 = vec3(
    sext(py, 4, 26),
    sextStraddle(py, 2, pz, 30, 26),
    sext(pz, 24, 26),
  );
  const sh3_4 = vec3(sext(pz, 18, 26), sext(pz, 12, 26), sext(pz, 6, 26));
  const sh3_5 = vec3(sext(pz, 0, 26), sext(pw, 26, 26), sext(pw, 20, 26));
  const sh3_6 = vec3(sext(pw, 14, 26), sext(pw, 8, 26), sext(pw, 2, 26));

  const x = viewDir.x;
  const y = viewDir.y;
  const z = viewDir.z;
  const xx = x.mul(x);
  const yy = y.mul(y);
  const zz = z.mul(z);
  const xy = x.mul(y);

  const rgb = sh3_0
    .mul(y.mul(xx.mul(3.0).sub(yy)).mul(-0.5900436))
    .add(sh3_1.mul(xy.mul(z).mul(2.8906114)))
    .add(sh3_2.mul(y.mul(zz.mul(4.0).sub(xx).sub(yy)).mul(-0.4570458)))
    .add(
      sh3_3.mul(
        z.mul(zz.mul(2.0).sub(xx.mul(3.0)).sub(yy.mul(3.0))).mul(0.3731763),
      ),
    )
    .add(sh3_4.mul(x.mul(zz.mul(4.0).sub(xx).sub(yy)).mul(-0.4570458)))
    .add(sh3_5.mul(z.mul(xx.sub(yy)).mul(1.4453057)))
    .add(sh3_6.mul(x.mul(xx.sub(yy.mul(3.0))).mul(-0.5900436)));
  return rgb.mul(sh3Max.div(31.0));
}

// Degree-gated evaluation at a texel coordinate, mirroring evaluatePackedSH.
// The stock GLSL gates on a runtime numSh int; here texture PRESENCE is the
// gate (a degree whose texture is absent cannot be bound at all), and the
// caller clamps degree via which textures it passes (min(fileSh, maxSh)).
export function evaluatePackedShTsl({
  coord, // ivec3 from splatTexCoordTsl — MUST be the packed-texture coord
  viewDir, // vec3, object space: normalize(center - viewOrigin)
  shMax, // vec3 uniform (sh1Max, sh2Max, sh3Max)
  sh1Texture,
  sh2Texture,
  sh3Texture,
}: {
  coord: TslNode;
  viewDir: TslNode;
  shMax: TslNode;
  sh1Texture?: THREE.DataArrayTexture;
  sh2Texture?: THREE.DataArrayTexture;
  sh3Texture?: THREE.DataArrayTexture;
}): TslNode {
  let rgb: TslNode = vec3(0.0);
  if (sh1Texture) {
    const t1 = textureLoad(sh1Texture, coord.xy).depth(coord.z);
    rgb = rgb.add(evaluatePackedSH1Tsl(t1, viewDir, shMax.x));
    if (sh2Texture) {
      const t2 = textureLoad(sh2Texture, coord.xy).depth(coord.z);
      rgb = rgb.add(evaluatePackedSH2Tsl(t2, viewDir, shMax.y));
      if (sh3Texture) {
        const t3 = textureLoad(sh3Texture, coord.xy).depth(coord.z);
        rgb = rgb.add(evaluatePackedSH3Tsl(t3, viewDir, shMax.z));
      }
    }
  }
  return rgb;
}

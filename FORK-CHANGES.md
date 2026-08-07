# Kroscloud fork of @sparkjsdev/spark — change log

This is a fork of [sparkjsdev/spark](https://github.com/sparkjsdev/spark) maintained by
Kroscloud, branched from upstream tag `v2.1.0` (f22236f). Upstream is MIT-licensed by
World Labs Technologies, Inc.; the upstream `LICENSE` file is retained unchanged.

Fork purpose: add an **additive WebGPU render path** (TSL node material + GPU radix
sort) for three.js `WebGPURenderer`, replacing Spark's WebGL2 readback→CPU-sort
pipeline on capable devices. The WebGL2 path stays byte-identical to upstream and
remains the default/fallback (`webgpuPipeline: 'off'`).

Conventions:
- All new code is additive under `src/webgpu/`.
- Every touched upstream file carries a `Modified by Kroscloud, 2026` header comment
  and is listed here.
- No upstream file is reformatted (biome untouched); diffs are kept minimal for
  rebase-on-tags maintenance.

## Modified upstream files

| File | Change |
|---|---|
| `vite.config.ts` | Rollup externals extended with `three/tsl`, `three/webgpu` (bundling them would duplicate three and break `instanceof` in consumers). |
| `package.json` | (planned P5) version suffix `-kroscloud.N` for vendored tarball releases. |

## Added files (`src/webgpu/`)

| File | Purpose |
|---|---|
| `packedSplatsTsl.ts` | TSL port of `shaders/splatDefines.glsl` packed-splat unpack: u8 RGBA, fp16 centers, log-u8 scales with 0-sentinel, `decodeQuatOctXy88R8`, both texture tiling functions (`splatTexCoord` 2048-wide, `pagedSplatTexCoord` 256-wide). Index math kept identical to upstream so SH textures co-index with the packed texture. |
| `shTsl.ts` | TSL port of the packed spherical-harmonics evaluation from `PackedSplats.ts` (`defineEvalPackedSH1/2/3`): sign-extending word-straddling sint7/sint8/sint6 extraction and `shMax/{63,127,31}` dequantization, bit-exact. |
| `SplatNodeMaterial.ts` | Hand-written TSL node material reproducing `shaders/splatVertex.glsl` + `shaders/splatFragment.glsl` for the WebGPU path: verbatim projection math (center rejects, clipXY guard, Jacobian, preBlur/blur, eigen decomposition, maxPixelRadius clamp order), LOD `a>1` opacity chain, premultiplied-alpha fragment. Draw ordering comes from an `order` storage buffer indexed by `instanceIndex` (identity in P1; GPU radix sort producer arrives in P2). |

## Behavioral deviations from upstream (WebGPU path only)

Enumerated per the fork plan §4.3; the WebGL2 path is unchanged.

1. No Pass-A accumulator: SH is evaluated per-frame in the vertex stage (upstream
   evaluates at sort cadence) and the per-frame fp16 camera-relative center
   re-quantization is gone (≤1 fp16 ulp precision improvement).
2. Blending is `CustomBlending` with explicit ONE/ONE_MINUS_SRC_ALPHA on both
   channels (r185 WebGPU ignores `premultipliedAlpha` on `NormalBlending`).

## Licensing notes

- Upstream MIT `LICENSE` (World Labs Technologies) retained; `npm pack` includes it.
- `src/webgpu/radixSort.ts` (arrives P2) carries PlayCanvas engine (MIT) +
  kishimisu WebGPU-Radix-Sort (MIT) attribution lineage.
- The Rust workspace declares `license = "Proprietary"` in upstream metadata
  (`rust/Cargo.toml`) despite the repo-level MIT LICENSE; the crates are never
  published standalone by this fork — WASM ships embedded in `dist` only, as
  upstream does.
- Nothing from graphdeco-inria/gaussian-splatting (non-commercial license) is or may
  ever be included in this fork.

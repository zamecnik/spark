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
| `vite.config.ts` | Rollup externals extended with `three/tsl`, `three/webgpu` (bundling them would duplicate three and break `instanceof` in consumers). Second lib entry `spark-webgpu` → `dist/spark-webgpu.module.js` so the WebGPU module ships as its own self-contained bundle (lazy-load requirement; WebGL2-only consumers never resolve `three/webgpu`). |
| `package.json` | `./webgpu` subpath export for the second bundle. (planned P5) version suffix `-kroscloud.N` for vendored tarball releases. |
| `src/shaders.ts` | `ShaderChunk` registration guarded — three.webgpu.js exports no ShaderChunk and module-eval-time callers crashed the whole import for WebGPU consumers. |
| `src/SparkRenderer.ts` | Additive `webgpuBackend` option (structural `SparkWebGpuBackendLike` interface — core never imports three/webgpu). When set: placeholder node material until the backend installs a per-source `SplatNodeMaterial`, `updateInternal` branches to the backend's keygen→GPU-radix-sort→ordered-draw instead of generate()+driveSort(), `onBeforeRender` syncs material uniforms via `applyPerFrame`, and the frame counter falls back to `info.frame` (WebGPURenderer has no `info.render.frame`). driveLod runs UNCHANGED on the branch (viewToWorld + visible-generators walk supplied inline; stale-cut pipeline gates deliberately absent — a new cut draws next frame). `updateLodIndices` gains a WebGPU else-branch: mirror-write + `needsUpdate` instead of raw `texSubImage2D`, and no `internalFormat` on creation. When absent, behavior is byte-identical to upstream (verified: WebGL sog AND paged-rad renders pixel-identical pre/post change, SSIM 1.0/MAD 0). `material` field widened `ShaderMaterial` → `Material`. |
| `src/SplatPager.ts` | WebGPU guards: `newUint32ArrayTexture` (pool + SH pools + ext) skips `internalFormat` (a WebGL string silently disables the WebGPU upload — P0/S1); `PagedSplats.update` gains a WebGPU else-branch (mirror-write + `needsUpdate`, no raw GL; image.data stays the raycast CPU mirror). `addLayerUpdate` page uploads work unchanged (S1-green). kroscloud.5: the cut texture is PRE-SIZED to min(session budget, RadMeta.count) at creation (`update` takes `presizeRows`; `totalFileSplats` captured at meta resolution) so fixed-budget sessions can never hit the mid-session capacity regrow — the ~25-pipeline recompile transition (2.7–11 s stall) behind the 2026-08-06 D3D12 device removals; the residual regrow (runtime `lodSplatCount` raises only) keeps ×2 geometric growth and defers old-texture disposal behind `onSubmittedWorkDone` (`kcRegrowDebug.ts`). |

## Added files (`src/webgpu/`)

| File | Purpose |
|---|---|
| `packedSplatsTsl.ts` | TSL port of `shaders/splatDefines.glsl` packed-splat unpack: u8 RGBA, fp16 centers, log-u8 scales with 0-sentinel, `decodeQuatOctXy88R8`, both texture tiling functions (`splatTexCoord` 2048-wide, `pagedSplatTexCoord` 256-wide). Index math kept identical to upstream so SH textures co-index with the packed texture. |
| `shTsl.ts` | TSL port of the packed spherical-harmonics evaluation from `PackedSplats.ts` (`defineEvalPackedSH1/2/3`): sign-extending word-straddling sint7/sint8/sint6 extraction and `shMax/{63,127,31}` dequantization, bit-exact. |
| `SplatNodeMaterial.ts` | Hand-written TSL node material reproducing `shaders/splatVertex.glsl` + `shaders/splatFragment.glsl` for the WebGPU path: verbatim projection math (center rejects, clipXY guard, Jacobian, preBlur/blur, eigen decomposition, maxPixelRadius clamp order), LOD `a>1` opacity chain, premultiplied-alpha fragment. Draw ordering comes from an `order` storage buffer indexed by `instanceIndex` (identity in P1; GPU radix sort producer arrives in P2). Not ported (default-off/dead upstream, unused by our apps): enable2DGS, depth-of-field, the dead `if(false)` falloff branch, encodeLinear, log-depth. |
| `index.ts` (webgpu) | Module entry for the `./webgpu` subpath. |
| `src/kcRegrowDebug.ts` | Cut-texture regrow policy + P6 diagnosis levers (base-bundle safe, no webgpu imports): budget pre-size row computation (`kcInitialCutRows`, 64-row floor / 1024-row cap), deferred old-resource disposal on WebGPU (`kcDisposeGrownTexture`/`kcDisposeOldMaterial` behind `queue.onSubmittedWorkDone`), and the harness-only globals `__kcRegrowMode` (baseline/leak/defer bisect), `__kcCutFloorRows` (forced initial size — the p6-stress regrow-torture lever) and `__kcRegrowLog` (sequence log). P6 finding recorded in the file header: the 2026-08-06 regrow deaths were the heavy transition frame on the margin, not an API-level dispose race (0 uncaptured errors across the whole bisect matrix). |
| `alphaReference.ts` | Pure-math mirror of the vertex alpha chain (the ×2-once convention) with WGSL round-half-even semantics; pinned by `test/webgpu/alphaChain.test.ts` hand-computed fixtures and reused by the browser parity probe. |
| `radixSort.ts` | TSL port of PlayCanvas's portable multipass 4-bit radix sort (MIT; kishimisu "Fast 4-way parallel radix sorting on GPUs" lineage — attribution in the file header). Stable u32 sort producing the index permutation; counts baked per instance. |
| `WebGpuSplatBackend.ts` | The WebGPU path orchestrator: per-frame TSL keygen (slot → optional cut-texel resolve → fp16 center → world → radial/z metric → INVERTED 16-bit key over CPU-computed [min,max] so the ascending radix yields back-to-front) + radix sort + order-buffer producer, viewChanged skip optimization, activeSplats publication, per-source material/buffer lifecycle. Three source modes: `static` (non-paged PackedSplats), `lodPacked` (whole-file LOD + lodInstances cut), `paged` (SplatPager pool + dynoIndices cut). Cut modes sort the FULL padded capacity (grow-only, no pipeline rebuilds per re-cut) with numSplats as a UNIFORM and 0xFFFF padding keys (the traverse zero-pads — never a texel sentinel); sort-stability puts real slots first among ties. Cut changes (mesh.mappingVersion — incl. static-camera page arrivals) force a same-frame resort. One SplatMesh per scene (composite cuts out of scope). |

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

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
| `src/SplatPager.ts` | WebGPU guards: `newUint32ArrayTexture` (pool + SH pools + ext) skips `internalFormat` (a WebGL string silently disables the WebGPU upload — P0/S1); `PagedSplats.update` gains a WebGPU else-branch (mirror-write + `needsUpdate`, no raw GL; image.data stays the raycast CPU mirror). `addLayerUpdate` page uploads work unchanged (S1-green). kroscloud.5: the cut texture is PRE-SIZED to min(session budget, RadMeta.count) at creation (`update` takes `presizeRows`; `totalFileSplats` captured at meta resolution) so fixed-budget sessions can never hit the mid-session capacity regrow — the ~25-pipeline recompile transition (2.7–11 s stall) behind the 2026-08-06 D3D12 device removals; the residual regrow (runtime `lodSplatCount` raises only) keeps ×2 geometric growth and defers old-texture disposal behind `onSubmittedWorkDone` (`kcRegrowDebug.ts`). kroscloud.6: `ensureShTextures` caps allocation by the pager's `maxSh` — bands above it never allocate their maxPages-deep plane textures (upload blocks skip via their `!== empty` guards; evaluation was already min-capped). Previously `maxSh` capped evaluation only and a SH3 .rad always committed sh1+sh2+sh3 pools (~2.5 MB/page GPU + equal CPU mirrors) regardless. |
| `src/SparkRenderer.ts` (kroscloud.6) | New `pagedMaxSh` option (default 3, backward-neutral) plumbed to `SplatPager`'s existing `maxSh` — app-level control of the SH allocation cap for memory-constrained devices (4 GB iPhones: sh2+sh3 pools are the difference between fitting under WebKit's GPU-process ceiling and thrashing against it). |
| `src/utils.ts` + `src/pcsogs.ts` (kroscloud.7, **[ssog-1]**) | Decode carve-out for the ssog worker call: the pure packed-splat encode helpers (`toHalf`/`fromHalf`, `floatToUint8`, `encodeQuatOctXy88R8` — reimplemented on a plain `{x,y,z,w}` record with identical normalize semantics and bit-identical output — `setPackedSplatCenter/Scales/Quat/Rgba`, `encodeSh1/2/3Rgb`, `computeMaxSplats`) moved VERBATIM to new three-free `src/packedEncode.ts`; `unpackPcSogs` + `decodeImage` moved VERBATIM to new `src/pcsogsDecode.ts` (type-only SplatLoader imports). Both origin modules re-export every moved symbol — public surfaces unchanged, all existing consumers untouched. Rationale: utils.ts evaluates `THREE.REVISION` and allocates Vector3/Quaternion/Color temps at module scope, which would drag three into the inline worker bundle (P0b measured the coupling). |
| `src/worker.ts` (kroscloud.7, **[ssog-1]**) | New `unpackSsogUnit` RPC: decodes one Streamed-SOG unit (meta.json + webp planes fetched by `SsogUnitCache`) via the carved-out `unpackPcSogs` into the standard PackedSplats shape `SplatPager.uploadPage` consumes. Verified three-free: standalone worker-graph bundle 44.9→61.8 KB (+16.9 KB decode), zero `three`/SplatLoader value imports (esbuild resolve trace). |
| `src/index.ts` (kroscloud.7, **[ssog-2]**) | Exports `workerPool`/`SplatWorker`/`NewSplatWorkerPool` so the ssog subpath entry (core external) reuses the core worker pool. |
| `src/SplatPager.ts` + `src/SparkRenderer.ts` (kroscloud.7, **[ssog-3]**) | `PagedSplats.externalLod` (readonly, default false) + one-line `lodMeshes` filter guard: paged sources whose LOD is owned by an external controller (ssog) are excluded from driveLod entirely — the rad worker-tree machinery never sees them. Default-false ⇒ rad behavior byte-identical. |
| `src/defines.ts` (kroscloud.7, **[ssog-4]**) | `SplatFileType.SSOG = "ssog"` — the Streamed-SOG lod-meta bundle source type. |
| `vite.config.ts` + `package.json` + `tsconfig.json` (kroscloud.7, **[ssog-2]**) | Third lib entry `spark-ssog` → `dist/spark-ssog.module.js` behind a `./ssog` subpath export. The ssog bundle imports the core by package name (`@sparkjsdev/spark`, added to rollup externals + tsconfig paths) so consumers resolve ONE core instance — `SsogSplats extends PagedSplats` keeps class identity, and base bundles for non-splat scenes pull zero new code. Version → 2.1.0-kroscloud.7. |
| `src/shaders/splatVertex.glsl` + `src/webgpu/SplatNodeMaterial.ts` + `src/SparkRenderer.ts` + `src/webgpu/WebGpuSplatBackend.ts` (kroscloud.8, **[ssog-5]**) | **SSOG_FILL_V2 fill layer** (Viewme plan §2.6, Phase C), expression-identical GLSL/TSL twins (R13 cross-path SSIM gate): (1) contribution cull before eigen decomposition (`α·2π·√det < ssogMinContribution` discard; 0 disables — the WebGL2 descope valve), (2) kernel cap WITH covariance rescale — viewport-adaptive cap `min(1024, min(renderSize))`, ONE factor on both axes so anisotropy survives, (3) alpha quad shrink `z* = √(2·max(0, ln(α·255)))`, quad AND UV span scaled together (identical Gaussian, fewer pixels filled) + alphaClip 1/255 discard. Gated by RUNTIME uniforms `ssogFillV2`/`ssogMinContribution` (no shader variant, no pipeline rebuild; float 0/1 on WebGPU — WGSL bans bool uniforms); default OFF ⇒ rad/stock output byte-identical (P4 floor). Plumbed as `SparkRenderer` options/fields → both backends' per-frame uniform sync. The min-size discard element is a POLICY change only (app sets the existing `minPixelRadius` to 1.0 for ssog scenes — no shader change). |
| `src/ssog/SsogLodController.ts` (kroscloud.9, **[ssog-6]**) | Pool-guard degenerate-case fix: `poolGuardLimit()` returns the FULL pool when `maxPages >= model.totalBlocks` (whole scene resident ⇒ eviction-to-fetch impossible ⇒ no fetcher headroom needed). Without it, tiny deep-ladder artifacts — where the kroscloud.8 `pool ≤ totalBlocks` clamp yields `maxPages == totalBlocks < numFetchers` — get a zero/negative flip threshold and EVERY grow flip defers forever (found live in the Phase D mixed-band sweep: 20k/3-level SH3 canary fixture, 191 deferrals, 0 flips, ladder pinned at coarsest). Production-scale artifacts (multi-level ⇒ >1M splats ⇒ blocks ≫ fetchers) never take the branch — rad and large-ssog behavior unchanged. |

## Added files (`src/webgpu/`)

| File | Purpose |
|---|---|
| `packedSplatsTsl.ts` | TSL port of `shaders/splatDefines.glsl` packed-splat unpack: u8 RGBA, fp16 centers, log-u8 scales with 0-sentinel, `decodeQuatOctXy88R8`, both texture tiling functions (`splatTexCoord` 2048-wide, `pagedSplatTexCoord` 256-wide). Index math kept identical to upstream so SH textures co-index with the packed texture. |
| `shTsl.ts` | TSL port of the packed spherical-harmonics evaluation from `PackedSplats.ts` (`defineEvalPackedSH1/2/3`): sign-extending word-straddling sint7/sint8/sint6 extraction and `shMax/{63,127,31}` dequantization, bit-exact. |
| `SplatNodeMaterial.ts` | Hand-written TSL node material reproducing `shaders/splatVertex.glsl` + `shaders/splatFragment.glsl` for the WebGPU path: verbatim projection math (center rejects, clipXY guard, Jacobian, preBlur/blur, eigen decomposition, maxPixelRadius clamp order), LOD `a>1` opacity chain, premultiplied-alpha fragment. Draw ordering comes from an `order` storage buffer indexed by `instanceIndex` (identity in P1; GPU radix sort producer arrives in P2). Not ported (default-off/dead upstream, unused by our apps): enable2DGS, depth-of-field, the dead `if(false)` falloff branch, encodeLinear, log-depth. |
| `index.ts` (webgpu) | Module entry for the `./webgpu` subpath. |
| `src/kcRegrowDebug.ts` | Cut-texture regrow policy + P6 diagnosis levers (base-bundle safe, no webgpu imports): budget pre-size row computation (`kcInitialCutRows`, 64-row floor / 1024-row cap), deferred old-resource disposal on WebGPU (`kcDisposeGrownTexture`/`kcDisposeOldMaterial` behind `queue.onSubmittedWorkDone`), and the harness-only globals `__kcRegrowMode` (baseline/leak/defer bisect), `__kcCutFloorRows` (forced initial size — the p6-stress regrow-torture lever) and `__kcRegrowLog` (sequence log). P6 finding recorded in the file header: the 2026-08-06 regrow deaths were the heavy transition frame on the margin, not an API-level dispose race (0 uncaptured errors across the whole bisect matrix). |
| `alphaReference.ts` | Pure-math mirror of the vertex alpha chain (the ×2-once convention) with WGSL round-half-even semantics; pinned by `test/webgpu/alphaChain.test.ts` hand-computed fixtures and reused by the browser parity probe. |

## Added files (`src/ssog/`, kroscloud.7, **[ssog-2]**) — Streamed-SOG runtime

The additive supersplat-equivalent LOD runtime (Viewme
`docs/features/gaussian-splatting/ssog-lod-adoption-plan.md` §2.3/§2.4, Phase
B), published as the lazy `@sparkjsdev/spark/ssog` subpath entry. Algorithms
are REIMPLEMENTED in TypeScript from the verified research notes
(supersplat-lod-architecture-analysis.md) — no PlayCanvas/supersplat code
copied.

| File | Purpose |
|---|---|
| `SsogModel.ts` | lod-meta.json parse/validate → flat leaf/unit SoA tables: PRE-resolution counts[] validation, VARIABLE per-unit count derivation + `blockBase` prefix-sum chunk mapping, missing-level resolution at load, quantified max per-leaf block footprint, scene bounds from `tree.bound`. |
| `SsogUnitCache.ts` | Unit fetch (unbundled files) + worker decode via `unpackSsogUnit`, decode LRU (default 3 units), `resolveUrl` signing hook, fixed `DEFAULT_SPLAT_ENCODING` (`lodOpacity:false`). |
| `SsogSplats.ts` | `extends PagedSplats`; constructs its OWN §2.3-sized `SplatPager` (budget·1.15 + coarsest + quantified slack) with `autoDrive:false`; `fetchDecodeChunk` = blockBase-mapped EXACT-SIZE block subarrays of the memoized unit decode; `externalLod=true`; fixed §2.4 cut capacity (no regrow ever); dispose stays detach-only (pano contract), `disposePool()` for final teardown. kroscloud.8: `poolFactor` option (default 1 = unchanged) multiplying the BUDGET term of the pool formula — Phase C measured displayed pages at ~55% occupancy (cut rows scatter across blocks), so the block-aware pool guard capped effective quality at ~0.55×budget; the calibrated desktop value is 1.8 (zero deferrals, deterministic converged cuts, pool 80 pages at a 2M budget on the 4.59M reference). |
| `SsogLodController.ts` | §2.4 verbatim: FOV-compensated selection with behind-penalty, 64-√bucket balancer (farthest-first demote / nearest-first promote, fit-check-before-apply, stop-don't-skip), budgetScale ±40% dead-zone feedback, 10-frame latched metronome + motion gates, keep-old-until-resident swap machine with shrink-first flips, fetchPriority tiers (coarsest PINNED / displayed / desired nearest-first with pre-staging headroom assert + sub-step fallback / 10-tick cooldown), coarsest-pinned reveal, §2.3 pump contract (driveFetchers → consumeLodTreeUpdates DISCARDED → processUploads), WebGL2 sort backpressure gate, `verifyCut()` stale-cut sweep. Drive hook = app rAF (`frame(camera)`, Q8 decision). kroscloud.8 (Phase C, §2.7): publishes `mesh.raycastIndices` (the complete pinned-coarsest cut, leaf-table order — deterministic raycast RESULTS regardless of page-assignment order) at reveal completion; consumed by the existing `SplatMesh.raycast` paged branch over the pool CPU mirror. Public `isConverged` probe + POOL-SETTLED convergence (Phase C liveness finding): at fragmented poses the block-aware pool guard can defer every remaining grow flip forever (191k deferrals observed at one fixed pose) — displayed==balanced is then unreachable BY DESIGN, so 3 consecutive no-flip ticks with a quiet pager also count as converged (stops the metronome spinning at pool-limited rest; prerequisite for the Phase D render-on-demand supplier). |
| `index.ts` (ssog) | Module entry for the `./ssog` subpath. |
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

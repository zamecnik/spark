// Kroscloud WebGPU fork (2026) — see FORK-CHANGES.md.
//
// WebGpuSplatBackend: the WebGPU render path orchestrator (fork plan §4.2).
// Owned by SparkRenderer via the additive `webgpuBackend` constructor option
// (SparkRenderer only knows a structural interface — the core bundle never
// imports three/webgpu; the app constructs this from the lazy-loaded
// `@sparkjsdev/spark/webgpu` module and passes it in).
//
// Per frame (called from SparkRenderer.updateInternal, i.e. inside the
// Mesh.onBeforeRender cadence — P0/S4 proved compute enqueued here lands
// before the same frame's draw):
//   1. find the visible SplatMesh and resolve its SOURCE MODE:
//        static    — non-paged PackedSplats, index = slot (P2 path)
//        lodPacked — whole-file LOD: lodSplats texture + the SparkRenderer
//                    lodInstances cut texture
//        paged     — streamed .rad: SplatPager pool + PagedSplats dynoIndices
//                    cut texture (P3 path)
//   2. (re)build baked state when identities/capacity change:
//      SplatNodeMaterial + keys/order storage buffers + keygen + radix,
//   3. sort when the view OR the CUT changed (mesh.mappingVersion — page
//      arrivals re-cut with a static camera and must resort; plan §5/P3
//      "page arrival visible next frame"); gating is an optimization only —
//      under motion this sorts EVERY frame,
//   4. publish activeSplats + same-frame instanceCount = the CUT's numSplats.
//
// Sort key scheme (fork plan §4.2 items 3/4): slot → (cut texel →) splat
// index → fp16 center → fp32 world → radial metric (z-mode `dot + 100.0`
// implemented) → INVERTED 16-bit key over CPU-computed [min,max] so the
// ascending radix yields back-to-front. The sort covers the cut texture's
// FULL padded capacity (rows×16384, grow-only — stable across re-cuts, no
// pipeline rebuilds); numSplats is a UNIFORM and padding slots are forced to
// key 0xFFFF (the Rust traverse ZERO-pads — a padding texel is
// indistinguishable from (page 0, slot 0), so the bound is the numSplats
// uniform, NEVER a texel sentinel; P0/S2 verified design). Real slots
// win 0xFFFF ties by sort stability, so order[0..numSplats) is exactly the
// real cut.

import type * as THREE from "three";
import {
  IndirectStorageBufferAttribute,
  Matrix4,
  MeshBasicNodeMaterial,
  Quaternion,
  Vector3,
} from "three/webgpu";
import {
  Fn,
  If,
  Return,
  atomicAdd,
  bool,
  clamp,
  exp,
  float,
  instanceIndex,
  instancedArray,
  int,
  ivec2,
  log,
  mat3,
  max,
  min,
  normalize,
  round,
  select,
  sqrt,
  storage,
  textureLoad,
  transpose,
  uint,
  uniform,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import * as TSL from "three/tsl";
import { BatchedSplatGeometry } from "./BatchedSplatGeometry";

// Duplicated from SplatNodeMaterial.ts / src/defines.ts (must match): the
// projector kernel replicates the material's parity lattice byte-for-byte.
const LN_SCALE_MIN = -12.0;
const LN_SCALE_MAX = 9.0;
import {
  type TslNode,
  pagedSplatTexCoordTsl,
  quatQuatTsl,
  quatVecTsl,
  scaleQuaternionToMatrixColumnsTsl,
  splatTexCoordTsl,
  unpackSplatEncodingTsl,
  stripWebGLInternalFormat,
} from "./packedSplatsTsl";
import { evaluatePackedShTsl } from "./shTsl";
import { kcDisposeOldMaterial, kcRegrowLog } from "../kcRegrowDebug";
import {
  type RadixSort,
  type RadixSortGroup,
  createRadixSort,
  createVisibleClear,
} from "./radixSort";
import { SplatNodeMaterial } from "./SplatNodeMaterial";

// biome-ignore lint/suspicious/noExplicitAny: r180 type decls lack this export
const unpackHalf2x16: (node: unknown) => any = (TSL as any).unpackHalf2x16;
// biome-ignore lint/suspicious/noExplicitAny: r180 type decls lack this export
const packHalf2x16: (node: unknown) => any = (TSL as any).packHalf2x16;
// biome-ignore lint/suspicious/noExplicitAny: r180 type decls lack this export
const uvec4: (...a: unknown[]) => any = (TSL as any).uvec4;

// Structural views of the Spark types this module touches (it deliberately
// imports nothing from the core bundle so the webgpu entry stays
// self-contained — see FORK-CHANGES.md).
type SplatEncodingLike = {
  rgbMin?: number;
  rgbMax?: number;
  lnScaleMin?: number;
  lnScaleMax?: number;
  sh1Max?: number;
  sh2Max?: number;
  sh3Max?: number;
  lodOpacity?: boolean;
};

type PackedSplatsLike = {
  numSplats: number;
  packedArray: Uint32Array | null;
  lodSplats?: PackedSplatsLike;
  splatEncoding?: SplatEncodingLike;
  getTexture(): THREE.DataArrayTexture;
  getNumSh(): number;
  ensureShTextures(): {
    sh1Texture?: { value: THREE.DataArrayTexture };
    sh2Texture?: { value: THREE.DataArrayTexture };
    sh3Texture?: { value: THREE.DataArrayTexture };
  };
};

type SplatPagerLike = {
  packedTexture: { value: THREE.DataArrayTexture };
  sh1Texture: { value: THREE.DataArrayTexture };
  sh2Texture: { value: THREE.DataArrayTexture };
  sh3Texture: { value: THREE.DataArrayTexture };
  maxSh: number;
};

type PagedSplatsLike = {
  numSplats: number;
  numSh: number;
  maxSh: number;
  pager?: SplatPagerLike;
  splatEncoding?: SplatEncodingLike;
  dynoIndices: { value: THREE.DataTexture };
};

type SplatMeshLike = THREE.Object3D & {
  packedSplats?: PackedSplatsLike;
  paged?: PagedSplatsLike;
  maxSh?: number;
  mappingVersion?: number;
  // SplatMesh.raycast reads these context fields; stock feeds them from the
  // accumulator scene-walk which never runs on the WebGPU branch
  context?: {
    numSplats?: { value: number };
    enableLod?: { value: boolean };
    lodIndices?: { value: unknown };
  };
};

type LodInstanceLike = {
  numSplats: number;
  indices: Uint32Array;
  texture: THREE.DataTexture;
};

type SparkRendererLike = THREE.Mesh & {
  // dispatchSize: an IndirectStorageBufferAttribute makes three dispatch the
  // whole call indirectly (r185 WebGPUBackend.compute) — [vc] uses it for the
  // hist/reorder groups; null/omitted keeps each node's baked size.
  renderer: {
    compute(nodes: TslNode | TslNode[], dispatchSize?: unknown): void;
  };
  activeSplats: number;
  sortRadial?: boolean;
  maxStdDev: number;
  minPixelRadius: number;
  maxPixelRadius: number;
  ssogFillV2: boolean;
  ssogMinContribution: number;
  // [ssog-9] expected-depth pick mode + normalization window (optional so
  // older SparkRenderer-shaped hosts still type-check; defaults applied)
  pickMode?: number;
  pickNear?: number;
  pickFar?: number;
  minAlpha: number;
  preBlurAmount: number;
  blurAmount: number;
  falloff: number;
  clipXY: number;
  focalAdjustment: number;
  renderSize: THREE.Vector2;
  lodInstances?: Map<unknown, LodInstanceLike>;
};

type SourceKind = "static" | "lodPacked" | "paged";

type ResolvedSource = {
  kind: SourceKind;
  packedTexture: THREE.DataArrayTexture;
  pagedTiling: boolean;
  cutTexture: THREE.DataTexture | null;
  numSplats: number;
  capacity: number;
  encoding: SplatEncodingLike;
  numSh: number;
  sh1?: THREE.DataArrayTexture;
  sh2?: THREE.DataArrayTexture;
  sh3?: THREE.DataArrayTexture;
  mappingVersion: number;
};

type MeshState = {
  mesh: SplatMeshLike;
  kind: SourceKind;
  packedTexture: THREE.DataArrayTexture;
  cutTexture: THREE.DataTexture | null;
  sh1?: THREE.DataArrayTexture;
  sh2?: THREE.DataArrayTexture;
  sh3?: THREE.DataArrayTexture;
  capacity: number;
  material: SplatNodeMaterial;
  keysNode: TslNode;
  keygen: TslNode;
  radix: RadixSort;
  uNumSplats: ReturnType<typeof uniform>;
  uMeshToWorld: ReturnType<typeof uniform>;
  uCameraPos: ReturnType<typeof uniform>;
  uCameraDir: ReturnType<typeof uniform>;
  uDistRange: ReturnType<typeof uniform>;
  boundsMin: THREE.Vector3;
  boundsMax: THREE.Vector3;
  lastNumSplats: number;
  lastMappingVersion: number;
  // instances actually submitted = ceil(numSplats / batchSize); re-asserted
  // in applyPerFrame because SparkRenderer.onBeforeRender writes
  // instanceCount = activeSplats (the SPLAT count) between update() and the
  // render, which is only correct for batchSize 1.
  drawInstances: number;
  // [proj] projector kernel + its projection-matrix uniform (compute passes
  // cannot read the render context's cameraProjectionMatrix), null when the
  // lever is off
  projector: TslNode | null;
  uProjection: { value: Matrix4 } | null;
  uWriteKeys: { value: number } | null;
  // [vc] visible-count sort state (?splatvis=1, requires the projector):
  // sort-frame pre-clear kernel, the radix's grouped dispatch plan, the
  // indirect dispatch-args attribute, and the 1-element visCount attribute
  // (exposed for the SplatMeasure phase-boundary readback). All null when
  // the lever is off.
  visPrePass: TslNode | null;
  visGroups: RadixSortGroup[] | null;
  visDispatchAttr: unknown;
  visCountAttr: THREE.BufferAttribute | null;
};

// fp16 → f32 (IEEE 754 half), for the CPU-side bounds scans
function fromHalf(h: number): number {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  if (e === 0) return (s ? -1 : 1) * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? Number.NaN : (s ? -1 : 1) * Number.POSITIVE_INFINITY;
  return (s ? -1 : 1) * 2 ** (e - 15) * (1 + f / 1024);
}

type Bounds = { min: THREE.Vector3; max: THREE.Vector3 };

// bounds over packed words at texel offsets yielded by nextOffset (u32 index
// into a packedArray-shaped u32 buffer, 4 words per splat)
function scanBounds(
  words: Uint32Array,
  offsets: () => number,
  count: number,
): Bounds {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let k = 0; k < count; k++) {
    const o = offsets();
    const w1 = words[o + 1];
    const w2 = words[o + 2];
    const x = fromHalf(w1 & 0xffff);
    const y = fromHalf(w1 >>> 16);
    const z = fromHalf(w2 & 0xffff);
    if (!Number.isFinite(x + y + z)) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  if (minX > maxX) {
    minX = minY = minZ = 0;
    maxX = maxY = maxZ = 1;
  }
  // small margin: sampled scans can miss the exact extremes; the keygen
  // clamp handles overflow, this just keeps end buckets from crowding
  const mx = 0.02 * (maxX - minX + 1e-6);
  const my = 0.02 * (maxY - minY + 1e-6);
  const mz = 0.02 * (maxZ - minZ + 1e-6);
  return {
    min: new Vector3(minX - mx, minY - my, minZ - mz),
    max: new Vector3(maxX + mx, maxY + my, maxZ + mz),
  };
}

export class WebGpuSplatBackend {
  // Assigned by SparkRenderer's ctor until the first real material exists.
  // MUST stay visible: an invisible material would stop three from ever
  // calling SparkRenderer.onBeforeRender — which drives this whole pipeline.
  // Nothing draws anyway (instanceCount starts at 0).
  placeholderMaterial: THREE.Material;

  // Sort by radial distance (true, Spark default) or view-z + 100.0 bias.
  sortRadial = true;

  // [ssog-30] Quantize the sort key on a LOG distance scale (true) instead
  // of linearly over [minD, maxD]. Linear 16-bit keys over a scene whose
  // bounding box spans hundreds of metres give ~1 cm buckets; zoomed in,
  // dense splats a few millimetres apart tie, and the compact sort appends
  // tied keys in nondeterministic order, so tied neighbours swap draw order
  // on every sort — sorting runs every frame while the camera moves and not
  // at rest, which reads as sparkle that vanishes when the camera stops
  // (owner report 2026-09-09, 20M scene, WebGPU only; WebGL2's CPU sort is
  // exact). Log keys give the near field sub-millimetre buckets (0.15 mm at
  // 1 m, 1.5 mm at 10 m over a 900 m range) and coarse ones only far away,
  // where splats are tiny. Monotonic in distance, so non-tied order is
  // unchanged. `?sortkey=linear` (app) restores the old mapping for A/B.
  sortKeyLog = true;

  // Testing hook (harness stale-order regression): freeze the order producer.
  freezeOrder = false;

  // Build-time diagnostic levers, read when the material is created, so the
  // app must set them BEFORE the scene loads (SplatView installs them next to
  // the sort throttle, well ahead of the first buildState).
  //   vsMinimal      - ?splatvsmin=N, the vertex-stage ablation
  //                    (1 = no projection maths, 2 = also no memory reads)
  //   parityQuantize - ?splatparity=off, drops the accumulator repack lattice
  //                    (3 log + 3 exp + ~7 round/clamp per drawn splat) which
  //                    the WebGL2 path does not do at all
  vsMinimal = 0;
  parityQuantize = true;
  //   batchSize      - ?splatbatch=N, N splats per instance (PlayCanvas draws
  //                    128). Swaps the mesh geometry to BatchedSplatGeometry
  //                    at buildState and divides instanceCount by N. 1 = the
  //                    stock draw, byte-identical WGSL.
  batchSize = 1;
  //   projectorEnabled - ?splatproj=1: run the whole projection chain ONCE
  //                    per splat in a compute pass (splatProjector) and turn
  //                    the draw's vertex stage into a cache reader. Validated
  //                    by measurement before being built (row 58: L1+batch =
  //                    34 ms vs the batched baseline's 68 on the Pixel 4).
  //                    Ignored while a vsMinimal ablation is active.
  projectorEnabled = false;
  //   sortBits       - ?sortbits=N (4..16, multiple of 4): radix passes =
  //                    N/4. Rows 76/77 priced the 16-bit 4-pass radix at
  //                    ~46 ms of the 74 ms Pixel orbit frame, so passes are
  //                    the currency: 12 bits = 3 passes (4096 depth buckets),
  //                    8 = 2 passes (256 buckets). Key quantization follows
  //                    the bit width, so precision loss is bucket coarsening,
  //                    never wrong bits. Diagnostic ladder first; whether a
  //                    reduced width SHIPS is a visual call on device.
  sortBits = 16;
  //   sortDigits     - radix digit width (?sortdigit=4|8). DEFAULT REVERTED
  //                    to 4 after row 81: digit-8 at 256 threads REGRESSED on
  //                    Adreno (orbit 86 vs 74 ms, ~29 ms/pass vs 9.5) while
  //                    the desktop rig ran it FASTER - the 9 KB ballot
  //                    footprint is the occupancy suspect. The permutation is
  //                    identical either way, so this is purely a perf knob;
  //                    the 2-pass prize (row 79 measured 55 ms orbit) is
  //                    chased via sortTpw below.
  sortDigits = 4;
  //   sortTpw        - hist/reorder threads per workgroup (?sorttpw=64|128|
  //                    256). Fewer threads shrink the digit-8 ballot masks
  //                    (words = threads/32): 128 -> 4 KB, 64 -> 2 KB, testing
  //                    the occupancy hypothesis on device.
  sortTpw = 256;
  //   sortVisible    - ?splatvis=1: cull + compact in the projector (it
  //                    already computes `rejected` per splat), radix over the
  //                    visible prefix only, hist/reorder dispatched
  //                    INDIRECTLY from the GPU visCount (the CPU never reads
  //                    it back in the render loop). Rows 82/83 killed the
  //                    2-pass kernel on Adreno, leaving the sort DOMAIN as
  //                    the last orbit lever: radix cost scales ~46*f ms with
  //                    the visible fraction f (f~0.5 projects orbit ~51 ms
  //                    on the proven 4-pass kernel). Requires the projector
  //                    (ignored without it / under a vsmin ablation); OFF by
  //                    default until the phone verdict. Ties among equal
  //                    16-bit keys reorder run-to-run (nondeterministic
  //                    atomic append order) — the accepted keygen-fusion
  //                    diff class, NOT byte-identical.
  sortVisible = false;
  //   cachePack      - ?splatpack=1|2: projector-cache slimming ladder
  //                    (round 14; requires the projector; independent of
  //                    sortVisible). The cache is 64 B/splat over padded
  //                    capacity (~74 MB at 1.16M), fully rewritten every
  //                    rendered frame and read 4x per drawn splat.
  //                    1 = WRITE GUARD: rejected slots write only c3 (the
  //                    live flag) instead of all four vec4s -
  //                    output-IDENTICAL by construction (both reader
  //                    variants load c0..c2 of a dead slot but discard on
  //                    the live flag before any use), so its desktop gate
  //                    is scene-0-px. Bandwidth saving materialises only
  //                    where rejection is clumpy in slot order (cut order
  //                    is leaf/block-coherent, so it should be) - which is
  //                    why this is a measured lever, not a free default.
  //                    2 = guard + the 32 B PACKED layout: p0 = fp32 clip
  //                    center (position precision holds), p1 = uvec4 of
  //                    [packHalf2x16(axis1), packHalf2x16(scale2, alpha),
  //                    rgb8 | live<<24, packHalf2x16(uvStd, adjStdDev)].
  //                    axis2 is DERIVED in the reader (perp(axis1)*scale2 -
  //                    eigenvectors are orthogonal), viewZ from
  //                    -clipCenter.w (perspective w = -viewZ; pick mode
  //                    under an ORTHOGRAPHIC camera is unsupported on this
  //                    path). rgb u8 is EXACT under the default parity
  //                    lattice (?splatparity=off would re-quantize - that
  //                    diagnostic is documented-dead). fp16 costs <=2^-11
  //                    relative on axes/alpha/uvStd - sub-pixel /
  //                    sub-u8-step. Halves footprint (74 -> 37 MB) AND
  //                    write+read bandwidth. Default 0 until the round-14
  //                    phone verdict.
  cachePack = 0;

  // Gate instrumentation (P2/P3 acceptance).
  frames = 0;
  sorts = 0;
  lastSortFrame = -1;
  // Each rebuild is a main-thread WGSL pipeline recompile (~25 pipelines).
  // With the cut-texture allocation headroom this should be 1 (rarely 2)
  // per scene — watch it via ?splatdebug state().webgpu.rebuilds.
  rebuilds = 0;

  private state: MeshState | null = null;
  private sortedOnce = false;
  private warnedMultiMesh = false;

  constructor() {
    this.placeholderMaterial = new MeshBasicNodeMaterial();
  }

  // Called from SparkRenderer.updateInternal (WebGPU branch). Returns true
  // if a sort was submitted this frame (caller updates sortedCenter/Dir).
  update({
    spark,
    scene,
    camera,
    viewChanged,
  }: {
    spark: SparkRendererLike;
    scene: THREE.Scene;
    camera: THREE.Camera;
    viewChanged: boolean;
  }): boolean {
    this.frames++;

    const mesh = this.findSplatMesh(scene);
    const src = mesh ? this.resolveSource(spark, mesh) : null;
    if (!mesh || !src || src.numSplats === 0) {
      spark.activeSplats = 0;
      (spark.geometry as THREE.InstancedBufferGeometry).instanceCount = 0;
      if (this.state) this.state.drawInstances = 0;
      return false;
    }

    // sync BEFORE buildState — the keygen kernel bakes the metric choice
    this.sortRadial = spark.sortRadial ?? true;

    let rebuilt = false;
    const st = this.state;
    if (
      !st ||
      st.mesh !== mesh ||
      st.kind !== src.kind ||
      st.packedTexture !== src.packedTexture ||
      st.cutTexture !== src.cutTexture ||
      st.sh1 !== src.sh1 ||
      st.sh2 !== src.sh2 ||
      st.sh3 !== src.sh3 ||
      st.capacity !== src.capacity
    ) {
      this.buildState(spark, mesh, src);
      rebuilt = true;
      this.rebuilds++;
    }
    const state = this.state as MeshState;

    const cutChanged =
      src.numSplats !== state.lastNumSplats ||
      src.mappingVersion !== state.lastMappingVersion;

    // [fuse] the sort DECISION is made here; the dispatches are submitted
    // below, merged with the projector when it is enabled, so the fused key
    // write and the radix ride one submission in guaranteed order.
    const wantSort =
      !this.freezeOrder &&
      (viewChanged || rebuilt || cutChanged || !this.sortedOnce);
    let didSort = false;
    if (wantSort) {
      if (rebuilt || cutChanged) {
        this.updateBounds(state, src);
      }
      (state.uNumSplats as { value: number }).value = src.numSplats;
      this.updateKeygenUniforms(state, camera);
      this.sortedOnce = true;
      this.sorts++;
      this.lastSortFrame = this.frames;
      didSort = true;
      state.lastNumSplats = src.numSplats;
      state.lastMappingVersion = src.mappingVersion;
    }

    // activeSplats publication (app contract: overlays gate on it) + the
    // same-frame instanceCount (the order buffer is fresh this frame, P0/S4)
    spark.activeSplats = src.numSplats;
    // [dbg-adreno] batched draw: N splats per instance -> ceil(n/N)
    // instances. The material's tail reject reads batchNumSplats, refreshed
    // here EVERY frame (uNumSplats only updates on sort frames).
    const drawInstances =
      this.batchSize > 1
        ? Math.ceil(src.numSplats / this.batchSize)
        : src.numSplats;
    state.drawInstances = drawInstances;
    state.material.batchNumSplats.value = src.numSplats;
    (spark.geometry as THREE.InstancedBufferGeometry).instanceCount =
      drawInstances;

    // [proj] the projector re-runs EVERY rendered frame (its inputs include
    // the camera), independent of the sort cadence. Uniforms are synced here
    // because applyPerFrame runs later in the frame (onBeforeRender) and the
    // compute below must not consume last frame's camera. uNumSplats is
    // always current at this point: it only changes when cutChanged, which
    // forces the sort branch above to run first.
    if (state.projector && src.numSplats > 0) {
      this.syncUniforms(spark, camera);
      // [fuse] on sort frames the projector writes the keys inline (round-7:
      // the standalone keygen duplicated its cut resolve + fetch + transform
      // for ~45 ms/frame of chain cost) and the radix follows in the SAME
      // submission; non-sort frames skip both the key writes and the radix.
      if (state.uWriteKeys) state.uWriteKeys.value = wantSort ? 1 : 0;
      if (wantSort && state.uWriteKeys && state.visGroups) {
        // [vc] compact sort: pre-clear (keys→quantMax, visCount→0) then the
        // appending projector ride ONE pass; the radix follows as the
        // grouped plan, because three applies a per-call dispatchSize to
        // every node of a compute() call — indirect hist/reorder and
        // baked-size clears/scans can never share one. Queue order
        // preserves sequencing across the calls. Non-sort frames (below)
        // run the projector alone with uWriteKeys=0, so order[] and
        // visCount stay a consistent stale pair — the freezeOrder/?gpusort
        // contract unchanged.
        spark.renderer.compute([state.visPrePass as TslNode, state.projector]);
        for (const g of state.visGroups) {
          spark.renderer.compute(
            g.nodes,
            g.indirect ? state.visDispatchAttr : null,
          );
        }
      } else {
        spark.renderer.compute(
          wantSort && state.uWriteKeys
            ? [state.projector, ...state.radix.steps]
            : [state.projector],
        );
      }
    } else if (wantSort) {
      // projector disabled (desktop default / ?splatproj=0): the standalone
      // keygen path, unchanged.
      spark.renderer.compute([state.keygen, ...state.radix.steps]);
    }

    // Raycast contract (fork plan §4.4/app-contract rows 15–17): stock feeds
    // SplatMesh.context from the accumulator scene-walk (SplatMesh.update),
    // which never runs on this branch — without this, non-LOD raycasts
    // iterate context.numSplats.value = 0 and return no hits (caught by the
    // P4 byte-identity gate). Paged meshes don't consult the context (their
    // raycast branch reads paged.numSplats directly).
    const ctx = mesh.context;
    if (ctx) {
      if (src.kind === "static" && ctx.numSplats) {
        ctx.numSplats.value = src.numSplats;
      } else if (src.kind === "lodPacked") {
        if (ctx.numSplats) ctx.numSplats.value = src.numSplats;
        if (ctx.enableLod) ctx.enableLod.value = true;
        if (ctx.lodIndices && src.cutTexture) {
          ctx.lodIndices.value = src.cutTexture;
        }
      }
    }
    return didSort;
  }

  // Called from SparkRenderer.onBeforeRender: per-frame material uniforms.
  applyPerFrame(spark: SparkRendererLike, camera: THREE.Camera): void {
    const state = this.state;
    if (!state) return;
    const mat = state.material;

    // [dbg-adreno] SparkRenderer.onBeforeRender sets instanceCount =
    // activeSplats (the SPLAT count) before calling here; with batching the
    // submitted count is ceil(n/N), so re-assert it right before the render.
    if (this.batchSize > 1) {
      (spark.geometry as THREE.InstancedBufferGeometry).instanceCount =
        state.drawInstances;
    }

    this.syncUniforms(spark, camera);
  }

  // Per-frame uniform sync, shared by applyPerFrame (onBeforeRender) and -
  // when the projector is on - update(), because the projector compute is
  // submitted from update() and must see THIS frame's camera, not last
  // frame's. camera.updateMatrixWorld() + a manual inverse make the transform
  // fresh regardless of which caller runs first (matrixWorldInverse is only
  // refreshed inside renderer.render).
  private syncUniforms(spark: SparkRendererLike, camera: THREE.Camera): void {
    const state = this.state;
    if (!state) return;
    const mat = state.material;

    camera.updateMatrixWorld();
    if (state.uProjection) {
      state.uProjection.value.copy(
        (camera as THREE.PerspectiveCamera).projectionMatrix,
      );
    }

    mat.renderSize.value.copy(spark.renderSize);
    mat.maxStdDev.value = spark.maxStdDev;
    mat.minPixelRadius.value = spark.minPixelRadius;
    mat.maxPixelRadius.value = spark.maxPixelRadius;
    mat.ssogFillV2.value = spark.ssogFillV2 ? 1 : 0;
    mat.ssogMinContribution.value = spark.ssogMinContribution;
    // [T1-3] vertex early-exit A/B gate. 1 = the shipped guarded body; 0
    // makes the phase-2 guard uniformly true, i.e. the exact pre-T1-3
    // straight-line shader, so the two can be flipped MID-SESSION with
    // nothing else varying (the protocol that measured [ssog-11]). Read
    // per frame, so `globalThis.__kcSplatEarlyExit = 0` from a remote
    // inspector takes effect on the next frame; the viewer also maps
    // `?splatearly=off` onto it for phones with no console.
    mat.earlyExit.value =
      (globalThis as { __kcSplatEarlyExit?: number }).__kcSplatEarlyExit === 0
        ? 0
        : 1;
    // [ssog-9] expected-depth pick mode + normalization window
    mat.pickMode.value = spark.pickMode ?? 0;
    mat.pickNear.value = spark.pickNear ?? 0;
    mat.pickFar.value = spark.pickFar ?? 1;
    // ?splatvsminpx=N - quad radius for the vsMinimal ablation, read per
    // frame so it can also be swept live from a remote inspector.
    const g = globalThis as {
      __kcSplatVsMinPx?: number;
      __kcSplatVsMinExt?: number;
    };
    const vsPx = g.__kcSplatVsMinPx;
    mat.vsMinPixelRadius.value = typeof vsPx === "number" && vsPx > 0 ? vsPx : 4;
    const vsExt = g.__kcSplatVsMinExt;
    mat.vsMinExtent.value = typeof vsExt === "number" && vsExt > 0 ? vsExt : 4;
    mat.minAlpha.value = spark.minAlpha;
    mat.preBlurAmount.value = spark.preBlurAmount;
    mat.blurAmount.value = spark.blurAmount;
    mat.falloff.value = spark.falloff;
    mat.clipXY.value = spark.clipXY;
    mat.focalAdjustment.value = spark.focalAdjustment;

    const enc = this.currentEncoding(state.mesh, state.kind);
    mat.rgbMinMaxLnScaleMinMax.value.set(
      enc.rgbMin ?? 0,
      enc.rgbMax ?? 1,
      enc.lnScaleMin ?? -12,
      enc.lnScaleMax ?? 9,
    );
    mat.shMax.value.set(enc.sh1Max ?? 1, enc.sh2Max ?? 1, enc.sh3Max ?? 1);

    // object→view = view ← world ← object; SplatTransformer semantics allow
    // uniform scale only, so decompose to quat + pos + scalar scale.
    const objectToView = new Matrix4()
      .copy(camera.matrixWorld)
      .invert()
      .multiply(state.mesh.matrixWorld);
    const pos = new Vector3();
    const quat = new Quaternion();
    const scl = new Vector3();
    objectToView.decompose(pos, quat, scl);
    mat.renderToViewQuat.value.set(quat.x, quat.y, quat.z, quat.w);
    mat.renderToViewPos.value.copy(pos);
    mat.renderToViewScale.value = scl.x;

    // SH viewDir origin: camera position in OBJECT space (stock evaluates SH
    // at read time in object space with viewOrigin = viewToObject.translate)
    const worldToObject = new Matrix4()
      .copy(state.mesh.matrixWorld)
      .invert();
    const camWorld = camera.getWorldPosition(new Vector3());
    mat.viewOrigin.value.copy(camWorld.applyMatrix4(worldToObject));
  }

  // Debug/test access (harness reads the permutation + material;
  // SplatMeasure reads visCountAttr ONCE per phase boundary via
  // renderer.getArrayBufferAsync — never per frame).
  getState(): {
    kind: SourceKind;
    numSplats: number;
    capacity: number;
    numShBound: number;
    material: SplatNodeMaterial;
    sortedValues: TslNode;
    keysNode: TslNode;
    visCountAttr: THREE.BufferAttribute | null;
  } | null {
    const s = this.state;
    if (!s) return null;
    return {
      kind: s.kind,
      numSplats: s.lastNumSplats,
      capacity: s.capacity,
      numShBound: s.sh3 ? 3 : s.sh2 ? 2 : s.sh1 ? 1 : 0,
      material: s.material,
      sortedValues: s.radix.sortedValues,
      keysNode: s.keysNode,
      visCountAttr: s.visCountAttr,
    };
  }

  private findSplatMesh(scene: THREE.Scene): SplatMeshLike | null {
    const found: SplatMeshLike[] = [];
    scene.traverse((obj) => {
      const candidate = obj as Partial<SplatMeshLike>;
      const isSplatSource =
        (candidate.packedSplats &&
          typeof candidate.packedSplats.getTexture === "function") ||
        (candidate.paged && candidate.paged.dynoIndices !== undefined);
      if (obj.visible && isSplatSource) {
        found.push(obj as SplatMeshLike);
      }
    });
    if (found.length > 1 && !this.warnedMultiMesh) {
      this.warnedMultiMesh = true;
      console.warn(
        "WebGpuSplatBackend: multiple SplatMeshes found; only the first is rendered on the WebGPU path (composite cuts are out of scope).",
      );
    }
    return found[0] ?? null;
  }

  private currentEncoding(
    mesh: SplatMeshLike,
    kind: SourceKind,
  ): SplatEncodingLike {
    if (kind === "paged") return mesh.paged?.splatEncoding ?? {};
    if (kind === "lodPacked")
      return mesh.packedSplats?.lodSplats?.splatEncoding ?? {};
    return mesh.packedSplats?.splatEncoding ?? {};
  }

  private resolveSource(
    spark: SparkRendererLike,
    mesh: SplatMeshLike,
  ): ResolvedSource | null {
    const maxShMesh = mesh.maxSh ?? 3;

    const paged = mesh.paged;
    if (paged?.pager) {
      const cutTexture = paged.dynoIndices.value;
      // the empty placeholder is not 4096-wide; nothing to draw until the
      // first real cut lands
      if (paged.numSplats === 0 || cutTexture.image.width !== 4096) {
        return {
          kind: "paged",
          packedTexture: paged.pager.packedTexture.value,
          pagedTiling: true,
          cutTexture: null,
          numSplats: 0,
          capacity: 0,
          encoding: paged.splatEncoding ?? {},
          numSh: 0,
          mappingVersion: mesh.mappingVersion ?? 0,
        };
      }
      const numSh = Math.min(
        paged.numSh,
        paged.maxSh,
        paged.pager.maxSh,
        maxShMesh,
      );
      // SH pools are allocated on first SH page upload; until then the
      // placeholders (not 256×256) are bound to nothing
      const shReady = (t: THREE.DataArrayTexture) =>
        t.image.width === 256 && t.image.height === 256 ? t : undefined;
      return {
        kind: "paged",
        packedTexture: paged.pager.packedTexture.value,
        pagedTiling: true,
        cutTexture,
        numSplats: paged.numSplats,
        capacity: cutTexture.image.height * 16384,
        encoding: paged.splatEncoding ?? {},
        numSh,
        sh1: numSh >= 1 ? shReady(paged.pager.sh1Texture.value) : undefined,
        sh2: numSh >= 2 ? shReady(paged.pager.sh2Texture.value) : undefined,
        sh3: numSh >= 3 ? shReady(paged.pager.sh3Texture.value) : undefined,
        mappingVersion: mesh.mappingVersion ?? 0,
      };
    }

    const packed = mesh.packedSplats;
    if (!packed) return null;

    const lodSplats = packed.lodSplats;
    const instance = spark.lodInstances?.get(mesh);
    if (lodSplats && instance) {
      const numSh = Math.min(lodSplats.getNumSh(), maxShMesh);
      const sh = numSh > 0 ? lodSplats.ensureShTextures() : {};
      return {
        kind: "lodPacked",
        packedTexture: lodSplats.getTexture(),
        pagedTiling: false,
        cutTexture: instance.texture,
        numSplats: instance.numSplats,
        capacity: instance.indices.length,
        encoding: lodSplats.splatEncoding ?? {},
        numSh,
        sh1: numSh >= 1 ? sh.sh1Texture?.value : undefined,
        sh2: numSh >= 2 ? sh.sh2Texture?.value : undefined,
        sh3: numSh >= 3 ? sh.sh3Texture?.value : undefined,
        mappingVersion: mesh.mappingVersion ?? 0,
      };
    }

    if (packed.numSplats === 0) return null;
    const numSh = Math.min(packed.getNumSh(), maxShMesh);
    const sh = numSh > 0 ? packed.ensureShTextures() : {};
    return {
      kind: "static",
      packedTexture: packed.getTexture(),
      pagedTiling: false,
      cutTexture: null,
      numSplats: packed.numSplats,
      capacity: packed.numSplats,
      encoding: packed.splatEncoding ?? {},
      numSh,
      sh1: numSh >= 1 ? sh.sh1Texture?.value : undefined,
      sh2: numSh >= 2 ? sh.sh2Texture?.value : undefined,
      sh3: numSh >= 3 ? sh.sh3Texture?.value : undefined,
      mappingVersion: mesh.mappingVersion ?? 0,
    };
  }

  private buildState(
    spark: SparkRendererLike,
    mesh: SplatMeshLike,
    src: ResolvedSource,
  ): void {
    const { capacity, cutTexture, packedTexture, pagedTiling } = src;

    stripWebGLInternalFormat(packedTexture);
    if (cutTexture) stripWebGLInternalFormat(cutTexture);

    const keysNode = instancedArray(Math.max(1, capacity), "uint");
    // [bits] pass count and key quantization both follow sortBits (the radix
    // sorts the LOW sortBits bits, so keys must quantize into exactly that
    // range - and the padding key must be its max, not a wider 0xffff).
    const sortBits =
      this.sortBits >= 4 && this.sortBits <= 16 && this.sortBits % 4 === 0
        ? this.sortBits
        : 16;
    const quantMax = 2 ** sortBits - 1;
    const digitBits =
      this.sortDigits === 8 && sortBits % 8 === 0 ? 8 : 4;
    const reorderThreads = [64, 128, 256].includes(this.sortTpw)
      ? this.sortTpw
      : 256;

    // [vc] visible-count sort (?splatvis=1): the projector culls + compacts,
    // so it must be running (and not replaced by a vsmin ablation).
    const projOn = this.projectorEnabled && this.vsMinimal === 0;
    const visOn = projOn && this.sortVisible;
    let visCountAtomic: TslNode | null = null;
    let visCountRead: TslNode | null = null;
    let compactVals: TslNode | null = null;
    let visDispatchAttr: unknown = null;
    let visCountAttr: THREE.BufferAttribute | null = null;
    if (visOn) {
      // one buffer, two shader-side views: the ATOMIC node for the
      // projector's atomicAdd append + the pre-pass atomicStore reset, and a
      // PLAIN u32 node for the args kernel and the material's vertex-stage
      // tail reject (WGSL forbids atomic types in read-only storage, and
      // three downgrades all non-compute storage to read-only).
      visCountAtomic = instancedArray(1, "uint").toAtomic() as TslNode;
      visCountAttr = (visCountAtomic as unknown as { value: THREE.BufferAttribute })
        .value;
      visCountRead = storage(
        // biome-ignore lint/suspicious/noExplicitAny: shared attribute view
        visCountAttr as any,
        "uint",
        1,
      ) as unknown as TslNode;
      compactVals = instancedArray(Math.max(1, capacity), "uint") as TslNode;
      visDispatchAttr = new IndirectStorageBufferAttribute(
        new Uint32Array([0, 1, 1]),
        3,
      );
    }

    const radix = createRadixSort({
      keysNode,
      count: Math.max(1, capacity),
      numBits: sortBits,
      digitBits,
      reorderThreads,
      ...(visOn && visCountRead && compactVals
        ? {
            valuesNode: compactVals,
            indirect: {
              visCountNode: visCountRead,
              dispatchAttr: visDispatchAttr,
            },
          }
        : {}),
    });
    const visPrePass = visOn
      ? createVisibleClear({
          keysNode,
          count: Math.max(1, capacity),
          quantMax,
          visCountNode: visCountAtomic as TslNode,
        })
      : null;

    const uNumSplats = uniform(0); // float; exact for counts < 2^24
    const uMeshToWorld = uniform(new Matrix4());
    const uCameraPos = uniform(new Vector3());
    const uCameraDir = uniform(new Vector3(0, 0, -1));
    const uDistRange = uniform(new Vector3(0, 1, 0)); // (min, max, unused)

    const sortRadial = this.sortRadial;
    const sortKeyLog = this.sortKeyLog;
    const keygen = (Fn(() => {
      const i = instanceIndex;
      If(i.greaterThanEqual(uint(Math.max(1, capacity))), () => {
        Return();
      });
      // padding slots (zero-padded traverse output!) → max key; bounded by
      // the numSplats UNIFORM, never a texel sentinel
      If(float(i).greaterThanEqual(uNumSplats as TslNode), () => {
        keysNode.element(i).assign(uint(quantMax));
        Return();
      });

      let splatIndex: TslNode = i;
      if (cutTexture) {
        const texel = textureLoad(
          cutTexture,
          ivec2(
            int(i.shiftRight(uint(2)).bitAnd(uint(4095))),
            int(i.shiftRight(uint(14))),
          ),
        );
        const comp = i.bitAnd(uint(3));
        splatIndex = select(
          comp.equal(uint(0)),
          texel.x,
          select(
            comp.equal(uint(1)),
            texel.y,
            select(comp.equal(uint(2)), texel.z, texel.w),
          ),
        );
      }

      const texCoord = pagedTiling
        ? pagedSplatTexCoordTsl(int(splatIndex))
        : splatTexCoordTsl(int(splatIndex));
      const t = textureLoad(packedTexture, texCoord.xy).depth(texCoord.z);
      const xy = unpackHalf2x16(t.y);
      const zw = unpackHalf2x16(t.z.bitAnd(uint(0xffff)));
      const world = (uMeshToWorld as TslNode)
        .mul(vec4(vec3(xy.x, xy.y, zw.x), 1.0))
        .xyz.toVar();
      // radial (Spark default) or z-mode with the stock +100.0 bias
      const metric = sortRadial
        ? world.sub(uCameraPos).length()
        : world.sub(uCameraPos).dot(uCameraDir).add(100.0);
      // INVERTED: the radix sort is ascending, compositing draws
      // back-to-front, so far splats need the smallest keys.
      // [ssog-30] log keys: uDistRange = (log minClamp, log span, minClamp);
      // linear keys: uDistRange = (minD, maxD, 0) as before.
      const norm = sortKeyLog
        ? log(max(metric, (uDistRange as TslNode).z))
            .sub((uDistRange as TslNode).x)
            .div((uDistRange as TslNode).y)
        : metric
            .sub((uDistRange as TslNode).x)
            .div((uDistRange as TslNode).y.sub((uDistRange as TslNode).x));
      const q = uint(float(1.0).sub(clamp(norm, 0.0, 1.0)).mul(quantMax));
      keysNode.element(i).assign(q);
    })() as TslNode)
      .compute([Math.ceil(Math.max(1, capacity) / 256)], [256])
      .setName("splatKeygen");

    // [proj] the projector cache, indexed by cut slot (the keygen's domain).
    // [pack] level 0/1: four vec4 arrays (64 B/splat; level 1 only changes
    // the projector's write pattern, the layout and readers are identical).
    // Level 2: fp32 clip center + one packed uvec4 (32 B/splat).
    const packLevel =
      projOn && (this.cachePack === 1 || this.cachePack === 2)
        ? this.cachePack
        : 0;
    const projC =
      projOn && packLevel < 2
        ? {
            c0: instancedArray(Math.max(1, capacity), "vec4") as TslNode,
            c1: instancedArray(Math.max(1, capacity), "vec4") as TslNode,
            c2: instancedArray(Math.max(1, capacity), "vec4") as TslNode,
            c3: instancedArray(Math.max(1, capacity), "vec4") as TslNode,
          }
        : null;
    const projP =
      projOn && packLevel === 2
        ? {
            p0: instancedArray(Math.max(1, capacity), "vec4") as TslNode,
            p1: instancedArray(Math.max(1, capacity), "uvec4") as TslNode,
          }
        : null;

    const material = new SplatNodeMaterial({
      packedTexture,
      orderNode: radix.sortedValues,
      cutIndicesTexture: cutTexture ?? undefined,
      sh1Texture: src.sh1,
      sh2Texture: src.sh2,
      sh3Texture: src.sh3,
      lodOpacity: src.encoding.lodOpacity ?? false,
      paged: pagedTiling,
      parityQuantize: this.parityQuantize,
      vsMinimal: this.vsMinimal,
      batchSize: this.batchSize,
      projCache: projC ?? undefined,
      projPacked: projP ?? undefined,
      visCountNode: visOn && visCountRead ? visCountRead : undefined,
    });

    // [proj] the projector kernel - a verbatim port of the material's vertex
    // body (phase 1 + phase 2), run once per SLOT instead of four times per
    // splat. It shares the material's uniform NODES so there is exactly one
    // source of truth for every constant; the one thing it cannot share is
    // cameraProjectionMatrix (a render-context node), so the projection
    // matrix travels in uProjection, synced in syncUniforms().
    let projector: TslNode | null = null;
    let uProjection: { value: Matrix4 } | null = null;
    let uWriteKeys: { value: number } | null = null;
    if (projC || projP) {
      const uProj = uniform(new Matrix4());
      uProjection = uProj as unknown as { value: Matrix4 };
      // [fuse] sort-key output gate: 1 on frames update() will also submit
      // the radix, 0 otherwise, so rest frames pay no key-write bandwidth.
      const uWK = uniform(0);
      uWriteKeys = uWK as unknown as { value: number };
      const lodOpacity = src.encoding.lodOpacity ?? false;
      const parityQuantize = this.parityQuantize;
      const sh1 = src.sh1;
      const sh2 = src.sh2;
      const sh3 = src.sh3;
      projector = (Fn(() => {
        const i = instanceIndex;
        If(i.greaterThanEqual(uint(Math.max(1, capacity))), () => {
          Return();
        });
        If(float(i).greaterThanEqual(uNumSplats as TslNode), () => {
          // padding slots carry only the dead flag - c3.w = 0 / p1 live bit 0
          if (projC) {
            projC.c3.element(i).assign(vec4(0.0, 0.0, 0.0, 0.0));
          } else if (projP) {
            projP.p1.element(i).assign(uvec4(uint(0), uint(0), uint(0), uint(0)));
          }
          // [fuse] padding slots take the max key, exactly as the standalone
          // keygen pads - ascending radix sorts them to the tail. [vc] with
          // the compact sort the pre-pass clear already set EVERY key slot
          // to quantMax and padding slots never append, so no write here.
          if (!visOn) {
            If(float(uWK as TslNode).greaterThan(0.5), () => {
              keysNode.element(i).assign(uint(quantMax));
            });
          }
          Return();
        });

        // cut resolve + unpack - identical to the keygen/vertex path
        let splatIndex: TslNode = i;
        if (cutTexture) {
          const texel = textureLoad(
            cutTexture,
            ivec2(
              int(i.shiftRight(uint(2)).bitAnd(uint(4095))),
              int(i.shiftRight(uint(14))),
            ),
          );
          const comp = i.bitAnd(uint(3));
          splatIndex = select(
            comp.equal(uint(0)),
            texel.x,
            select(
              comp.equal(uint(1)),
              texel.y,
              select(comp.equal(uint(2)), texel.z, texel.w),
            ),
          );
        }
        const texCoord = pagedTiling
          ? pagedSplatTexCoordTsl(int(splatIndex))
          : splatTexCoordTsl(int(splatIndex));
        const packedData = textureLoad(packedTexture, texCoord.xy).depth(
          texCoord.z,
        );
        const unpacked = unpackSplatEncodingTsl(
          packedData,
          material.rgbMinMaxLnScaleMinMax,
        );
        const center = unpacked.center;
        const quaternion = unpacked.quaternion;

        const rejected = bool(false).toVar();

        // -- phase 1: centre rejects (verbatim) --------------------------
        const viewCenter = quatVecTsl(
          material.renderToViewQuat,
          center.mul(material.renderToViewScale),
        ).add(material.renderToViewPos);
        rejected.assign(rejected.or(viewCenter.z.greaterThanEqual(0.0)));
        const clipCenter = (uProj as TslNode).mul(vec4(viewCenter, 1.0));
        rejected.assign(
          rejected.or(clipCenter.z.abs().greaterThanEqual(clipCenter.w)),
        );
        const clip = float(material.clipXY).mul(clipCenter.w);
        rejected.assign(
          rejected
            .or(clipCenter.x.abs().greaterThan(clip))
            .or(clipCenter.y.abs().greaterThan(clip)),
        );

        // -- phase 2 (verbatim port; out-vars for the tail writes) --------
        const rgba = vec4(0.0, 0.0, 0.0, 0.0).toVar();
        const axis1 = vec2(0.0, 0.0).toVar();
        const axis2 = vec2(0.0, 0.0).toVar();
        const uvStd = float(0.0).toVar();
        const adjOut = float(0.0).toVar();
        // [pack] level 2 stores scale2 instead of axis2 (the reader derives
        // axis2 = perp(normalize(axis1)) * scale2 - eigenvectors are
        // orthogonal by construction). Declared only on that level so the
        // level-0/1 WGSL stays byte-identical to the shipped kernel.
        const scl2 = projP ? float(0.0).toVar() : null;

        If(rejected.not(), () => {
          const scales = vec3(
            unpacked.scales.mul(material.renderToViewScale),
          ).toVar();
          rgba.assign(vec4(unpacked.rgba));
          if (lodOpacity) {
            rgba.a.assign(rgba.a.mul(2.0));
          }
          if (sh1) {
            const viewDir = normalize(center.sub(material.viewOrigin));
            const shRgb = evaluatePackedShTsl({
              coord: texCoord,
              viewDir,
              shMax: material.shMax,
              sh1Texture: sh1,
              sh2Texture: sh2,
              sh3Texture: sh3,
            });
            rgba.assign(vec4(rgba.rgb.add(shRgb), rgba.a));
          }
          if (parityQuantize) {
            const rgbQ = round(clamp(rgba.rgb.mul(255.0), 0.0, 255.0)).div(
              255.0,
            );
            const aQ = round(clamp(rgba.a.mul(0.5).mul(255.0), 0.0, 255.0))
              .div(255.0)
              .mul(2.0);
            rgba.assign(vec4(rgbQ, aQ));
            const lnScaleScale = float(254.0 / (LN_SCALE_MAX - LN_SCALE_MIN));
            const requantScale = (sc: TslNode) =>
              select(
                sc.equal(0.0),
                float(0.0),
                exp(
                  round(
                    clamp(
                      sc.log().sub(LN_SCALE_MIN).mul(lnScaleScale),
                      0.0,
                      254.0,
                    ),
                  )
                    .div(lnScaleScale)
                    .add(LN_SCALE_MIN),
                ),
              );
            scales.assign(
              vec3(
                requantScale(scales.x),
                requantScale(scales.y),
                requantScale(scales.z),
              ),
            );
          }

          const zeroScales = scales.equal(vec3(0.0));
          rejected.assign(rejected.or(zeroScales.all()));
          rejected.assign(
            rejected
              .or(rgba.a.equal(0.0))
              .or(rgba.a.lessThan(material.minAlpha)),
          );

          const adjustedStdDev = float(material.maxStdDev).toVar();
          If(rgba.a.greaterThan(1.0), () => {
            rgba.a.assign(min(rgba.a.mul(4.0).sub(3.0), 5.0));
            adjustedStdDev.assign(
              float(material.maxStdDev).add(rgba.a.sub(1.0).mul(0.7)),
            );
          });

          const viewQuaternion = quatQuatTsl(
            material.renderToViewQuat,
            quaternion,
          );
          const [rsC0, rsC1, rsC2] = scaleQuaternionToMatrixColumnsTsl(
            scales,
            viewQuaternion,
          );
          const RS = (mat3 as TslNode)(rsC0, rsC1, rsC2);
          const cov3D = RS.mul(transpose(RS));

          const scaledRenderSize = vec2(material.renderSize).mul(
            material.focalAdjustment,
          );
          const focal = scaledRenderSize
            .mul(0.5)
            .mul(
              vec2(
                (uProj as TslNode).element(int(0)).element(int(0)),
                (uProj as TslNode).element(int(1)).element(int(1)),
              ),
            );
          const isOrthographic = (uProj as TslNode)
            .element(int(2))
            .element(int(3))
            .notEqual(-1.0);
          const invZ = float(1.0).div(viewCenter.z);
          const J1 = focal.mul(invZ);
          const J2 = J1.mul(viewCenter.xy).negate().mul(invZ);
          const jC0 = select(
            isOrthographic,
            vec3(focal.x, 0.0, 0.0),
            vec3(J1.x, 0.0, J2.x),
          );
          const jC1 = select(
            isOrthographic,
            vec3(0.0, focal.y, 0.0),
            vec3(0.0, J1.y, J2.y),
          );
          const J = (mat3 as TslNode)(jC0, jC1, vec3(0.0, 0.0, 0.0));
          const cov2D = transpose(J).mul(cov3D).mul(J);
          const a = float(cov2D.element(int(0)).element(int(0))).toVar();
          const d = float(cov2D.element(int(1)).element(int(1))).toVar();
          const b = cov2D.element(int(0)).element(int(1));
          a.addAssign(material.preBlurAmount);
          d.addAssign(material.preBlurAmount);
          const detOrig = a.mul(d).sub(b.mul(b));
          a.addAssign(material.blurAmount);
          d.addAssign(material.blurAmount);
          const det = a.mul(d).sub(b.mul(b));
          const blurAdjust = sqrt(max(0.0, detOrig.div(det)));
          const rawAlpha = rgba.a.toVar("kcRawAlphaP");
          rgba.a.assign(rgba.a.mul(blurAdjust));
          rejected.assign(
            rejected.or(rgba.a.lessThan(material.minAlpha)),
          );

          const fillOn = material.ssogFillV2.greaterThan(0.5);
          rejected.assign(
            rejected.or(fillOn.and(rawAlpha.lessThan(1.0 / 255.0))),
          );
          rejected.assign(
            rejected.or(
              fillOn.and(
                rawAlpha
                  .mul(6.2831853071795862)
                  .mul(sqrt(max(det, 0.0)))
                  .lessThan(material.ssogMinContribution),
              ),
            ),
          );

          const eigenAvg = a.add(d).mul(0.5);
          const eigenDelta = sqrt(
            max(0.0, eigenAvg.mul(eigenAvg).sub(det)),
          );
          const eigen1 = eigenAvg.add(eigenDelta);
          const eigen2 = eigenAvg.sub(eigenDelta);
          const eigenVec1 = select(
            b.abs().greaterThan(0.001),
            normalize(vec2(b, eigen1.sub(a))),
            select(a.greaterThanEqual(d), vec2(1.0, 0.0), vec2(0.0, 1.0)),
          );
          const eigenVec2 = vec2(eigenVec1.y, eigenVec1.x.negate());
          const r1 = adjustedStdDev.mul(sqrt(eigen1));
          const r2 = adjustedStdDev.mul(sqrt(eigen2));
          const fillCap = min(
            1024.0,
            min(material.renderSize.x, material.renderSize.y),
          );
          const capScale = min(1.0, fillCap.div(max(r1, r2)));
          const zStar = sqrt(max(0.0, log(rgba.a.mul(255.0))).mul(2.0));
          const quadScale = min(1.0, zStar.div(adjustedStdDev));
          const scale1 = select(
            fillOn,
            r1.mul(capScale).mul(quadScale),
            min(material.maxPixelRadius, r1),
          );
          const scale2 = select(
            fillOn,
            r2.mul(capScale).mul(quadScale),
            min(material.maxPixelRadius, r2),
          );
          rejected.assign(
            rejected.or(
              scale1
                .lessThan(material.minPixelRadius)
                .and(scale2.lessThan(material.minPixelRadius)),
            ),
          );
          axis1.assign(eigenVec1.mul(scale1));
          axis2.assign(eigenVec2.mul(scale2));
          if (scl2) scl2.assign(scale2);
          uvStd.assign(
            select(fillOn, adjustedStdDev.mul(quadScale), adjustedStdDev),
          );
          adjOut.assign(adjustedStdDev);
        });

        // [fuse] KEY GENERATION, fused (round-7 matrix: the standalone
        // keygen+radix chain was ~45 of the 74 ms orbit frame, and keygen
        // duplicated this kernel's cut resolve + texel fetch + transform
        // every sort frame). The metrics are EXACT ports to view space:
        // the camera transform is rigid, so |viewCenter| equals the world
        // distance keygen computed via uMeshToWorld/uCameraPos, and
        // getWorldDirection is the camera forward axis, so
        // dot(world-camPos, camDir) == -viewCenter.z. Same uDistRange
        // normalization, same 16-bit inverted quantization, same padding -
        // the radix consumes these keys byte-for-byte like keygen's.
        // Keys are written for EVERY live slot regardless of `rejected`,
        // exactly as keygen keyed every slot.
        If(float(uWK as TslNode).greaterThan(0.5), () => {
          const metric = sortRadial
            ? viewCenter.length()
            : viewCenter.z.negate().add(100.0);
          // [ssog-30] same mapping as keygen (log or linear, baked)
          const normK = sortKeyLog
            ? log(max(metric, (uDistRange as TslNode).z))
                .sub((uDistRange as TslNode).x)
                .div((uDistRange as TslNode).y)
            : metric
                .sub((uDistRange as TslNode).x)
                .div(
                  (uDistRange as TslNode).y.sub((uDistRange as TslNode).x),
                );
          const qk = uint(float(1.0).sub(clamp(normK, 0.0, 1.0)).mul(quantMax));
          if (visOn && visCountAtomic && compactVals) {
            // [vc] compact append: only NON-rejected splats enter the sort
            // domain. atomicAdd hands each visible splat a unique compact
            // position j (storage atomics rig-proven, poc/webgpu-sort stage
            // 3); the key moves from slot-indexed to compact-indexed and the
            // slot id travels in compactVals[j], so sortedValues keeps slot
            // semantics downstream. Append order is nondeterministic — ties
            // among equal quantized keys reorder run-to-run (the accepted
            // keygen-fusion diff class). Rejected splats never append; the
            // draw's visCount tail reject keeps them out of the raster,
            // where today they cost vertex work before self-rejecting.
            If(rejected.not(), () => {
              const j = atomicAdd(
                (visCountAtomic as TslNode).element(uint(0)),
                uint(1),
              ).toVar();
              keysNode.element(j).assign(qk);
              (compactVals as TslNode).element(j).assign(i);
            });
          } else {
            keysNode.element(i).assign(qk);
          }
        });

        if (projC && packLevel === 0) {
          // level 0: the shipped unconditional writes, byte-identical WGSL
          projC.c0.element(i).assign(clipCenter);
          projC.c1.element(i).assign(vec4(axis1, axis2));
          projC.c2.element(i).assign(rgba);
          projC.c3
            .element(i)
            .assign(
              vec4(uvStd, adjOut, viewCenter.z, select(rejected, 0.0, 1.0)),
            );
        } else if (projC) {
          // [pack] level 1 write guard: a rejected slot's c0..c2 are loaded
          // by the readers but discarded on c3.w before any use (stale
          // values are as good as zeros there), so only the flag word needs
          // writing - 64 -> 16 B per rejected slot per frame.
          If(rejected.not(), () => {
            projC.c0.element(i).assign(clipCenter);
            projC.c1.element(i).assign(vec4(axis1, axis2));
            projC.c2.element(i).assign(rgba);
          });
          projC.c3
            .element(i)
            .assign(
              vec4(uvStd, adjOut, viewCenter.z, select(rejected, 0.0, 1.0)),
            );
        } else if (projP) {
          // [pack] level 2: 32 B packed layout (see the cachePack comment).
          // rgb re-derives the parity-lattice integers exactly
          // (round(round(x*255)/255*255) == round(x*255)); alpha is fp16
          // (post-blurAdjust, continuous); live rides bit 24 of the rgb
          // word; viewZ is NOT stored (reader uses -p0.w, perspective).
          If(rejected.not(), () => {
            const w4 = packHalf2x16(axis1);
            const w5 = packHalf2x16(vec2(scl2 as TslNode, rgba.a));
            const r8 = uint(round(clamp(rgba.r.mul(255.0), 0.0, 255.0)));
            const g8 = uint(round(clamp(rgba.g.mul(255.0), 0.0, 255.0)));
            const b8 = uint(round(clamp(rgba.b.mul(255.0), 0.0, 255.0)));
            const w6 = r8
              .bitOr(g8.shiftLeft(uint(8)))
              .bitOr(b8.shiftLeft(uint(16)))
              .bitOr(uint(1).shiftLeft(uint(24)));
            const w7 = packHalf2x16(vec2(uvStd, adjOut));
            projP.p0.element(i).assign(clipCenter);
            projP.p1.element(i).assign(uvec4(w4, w5, w6, w7));
          }).Else(() => {
            projP.p1
              .element(i)
              .assign(uvec4(uint(0), uint(0), uint(0), uint(0)));
          });
        }
      })() as TslNode)
        .compute([Math.ceil(Math.max(1, capacity) / 256)], [256])
        .setName("splatProjector");
    }

    if (this.state) {
      // P6 diagnosis lever: old-material dispose policy is runtime-
      // selectable (baseline/leak/defer) — see kcRegrowDebug.ts.
      kcDisposeOldMaterial(spark.renderer, this.state.material);
    }
    kcRegrowLog("buildState", { capacity });
    this.state = {
      mesh,
      kind: src.kind,
      packedTexture,
      cutTexture,
      sh1: src.sh1,
      sh2: src.sh2,
      sh3: src.sh3,
      capacity,
      material,
      keysNode,
      keygen,
      radix,
      uNumSplats,
      uMeshToWorld,
      uCameraPos,
      uCameraDir,
      uDistRange,
      boundsMin: new Vector3(0, 0, 0),
      boundsMax: new Vector3(1, 1, 1),
      lastNumSplats: -1,
      lastMappingVersion: -1,
      drawInstances: 0,
      projector,
      uProjection,
      uWriteKeys,
      visPrePass,
      visGroups: radix.groups,
      visDispatchAttr,
      visCountAttr,
    };
    this.sortedOnce = false;

    // SparkRenderer (the Mesh) draws with the per-source material
    spark.material = material;

    // [dbg-adreno] batched draw wants a geometry with N quads whose vertices
    // carry the batch-local index in position.z. Swapped once, WebGPU only -
    // the WebGL2 path never reaches buildState and keeps the shared 1-quad
    // SplatGeometry.
    if (
      this.batchSize > 1 &&
      !(spark.geometry instanceof BatchedSplatGeometry)
    ) {
      spark.geometry = new BatchedSplatGeometry(this.batchSize);
    }
  }

  // (Re)compute object-space bounds for the CURRENT cut/source. Static
  // sources scan the whole packedArray once; cut sources sample the cut
  // through the CPU mirrors (cut indices texture image.data → pool/lodSplats
  // mirror) at each re-cut (≤ ~65k samples, sub-ms).
  private updateBounds(state: MeshState, src: ResolvedSource): void {
    const mesh = state.mesh;
    let bounds: Bounds | null = null;

    if (src.kind === "static") {
      const arr = mesh.packedSplats?.packedArray;
      if (arr) {
        let i = 0;
        bounds = scanBounds(arr, () => 4 * i++, src.numSplats);
      }
    } else if (src.kind === "lodPacked") {
      const arr = mesh.packedSplats?.lodSplats?.packedArray;
      const cut = state.cutTexture?.image.data as Uint32Array | undefined;
      if (arr && cut) {
        const step = Math.max(1, Math.floor(src.numSplats / 65536));
        let i = 0;
        bounds = scanBounds(
          arr,
          () => {
            const idx = cut[i];
            i += step;
            return 4 * idx;
          },
          Math.floor(src.numSplats / step),
        );
      }
    } else {
      // paged: cut entries are (page<<16)|slot into the 65536-splat pages of
      // the pool mirror
      const pool = mesh.paged?.pager?.packedTexture.value.image.data as
        | Uint32Array
        | undefined;
      const cut = state.cutTexture?.image.data as Uint32Array | undefined;
      if (pool && cut) {
        const step = Math.max(1, Math.floor(src.numSplats / 65536));
        let i = 0;
        bounds = scanBounds(
          pool,
          () => {
            const idx = cut[i];
            i += step;
            return 4 * ((idx >>> 16) * 65536 + (idx & 0xffff));
          },
          Math.floor(src.numSplats / step),
        );
      }
    }

    if (bounds) {
      state.boundsMin.copy(bounds.min);
      state.boundsMax.copy(bounds.max);
    }
  }

  private updateKeygenUniforms(state: MeshState, camera: THREE.Camera): void {
    state.mesh.updateWorldMatrix(true, false);
    (state.uMeshToWorld.value as THREE.Matrix4).copy(state.mesh.matrixWorld);

    const camPos = camera.getWorldPosition(new Vector3());
    (state.uCameraPos.value as THREE.Vector3).copy(camPos);
    const camDir = camera.getWorldDirection(new Vector3());
    (state.uCameraDir.value as THREE.Vector3).copy(camDir);

    // CPU [minDist, maxDist] for the 16-bit quantization (fork plan §4.2
    // item 4). Max distance to a box is attained at a corner; the z-mode
    // plane metric attains BOTH extrema at corners.
    const { boundsMin: mn, boundsMax: mx } = state;
    let minD = Number.POSITIVE_INFINITY;
    let maxD = Number.NEGATIVE_INFINITY;
    const corner = new Vector3();
    for (let c = 0; c < 8; c++) {
      corner.set(
        c & 1 ? mx.x : mn.x,
        c & 2 ? mx.y : mn.y,
        c & 4 ? mx.z : mn.z,
      );
      corner.applyMatrix4(state.mesh.matrixWorld);
      const d = this.sortRadial
        ? corner.distanceTo(camPos)
        : corner.sub(camPos).dot(camDir) + 100.0;
      if (d < minD) minD = d;
      if (d > maxD) maxD = d;
    }
    if (this.sortRadial) {
      // radial MIN needs the true point-to-box distance (a face can be
      // closer than every corner; overestimating minD would flatten all
      // nearer splats into bucket 0): clamp the OBJECT-space camera into
      // the object AABB, take the world-space distance to that point.
      const camObj = camPos
        .clone()
        .applyMatrix4(new Matrix4().copy(state.mesh.matrixWorld).invert());
      const closest = new Vector3(
        Math.min(Math.max(camObj.x, mn.x), mx.x),
        Math.min(Math.max(camObj.y, mn.y), mx.y),
        Math.min(Math.max(camObj.z, mn.z), mx.z),
      ).applyMatrix4(state.mesh.matrixWorld);
      minD = Math.max(0, closest.distanceTo(camPos));
    }
    if (this.sortKeyLog) {
      // [ssog-30] log-distance keys: everything nearer than minClamp shares
      // the nearest bucket (2 cm — inside any camera near plane); the span
      // is log(maxD/minClamp), ~10.7 on a 900 m scene, so the bucket at
      // distance d is d·span/65535 (0.16 mm at 1 m, 15 cm at 900 m).
      const minClamp = Math.max(minD, 0.02);
      if (maxD <= minClamp * 1.001) maxD = minClamp * 2;
      const logMin = Math.log(minClamp);
      (state.uDistRange.value as THREE.Vector3).set(
        logMin,
        Math.log(maxD) - logMin,
        minClamp,
      );
      return;
    }
    if (maxD <= minD) maxD = minD + 1;
    (state.uDistRange.value as THREE.Vector3).set(minD, maxD, 0);
  }
}

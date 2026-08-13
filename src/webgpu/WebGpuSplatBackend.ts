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
  Matrix4,
  MeshBasicNodeMaterial,
  Quaternion,
  Vector3,
} from "three/webgpu";
import {
  Fn,
  If,
  Return,
  clamp,
  float,
  instanceIndex,
  instancedArray,
  int,
  ivec2,
  select,
  textureLoad,
  uint,
  uniform,
  vec3,
  vec4,
} from "three/tsl";
import * as TSL from "three/tsl";
import {
  type TslNode,
  pagedSplatTexCoordTsl,
  splatTexCoordTsl,
  stripWebGLInternalFormat,
} from "./packedSplatsTsl";
import { kcDisposeOldMaterial, kcRegrowLog } from "../kcRegrowDebug";
import { type RadixSort, createRadixSort } from "./radixSort";
import { SplatNodeMaterial } from "./SplatNodeMaterial";

// biome-ignore lint/suspicious/noExplicitAny: r180 type decls lack this export
const unpackHalf2x16: (node: unknown) => any = (TSL as any).unpackHalf2x16;

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
  renderer: { compute(nodes: TslNode | TslNode[]): void };
  activeSplats: number;
  sortRadial?: boolean;
  maxStdDev: number;
  minPixelRadius: number;
  maxPixelRadius: number;
  ssogFillV2: boolean;
  ssogMinContribution: number;
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

  // Testing hook (harness stale-order regression): freeze the order producer.
  freezeOrder = false;

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

    let didSort = false;
    if (
      !this.freezeOrder &&
      (viewChanged || rebuilt || cutChanged || !this.sortedOnce)
    ) {
      if (rebuilt || cutChanged) {
        this.updateBounds(state, src);
      }
      (state.uNumSplats as { value: number }).value = src.numSplats;
      this.updateKeygenUniforms(state, camera);
      spark.renderer.compute([state.keygen, ...state.radix.steps]);
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
    (spark.geometry as THREE.InstancedBufferGeometry).instanceCount =
      src.numSplats;

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

    mat.renderSize.value.copy(spark.renderSize);
    mat.maxStdDev.value = spark.maxStdDev;
    mat.minPixelRadius.value = spark.minPixelRadius;
    mat.maxPixelRadius.value = spark.maxPixelRadius;
    mat.ssogFillV2.value = spark.ssogFillV2 ? 1 : 0;
    mat.ssogMinContribution.value = spark.ssogMinContribution;
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
      .copy(camera.matrixWorldInverse)
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

  // Debug/test access (harness reads the permutation + material).
  getState(): {
    kind: SourceKind;
    numSplats: number;
    capacity: number;
    numShBound: number;
    material: SplatNodeMaterial;
    sortedValues: TslNode;
    keysNode: TslNode;
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
    const radix = createRadixSort({
      keysNode,
      count: Math.max(1, capacity),
      numBits: 16,
    });

    const uNumSplats = uniform(0); // float; exact for counts < 2^24
    const uMeshToWorld = uniform(new Matrix4());
    const uCameraPos = uniform(new Vector3());
    const uCameraDir = uniform(new Vector3(0, 0, -1));
    const uDistRange = uniform(new Vector3(0, 1, 0)); // (min, max, unused)

    const sortRadial = this.sortRadial;
    const keygen = (Fn(() => {
      const i = instanceIndex;
      If(i.greaterThanEqual(uint(Math.max(1, capacity))), () => {
        Return();
      });
      // padding slots (zero-padded traverse output!) → max key; bounded by
      // the numSplats UNIFORM, never a texel sentinel
      If(float(i).greaterThanEqual(uNumSplats as TslNode), () => {
        keysNode.element(i).assign(uint(0xffff));
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
      const q = uint(
        float(1.0)
          .sub(
            clamp(
              metric
                .sub((uDistRange as TslNode).x)
                .div((uDistRange as TslNode).y.sub((uDistRange as TslNode).x)),
              0.0,
              1.0,
            ),
          )
          .mul(65535.0),
      );
      keysNode.element(i).assign(q);
    })() as TslNode)
      .compute([Math.ceil(Math.max(1, capacity) / 256)], [256])
      .setName("splatKeygen");

    const material = new SplatNodeMaterial({
      packedTexture,
      orderNode: radix.sortedValues,
      cutIndicesTexture: cutTexture ?? undefined,
      sh1Texture: src.sh1,
      sh2Texture: src.sh2,
      sh3Texture: src.sh3,
      lodOpacity: src.encoding.lodOpacity ?? false,
      paged: pagedTiling,
    });

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
    };
    this.sortedOnce = false;

    // SparkRenderer (the Mesh) draws with the per-source material
    spark.material = material;
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
    if (maxD <= minD) maxD = minD + 1;
    (state.uDistRange.value as THREE.Vector3).set(minD, maxD, 0);
  }
}

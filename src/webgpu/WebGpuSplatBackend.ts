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
//   1. find the visible SplatMesh (P2 scope: exactly one, non-paged),
//   2. (re)build per-source state: SplatNodeMaterial + keys/order storage
//      buffers + keygen kernel + radix sorter,
//   3. unless the view is unchanged (gating is an OPTIMIZATION only — under
//      motion this sorts EVERY frame, the structural fix for the rotation
//      artifact), run keygen → 16-bit radix sort in ONE renderer.compute()
//      submit; the material reads the sorted permutation via
//      order[instanceIndex],
//   4. publish activeSplats (hard app contract — loading overlays gate on
//      it) and the same-frame instanceCount.
//
// Sort key scheme (fork plan §4.2 item 3/4): fp16 center → world transform
// in fp32 → radial `length(center − cameraPos)` (sortRadial default; z-mode
// `dot(dir) + 100.0` bias reproduced exactly) → 16-bit linear quantization
// over a CPU-computed [minDist, maxDist] from the scene-bounds corners.
// P2 handles the non-paged source texture; padding never enters (count =
// numSplats exactly). The paged/cut-index variant arrives in P3.

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
  textureLoad,
  uint,
  uniform,
  vec3,
  vec4,
} from "three/tsl";
import * as TSL from "three/tsl";
import {
  type TslNode,
  splatTexCoordTsl,
} from "./packedSplatsTsl";
import { type RadixSort, createRadixSort } from "./radixSort";
import { SplatNodeMaterial } from "./SplatNodeMaterial";

// biome-ignore lint/suspicious/noExplicitAny: r180 type decls lack this export
const unpackHalf2x16: (node: unknown) => any = (TSL as any).unpackHalf2x16;

// Structural view of the Spark types this module touches (it deliberately
// imports nothing from the core bundle so the webgpu entry stays
// self-contained — see FORK-CHANGES.md).
type PackedSplatsLike = {
  numSplats: number;
  packedArray: Uint32Array | null;
  splatEncoding?: {
    rgbMin?: number;
    rgbMax?: number;
    lnScaleMin?: number;
    lnScaleMax?: number;
    sh1Max?: number;
    sh2Max?: number;
    sh3Max?: number;
    lodOpacity?: boolean;
  };
  getTexture(): THREE.DataArrayTexture;
  getNumSh(): number;
  ensureShTextures(): {
    sh1Texture?: { value: THREE.DataArrayTexture };
    sh2Texture?: { value: THREE.DataArrayTexture };
    sh3Texture?: { value: THREE.DataArrayTexture };
  };
};

type SplatMeshLike = THREE.Object3D & {
  packedSplats: PackedSplatsLike;
  maxSh?: number;
};

type SparkRendererLike = THREE.Mesh & {
  renderer: { compute(nodes: TslNode | TslNode[]): void };
  activeSplats: number;
  sortRadial?: boolean;
  maxStdDev: number;
  minPixelRadius: number;
  maxPixelRadius: number;
  minAlpha: number;
  preBlurAmount: number;
  blurAmount: number;
  falloff: number;
  clipXY: number;
  focalAdjustment: number;
  renderSize: THREE.Vector2;
};

type MeshState = {
  mesh: SplatMeshLike;
  packedSplats: PackedSplatsLike;
  numSplats: number;
  packedTexture: THREE.DataArrayTexture;
  material: SplatNodeMaterial;
  keysNode: TslNode;
  keygen: TslNode;
  radix: RadixSort;
  // object-space bounds (full scan of the fp16 centers, once per source)
  boundsMin: THREE.Vector3;
  boundsMax: THREE.Vector3;
  // keygen uniforms
  uMeshToWorld: ReturnType<typeof uniform>;
  uCameraPos: ReturnType<typeof uniform>;
  uCameraDir: ReturnType<typeof uniform>;
  uDistRange: ReturnType<typeof uniform>;
};

// fp16 → f32 (IEEE 754 half), for the CPU-side bounds scan
function fromHalf(h: number): number {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  if (e === 0) return (s ? -1 : 1) * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? Number.NaN : (s ? -1 : 1) * Number.POSITIVE_INFINITY;
  return (s ? -1 : 1) * 2 ** (e - 15) * (1 + f / 1024);
}

export class WebGpuSplatBackend {
  // Assigned by SparkRenderer's ctor until the first real material exists;
  // invisible so the pre-init frame draws nothing under WebGPU.
  placeholderMaterial: THREE.Material;

  // Sort by radial distance (true, Spark default) or view-z + 100.0 bias.
  sortRadial = true;

  // Testing hook (harness stale-order regression): freeze the order producer.
  freezeOrder = false;

  // Gate instrumentation (P2 acceptance: order age ≤ 1 frame under motion).
  frames = 0;
  sorts = 0;
  lastSortFrame = -1;

  private state: MeshState | null = null;
  private sortedOnce = false;
  private warnedMultiMesh = false;

  constructor() {
    // MUST stay visible: an invisible material would stop three from ever
    // calling SparkRenderer.onBeforeRender — which drives this whole
    // pipeline. Nothing draws anyway (instanceCount starts at 0).
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
    if (!mesh || mesh.packedSplats.numSplats === 0) {
      spark.activeSplats = 0;
      return false;
    }

    const packed = mesh.packedSplats;
    const texture = packed.getTexture();
    // sync BEFORE buildState — the keygen kernel bakes the metric choice
    this.sortRadial = spark.sortRadial ?? true;
    let rebuilt = false;
    if (
      !this.state ||
      this.state.mesh !== mesh ||
      this.state.numSplats !== packed.numSplats ||
      this.state.packedTexture !== texture
    ) {
      this.buildState(spark, mesh, packed, texture);
      rebuilt = true;
    }
    const state = this.state as MeshState;

    let didSort = false;
    if (!this.freezeOrder && (viewChanged || rebuilt || !this.sortedOnce)) {
      this.updateKeygenUniforms(state, camera);
      spark.renderer.compute([state.keygen, ...state.radix.steps]);
      this.sortedOnce = true;
      this.sorts++;
      this.lastSortFrame = this.frames;
      didSort = true;
    }

    // activeSplats publication (app contract: overlays gate on it) + the
    // same-frame instanceCount (the order buffer is fresh this frame, P0/S4)
    spark.activeSplats = state.numSplats;
    (spark.geometry as THREE.InstancedBufferGeometry).instanceCount =
      state.numSplats;
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
    mat.minAlpha.value = spark.minAlpha;
    mat.preBlurAmount.value = spark.preBlurAmount;
    mat.blurAmount.value = spark.blurAmount;
    mat.falloff.value = spark.falloff;
    mat.clipXY.value = spark.clipXY;
    mat.focalAdjustment.value = spark.focalAdjustment;

    const enc = state.packedSplats.splatEncoding ?? {};
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
    numSplats: number;
    material: SplatNodeMaterial;
    sortedValues: TslNode;
    keysNode: TslNode;
  } | null {
    const s = this.state;
    if (!s) return null;
    return {
      numSplats: s.numSplats,
      material: s.material,
      sortedValues: s.radix.sortedValues,
      keysNode: s.keysNode,
    };
  }

  private findSplatMesh(scene: THREE.Scene): SplatMeshLike | null {
    const found: SplatMeshLike[] = [];
    scene.traverse((obj) => {
      const candidate = obj as Partial<SplatMeshLike>;
      if (
        obj.visible &&
        candidate.packedSplats &&
        typeof candidate.packedSplats.getTexture === "function" &&
        candidate.packedSplats.numSplats > 0
      ) {
        found.push(obj as SplatMeshLike);
      }
    });
    if (found.length > 1 && !this.warnedMultiMesh) {
      this.warnedMultiMesh = true;
      console.warn(
        "WebGpuSplatBackend: multiple SplatMeshes found; only the first is rendered on the WebGPU path (P2 scope — composite cuts arrive with the paged path).",
      );
    }
    return found[0] ?? null;
  }

  private buildState(
    spark: SparkRendererLike,
    mesh: SplatMeshLike,
    packed: PackedSplatsLike,
    packedTexture: THREE.DataArrayTexture,
  ): void {
    const numSplats = packed.numSplats;

    // object-space bounds: full scan of the packed fp16 centers (once per
    // source version; ~30 ms @ 4.6M)
    const arr = packed.packedArray as Uint32Array;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < numSplats; i++) {
      const w1 = arr[i * 4 + 1];
      const w2 = arr[i * 4 + 2];
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

    const keysNode = instancedArray(numSplats, "uint");
    const radix = createRadixSort({ keysNode, count: numSplats, numBits: 16 });

    const uMeshToWorld = uniform(new Matrix4());
    const uCameraPos = uniform(new Vector3());
    const uCameraDir = uniform(new Vector3(0, 0, -1));
    const uDistRange = uniform(new Vector3(0, 1, 0)); // (min, max, unused)

    const sortRadial = this.sortRadial;
    const keygen = (Fn(() => {
      const i = instanceIndex;
      If(i.greaterThanEqual(uint(numSplats)), () => {
        Return();
      });
      const texCoord = splatTexCoordTsl(int(i));
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
      .compute([Math.ceil(numSplats / 256)], [256])
      .setName("splatKeygen");

    const numSh = Math.min(packed.getNumSh(), mesh.maxSh ?? 3);
    const sh = numSh > 0 ? packed.ensureShTextures() : {};
    const enc = packed.splatEncoding ?? {};

    const material = new SplatNodeMaterial({
      packedTexture,
      orderNode: radix.sortedValues,
      sh1Texture: numSh >= 1 ? sh.sh1Texture?.value : undefined,
      sh2Texture: numSh >= 2 ? sh.sh2Texture?.value : undefined,
      sh3Texture: numSh >= 3 ? sh.sh3Texture?.value : undefined,
      lodOpacity: enc.lodOpacity ?? false,
    });

    if (this.state) {
      this.state.material.dispose();
    }
    this.state = {
      mesh,
      packedSplats: packed,
      numSplats,
      packedTexture,
      material,
      keysNode,
      keygen,
      radix,
      boundsMin: new Vector3(minX, minY, minZ),
      boundsMax: new Vector3(maxX, maxY, maxZ),
      uMeshToWorld,
      uCameraPos,
      uCameraDir,
      uDistRange,
    };
    this.sortedOnce = false;

    // SparkRenderer (the Mesh) draws with the per-source material
    spark.material = material;
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

// Kroscloud WebGPU fork (2026) — see FORK-CHANGES.md, [dbg-adreno].
//
// N splats per instance, the PlayCanvas gsplat-unified draw shape
// (GSPLAT_INSTANCE_SIZE = 128 there): instead of one quad instanced once per
// splat, the geometry holds N quads whose vertices carry the quad's index
// inside the batch in position.z, and the shader reconstructs
//   splat = instanceIndex * N + position.z
// so ~1M instances become ceil(1M/N).
//
// Why: the round-2 ablation on the Pixel 4 (Adreno 640) left a 70 ms
// irreducible remainder with ALL projection arithmetic and ALL memory reads
// removed — nothing in the frame but the 1M-instance submission and
// fixed-size quads (fill measured negligible). Our own WebGL2 path issues the
// same 1M instances in a 51 ms whole-job frame, so the cost is specific to
// the instance front-end through Dawn/Vulkan on Adreno, and batching
// side-steps it exactly the way PlayCanvas does.
//
// The vertex layout replicates SplatGeometry verbatim per quad — corners
// (-1,-1) (1,-1) (1,1) (-1,1), indices [0,1,2, 0,2,3] — with z = quad index
// (exact in f32 for any sane N). WebGPU-only: the WebGL2 path keeps the
// shared 1-quad SplatGeometry and is untouched.

import * as THREE from "three";

export class BatchedSplatGeometry extends THREE.InstancedBufferGeometry {
  readonly batchSize: number;

  constructor(batchSize: number) {
    super();
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 4096) {
      throw new Error(`BatchedSplatGeometry: bad batchSize ${batchSize}`);
    }
    this.batchSize = batchSize;

    const verts = new Float32Array(batchSize * 4 * 3);
    const use32 = batchSize * 4 > 65535;
    const idx = use32
      ? new Uint32Array(batchSize * 6)
      : new Uint16Array(batchSize * 6);

    for (let q = 0; q < batchSize; q++) {
      const v = q * 12;
      // (-1,-1) (1,-1) (1,1) (-1,1), z = quad index — SplatGeometry order
      verts[v + 0] = -1; verts[v + 1] = -1; verts[v + 2] = q;
      verts[v + 3] = 1;  verts[v + 4] = -1; verts[v + 5] = q;
      verts[v + 6] = 1;  verts[v + 7] = 1;  verts[v + 8] = q;
      verts[v + 9] = -1; verts[v + 10] = 1; verts[v + 11] = q;
      const i = q * 6;
      const b = q * 4;
      idx[i + 0] = b; idx[i + 1] = b + 1; idx[i + 2] = b + 2;
      idx[i + 3] = b; idx[i + 4] = b + 2; idx[i + 5] = b + 3;
    }

    this.setAttribute("position", new THREE.BufferAttribute(verts, 3));
    this.setIndex(new THREE.BufferAttribute(idx, 1));
  }
}

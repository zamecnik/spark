// Modified by Kroscloud, 2026 — see FORK-CHANGES.md
import * as THREE from "three";

import computeUvec4Template from "./shaders/computeUvec4.glsl";
import computeUvec4Vec4Template from "./shaders/computeUvec4_Vec4.glsl";
import computeUvec4x2Vec4Template from "./shaders/computeUvec4x2_Vec4.glsl";
import computeVec4Template from "./shaders/computeVec4.glsl";
import oldSplatFragment from "./shaders/oldSplatFragment.glsl";
import oldSplatVertex from "./shaders/oldSplatVertex.glsl";
import splatDefines from "./shaders/splatDefines.glsl";
import splatFragment from "./shaders/splatFragment.glsl";
import splatVertex from "./shaders/splatVertex.glsl";

let shaders: Record<string, string> | null = null;

export function getShaders(): Record<string, string> {
  if (!shaders) {
    // Kroscloud: guard for WebGPU-build three ('three' → three.webgpu.js has
    // no ShaderChunk; the registration only serves the WebGLRenderer path).
    // Module-eval-time callers (SplatAccumulator static fields) would
    // otherwise crash the whole import for WebGPU consumers.
    // @ts-ignore
    if (THREE.ShaderChunk) THREE.ShaderChunk.splatDefines = splatDefines;
    shaders = {
      oldSplatVertex,
      oldSplatFragment,
      splatVertex,
      splatFragment,
      computeVec4Template,
      computeUvec4Vec4Template,
      computeUvec4x2Vec4Template,
      computeUvec4Template,
    };
  }
  return shaders;
}

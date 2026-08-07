// Kroscloud WebGPU fork (2026) — see FORK-CHANGES.md.
//
// Entry point of the additive WebGPU module (@sparkjsdev/spark/webgpu).
// Built as its OWN dist bundle so WebGL2-only consumers never resolve
// three/webgpu or three/tsl; load it via dynamic import() after WebGPU
// capability detection (fork plan §4.6 item 9).

export {
  SPLAT_TEX_LAYER_BITS,
  SPLAT_TEX_MASK,
  SPLAT_TEX_WIDTH_BITS,
  type TslNode,
  type UnpackedSplatTsl,
  decodeQuatOctXy88R8Tsl,
  pagedSplatTexCoordTsl,
  quatQuatTsl,
  quatVecTsl,
  scaleQuaternionToMatrixColumnsTsl,
  splatTexCoordTsl,
  stripWebGLInternalFormat,
  unpackSplatEncodingTsl,
} from "./packedSplatsTsl";
export {
  evaluatePackedSH1Tsl,
  evaluatePackedSH2Tsl,
  evaluatePackedSH3Tsl,
  evaluatePackedShTsl,
} from "./shTsl";
export {
  SplatNodeMaterial,
  type SplatNodeMaterialOptions,
} from "./SplatNodeMaterial";
export {
  type AlphaChainResult,
  referenceAlphaChain,
  roundEven,
  stockNetAlpha,
} from "./alphaReference";
export { type RadixSort, createRadixSort } from "./radixSort";
export { WebGpuSplatBackend } from "./WebGpuSplatBackend";

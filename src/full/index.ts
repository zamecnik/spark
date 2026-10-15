// Kroscloud fork (2026) — see FORK-CHANGES.md [full-1].
//
// Entry point of the additive full-detail module (@sparkjsdev/spark/full):
// one static SplatMesh holding an entire plain scene.sog with no LOD, for
// controlled devices, behind an explicit switch in the app. Built as its OWN
// dist bundle with the core package EXTERNAL (class identity for
// PackedSplats / SplatMesh, base bundles unchanged) — the same shape as the
// ssog entry. Load via dynamic import() from the app.

export {
  FULL_DETAIL_VERSION,
  FullDetailError,
  type FullDetailErrorCode,
  type FullDetailOptions,
  type FullDetailPhase,
  type FullDetailProgress,
  type FullDetailResult,
  type FullDetailStats,
  createFullDetailMesh,
  loadFullDetailSog,
} from "./FullDetailLoader";
export {
  type SogMeta,
  SogMetaError,
  type SogPlaneName,
  boundsFromMeta,
  centroidStride,
  parseSogMeta,
  planeSize,
} from "./sogMeta";
export {
  type PackOutput,
  type PackPlanes,
  type PackTables,
  type SogPlaneRgba,
  buildPackTables,
  packRange,
} from "./sogPack";
export {
  SogMeanCodeHistogram,
  composeCenterOrigin,
  decodeMeanCode,
  sogPackOrigin,
} from "./sogOrigin";
export {
  type SogWalkedEntry,
  SogStreamWalker,
  type SogZipEntry,
  SogZipError,
  type SogZipIndex,
  indexSogZip,
  sliceSogEntries,
} from "./sogZip";

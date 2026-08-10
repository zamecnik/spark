// Kroscloud fork (2026) — see FORK-CHANGES.md [ssog-2].
//
// Entry point of the additive Streamed-SOG module (@sparkjsdev/spark/ssog).
// Built as its OWN dist bundle with the core package EXTERNAL
// ("@sparkjsdev/spark" resolves to the consumer's single core instance, so
// `SsogSplats extends PagedSplats` keeps class identity and base bundles for
// non-splat scenes pull zero new code). Load via dynamic import() behind the
// ?splatvariant=ssog debug route (plan §3/Phase B).

export {
  SSOG_PAGE_SPLATS,
  SsogModel,
  type SsogLodMeta,
  type SsogLodMetaBound,
} from "./SsogModel";
export {
  SsogUnitCache,
  type SsogDecodedUnit,
  type SsogResolvedUrl,
  type SsogUnitCacheOptions,
} from "./SsogUnitCache";
export { SsogSplats, type SsogSplatsOptions } from "./SsogSplats";
export {
  SsogLodController,
  type SsogLodControllerOptions,
} from "./SsogLodController";

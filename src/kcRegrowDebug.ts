// Kroscloud fork — P6 cut-texture regrow policy + diagnosis levers.
//
// P6 finding (2026-08-07, RTX 2080/2080 Ti, driver 576.40, Chrome 151): the
// regrow transition (old texture dispose → bigger texture → full backend
// rebuild) is not inherently fatal — the exact configs that died on
// 2026-08-06 (128→256 rows crossing 2,097,152 splats @ 4K, budget 2.5M)
// survive clean AND under deliberate 4-fps-class GPU contention, with zero
// uncaptured GPU errors (no destroyed-resource submits). The 2026-08-06
// deaths were the anomalously heavy transition frame (2.7–11 s stall:
// whole-texture upload + ~25-pipeline WGSL recompile + first full draw)
// tipping over the 2 s Windows TDR margin in that day's environment
// (documented stray-headless-chrome contention era). Policy consequence:
//   1. PRE-SIZE the cut texture to the session budget at creation
//      (kcInitialCutRows) — the regrow then CANNOT fire for any fixed
//      budget; it remains only for runtime lodSplatCount raises.
//   2. When a regrow does fire, old-resource disposal is DEFERRED behind
//      queue.onSubmittedWorkDone() on WebGPU (belt-and-braces: never
//      destroy a resource an in-flight submit may reference).
//
// Diagnosis levers (harness only, default off):
//   globalThis.__kcRegrowMode:
//     (unset)      deferred dispose on WebGPU, immediate on WebGL (shipped)
//     "baseline"   dispose immediately everywhere (pre-fix behavior)
//     "leak-tex"   never dispose the old cut texture
//     "leak-mat"   never dispose the old backend material
//     "leak-all"   never dispose either
//     "defer-tex"/"defer-mat"/"defer-all"  force deferral selectively
//   globalThis.__kcCutFloorRows: FORCE the initial cut-texture row count
//     (bypasses budget pre-sizing; the p6-stress torture gate uses tiny
//     values to force mid-stream regrows on demand).
//   globalThis.__kcRegrowLog: appended sequence log (harness copies it out).
//
// Base-bundle safe: no three/webgpu imports; the renderer is duck-typed.

type KcGlobals = {
  __kcRegrowMode?: string;
  __kcCutFloorRows?: number;
  __kcRegrowLog?: Array<Record<string, unknown>>;
};

type DisposableTexture = { dispose(): void; image?: { height?: number } };
type DuckRenderer = {
  backend?: { device?: { queue?: { onSubmittedWorkDone?: () => Promise<undefined> } } };
};

const ROW_SPLATS = 16384; // 4096 texels × RGBA = indices per texture row
// Small floor: with budget pre-sizing the floor's ONLY job is headroom for
// runtime lodSplatCount raises (a dev/A-B lever — production never raises),
// and that residual regrow is safe (deferred dispose, ×2 growth). A large
// floor would tax every small-budget session with capacity-bound keygen
// cost (the sort scans capacity, not the cut).
const MIN_ROWS = 64; // 1.05M slots
const MAX_PRESIZE_ROWS = 1024; // 16.77M slots / 67 MB — sanity ceiling

export function kcRegrowMode(): string {
  return (globalThis as KcGlobals).__kcRegrowMode || "";
}

// Initial cut-texture rows for a session splat budget: size to the budget
// so a fixed-budget session NEVER regrows; keep the 384-row floor so
// moderate runtime budget raises stay regrow-free too. The harness
// __kcCutFloorRows override wins outright (torture gate).
export function kcInitialCutRows(budgetSplats: number): number {
  const forced = (globalThis as KcGlobals).__kcCutFloorRows;
  if (typeof forced === "number" && forced >= 1) return Math.floor(forced);
  const budgetRows = Math.ceil(Math.max(1, budgetSplats) / ROW_SPLATS);
  return Math.min(Math.max(budgetRows, MIN_ROWS), MAX_PRESIZE_ROWS);
}

export function kcGrowthCapRows(): number {
  return MAX_PRESIZE_ROWS;
}

export function kcRegrowLog(ev: string, data?: Record<string, unknown>): void {
  const g = globalThis as KcGlobals;
  if (!g.__kcRegrowLog) {
    g.__kcRegrowLog = [];
  }
  if (g.__kcRegrowLog.length < 300) {
    g.__kcRegrowLog.push({
      t: Math.round(globalThis.performance?.now() ?? 0),
      ev,
      ...data,
    });
  }
}

export function kcDisposeGrownTexture(
  renderer: unknown,
  texture: DisposableTexture,
): void {
  const mode = kcRegrowMode();
  kcRegrowLog("disposeTex", { rows: texture.image?.height, mode });
  if (mode === "leak-tex" || mode === "leak-all") return;
  if (mode === "baseline") {
    texture.dispose();
    return;
  }
  kcDefer(renderer, () => {
    kcRegrowLog("deferredTexDisposeFired");
    texture.dispose();
  });
}

export function kcDisposeOldMaterial(
  renderer: unknown,
  material: { dispose(): void },
): void {
  const mode = kcRegrowMode();
  kcRegrowLog("disposeMat", { mode });
  if (mode === "leak-mat" || mode === "leak-all") return;
  if (mode === "baseline") {
    material.dispose();
    return;
  }
  kcDefer(renderer, () => {
    kcRegrowLog("deferredMatDisposeFired");
    material.dispose();
  });
}

// Defer fn until currently-submitted GPU work completes. On WebGL (no
// backend.device) or a lost device this falls through to immediate — the
// deferral is only meaningful (and only needed) on a live WebGPU device.
function kcDefer(renderer: unknown, fn: () => void): void {
  const queue = (renderer as DuckRenderer)?.backend?.device?.queue;
  if (queue && typeof queue.onSubmittedWorkDone === "function") {
    queue.onSubmittedWorkDone().then(
      () => fn(),
      () => fn(),
    );
  } else {
    fn();
  }
}

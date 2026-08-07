const ROW_SPLATS = 16384;
const MIN_ROWS = 64;
const MAX_PRESIZE_ROWS = 1024;
function kcRegrowMode() {
  return globalThis.__kcRegrowMode || "";
}
function kcInitialCutRows(budgetSplats) {
  const forced = globalThis.__kcCutFloorRows;
  if (typeof forced === "number" && forced >= 1) return Math.floor(forced);
  const budgetRows = Math.ceil(Math.max(1, budgetSplats) / ROW_SPLATS);
  return Math.min(Math.max(budgetRows, MIN_ROWS), MAX_PRESIZE_ROWS);
}
function kcGrowthCapRows() {
  return MAX_PRESIZE_ROWS;
}
function kcRegrowLog(ev, data) {
  var _a;
  const g = globalThis;
  if (!g.__kcRegrowLog) {
    g.__kcRegrowLog = [];
  }
  if (g.__kcRegrowLog.length < 300) {
    g.__kcRegrowLog.push({
      t: Math.round(((_a = globalThis.performance) == null ? void 0 : _a.now()) ?? 0),
      ev,
      ...data
    });
  }
}
function kcDisposeGrownTexture(renderer, texture) {
  var _a;
  const mode = kcRegrowMode();
  kcRegrowLog("disposeTex", { rows: (_a = texture.image) == null ? void 0 : _a.height, mode });
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
function kcDisposeOldMaterial(renderer, material) {
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
function kcDefer(renderer, fn) {
  var _a, _b;
  const queue = (_b = (_a = renderer == null ? void 0 : renderer.backend) == null ? void 0 : _a.device) == null ? void 0 : _b.queue;
  if (queue && typeof queue.onSubmittedWorkDone === "function") {
    queue.onSubmittedWorkDone().then(
      () => fn(),
      () => fn()
    );
  } else {
    fn();
  }
}
export {
  kcDisposeGrownTexture as a,
  kcRegrowLog as b,
  kcGrowthCapRows as c,
  kcDisposeOldMaterial as d,
  kcInitialCutRows as k
};
//# sourceMappingURL=kcRegrowDebug-gV7aMG4z.js.map

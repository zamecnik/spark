function c() {
  return globalThis.__kcRegrowMode || "";
}
function r(t) {
  const e = globalThis.__kcCutFloorRows;
  if (typeof e == "number" && e >= 1) return Math.floor(e);
  const o = Math.ceil(Math.max(1, t) / 16384);
  return Math.min(Math.max(o, 64), 1024);
}
function u() {
  return 1024;
}
function i(t, e) {
  var s;
  const o = globalThis;
  o.__kcRegrowLog || (o.__kcRegrowLog = []), o.__kcRegrowLog.length < 300 && o.__kcRegrowLog.push({
    t: Math.round(((s = globalThis.performance) == null ? void 0 : s.now()) ?? 0),
    ev: t,
    ...e
  });
}
function l(t, e) {
  var s;
  const o = c();
  if (i("disposeTex", { rows: (s = e.image) == null ? void 0 : s.height, mode: o }), !(o === "leak-tex" || o === "leak-all")) {
    if (o === "baseline") {
      e.dispose();
      return;
    }
    a(t, () => {
      i("deferredTexDisposeFired"), e.dispose();
    });
  }
}
function f(t, e) {
  const o = c();
  if (i("disposeMat", { mode: o }), !(o === "leak-mat" || o === "leak-all")) {
    if (o === "baseline") {
      e.dispose();
      return;
    }
    a(t, () => {
      i("deferredMatDisposeFired"), e.dispose();
    });
  }
}
function a(t, e) {
  var s, n;
  const o = (n = (s = t == null ? void 0 : t.backend) == null ? void 0 : s.device) == null ? void 0 : n.queue;
  o && typeof o.onSubmittedWorkDone == "function" ? o.onSubmittedWorkDone().then(
    () => e(),
    () => e()
  ) : e();
}
export {
  l as a,
  i as b,
  u as c,
  f as d,
  r as k
};
//# sourceMappingURL=kcRegrowDebug-5oGZeoGc.js.map

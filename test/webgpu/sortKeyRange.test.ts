// Kroscloud WebGPU fork (2026) — see FORK-CHANGES.md [fov-1].
//
// The robust sort-key range: quickselect, the padded quantile box, and the
// piecewise-log key map the keygen evaluates (robustKeyNorm is its CPU
// reference; `fround` emulates the GPU's float32).

import assert from "node:assert";
import {
  ROBUST_TAIL_SHARE,
  keyOf,
  legacyLogKeyNorm,
  paddedQuantileRange,
  robustKeyMap,
  robustKeyNorm,
  selectKth,
} from "../../src/webgpu/sortKeyRange.js";

const f32 = Math.fround;
// deterministic PRNG (mulberry32)
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- selectKth: k-th smallest + partition property, duplicates included -----
{
  const r = rng(7);
  for (let trial = 0; trial < 400; trial++) {
    const n = 1 + Math.floor(r() * 3000);
    const a = new Float32Array(n);
    const levels = trial % 3 === 0 ? 5 : 1e6; // heavy duplicates every 3rd
    for (let i = 0; i < n; i++) a[i] = Math.floor(r() * levels) - levels / 2;
    const sorted = Float32Array.from(a).sort();
    const k = Math.floor(r() * n);
    const v = selectKth(a, k, 0, n - 1);
    assert.strictEqual(v, sorted[k], `trial ${trial}: k=${k} of ${n}`);
    for (let i = 0; i < k; i++) assert.ok(a[i] <= v, "left of k must be <=");
    for (let i = k + 1; i < n; i++) assert.ok(a[i] >= v, "right of k must be >=");
  }
}

// --- paddedQuantileRange: the sorted quantiles, padded 5 % of the span ------
{
  const r = rng(11);
  const m = 20000;
  const a = new Float32Array(m);
  for (let i = 0; i < m; i++) a[i] = r() * 100;
  // 1 % far outliers
  for (let i = 0; i < m / 100; i++) a[Math.floor(r() * m)] = 1e5 + r() * 1e5;
  const sorted = Float32Array.from(a).sort();
  const lo = sorted[Math.floor(0.005 * (m - 1))];
  const hi = sorted[Math.ceil(0.995 * (m - 1))];
  const [plo, phi] = paddedQuantileRange(a, m);
  const pad = 0.05 * (hi - lo) + 1e-6;
  assert.ok(Math.abs(plo - (lo - pad)) < 1e-6 && Math.abs(phi - (hi + pad)) < 1e-6);
  // 1 % outliers on ONE side sit above the 99.5 % quantile only partly: the
  // box must still be far smaller than the raw extent
  assert.ok(phi < 1e5 * 2 && phi - plo < sorted[m - 1] - sorted[0]);
}

// --- no outliers: exactly [ssog-30]'s mapping ---------------------------------
{
  const c0 = 0.02;
  const m0 = 900;
  const map = robustKeyMap(c0, m0, 0, 900);
  assert.deepStrictEqual(map.cap, [0, 1, 0]);
  for (const d of [0.001, 0.02, 0.5, 1, 10, 123.4, 899, 900, 5000]) {
    const a = robustKeyNorm(d, map);
    const b = legacyLogKeyNorm(d, c0, m0);
    assert.ok(Math.abs(Math.min(a, 1) - Math.min(b, 1)) < 1e-12, `d=${d}: ${a} vs ${b}`);
  }
}

// --- monotonic, continuous, [0, 1], segment ends where the shares say --------
function checkMap(c0: number, m0: number, rMin: number, rMax: number) {
  const map = robustKeyMap(c0, m0, rMin, rMax);
  for (const v of [...map.a, ...map.g, ...map.cap]) assert.ok(Number.isFinite(v), `finite ${JSON.stringify(map)}`);
  const [aN, aM, aF] = map.cap;
  assert.ok(Math.abs(aN + aM + aF - 1) < 1e-12 && aM >= 1 - 2 * ROBUST_TAIL_SHARE - 1e-12);
  let prev = -1;
  const N = 4000;
  for (let i = 0; i <= N; i++) {
    const d = c0 * 0.5 * (m0 * 4 / c0) ** (i / N);
    const v = robustKeyNorm(d, map);
    assert.ok(v >= prev - 1e-12, `monotonic at d=${d}`);
    assert.ok(v >= -1e-12 && v <= 1 + 1e-12, `bounded at d=${d}: ${v}`);
    prev = v;
  }
  assert.ok(Math.abs(robustKeyNorm(c0, map)) < 1e-9, "nearest end = 0");
  assert.ok(Math.abs(robustKeyNorm(m0, map) - 1) < 1e-9, "farthest end = 1");
  const c1 = 1 / map.a[1];
  assert.ok(Math.abs(robustKeyNorm(c1, map) - aN) < 1e-9, "near tail ends at aN");
  const m1 = c1 * Math.exp(map.a[3]);
  assert.ok(Math.abs(robustKeyNorm(m1, map) - (aN + aM)) < 1e-9, "robust range ends at aN + aM");
  return map;
}
checkMap(0.02, 1e5, 7440, 7655); // both tails
checkMap(0.02, 1e5, 0, 2000); // camera inside the robust box: far tail only
checkMap(6000, 9000, 6000, 8000); // near tail folded (no gap)
checkMap(0.02, 100, 50, 50); // degenerate robust range
checkMap(0.02, 100, 300, 400); // robust range beyond the raw one
checkMap(0.02, 100, 80, 10); // inverted
checkMap(1, 2, 0, 1e9); // robust wider than raw
checkMap(5, 10, 9.99, 10); // robust range at the far end

// --- the motivating case: camera 7.5 km from the subject, raw box with ------
// kilometre floaters (prod qsoy, nadir camera at 1 deg). float32 throughout.
{
  const c0 = 0.02; // the camera is INSIDE the raw box
  const m0 = 1e5;
  const legacyBucket = (d: number) => (d * Math.log(m0 / c0)) / 65535;
  assert.ok(legacyBucket(7500) > 1.5, `legacy bucket ${legacyBucket(7500)} m`);
  const map = robustKeyMap(c0, m0, 7440, 7655);
  // distance per key inside the robust range (f64): < 4 mm
  const width = 7655 - 7440;
  assert.ok(width / (map.cap[1] * 65535) < 0.004);
  // float32 keys: distances 1 cm apart get different keys, the key moves
  // monotonically and agrees with the f64 key to within 1
  let prevKey = Number.POSITIVE_INFINITY;
  for (let d = 7450; d <= 7650; d += 0.01) {
    const k32 = keyOf(robustKeyNorm(d, map, f32));
    const k64 = keyOf(robustKeyNorm(d, map));
    assert.ok(Math.abs(k32 - k64) <= 1, `d=${d}: f32 key ${k32} vs f64 ${k64}`);
    assert.ok(k32 <= prevKey, `keys must not increase with distance at d=${d}`);
    prevKey = k32;
  }
  const kA = keyOf(robustKeyNorm(7500, map, f32));
  const kB = keyOf(robustKeyNorm(7500.01, map, f32));
  const kC = keyOf(robustKeyNorm(7500.02, map, f32));
  assert.ok(kA > kC && kA >= kB, `1 cm resolution: ${kA} ${kB} ${kC}`);
  // distinct keys over 10 m of depth at 1 cm steps (1,000 samples): [ssog-30]
  // has ~6 (1.75 m buckets), the robust map gives every step its own key
  const legacyKeys = new Set<number>();
  const robustKeys = new Set<number>();
  for (let i = 0; i < 1000; i++) {
    const d = 7500 + i * 0.01;
    legacyKeys.add(keyOf(legacyLogKeyNorm(d, c0, m0, f32)));
    robustKeys.add(keyOf(robustKeyNorm(d, map, f32)));
  }
  assert.ok(legacyKeys.size <= 8, `legacy keys over 10 m: ${legacyKeys.size}`);
  assert.ok(robustKeys.size >= 990, `robust keys over 10 m: ${robustKeys.size}`);
}

// --- a normal close view keeps (at least) [ssog-30]'s near resolution --------
{
  const c0 = 0.02;
  const m0 = 1e5;
  const map = robustKeyMap(c0, m0, 0, 2000); // inside the robust box
  const bucket = (d: number, norm: (x: number) => number) => {
    // distance per key around d (numerical)
    const dd = d * 1e-4;
    return dd / ((norm(d + dd) - norm(d)) * 65535);
  };
  for (const d of [1, 10, 50, 500]) {
    const robust = bucket(d, (x) => robustKeyNorm(x, map));
    const legacy = bucket(d, (x) => legacyLogKeyNorm(x, c0, m0));
    assert.ok(robust < legacy, `d=${d}: robust ${robust} vs legacy ${legacy}`);
  }
}

console.log("sortKeyRange tests passed");

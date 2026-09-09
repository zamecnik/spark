import assert from "node:assert";
import { type SsogLodMeta, SsogModel } from "../src/ssog/SsogModel.js";

// [ssog-31] missing-level resolution: a level COARSER than the leaf's coarsest
// real level stays EMPTY (file -1, count 0); a middle gap resolves to the
// nearest available level (tie -> coarser); complete leaves are untouched.
const L = 3;
const leaf = (
  bound: number[][],
  lods: Record<string, { file: number; offset: number; count: number }>,
) => ({
  bound: { min: bound[0], max: bound[1] },
  lods,
});
const meta = {
  version: 1,
  count: 36,
  counts: [24, 9, 3],
  lodLevels: L,
  filenames: ["0_0/meta.json", "1_0/meta.json", "2_0/meta.json"],
  chunkExtent: 4,
  tree: {
    bound: { min: [0, 0, 0], max: [12, 4, 4] },
    children: [
      // A: every level present
      leaf(
        [
          [0, 0, 0],
          [4, 4, 4],
        ],
        {
          0: { file: 0, offset: 0, count: 10 },
          1: { file: 1, offset: 0, count: 5 },
          2: { file: 2, offset: 0, count: 2 },
        },
      ),
      // B: no L2 rows (coarse suffix)
      leaf(
        [
          [4, 0, 0],
          [8, 4, 4],
        ],
        {
          0: { file: 0, offset: 10, count: 8 },
          1: { file: 1, offset: 5, count: 4 },
        },
      ),
      // C: L1 missing but L2 present (middle gap)
      leaf(
        [
          [8, 0, 0],
          [12, 4, 4],
        ],
        {
          0: { file: 0, offset: 18, count: 6 },
          2: { file: 2, offset: 2, count: 1 },
        },
      ),
    ],
  },
};
const model = new SsogModel(meta as unknown as SsogLodMeta);
const lods = model.leafLods;
const at = (li: number, l: number) => [
  lods[(li * L + l) * 3],
  lods[(li * L + l) * 3 + 1],
  lods[(li * L + l) * 3 + 2],
];

assert.deepStrictEqual(at(0, 2), [2, 0, 2], "A keeps its own L2");
assert.deepStrictEqual(at(1, 1), [1, 5, 4], "B keeps its own L1");
assert.deepStrictEqual(
  at(1, 2),
  [-1, 0, 0],
  "B's missing coarsest level is EMPTY, not resolved to L1",
);
assert.deepStrictEqual(
  at(2, 1),
  [2, 2, 1],
  "C's middle gap resolves to the nearest level, tie -> coarser (L2)",
);
assert.deepStrictEqual(at(2, 2), [2, 2, 1], "C keeps its own L2");
// the pre-resolution copy still says -1 for every gap
assert.strictEqual(model.leafLodsPre[(1 * L + 2) * 3], -1);
assert.strictEqual(model.leafLodsPre[(2 * L + 1) * 3], -1);

console.log("✅ ssog-model resolution tests passed");

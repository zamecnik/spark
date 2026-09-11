import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  SogMetaError,
  boundsFromMeta,
  centroidStride,
  parseSogMeta,
  planeSize,
} from "../../src/full/sogMeta.js";
import { indexSogZip, sliceSogEntries } from "../../src/full/sogZip.js";

// [full-1] manifest validation: accept the fixture, refuse what the stream's
// decoder would not decode identically, and derive geometry/bounds exactly.
const file = new Uint8Array(
  readFileSync(new URL("../fixtures/full/smoke-sh3/scene.sog", import.meta.url)),
);
const slices = sliceSogEntries(file, indexSogZip(file));
const json = JSON.parse(new TextDecoder().decode(slices.get("meta.json")));
const planes = JSON.parse(
  readFileSync(new URL("../fixtures/full/smoke-sh3/planes/planes.json", import.meta.url), "utf8"),
);

const meta = parseSogMeta(json);
assert.strictEqual(meta.count, 20004);
assert.strictEqual(meta.bands, 3);
assert.strictEqual(meta.centroidCount, 16384);
assert.deepStrictEqual(meta.files, {
  means_l: "means_l.webp",
  means_u: "means_u.webp",
  quats: "quats.webp",
  scales: "scales.webp",
  sh0: "sh0.webp",
  shN_centroids: "shN_centroids.webp",
  shN_labels: "shN_labels.webp",
});
assert.strictEqual(meta.scalesCodebook.length, 256);
assert.strictEqual(meta.sh0Codebook.length, 256);
assert.strictEqual(meta.shNCodebook?.length, 256);

// geometry rule matches the real planes of this writer (splat-transform 3.1.7)
assert.deepStrictEqual(planeSize(20004), { width: planes.planes.means_l.width, height: planes.planes.means_l.height });
assert.deepStrictEqual(planeSize(19920313), { width: 4464, height: 4464 }, "the owner's 20M scene");
assert.deepStrictEqual(planeSize(5000000), { width: 2240, height: 2236 });
assert.strictEqual(centroidStride(planes.planes.shN_centroids.width, 3), 15);
assert.strictEqual(centroidStride(512, 2), 8);
assert.strictEqual(centroidStride(192, 1), 3);
assert.throws(() => centroidStride(512, 3), /stride/);

// bounds: sign(v)(exp|v| - 1) per stored corner
const b = boundsFromMeta(meta);
const un = (v: number) => Math.sign(v) * (Math.exp(Math.abs(v)) - 1);
for (let c = 0; c < 3; ++c) {
  const a = un(json.means.mins[c]);
  const z = un(json.means.maxs[c]);
  assert.strictEqual(b.min[c], Math.min(a, z));
  assert.strictEqual(b.max[c], Math.max(a, z));
}

// refusals
const clone = () => JSON.parse(JSON.stringify(json));
const expectCode = (j: unknown, code: SogMetaError["code"], what: string) => {
  let got: unknown = null;
  try {
    parseSogMeta(j);
  } catch (e) {
    got = e;
  }
  assert.ok(got instanceof SogMetaError, `${what}: SogMetaError (got ${String(got)})`);
  assert.strictEqual((got as SogMetaError).code, code, `${what}: code`);
};
{
  const j = clone();
  j.sh0.codebook[0] = null;
  expectCode(j, "codebook-null", "null codebook slot is refused, not patched");
}
{
  const j = clone();
  delete j.version;
  expectCode(j, "not-v2", "v1 manifest");
}
{
  const j = clone();
  j.shN.bands = 4;
  expectCode(j, "bands", "bands out of range");
}
{
  const j = clone();
  j.shN.files = ["shN_labels.webp"];
  j.shN.palette = "palette/L0/shN_centroids.webp";
  expectCode(j, "files", "palette-referencing unit shape");
}
{
  const j = clone();
  j.scales.codebook = j.scales.codebook.slice(0, 255);
  expectCode(j, "codebook", "short codebook");
}
{
  const j = clone();
  j.count = 0;
  expectCode(j, "count", "zero count");
}
// no SH at all is fine
{
  const j = clone();
  delete j.shN;
  const m = parseSogMeta(j);
  assert.strictEqual(m.bands, 0);
  assert.strictEqual(m.files.shN_labels, null);
}

console.log("✅ sogMeta tests passed");

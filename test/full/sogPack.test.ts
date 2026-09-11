import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  computeMaxSplats,
  encodeSh1Rgb,
  encodeSh2Rgb,
  encodeSh3Rgb,
  setPackedSplatCenter,
  setPackedSplatQuat,
  setPackedSplatRgba,
  setPackedSplatScales,
} from "../../src/packedEncode.js";
import { parseSogMeta } from "../../src/full/sogMeta.js";
import { type PackOutput, buildPackTables, packRange } from "../../src/full/sogPack.js";
import { indexSogZip, sliceSogEntries } from "../../src/full/sogZip.js";

// [full-1] THE parity test: the table-driven packer must write, word for
// word, what the streamed-LOD unit decoder writes. The reference below is
// pcsogsDecode.ts unpackPcSogs's v2 per-splat path, transcribed with the
// SAME packedEncode.js helpers, run on raw RGBA dumps of the SH3 fixture's
// planes (Node has no WebP decoder; the browser-side decode is covered by
// the harness parity page). Tolerance: zero.

const dir = new URL("../fixtures/full/smoke-sh3/", import.meta.url);
const file = new Uint8Array(readFileSync(new URL("scene.sog", dir)));
const slices = sliceSogEntries(file, indexSogZip(file));
const json = JSON.parse(new TextDecoder().decode(slices.get("meta.json")));
const meta = parseSogMeta(json);
const planesInfo = JSON.parse(readFileSync(new URL("planes/planes.json", dir), "utf8"));
const plane = (name: string) => new Uint8Array(readFileSync(new URL(`planes/${name}.rgba`, dir)));
const meansL = plane("means_l");
const meansU = plane("means_u");
const quats = plane("quats");
const scales = plane("scales");
const sh0 = plane("sh0");
const labels = plane("shN_labels");
const centroidsRgba = plane("shN_centroids");
const centroids = {
  rgba: centroidsRgba,
  width: planesInfo.planes.shN_centroids.width as number,
  height: planesInfo.planes.shN_centroids.height as number,
};
const count = meta.count;
assert.strictEqual(count, 20004);
assert.ok(meansL.length >= count * 4);

// ---- the reference: unpackPcSogs v2 path, per splat, real helpers -------
function referencePack(maxSh: number) {
  const maxSplats = computeMaxSplats(count);
  const packedArray = new Uint32Array(maxSplats * 4);
  const extra: { sh1?: Uint32Array; sh2?: Uint32Array; sh3?: Uint32Array } = {};
  const encoding = undefined; // decodePcSogsZip's default, as in the spike page

  // means
  for (let i = 0; i < count; ++i) {
    const i4 = i * 4;
    const fx = (meansL[i4 + 0] + (meansU[i4 + 0] << 8)) / 65535;
    const fy = (meansL[i4 + 1] + (meansU[i4 + 1] << 8)) / 65535;
    const fz = (meansL[i4 + 2] + (meansU[i4 + 2] << 8)) / 65535;
    let x = json.means.mins[0] + (json.means.maxs[0] - json.means.mins[0]) * fx;
    let y = json.means.mins[1] + (json.means.maxs[1] - json.means.mins[1]) * fy;
    let z = json.means.mins[2] + (json.means.maxs[2] - json.means.mins[2]) * fz;
    x = Math.sign(x) * (Math.exp(Math.abs(x)) - 1);
    y = Math.sign(y) * (Math.exp(Math.abs(y)) - 1);
    z = Math.sign(z) * (Math.exp(Math.abs(z)) - 1);
    setPackedSplatCenter(packedArray, i, x, y, z);
  }
  // scales
  const sLookup: number[] = json.scales.codebook.map((v: number) => Math.exp(v));
  for (let i = 0; i < count; ++i) {
    const i4 = i * 4;
    setPackedSplatScales(packedArray, i, sLookup[scales[i4]], sLookup[scales[i4 + 1]], sLookup[scales[i4 + 2]], encoding);
  }
  // quats
  const SQRT2 = Math.sqrt(2);
  const qLookup = new Array(256).fill(0).map((_, i) => (i / 255 - 0.5) * SQRT2);
  for (let i = 0; i < count; ++i) {
    const i4 = i * 4;
    const r0 = qLookup[quats[i4 + 0]];
    const r1 = qLookup[quats[i4 + 1]];
    const r2 = qLookup[quats[i4 + 2]];
    const rr = Math.sqrt(Math.max(0, 1.0 - r0 * r0 - r1 * r1 - r2 * r2));
    const rOrder = quats[i4 + 3] - 252;
    const quatX = rOrder === 0 ? r0 : rOrder === 1 ? rr : r1;
    const quatY = rOrder <= 1 ? r1 : rOrder === 2 ? rr : r2;
    const quatZ = rOrder <= 2 ? r2 : rr;
    const quatW = rOrder === 0 ? rr : r0;
    setPackedSplatQuat(packedArray, i, quatX, quatY, quatZ, quatW);
  }
  // sh0
  const SH_C0 = 0.28209479177387814;
  const cLookup: number[] = json.sh0.codebook.map((v: number) => SH_C0 * v + 0.5);
  const aLookup = new Array(256).fill(0).map((_, i) => i / 255);
  for (let i = 0; i < count; ++i) {
    const i4 = i * 4;
    setPackedSplatRgba(packedArray, i, cLookup[sh0[i4]], cLookup[sh0[i4 + 1]], cLookup[sh0[i4 + 2]], aLookup[sh0[i4 + 3]], encoding);
  }
  // shN
  if (maxSh >= 1) {
    const useSH1 = maxSh >= 1;
    const useSH2 = maxSh >= 2;
    const useSH3 = maxSh >= 3;
    if (useSH1) extra.sh1 = new Uint32Array(count * 2);
    if (useSH2) extra.sh2 = new Uint32Array(count * 4);
    if (useSH3) extra.sh3 = new Uint32Array(count * 4);
    const sh1 = new Float32Array(9);
    const sh2 = new Float32Array(15);
    const sh3 = new Float32Array(21);
    const lookup: number[] = json.shN.codebook;
    const shStride = Math.max(1, Math.floor(centroids.width / 64));
    for (let i = 0; i < count; ++i) {
      const i4 = i * 4;
      const label = labels[i4 + 0] + (labels[i4 + 1] << 8);
      const col = (label & 63) * shStride;
      const row = label >>> 6;
      const offset = row * centroids.width + col;
      for (let d = 0; d < 3; ++d) {
        if (useSH1) for (let k = 0; k < 3; ++k) sh1[k * 3 + d] = lookup[centroidsRgba[(offset + k) * 4 + d]];
        if (useSH2) for (let k = 0; k < 5; ++k) sh2[k * 3 + d] = lookup[centroidsRgba[(offset + 3 + k) * 4 + d]];
        if (useSH3) for (let k = 0; k < 7; ++k) sh3[k * 3 + d] = lookup[centroidsRgba[(offset + 8 + k) * 4 + d]];
      }
      if (useSH1) encodeSh1Rgb(extra.sh1 as Uint32Array, i, sh1, encoding);
      if (useSH2) encodeSh2Rgb(extra.sh2 as Uint32Array, i, sh2, encoding);
      if (useSH3) encodeSh3Rgb(extra.sh3 as Uint32Array, i, sh3, encoding);
    }
  }
  return { packedArray, extra };
}

function assertWordsEqual(a: Uint32Array, b: Uint32Array, n: number, what: string) {
  for (let i = 0; i < n; ++i) {
    if (a[i] !== b[i]) {
      assert.fail(`${what}: word ${i} differs: ${a[i].toString(16)} vs ${b[i].toString(16)} (splat ${Math.floor(i / (n / count))})`);
    }
  }
}

for (const maxSh of [3, 2, 1, 0]) {
  const ref = referencePack(maxSh);
  const tables = buildPackTables(meta, maxSh > 0 ? centroids : null, maxSh);
  assert.strictEqual(tables.maxSh, maxSh);
  const maxSplats = computeMaxSplats(count);
  const out: PackOutput = {
    packed: new Uint32Array(maxSplats * 4),
    sh1: maxSh >= 1 ? new Uint32Array(maxSplats * 2) : null,
    sh2: maxSh >= 2 ? new Uint32Array(maxSplats * 4) : null,
    sh3: maxSh >= 3 ? new Uint32Array(maxSplats * 4) : null,
  };
  // whole range in one call
  const r = packRange({ meansL, meansU, quats, scales, sh0, labels: maxSh > 0 ? labels : null }, count, tables, out, 0);
  assert.strictEqual(r.badLabels, 0, `maxSh ${maxSh}: no bad labels in the fixture`);
  assertWordsEqual(out.packed, ref.packedArray, count * 4, `maxSh ${maxSh} packed`);
  if (maxSh >= 1) assertWordsEqual(out.sh1 as Uint32Array, ref.extra.sh1 as Uint32Array, count * 2, `maxSh ${maxSh} sh1`);
  if (maxSh >= 2) assertWordsEqual(out.sh2 as Uint32Array, ref.extra.sh2 as Uint32Array, count * 4, `maxSh ${maxSh} sh2`);
  if (maxSh >= 3) assertWordsEqual(out.sh3 as Uint32Array, ref.extra.sh3 as Uint32Array, count * 4, `maxSh ${maxSh} sh3`);
  // padding stays zero
  for (let i = count * 4; i < out.packed.length; ++i) assert.strictEqual(out.packed[i], 0, "padding");

  // the same range as 5 bands, packed in shuffled order (the loader's K workers)
  const W = planesInfo.planes.means_l.width as number;
  const H = planesInfo.planes.means_l.height as number;
  const bands = 5;
  const rowsPer = Math.ceil(H / bands);
  const out2: PackOutput = {
    packed: new Uint32Array(maxSplats * 4),
    sh1: maxSh >= 1 ? new Uint32Array(maxSplats * 2) : null,
    sh2: maxSh >= 2 ? new Uint32Array(maxSplats * 4) : null,
    sh3: maxSh >= 3 ? new Uint32Array(maxSplats * 4) : null,
  };
  const order = [3, 0, 4, 1, 2];
  for (const k of order) {
    const y0 = k * rowsPer;
    if (y0 >= H) continue;
    const rows = Math.min(rowsPer, H - y0);
    const offset = y0 * W;
    const n = Math.min(rows * W, count - offset);
    if (n <= 0) continue;
    const sub = (p: Uint8Array) => p.subarray(offset * 4, (offset + rows * W) * 4);
    packRange(
      { meansL: sub(meansL), meansU: sub(meansU), quats: sub(quats), scales: sub(scales), sh0: sub(sh0), labels: maxSh > 0 ? sub(labels) : null },
      n,
      tables,
      out2,
      offset,
    );
  }
  assertWordsEqual(out2.packed, ref.packedArray, count * 4, `maxSh ${maxSh} banded packed`);
  if (maxSh >= 1) assertWordsEqual(out2.sh1 as Uint32Array, ref.extra.sh1 as Uint32Array, count * 2, `maxSh ${maxSh} banded sh1`);
  if (maxSh >= 3) assertWordsEqual(out2.sh3 as Uint32Array, ref.extra.sh3 as Uint32Array, count * 4, `maxSh ${maxSh} banded sh3`);
}

// out-of-palette labels: zero SH words (the reference decodes undefined ->
// NaN -> 0) and counted
{
  const tables = buildPackTables(meta, centroids, 3);
  const n = 4;
  const bad = new Uint8Array(n * 4);
  for (let i = 0; i < n; ++i) {
    bad[i * 4] = 0xff;
    bad[i * 4 + 1] = 0xff; // label 65535, far past the 16,384-centroid image
  }
  const out: PackOutput = { packed: new Uint32Array(n * 4), sh1: new Uint32Array(n * 2), sh2: new Uint32Array(n * 4), sh3: new Uint32Array(n * 4) };
  const sub = (p: Uint8Array) => p.subarray(0, n * 4);
  const r = packRange({ meansL: sub(meansL), meansU: sub(meansU), quats: sub(quats), scales: sub(scales), sh0: sub(sh0), labels: bad }, n, tables, out, 0);
  assert.strictEqual(r.badLabels, n);
  assert.ok((out.sh1 as Uint32Array).every((w) => w === 0));
  assert.ok((out.sh3 as Uint32Array).every((w) => w === 0));
}

console.log(`✅ sogPack parity tests passed (Float16Array ${"Float16Array" in globalThis ? "native" : "JS fallback"})`);

import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  SogStreamWalker,
  type SogWalkedEntry,
  SogZipError,
  indexSogZip,
  sliceSogEntries,
} from "../../src/full/sogZip.js";

// [full-1] The STORED-zip walker must reproduce the tail-first index
// byte-for-byte whatever the chunking, and refuse what it cannot handle.
const file = new Uint8Array(
  readFileSync(new URL("../fixtures/full/smoke-sh3/scene.sog", import.meta.url)),
);

const u32 = (b: Uint8Array, o: number) =>
  (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

// ---- index ---------------------------------------------------------------
const index = indexSogZip(file);
assert.strictEqual(index.entries.length, 8, "8 entries");
assert.deepStrictEqual(
  index.entries.map((e) => e.name),
  ["means_l.webp", "means_u.webp", "quats.webp", "scales.webp", "sh0.webp", "shN_centroids.webp", "shN_labels.webp", "meta.json"],
  "entry order, meta.json last",
);
const slices = sliceSogEntries(file, index);
for (const e of index.entries) {
  const s = slices.get(e.name) as Uint8Array;
  assert.strictEqual(s.length, e.size);
  if (e.name.endsWith(".webp")) {
    assert.strictEqual(String.fromCharCode(...s.subarray(0, 4)), "RIFF", `${e.name} starts with RIFF`);
    assert.strictEqual(u32(s, 4) + 8, e.size, `${e.name}: RIFF size + 8 == entry size`);
  }
}
const meta = JSON.parse(new TextDecoder().decode(slices.get("meta.json")));
assert.strictEqual(meta.count, 20004);

// ---- walker, every chunking -----------------------------------------------
function walk(bytes: Uint8Array, chunk: number) {
  const seen: SogWalkedEntry[] = [];
  const w = new SogStreamWalker((e) => seen.push(e));
  for (let o = 0; o < bytes.length; o += chunk) {
    w.push(bytes.subarray(o, Math.min(bytes.length, o + chunk)));
  }
  const idx = w.finish();
  return { seen, idx };
}
for (const chunk of [1, 7, 4096, 1 << 20, file.length]) {
  const { seen, idx } = walk(file, chunk);
  assert.strictEqual(seen.length, index.entries.length, `chunk ${chunk}: entry count`);
  for (let i = 0; i < seen.length; ++i) {
    const a = seen[i];
    const b = index.entries[i];
    assert.strictEqual(a.name, b.name, `chunk ${chunk}: name ${i}`);
    assert.strictEqual(a.headerOffset, b.headerOffset, `chunk ${chunk}: header offset ${b.name}`);
    assert.strictEqual(a.dataOffset, b.dataOffset, `chunk ${chunk}: data offset ${b.name}`);
    assert.strictEqual(a.bytes.length, b.size, `chunk ${chunk}: size ${b.name}`);
    assert.strictEqual(a.size, b.size, `chunk ${chunk}: recorded size ${b.name}`);
    assert.strictEqual(a.crc32, b.crc32, `chunk ${chunk}: crc ${b.name}`);
    assert.ok(
      Buffer.compare(Buffer.from(a.bytes), Buffer.from(slices.get(b.name) as Uint8Array)) === 0,
      `chunk ${chunk}: bytes ${b.name}`,
    );
    assert.strictEqual(idx.entries[i].size, b.size);
    assert.strictEqual(idx.entries[i].dataOffset, b.dataOffset);
  }
}

// ---- refusals -------------------------------------------------------------
const expectCode = (fn: () => unknown, code: SogZipError["code"], what: string) => {
  let got: unknown = null;
  try {
    fn();
  } catch (e) {
    got = e;
  }
  assert.ok(got instanceof SogZipError, `${what}: throws SogZipError (got ${String(got)})`);
  assert.strictEqual((got as SogZipError).code, code, `${what}: code`);
};

// EOCD offset (scan from the end)
let eocd = -1;
for (let i = file.length - 22; i >= 0; --i) {
  if (u32(file, i) === 0x06054b50) {
    eocd = i;
    break;
  }
}
assert.ok(eocd > 0, "EOCD found");

// zip64 markers in the EOCD
{
  const z = file.slice();
  z[eocd + 10] = 0xff;
  z[eocd + 11] = 0xff; // entry count 0xffff
  expectCode(() => indexSogZip(z), "zip64", "zip64 EOCD");
}
// a deflated entry in the central directory
{
  const z = file.slice();
  const cd = index.centralDirectoryOffset;
  z[cd + 10] = 8; // method of the first CD entry
  expectCode(() => indexSogZip(z), "deflated", "deflated CD entry");
  // and in a local header, for the walker
  const y = file.slice();
  y[index.entries[0].headerOffset + 8] = 8;
  expectCode(() => walk(y, 4096), "deflated", "deflated local header");
}
// truncated tail: the walker never reaches the central directory
{
  const t = file.subarray(0, index.centralDirectoryOffset - 5);
  expectCode(() => walk(t, 4096), "truncated", "truncated before the CD");
  expectCode(() => indexSogZip(t), "no-eocd", "index without EOCD");
}
// corrupted RIFF size -> the descriptor no longer matches what was walked
{
  const z = file.slice();
  const d = index.entries[0].dataOffset;
  z[d + 4] = (z[d + 4] + 8) & 0xff; // RIFF size += 8
  expectCode(() => walk(z, 4096), "bad-descriptor", "corrupt RIFF size");
}
// 12-byte descriptor without the signature (allowed by the zip spec)
{
  const e = index.entries[0];
  const descAt = e.dataOffset + e.size;
  assert.strictEqual(u32(file, descAt), 0x08074b50, "fixture uses signed descriptors");
  const z = new Uint8Array(file.length - 4);
  z.set(file.subarray(0, descAt), 0);
  z.set(file.subarray(descAt + 4), descAt);
  // every later offset moved by 4: patch the central directory header offsets
  // of entries 1.. and the EOCD's CD offset so the tail cross-check still holds
  const cdOff = index.centralDirectoryOffset - 4;
  let p = cdOff;
  for (let k = 0; k < index.entries.length; ++k) {
    const fnLen = z[p + 28] | (z[p + 29] << 8);
    const exLen = z[p + 30] | (z[p + 31] << 8);
    const cmLen = z[p + 32] | (z[p + 33] << 8);
    if (k > 0) {
      const ho = u32(z, p + 42) - 4;
      z[p + 42] = ho & 0xff;
      z[p + 43] = (ho >>> 8) & 0xff;
      z[p + 44] = (ho >>> 16) & 0xff;
      z[p + 45] = (ho >>> 24) & 0xff;
    }
    p += 46 + fnLen + exLen + cmLen;
  }
  const eocd2 = eocd - 4;
  z[eocd2 + 16] = cdOff & 0xff;
  z[eocd2 + 17] = (cdOff >>> 8) & 0xff;
  z[eocd2 + 18] = (cdOff >>> 16) & 0xff;
  z[eocd2 + 19] = (cdOff >>> 24) & 0xff;
  const { seen } = walk(z, 4096);
  assert.strictEqual(seen.length, 8, "signature-less descriptor: all entries");
  assert.strictEqual(seen[0].bytes.length, e.size, "signature-less descriptor: first entry size");
}
// a zip comment after the EOCD is tolerated by the index
{
  const comment = new TextEncoder().encode("kroscloud full-detail test comment");
  const z = new Uint8Array(file.length + comment.length);
  z.set(file, 0);
  z.set(comment, file.length);
  z[eocd + 20] = comment.length & 0xff;
  z[eocd + 21] = (comment.length >>> 8) & 0xff;
  const idx = indexSogZip(z);
  assert.strictEqual(idx.entries.length, 8, "zip comment tolerated");
  const { seen } = walk(z, 4096);
  assert.strictEqual(seen.length, 8, "walker tolerates a zip comment");
}

console.log("✅ sogZip walker/index tests passed");

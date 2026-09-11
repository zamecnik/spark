// Kroscloud fork (2026) — see FORK-CHANGES.md [full-1].
//
// The full-detail loader's inline worker (bundled with `?worker&inline`,
// the SplatWorker.ts mechanism). SEPARATE from src/worker.ts: it carries no
// wasm and no three, and the streamed-LOD path never runs it. It does two
// things: decode one WebP plane with the browser's own decoder into
// horizontal row bands (the exact createImageBitmap + WebGL2 readPixels
// route the stream's unit decoder uses, so the texels are the same bytes),
// and pack a band of every plane into PackedSplats words (sogPack.ts).
//
// RPC shape mirrors worker.ts: {id, name, args} in, {id, result} | {id, error}
// out, every ArrayBuffer in `result` transferred.

import type { SplatEncoding } from "../defines";
import type { SogMeta } from "./sogMeta";
import {
  type PackOutput,
  type PackPlanes,
  type PackTables,
  type SogPlaneRgba,
  buildPackTables,
  packRange,
} from "./sogPack";

type DecodePlaneArgs = {
  name: string;
  bytes: Uint8Array;
  /** Number of horizontal bands to split the plane into (>= 1). */
  bands: number;
  /** Expected size from the manifest's geometry rule; mismatch = refuse. */
  expectWidth?: number;
  expectHeight?: number;
};

type DecodePlaneResult = {
  name: string;
  width: number;
  height: number;
  /** Band k = rows [rowStart[k], rowStart[k] + rows[k]) as tightly packed RGBA. */
  bands: Uint8Array[];
  rowStart: number[];
  rows: number[];
  decodeMs: number;
  readMs: number;
};

type BuildTablesArgs = {
  meta: SogMeta;
  centroids: SogPlaneRgba | null;
  maxSh: number;
  encoding?: SplatEncoding;
};

type PackBandArgs = {
  planes: PackPlanes;
  count: number;
};

type PackBandResult = PackOutput & { badLabels: number; packMs: number };

let gl: WebGL2RenderingContext | null = null;
let tables: PackTables | null = null;

function getGl(): WebGL2RenderingContext {
  if (!gl) {
    const canvas = new OffscreenCanvas(1, 1);
    gl = canvas.getContext("webgl2");
    if (!gl) throw new Error("full worker: failed to create a WebGL2 context");
  }
  return gl;
}

async function decodePlane(args: DecodePlaneArgs): Promise<DecodePlaneResult> {
  const t0 = performance.now();
  // EXACTLY the stream's decodeImage options (pcsogsDecode.ts): premultiply
  // off, nothing else - not superspl.at's colorSpaceConversion:'none', so the
  // texels are the ones the LOD units decode to.
  const bitmap = await createImageBitmap(new Blob([args.bytes]), {
    premultiplyAlpha: "none",
  });
  const width = bitmap.width;
  const height = bitmap.height;
  if (
    (args.expectWidth !== undefined && width !== args.expectWidth) ||
    (args.expectHeight !== undefined && height !== args.expectHeight)
  ) {
    bitmap.close();
    throw new Error(
      `full worker: plane ${args.name} is ${width}x${height}, manifest implies ${args.expectWidth}x${args.expectHeight}`,
    );
  }
  const t1 = performance.now();
  const g = getGl();
  const texture = g.createTexture();
  g.bindTexture(g.TEXTURE_2D, texture);
  // same orientation as decodeImage: flip on upload, read from row 0 -> the
  // pixel order of the whole-plane readback the stream uses
  g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, true);
  g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, bitmap);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST);
  const fb = g.createFramebuffer();
  g.bindFramebuffer(g.FRAMEBUFFER, fb);
  g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, texture, 0);
  bitmap.close();

  const nBands = Math.max(1, Math.min(args.bands | 0, height));
  const rowsPer = Math.ceil(height / nBands);
  const bands: Uint8Array[] = [];
  const rowStart: number[] = [];
  const rows: number[] = [];
  for (let k = 0; k < nBands; ++k) {
    const y0 = k * rowsPer;
    if (y0 >= height) break;
    const r = Math.min(rowsPer, height - y0);
    const out = new Uint8Array(width * r * 4);
    g.readPixels(0, y0, width, r, g.RGBA, g.UNSIGNED_BYTE, out);
    bands.push(out);
    rowStart.push(y0);
    rows.push(r);
  }
  g.bindFramebuffer(g.FRAMEBUFFER, null);
  g.deleteFramebuffer(fb);
  g.deleteTexture(texture);
  const t2 = performance.now();
  return { name: args.name, width, height, bands, rowStart, rows, decodeMs: t1 - t0, readMs: t2 - t1 };
}

function buildTables(args: BuildTablesArgs): { maxSh: number; paletteEntries: number; ms: number } {
  const t0 = performance.now();
  tables = buildPackTables(args.meta, args.centroids, args.maxSh, args.encoding);
  return { maxSh: tables.maxSh, paletteEntries: tables.paletteEntries, ms: performance.now() - t0 };
}

function packBand(args: PackBandArgs): PackBandResult {
  if (!tables) throw new Error("full worker: packBand before buildTables");
  const t0 = performance.now();
  const n = args.count;
  const out: PackOutput = {
    packed: new Uint32Array(n * 4),
    sh1: tables.maxSh >= 1 ? new Uint32Array(n * 2) : null,
    sh2: tables.maxSh >= 2 ? new Uint32Array(n * 4) : null,
    sh3: tables.maxSh >= 3 ? new Uint32Array(n * 4) : null,
  };
  const { badLabels } = packRange(args.planes, n, tables, out, 0);
  return { ...out, badLabels, packMs: performance.now() - t0 };
}

function cancel(): boolean {
  tables = null;
  return true;
}

const handlers: Record<string, (args: never) => unknown> = {
  decodePlane,
  buildTables,
  packBand,
  cancel,
};

function transferables(value: unknown): Transferable[] {
  const out: Transferable[] = [];
  const seen = new Set<unknown>();
  const walk = (v: unknown) => {
    if (!v || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (v instanceof ArrayBuffer) out.push(v);
    else if (ArrayBuffer.isView(v)) out.push(v.buffer as ArrayBuffer);
    else if (Array.isArray(v)) for (const x of v) walk(x);
    else for (const x of Object.values(v as Record<string, unknown>)) walk(x);
  };
  walk(value);
  return out;
}

self.onmessage = async (event: MessageEvent) => {
  const { id, name, args } = event.data as { id: number; name: string; args: never };
  try {
    const handler = handlers[name];
    if (!handler) throw new Error(`full worker: unknown RPC ${name}`);
    const result = await handler(args);
    self.postMessage({ id, result }, { transfer: transferables(result) });
  } catch (error) {
    self.postMessage({ id, error: String((error as Error)?.message ?? error) });
  }
};

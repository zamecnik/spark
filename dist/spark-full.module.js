import { SplatMesh, PackedSplats } from "@sparkjsdev/spark";
import { D as DEFAULT_SPLAT_ENCODING, h as computeMaxSplats, t as toHalf, n as setPackedSplatScales, m as setPackedSplatRgba, i as encodeSh1Rgb, j as encodeSh2Rgb, k as encodeSh3Rgb, e as encodeQuatOctXy88R8 } from "./packedEncode-VGkFJ6ws.js";
const jsContent = '(function() {\n  "use strict";\n  const LN_SCALE_MIN = -12;\n  const LN_SCALE_MAX = 9;\n  const LN_SCALE_ZERO = -30;\n  const SCALE_ZERO = Math.exp(LN_SCALE_ZERO);\n  const DEFAULT_SPLAT_ENCODING = {\n    rgbMin: 0,\n    rgbMax: 1,\n    lnScaleMin: LN_SCALE_MIN,\n    lnScaleMax: LN_SCALE_MAX,\n    sh1Max: 1,\n    sh2Max: 1,\n    sh3Max: 1,\n    lodOpacity: false\n  };\n  const supportsFloat16Array = "Float16Array" in globalThis;\n  const f16buffer = supportsFloat16Array ? new globalThis["Float16Array"](1) : null;\n  const u16buffer = new Uint16Array(f16buffer == null ? void 0 : f16buffer.buffer);\n  const toHalf = supportsFloat16Array ? toHalfNative : toHalfJS;\n  function toHalfNative(f) {\n    f16buffer[0] = f;\n    return u16buffer[0];\n  }\n  const f64buffer = new Float64Array(1);\n  const u32of64buffer = new Uint32Array(f64buffer.buffer);\n  const f64HighWord = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1 ? 1 : 0;\n  const halfMantissaScale = Array.from({ length: 30 }, (_, k) => 2 ** (24 - k));\n  function roundHalfEven(m) {\n    const fl = Math.floor(m);\n    const d = m - fl;\n    return d > 0.5 || d === 0.5 && (fl & 1) === 1 ? fl + 1 : fl;\n  }\n  function toHalfJS(f) {\n    f64buffer[0] = f;\n    const hi = u32of64buffer[f64HighWord];\n    const sign = hi >>> 16 & 32768;\n    const exp64 = hi >>> 20 & 2047;\n    if (exp64 === 2047) {\n      return sign | (Number.isNaN(f) ? 32256 : 31744);\n    }\n    const a = Math.abs(f);\n    const e = exp64 - 1023;\n    if (e >= 16) {\n      return sign | 31744;\n    }\n    if (e < -14) {\n      return sign | roundHalfEven(a * 16777216);\n    }\n    return sign | (e + 15 << 10) + roundHalfEven(a * halfMantissaScale[e + 14]) - 1024;\n  }\n  function floatToUint8(v) {\n    return Math.max(0, Math.min(255, Math.round(v * 255)));\n  }\n  function encodeQuatOctXy88R8(q) {\n    let { x, y, z, w } = q;\n    const len = Math.sqrt(x * x + y * y + z * z + w * w);\n    if (len === 0) {\n      x = 0;\n      y = 0;\n      z = 0;\n      w = 1;\n    } else {\n      const inv = 1 / len;\n      x *= inv;\n      y *= inv;\n      z *= inv;\n      w *= inv;\n    }\n    if (w < 0) {\n      x = -x;\n      y = -y;\n      z = -z;\n      w = -w;\n    }\n    const theta = 2 * Math.acos(w);\n    const xyz_norm = Math.sqrt(x * x + y * y + z * z);\n    let axisX;\n    let axisY;\n    let axisZ;\n    if (xyz_norm < 1e-6) {\n      axisX = 1;\n      axisY = 0;\n      axisZ = 0;\n    } else {\n      axisX = x / xyz_norm;\n      axisY = y / xyz_norm;\n      axisZ = z / xyz_norm;\n    }\n    const sum = Math.abs(axisX) + Math.abs(axisY) + Math.abs(axisZ);\n    let p_x = axisX / sum;\n    let p_y = axisY / sum;\n    if (axisZ < 0) {\n      const tmp = p_x;\n      p_x = (1 - Math.abs(p_y)) * (p_x >= 0 ? 1 : -1);\n      p_y = (1 - Math.abs(tmp)) * (p_y >= 0 ? 1 : -1);\n    }\n    const u_f = p_x * 0.5 + 0.5;\n    const v_f = p_y * 0.5 + 0.5;\n    const quantU = Math.round(u_f * 255);\n    const quantV = Math.round(v_f * 255);\n    const angleInt = Math.round(theta * (255 / Math.PI));\n    return angleInt << 16 | quantV << 8 | quantU;\n  }\n  function setPackedSplatScales(packedSplats, index, scaleX, scaleY, scaleZ, encoding) {\n    const lnScaleMin = (encoding == null ? void 0 : encoding.lnScaleMin) ?? LN_SCALE_MIN;\n    const lnScaleMax = (encoding == null ? void 0 : encoding.lnScaleMax) ?? LN_SCALE_MAX;\n    const lnScaleScale = 254 / (lnScaleMax - lnScaleMin);\n    const uScaleX = scaleX < SCALE_ZERO ? 0 : Math.min(\n      255,\n      Math.max(\n        1,\n        Math.round((Math.log(scaleX) - lnScaleMin) * lnScaleScale) + 1\n      )\n    );\n    const uScaleY = scaleY < SCALE_ZERO ? 0 : Math.min(\n      255,\n      Math.max(\n        1,\n        Math.round((Math.log(scaleY) - lnScaleMin) * lnScaleScale) + 1\n      )\n    );\n    const uScaleZ = scaleZ < SCALE_ZERO ? 0 : Math.min(\n      255,\n      Math.max(\n        1,\n        Math.round((Math.log(scaleZ) - lnScaleMin) * lnScaleScale) + 1\n      )\n    );\n    const i4 = index * 4;\n    packedSplats[i4 + 3] = uScaleX | uScaleY << 8 | uScaleZ << 16 | packedSplats[i4 + 3] & 4278190080;\n  }\n  function setPackedSplatRgba(packedSplats, index, r, g, b, a, encoding) {\n    const rgbMin = (encoding == null ? void 0 : encoding.rgbMin) ?? 0;\n    const rgbMax = (encoding == null ? void 0 : encoding.rgbMax) ?? 1;\n    const rgbRange = rgbMax - rgbMin;\n    const uR = floatToUint8((r - rgbMin) / rgbRange);\n    const uG = floatToUint8((g - rgbMin) / rgbRange);\n    const uB = floatToUint8((b - rgbMin) / rgbRange);\n    const uA = floatToUint8((encoding == null ? void 0 : encoding.lodOpacity) ? 0.5 * a : a);\n    const i4 = index * 4;\n    packedSplats[i4] = uR | uG << 8 | uB << 16 | uA << 24;\n  }\n  function packSint8Bytes(b0, b1, b2, b3) {\n    const clampedB0 = Math.round(Math.max(-127, Math.min(127, b0 * 127)));\n    const clampedB1 = Math.round(Math.max(-127, Math.min(127, b1 * 127)));\n    const clampedB2 = Math.round(Math.max(-127, Math.min(127, b2 * 127)));\n    const clampedB3 = Math.round(Math.max(-127, Math.min(127, b3 * 127)));\n    return clampedB0 & 255 | (clampedB1 & 255) << 8 | (clampedB2 & 255) << 16 | (clampedB3 & 255) << 24;\n  }\n  function encodeSh1Rgb(sh1Array, index, sh1Rgb, encoding) {\n    const sh1Max = (encoding == null ? void 0 : encoding.sh1Max) ?? 1;\n    const sh1Scale = 63 / sh1Max;\n    const base = index * 2;\n    for (let i = 0; i < 9; ++i) {\n      const s = sh1Rgb[i] * sh1Scale;\n      const value = Math.round(Math.max(-63, Math.min(63, s))) & 127;\n      const bitStart = i * 7;\n      const bitEnd = bitStart + 7;\n      const wordStart = Math.floor(bitStart / 32);\n      const bitOffset = bitStart - wordStart * 32;\n      const firstWord = value << bitOffset & 4294967295;\n      sh1Array[base + wordStart] |= firstWord;\n      if (bitEnd > wordStart * 32 + 32) {\n        const secondWord = value >>> 32 - bitOffset & 4294967295;\n        sh1Array[base + wordStart + 1] |= secondWord;\n      }\n    }\n  }\n  function encodeSh2Rgb(sh2Array, index, sh2Rgb, encoding) {\n    const sh2Max = (encoding == null ? void 0 : encoding.sh2Max) ?? 1;\n    const sh2Scale = 1 / sh2Max;\n    sh2Array[index * 4 + 0] = packSint8Bytes(\n      sh2Rgb[0] * sh2Scale,\n      sh2Rgb[1] * sh2Scale,\n      sh2Rgb[2] * sh2Scale,\n      sh2Rgb[3] * sh2Scale\n    );\n    sh2Array[index * 4 + 1] = packSint8Bytes(\n      sh2Rgb[4] * sh2Scale,\n      sh2Rgb[5] * sh2Scale,\n      sh2Rgb[6] * sh2Scale,\n      sh2Rgb[7] * sh2Scale\n    );\n    sh2Array[index * 4 + 2] = packSint8Bytes(\n      sh2Rgb[8] * sh2Scale,\n      sh2Rgb[9] * sh2Scale,\n      sh2Rgb[10] * sh2Scale,\n      sh2Rgb[11] * sh2Scale\n    );\n    sh2Array[index * 4 + 3] = packSint8Bytes(\n      sh2Rgb[12] * sh2Scale,\n      sh2Rgb[13] * sh2Scale,\n      sh2Rgb[14] * sh2Scale,\n      0\n    );\n  }\n  function encodeSh3Rgb(sh3Array, index, sh3Rgb, encoding) {\n    const sh3Max = (encoding == null ? void 0 : encoding.sh3Max) ?? 1;\n    const sh3Scale = 31 / sh3Max;\n    const base = index * 4;\n    for (let i = 0; i < 21; ++i) {\n      const s = sh3Rgb[i] * sh3Scale;\n      const value = Math.round(Math.max(-31, Math.min(31, s))) & 63;\n      const bitStart = i * 6;\n      const bitEnd = bitStart + 6;\n      const wordStart = Math.floor(bitStart / 32);\n      const bitOffset = bitStart - wordStart * 32;\n      const firstWord = value << bitOffset & 4294967295;\n      sh3Array[base + wordStart] |= firstWord;\n      if (bitEnd > wordStart * 32 + 32) {\n        const secondWord = value >>> 32 - bitOffset & 4294967295;\n        sh3Array[base + wordStart + 1] |= secondWord;\n      }\n    }\n  }\n  class SogMetaError extends Error {\n    constructor(code, message) {\n      super(message);\n      this.name = "SogMetaError";\n      this.code = code;\n    }\n  }\n  function centroidStride(width, bands) {\n    const stride = Math.max(1, Math.floor(width / 64));\n    const expected = bands >= 3 ? 15 : bands === 2 ? 8 : 3;\n    if (stride !== expected) {\n      throw new SogMetaError(\n        "bands",\n        `shN_centroids width ${width} implies stride ${stride}, but bands ${bands} needs ${expected}`\n      );\n    }\n    return stride;\n  }\n  const SH_C0 = 0.28209479177387814;\n  const SQRT2 = Math.sqrt(2);\n  function buildPackTables(meta, centroids, maxShRequested, encoding = DEFAULT_SPLAT_ENCODING, origin = [0, 0, 0]) {\n    const maxSh = Math.max(0, Math.min(3, meta.bands, Math.floor(maxShRequested)));\n    const scratch = new Uint32Array(4);\n    const centerHalf = [\n      new Uint16Array(65536),\n      new Uint16Array(65536),\n      new Uint16Array(65536)\n    ];\n    for (let c = 0; c < 3; ++c) {\n      const mn = meta.means.mins[c];\n      const mx = meta.means.maxs[c];\n      const oc = origin[c] || 0;\n      const t = centerHalf[c];\n      for (let n = 0; n < 65536; ++n) {\n        const f = n / 65535;\n        let v = mn + (mx - mn) * f;\n        v = Math.sign(v) * (Math.exp(Math.abs(v)) - 1);\n        t[n] = toHalf(v - oc);\n      }\n    }\n    const scaleByte = new Uint8Array(256);\n    for (let b = 0; b < 256; ++b) {\n      const s = Math.exp(meta.scalesCodebook[b]);\n      scratch[3] = 0;\n      setPackedSplatScales(scratch, 0, s, s, s, encoding);\n      scaleByte[b] = scratch[3] & 255;\n    }\n    const rgbByte = new Uint8Array(256);\n    const alphaByte = new Uint8Array(256);\n    for (let b = 0; b < 256; ++b) {\n      const r = SH_C0 * meta.sh0Codebook[b] + 0.5;\n      scratch[0] = 0;\n      setPackedSplatRgba(scratch, 0, r, r, r, 0, encoding);\n      rgbByte[b] = scratch[0] & 255;\n      scratch[0] = 0;\n      setPackedSplatRgba(scratch, 0, 0, 0, 0, b / 255, encoding);\n      alphaByte[b] = scratch[0] >>> 24 & 255;\n    }\n    const quatComp = new Float64Array(256);\n    for (let b = 0; b < 256; ++b) quatComp[b] = (b / 255 - 0.5) * SQRT2;\n    let paletteEntries = 0;\n    let paletteSh1 = null;\n    let paletteSh2 = null;\n    let paletteSh3 = null;\n    if (maxSh > 0) {\n      if (!centroids || !meta.shNCodebook) {\n        throw new Error("buildPackTables: SH requested but no centroid plane / codebook");\n      }\n      const stride = centroidStride(centroids.width, meta.bands);\n      const width = centroids.width;\n      paletteEntries = Math.min(65536, centroids.height * 64);\n      const lookup = meta.shNCodebook;\n      const px = centroids.rgba;\n      const sh1 = new Float32Array(9);\n      const sh2 = new Float32Array(15);\n      const sh3 = new Float32Array(21);\n      if (maxSh >= 1) paletteSh1 = new Uint32Array(paletteEntries * 2);\n      if (maxSh >= 2) paletteSh2 = new Uint32Array(paletteEntries * 4);\n      if (maxSh >= 3) paletteSh3 = new Uint32Array(paletteEntries * 4);\n      for (let label = 0; label < paletteEntries; ++label) {\n        const col = (label & 63) * stride;\n        const row = label >>> 6;\n        const offset = row * width + col;\n        for (let d = 0; d < 3; ++d) {\n          if (maxSh >= 1) {\n            for (let k = 0; k < 3; ++k) sh1[k * 3 + d] = lookup[px[(offset + k) * 4 + d]];\n          }\n          if (maxSh >= 2) {\n            for (let k = 0; k < 5; ++k) sh2[k * 3 + d] = lookup[px[(offset + 3 + k) * 4 + d]];\n          }\n          if (maxSh >= 3) {\n            for (let k = 0; k < 7; ++k) sh3[k * 3 + d] = lookup[px[(offset + 8 + k) * 4 + d]];\n          }\n        }\n        if (paletteSh1) encodeSh1Rgb(paletteSh1, label, sh1, encoding);\n        if (paletteSh2) encodeSh2Rgb(paletteSh2, label, sh2, encoding);\n        if (paletteSh3) encodeSh3Rgb(paletteSh3, label, sh3, encoding);\n      }\n    }\n    return {\n      centerHalf,\n      scaleByte,\n      rgbByte,\n      alphaByte,\n      quatComp,\n      maxSh,\n      paletteEntries,\n      paletteSh1,\n      paletteSh2,\n      paletteSh3\n    };\n  }\n  function packRange(planes, count, tables2, out, outIndex) {\n    const { meansL, meansU, quats, scales, sh0 } = planes;\n    const [tx, ty, tz] = tables2.centerHalf;\n    const scaleByte = tables2.scaleByte;\n    const rgbByte = tables2.rgbByte;\n    const alphaByte = tables2.alphaByte;\n    const quatComp = tables2.quatComp;\n    const packed = out.packed;\n    const q = { x: 0, y: 0, z: 0, w: 1 };\n    for (let i = 0; i < count; ++i) {\n      const i4 = i * 4;\n      const o4 = (outIndex + i) * 4;\n      packed[o4] = rgbByte[sh0[i4]] | rgbByte[sh0[i4 + 1]] << 8 | rgbByte[sh0[i4 + 2]] << 16 | alphaByte[sh0[i4 + 3]] << 24;\n      const nx = meansL[i4] | meansU[i4] << 8;\n      const ny = meansL[i4 + 1] | meansU[i4 + 1] << 8;\n      const nz = meansL[i4 + 2] | meansU[i4 + 2] << 8;\n      packed[o4 + 1] = tx[nx] | ty[ny] << 16;\n      const r0 = quatComp[quats[i4]];\n      const r1 = quatComp[quats[i4 + 1]];\n      const r2 = quatComp[quats[i4 + 2]];\n      const rr = Math.sqrt(Math.max(0, 1 - r0 * r0 - r1 * r1 - r2 * r2));\n      const rOrder = quats[i4 + 3] - 252;\n      q.x = rOrder === 0 ? r0 : rOrder === 1 ? rr : r1;\n      q.y = rOrder <= 1 ? r1 : rOrder === 2 ? rr : r2;\n      q.z = rOrder <= 2 ? r2 : rr;\n      q.w = rOrder === 0 ? rr : r0;\n      const uQuat = encodeQuatOctXy88R8(q);\n      const uQuatX = uQuat & 255;\n      const uQuatY = uQuat >>> 8 & 255;\n      const uQuatZ = uQuat >>> 16 & 255;\n      packed[o4 + 2] = tz[nz] | uQuatX << 16 | uQuatY << 24;\n      packed[o4 + 3] = scaleByte[scales[i4]] | scaleByte[scales[i4 + 1]] << 8 | scaleByte[scales[i4 + 2]] << 16 | uQuatZ << 24;\n    }\n    let badLabels = 0;\n    if (tables2.maxSh > 0) {\n      const labels = planes.labels;\n      if (!labels) throw new Error("packRange: labels plane missing");\n      const n = tables2.paletteEntries;\n      const p1 = tables2.paletteSh1;\n      const p2 = tables2.paletteSh2;\n      const p3 = tables2.paletteSh3;\n      const s1 = out.sh1;\n      const s2 = out.sh2;\n      const s3 = out.sh3;\n      for (let i = 0; i < count; ++i) {\n        const i4 = i * 4;\n        const label = labels[i4] | labels[i4 + 1] << 8;\n        const o = outIndex + i;\n        if (label < n) {\n          if (p1 && s1) {\n            s1[o * 2] = p1[label * 2];\n            s1[o * 2 + 1] = p1[label * 2 + 1];\n          }\n          if (p2 && s2) {\n            s2[o * 4] = p2[label * 4];\n            s2[o * 4 + 1] = p2[label * 4 + 1];\n            s2[o * 4 + 2] = p2[label * 4 + 2];\n            s2[o * 4 + 3] = p2[label * 4 + 3];\n          }\n          if (p3 && s3) {\n            s3[o * 4] = p3[label * 4];\n            s3[o * 4 + 1] = p3[label * 4 + 1];\n            s3[o * 4 + 2] = p3[label * 4 + 2];\n            s3[o * 4 + 3] = p3[label * 4 + 3];\n          }\n        } else {\n          badLabels++;\n          if (s1) {\n            s1[o * 2] = 0;\n            s1[o * 2 + 1] = 0;\n          }\n          if (s2) s2.fill(0, o * 4, o * 4 + 4);\n          if (s3) s3.fill(0, o * 4, o * 4 + 4);\n        }\n      }\n    }\n    return { badLabels };\n  }\n  let gl = null;\n  let tables = null;\n  function getGl() {\n    if (!gl) {\n      const canvas = new OffscreenCanvas(1, 1);\n      gl = canvas.getContext("webgl2");\n      if (!gl) throw new Error("full worker: failed to create a WebGL2 context");\n    }\n    return gl;\n  }\n  async function decodePlane(args) {\n    const t0 = performance.now();\n    const bitmap = await createImageBitmap(new Blob([args.bytes]), {\n      premultiplyAlpha: "none"\n    });\n    const width = bitmap.width;\n    const height = bitmap.height;\n    if (args.expectWidth !== void 0 && width !== args.expectWidth || args.expectHeight !== void 0 && height !== args.expectHeight) {\n      bitmap.close();\n      throw new Error(\n        `full worker: plane ${args.name} is ${width}x${height}, manifest implies ${args.expectWidth}x${args.expectHeight}`\n      );\n    }\n    const t1 = performance.now();\n    const g = getGl();\n    const texture = g.createTexture();\n    g.bindTexture(g.TEXTURE_2D, texture);\n    g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, true);\n    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, bitmap);\n    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST);\n    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST);\n    const fb = g.createFramebuffer();\n    g.bindFramebuffer(g.FRAMEBUFFER, fb);\n    g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, texture, 0);\n    bitmap.close();\n    const nBands = Math.max(1, Math.min(args.bands | 0, height));\n    const rowsPer = Math.ceil(height / nBands);\n    const bands = [];\n    const rowStart = [];\n    const rows = [];\n    for (let k = 0; k < nBands; ++k) {\n      const y0 = k * rowsPer;\n      if (y0 >= height) break;\n      const r = Math.min(rowsPer, height - y0);\n      const out = new Uint8Array(width * r * 4);\n      g.readPixels(0, y0, width, r, g.RGBA, g.UNSIGNED_BYTE, out);\n      bands.push(out);\n      rowStart.push(y0);\n      rows.push(r);\n    }\n    g.bindFramebuffer(g.FRAMEBUFFER, null);\n    g.deleteFramebuffer(fb);\n    g.deleteTexture(texture);\n    const t2 = performance.now();\n    return { name: args.name, width, height, bands, rowStart, rows, decodeMs: t1 - t0, readMs: t2 - t1 };\n  }\n  function buildTables(args) {\n    const t0 = performance.now();\n    tables = buildPackTables(\n      args.meta,\n      args.centroids,\n      args.maxSh,\n      args.encoding,\n      args.origin\n    );\n    return { maxSh: tables.maxSh, paletteEntries: tables.paletteEntries, ms: performance.now() - t0 };\n  }\n  function packBand(args) {\n    if (!tables) throw new Error("full worker: packBand before buildTables");\n    const t0 = performance.now();\n    const n = args.count;\n    const out = {\n      packed: new Uint32Array(n * 4),\n      sh1: tables.maxSh >= 1 ? new Uint32Array(n * 2) : null,\n      sh2: tables.maxSh >= 2 ? new Uint32Array(n * 4) : null,\n      sh3: tables.maxSh >= 3 ? new Uint32Array(n * 4) : null\n    };\n    const { badLabels } = packRange(args.planes, n, tables, out, 0);\n    return { ...out, badLabels, packMs: performance.now() - t0 };\n  }\n  function cancel() {\n    tables = null;\n    return true;\n  }\n  const handlers = {\n    decodePlane,\n    buildTables,\n    packBand,\n    cancel\n  };\n  function transferables(value) {\n    const out = [];\n    const seen = /* @__PURE__ */ new Set();\n    const walk = (v) => {\n      if (!v || typeof v !== "object" || seen.has(v)) return;\n      seen.add(v);\n      if (v instanceof ArrayBuffer) out.push(v);\n      else if (ArrayBuffer.isView(v)) out.push(v.buffer);\n      else if (Array.isArray(v)) for (const x of v) walk(x);\n      else for (const x of Object.values(v)) walk(x);\n    };\n    walk(value);\n    return out;\n  }\n  self.onmessage = async (event) => {\n    const { id, name, args } = event.data;\n    try {\n      const handler = handlers[name];\n      if (!handler) throw new Error(`full worker: unknown RPC ${name}`);\n      const result = await handler(args);\n      self.postMessage({ id, result }, { transfer: transferables(result) });\n    } catch (error) {\n      self.postMessage({ id, error: String((error == null ? void 0 : error.message) ?? error) });\n    }\n  };\n})();\n//# sourceMappingURL=fullWorker-CjptXZB3.js.map\n';
const blob = typeof self !== "undefined" && self.Blob && new Blob([jsContent], { type: "text/javascript;charset=utf-8" });
function WorkerWrapper(options) {
  let objURL;
  try {
    objURL = blob && (self.URL || self.webkitURL).createObjectURL(blob);
    if (!objURL) throw "";
    const worker = new Worker(objURL, {
      name: options == null ? void 0 : options.name
    });
    worker.addEventListener("error", () => {
      (self.URL || self.webkitURL).revokeObjectURL(objURL);
    });
    return worker;
  } catch (e) {
    return new Worker(
      "data:text/javascript;charset=utf-8," + encodeURIComponent(jsContent),
      {
        name: options == null ? void 0 : options.name
      }
    );
  } finally {
    objURL && (self.URL || self.webkitURL).revokeObjectURL(objURL);
  }
}
class SogMetaError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SogMetaError";
    this.code = code;
  }
}
function isNumArray(a, n) {
  return Array.isArray(a) && (n === void 0 || a.length === n) && a.every((v) => typeof v === "number" && Number.isFinite(v));
}
function codebook(raw, what) {
  if (!Array.isArray(raw) || raw.length !== 256) {
    throw new SogMetaError(
      "codebook",
      `${what}.codebook must have 256 entries (got ${Array.isArray(raw) ? raw.length : typeof raw})`
    );
  }
  for (let i = 0; i < 256; ++i) {
    const v = raw[i];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new SogMetaError(
        "codebook-null",
        `${what}.codebook[${i}] is ${v === null ? "null" : typeof v}; the reference decoders do not patch codebooks`
      );
    }
  }
  return Float64Array.from(raw);
}
function parseSogMeta(json) {
  var _a, _b;
  const j = json;
  if (!j || typeof j !== "object" || j.version !== 2) {
    throw new SogMetaError(
      "not-v2",
      `expected a SOG v2 manifest (version 2), got ${j && typeof j === "object" ? String(j.version) : typeof j}`
    );
  }
  if (!Number.isInteger(j.count) || j.count <= 0) {
    throw new SogMetaError("count", `count must be a positive integer (got ${j.count})`);
  }
  if (!j.means || !isNumArray(j.means.mins, 3) || !isNumArray(j.means.maxs, 3) || !Array.isArray(j.means.files) || j.means.files.length !== 2) {
    throw new SogMetaError("means", "means needs mins[3], maxs[3] and files[2]");
  }
  const one = (sec, what) => {
    if (!sec || !Array.isArray(sec.files) || sec.files.length !== 1 || typeof sec.files[0] !== "string") {
      throw new SogMetaError("files", `${what}.files must name exactly one plane`);
    }
    return sec.files[0];
  };
  const files = {
    means_l: j.means.files[0],
    means_u: j.means.files[1],
    quats: one(j.quats, "quats"),
    scales: one(j.scales, "scales"),
    sh0: one(j.sh0, "sh0"),
    shN_centroids: null,
    shN_labels: null
  };
  const scalesCodebook = codebook((_a = j.scales) == null ? void 0 : _a.codebook, "scales");
  const sh0Codebook = codebook((_b = j.sh0) == null ? void 0 : _b.codebook, "sh0");
  let bands = 0;
  let centroidCount = 0;
  let shNCodebook = null;
  if (j.shN) {
    const b = j.shN.bands;
    if (b !== 1 && b !== 2 && b !== 3) {
      throw new SogMetaError("bands", `shN.bands must be 1, 2 or 3 (got ${b})`);
    }
    if (!Number.isInteger(j.shN.count) || j.shN.count <= 0 || j.shN.count > 65536) {
      throw new SogMetaError("bands", `shN.count must be 1..65536 (got ${j.shN.count})`);
    }
    if (!Array.isArray(j.shN.files) || j.shN.files.length !== 2 || j.shN.palette) {
      throw new SogMetaError(
        "files",
        "shN.files must be [centroids, labels] (a scene.sog carries its own palette)"
      );
    }
    bands = b;
    centroidCount = j.shN.count;
    shNCodebook = codebook(j.shN.codebook, "shN");
    files.shN_centroids = j.shN.files[0];
    files.shN_labels = j.shN.files[1];
  }
  let origin = null;
  const raw = j.kcOrigin;
  if (raw !== void 0) {
    if (!isNumArray(raw, 3)) {
      throw new SogMetaError(
        "origin",
        `kcOrigin must be [x, y, z] of finite numbers (got ${String(
          JSON.stringify(raw)
        ).slice(0, 80)})`
      );
    }
    if (raw[0] !== 0 || raw[1] !== 0 || raw[2] !== 0) {
      origin = [raw[0] || 0, raw[1] || 0, raw[2] || 0];
    }
  }
  return {
    count: j.count,
    bands,
    centroidCount,
    means: {
      mins: [j.means.mins[0], j.means.mins[1], j.means.mins[2]],
      maxs: [j.means.maxs[0], j.means.maxs[1], j.means.maxs[2]]
    },
    scalesCodebook,
    sh0Codebook,
    shNCodebook,
    files,
    origin,
    json: j
  };
}
function planeSize(count) {
  const up4 = (v) => Math.ceil(v / 4) * 4;
  const width = up4(Math.ceil(Math.sqrt(count)));
  const height = up4(Math.ceil(count / width));
  return { width, height };
}
function boundsFromMeta(meta) {
  const un = (v) => Math.sign(v) * (Math.exp(Math.abs(v)) - 1);
  const min = [0, 0, 0];
  const max = [0, 0, 0];
  const origin = meta.origin ?? null;
  for (let c = 0; c < 3; ++c) {
    const a = un(meta.means.mins[c]);
    const b = un(meta.means.maxs[c]);
    min[c] = Math.min(a, b);
    max[c] = Math.max(a, b);
    if (origin) {
      min[c] += origin[c];
      max[c] += origin[c];
    }
  }
  return { min, max };
}
function centroidStride(width, bands) {
  const stride = Math.max(1, Math.floor(width / 64));
  const expected = bands >= 3 ? 15 : bands === 2 ? 8 : 3;
  if (stride !== expected) {
    throw new SogMetaError(
      "bands",
      `shN_centroids width ${width} implies stride ${stride}, but bands ${bands} needs ${expected}`
    );
  }
  return stride;
}
class SogMeanCodeHistogram {
  constructor() {
    this.bins = [
      new Uint32Array(65536),
      new Uint32Array(65536),
      new Uint32Array(65536)
    ];
    this.count = 0;
  }
  /**
   * Add `count` splats whose means_l / means_u RGBA pixels start at element 0
   * of each array (the loader's band layout; padding pixels past the scene's
   * splat count must not be included).
   */
  add(meansL, meansU, count) {
    if (!Number.isInteger(count) || count < 0 || count * 4 > meansL.length || count * 4 > meansU.length) {
      throw new RangeError(
        `SogMeanCodeHistogram.add: ${count} splats do not fit planes of ${meansL.length} / ${meansU.length} bytes`
      );
    }
    const [bx, by, bz] = this.bins;
    for (let i = 0; i < count; ++i) {
      const i4 = i * 4;
      bx[meansL[i4] | meansU[i4] << 8]++;
      by[meansL[i4 + 1] | meansU[i4 + 1] << 8]++;
      bz[meansL[i4 + 2] | meansU[i4 + 2] << 8]++;
    }
    this.count += count;
  }
  /**
   * Per-axis LOWER median code: the ceil(count / 2)-th smallest code (exact
   * for an odd count, the lower middle one for an even count). null before
   * any splat was added.
   */
  medianCodes() {
    if (this.count === 0) {
      return null;
    }
    const rank = Math.ceil(this.count / 2);
    const out = [0, 0, 0];
    for (let c = 0; c < 3; ++c) {
      const b = this.bins[c];
      let acc = 0;
      for (let k = 0; k < 65536; ++k) {
        acc += b[k];
        if (acc >= rank) {
          out[c] = k;
          break;
        }
      }
    }
    return out;
  }
}
function decodeMeanCode(meta, c, n) {
  const mn = meta.means.mins[c];
  const mx = meta.means.maxs[c];
  const f = n / 65535;
  const v = mn + (mx - mn) * f;
  return Math.sign(v) * (Math.exp(Math.abs(v)) - 1);
}
function roundOrigin(v) {
  const r = Math.round(v);
  return Number.isFinite(r) && r !== 0 ? r : 0;
}
function sogPackOrigin(meta, hist) {
  const codes = hist.medianCodes();
  if (!codes) {
    return [0, 0, 0];
  }
  return [
    roundOrigin(decodeMeanCode(meta, 0, codes[0])),
    roundOrigin(decodeMeanCode(meta, 1, codes[1])),
    roundOrigin(decodeMeanCode(meta, 2, codes[2]))
  ];
}
function composeCenterOrigin(kcOrigin, oRel) {
  const k = kcOrigin ?? [0, 0, 0];
  const x = k[0] + oRel[0];
  const y = k[1] + oRel[1];
  const z = k[2] + oRel[2];
  return x === 0 && y === 0 && z === 0 ? null : [x || 0, y || 0, z || 0];
}
class SogZipError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SogZipError";
    this.code = code;
  }
}
const SIG_LOCAL = 67324752;
const SIG_CENTRAL = 33639248;
const SIG_EOCD = 101010256;
const SIG_EOCD64_LOC = 117853008;
const SIG_DESCRIPTOR = 134695760;
const FLAG_DESCRIPTOR = 8;
const utf8 = new TextDecoder("utf-8");
function u16(b, o) {
  return b[o] | b[o + 1] << 8;
}
function u32(b, o) {
  return (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) >>> 0;
}
function indexSogZip(bytes) {
  const n = bytes.length;
  const minEocd = Math.max(0, n - 22 - 65535);
  let eocd = -1;
  for (let i = n - 22; i >= minEocd; --i) {
    if (u32(bytes, i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new SogZipError("no-eocd", "end of central directory record not found");
  }
  if (eocd >= 20 && u32(bytes, eocd - 20) === SIG_EOCD64_LOC) {
    throw new SogZipError("zip64", "Zip64 archives are not supported");
  }
  const entryCount = u16(bytes, eocd + 10);
  const cdSize = u32(bytes, eocd + 12);
  const cdOffset = u32(bytes, eocd + 16);
  if (entryCount === 65535 || cdSize === 4294967295 || cdOffset === 4294967295) {
    throw new SogZipError("zip64", "Zip64 field markers in the EOCD");
  }
  if (cdOffset + cdSize > eocd) {
    throw new SogZipError("truncated", "central directory extends past the EOCD");
  }
  const entries = [];
  let p = cdOffset;
  for (let k = 0; k < entryCount; ++k) {
    if (p + 46 > n || u32(bytes, p) !== SIG_CENTRAL) {
      throw new SogZipError("bad-header", `central directory entry ${k} is malformed`);
    }
    const method = u16(bytes, p + 10);
    const crc32 = u32(bytes, p + 16);
    const csize = u32(bytes, p + 20);
    const usize = u32(bytes, p + 24);
    const fnLen = u16(bytes, p + 28);
    const exLen = u16(bytes, p + 30);
    const cmLen = u16(bytes, p + 32);
    const headerOffset = u32(bytes, p + 42);
    const name = utf8.decode(bytes.subarray(p + 46, p + 46 + fnLen));
    if (method !== 0) {
      throw new SogZipError("deflated", `entry ${name} uses compression method ${method}`);
    }
    if (csize !== usize) {
      throw new SogZipError("bad-header", `entry ${name}: stored sizes differ (${csize} vs ${usize})`);
    }
    if (headerOffset + 30 > n || u32(bytes, headerOffset) !== SIG_LOCAL) {
      throw new SogZipError("bad-header", `entry ${name}: local header not at ${headerOffset}`);
    }
    const lfnLen = u16(bytes, headerOffset + 26);
    const lexLen = u16(bytes, headerOffset + 28);
    const dataOffset = headerOffset + 30 + lfnLen + lexLen;
    if (dataOffset + csize > n) {
      throw new SogZipError("truncated", `entry ${name}: data extends past the end of the file`);
    }
    entries.push({ name, dataOffset, size: csize, crc32, headerOffset });
    p += 46 + fnLen + exLen + cmLen;
  }
  const byName = new Map(entries.map((e) => [e.name, e]));
  return { entries, byName, centralDirectoryOffset: cdOffset };
}
function sliceSogEntries(bytes, index) {
  const out = /* @__PURE__ */ new Map();
  for (const e of index.entries) {
    out.set(e.name, bytes.subarray(e.dataOffset, e.dataOffset + e.size));
  }
  return out;
}
class SogStreamWalker {
  constructor(onEntry) {
    this.queue = [];
    this.queued = 0;
    this.offset = 0;
    this.state = "header";
    this.finished = false;
    this.name = "";
    this.headerOffset = 0;
    this.dataOffset = 0;
    this.hasDescriptor = false;
    this.headerCrc = 0;
    this.target = null;
    this.written = 0;
    this.scanParts = [];
    this.scanLength = 0;
    this.walked = [];
    this.tail = [];
    this.tailOffset = 0;
    this.onEntry = onEntry;
  }
  get bytesConsumed() {
    return this.offset;
  }
  push(chunk) {
    if (this.finished) throw new SogZipError("bad-header", "push after finish");
    if (chunk.length === 0) return;
    if (this.state === "tail") {
      this.tail.push(chunk.slice());
      this.offset += chunk.length;
      return;
    }
    this.queue.push(chunk);
    this.queued += chunk.length;
    this.process();
  }
  /** Parse the tail (central directory + EOCD) and cross-check the walk. */
  finish() {
    if (this.finished) throw new SogZipError("bad-header", "finish called twice");
    this.finished = true;
    if (this.state !== "tail") {
      throw new SogZipError(
        "truncated",
        `stream ended in state ${this.state} at offset ${this.offset}` + (this.name ? ` inside entry ${this.name}` : "")
      );
    }
    let total = 0;
    for (const t of this.tail) total += t.length;
    const tail = new Uint8Array(total);
    let o = 0;
    for (const t of this.tail) {
      tail.set(t, o);
      o += t.length;
    }
    const index = parseCentralDirectory(tail, this.tailOffset);
    if (index.entries.length !== this.walked.length) {
      throw new SogZipError(
        "cd-mismatch",
        `central directory lists ${index.entries.length} entries, walked ${this.walked.length}`
      );
    }
    for (let i = 0; i < index.entries.length; ++i) {
      const c = index.entries[i];
      const w = this.walked[i];
      if (c.name !== w.name || c.headerOffset !== w.headerOffset || c.size !== w.size || c.crc32 !== 0 && w.crc32 !== 0 && c.crc32 !== w.crc32) {
        throw new SogZipError(
          "cd-mismatch",
          `entry ${i} (${c.name}): central directory says offset ${c.headerOffset} size ${c.size}, walked ${w.name} at ${w.headerOffset} size ${w.size}`
        );
      }
      c.dataOffset = w.dataOffset;
    }
    return index;
  }
  // ---- internals -----------------------------------------------------
  /** Materialise the next n queued bytes without consuming them. */
  peek(n) {
    if (this.queued < n) return null;
    if (n === 0) return new Uint8Array(0);
    const first = this.queue[0];
    if (first.length >= n) return first.subarray(0, n);
    const out = new Uint8Array(n);
    let o = 0;
    for (const q of this.queue) {
      const take = Math.min(n - o, q.length);
      out.set(q.subarray(0, take), o);
      o += take;
      if (o === n) break;
    }
    return out;
  }
  drop(n) {
    let left = n;
    while (left > 0) {
      const q = this.queue[0];
      if (q.length <= left) {
        this.queue.shift();
        left -= q.length;
      } else {
        this.queue[0] = q.subarray(left);
        left = 0;
      }
    }
    this.queued -= n;
    this.offset += n;
  }
  /** Copy up to n queued bytes into target at `written`, consuming them. */
  copyInto(target, at, n) {
    let left = n;
    let o = at;
    while (left > 0 && this.queue.length) {
      const q = this.queue[0];
      const take = Math.min(left, q.length);
      target.set(q.subarray(0, take), o);
      o += take;
      left -= take;
      if (take === q.length) this.queue.shift();
      else this.queue[0] = q.subarray(take);
    }
    const done = n - left;
    this.queued -= done;
    this.offset += done;
    return done;
  }
  process() {
    for (; ; ) {
      switch (this.state) {
        case "header": {
          const h = this.peek(30);
          if (!h) return;
          const sig = u32(h, 0);
          if (sig === SIG_CENTRAL || sig === SIG_EOCD) {
            this.state = "tail";
            this.tailOffset = this.offset;
            const rest = new Uint8Array(this.queued);
            this.copyInto(rest, 0, this.queued);
            this.tail.push(rest);
            return;
          }
          if (sig !== SIG_LOCAL) {
            throw new SogZipError(
              "bad-header",
              `expected a local file header at offset ${this.offset}, found 0x${sig.toString(16)}`
            );
          }
          const flag = u16(h, 6);
          const method = u16(h, 8);
          const crc = u32(h, 14);
          const csize = u32(h, 18);
          const fnLen = u16(h, 26);
          const exLen = u16(h, 28);
          const full = this.peek(30 + fnLen + exLen);
          if (!full) return;
          const name = utf8.decode(full.subarray(30, 30 + fnLen));
          if (method !== 0) {
            throw new SogZipError("deflated", `entry ${name} uses compression method ${method}`);
          }
          this.name = name;
          this.headerOffset = this.offset;
          this.hasDescriptor = (flag & FLAG_DESCRIPTOR) !== 0;
          this.headerCrc = crc;
          this.drop(30 + fnLen + exLen);
          this.dataOffset = this.offset;
          this.written = 0;
          this.target = null;
          this.scanParts = [];
          this.scanLength = 0;
          if (!this.hasDescriptor) {
            this.target = new Uint8Array(csize);
            this.state = "data-known";
          } else if (/\.webp$/i.test(name)) {
            this.state = "data-riff";
          } else {
            this.state = "data-scan";
          }
          break;
        }
        case "data-riff": {
          const r = this.peek(12);
          if (!r) return;
          const isRiff = r[0] === 82 && r[1] === 73 && r[2] === 70 && r[3] === 70 && // RIFF
          r[8] === 87 && r[9] === 69 && r[10] === 66 && r[11] === 80;
          if (!isRiff) {
            throw new SogZipError("bad-riff", `entry ${this.name} does not start with a RIFF/WEBP header`);
          }
          const length = u32(r, 4) + 8;
          this.target = new Uint8Array(length);
          this.state = "data-known";
          break;
        }
        case "data-known": {
          const target = this.target;
          if (this.written < target.length) {
            this.written += this.copyInto(target, this.written, target.length - this.written);
            if (this.written < target.length) return;
          }
          this.state = this.hasDescriptor ? "descriptor" : "header";
          if (!this.hasDescriptor) this.emit(target, this.headerCrc);
          break;
        }
        case "data-scan": {
          if (this.queued === 0) return;
          const avail = this.peek(this.queued);
          let hit = -1;
          for (let i = 0; i + 4 <= avail.length; ++i) {
            if (avail[i] === 80 && avail[i + 1] === 75 && avail[i + 2] === 7 && avail[i + 3] === 8) {
              hit = i;
              break;
            }
          }
          if (hit < 0) {
            const keep = Math.min(3, avail.length);
            const take = avail.length - keep;
            if (take > 0) {
              const part = new Uint8Array(take);
              this.copyInto(part, 0, take);
              this.scanParts.push(part);
              this.scanLength += take;
            }
            return;
          }
          if (hit > 0) {
            const part = new Uint8Array(hit);
            this.copyInto(part, 0, hit);
            this.scanParts.push(part);
            this.scanLength += hit;
          }
          const target = new Uint8Array(this.scanLength);
          let o = 0;
          for (const p of this.scanParts) {
            target.set(p, o);
            o += p.length;
          }
          this.target = target;
          this.written = target.length;
          this.state = "descriptor";
          break;
        }
        case "descriptor": {
          const d = this.peek(16);
          if (!d) return;
          const target = this.target;
          let crc;
          let csize;
          let len;
          if (u32(d, 0) === SIG_DESCRIPTOR) {
            crc = u32(d, 4);
            csize = u32(d, 8);
            len = 16;
          } else {
            crc = u32(d, 0);
            csize = u32(d, 4);
            len = 12;
          }
          if (csize !== target.length) {
            throw new SogZipError(
              "bad-descriptor",
              `entry ${this.name}: descriptor size ${csize} does not match the ${target.length} bytes walked`
            );
          }
          this.drop(len);
          this.state = "header";
          this.emit(target, crc);
          break;
        }
        case "tail":
          return;
      }
    }
  }
  emit(bytes, crc32) {
    const entry = {
      name: this.name,
      bytes,
      size: bytes.length,
      headerOffset: this.headerOffset,
      dataOffset: this.dataOffset,
      crc32
    };
    this.walked.push(entry);
    this.name = "";
    this.target = null;
    this.onEntry(entry);
  }
}
function parseCentralDirectory(tail, tailOffset) {
  const n = tail.length;
  let eocd = -1;
  for (let i = n - 22; i >= 0; --i) {
    if (u32(tail, i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new SogZipError("no-eocd", "end of central directory record not found in the tail");
  if (eocd >= 20 && u32(tail, eocd - 20) === SIG_EOCD64_LOC) {
    throw new SogZipError("zip64", "Zip64 archives are not supported");
  }
  const entryCount = u16(tail, eocd + 10);
  const cdSize = u32(tail, eocd + 12);
  const cdOffset = u32(tail, eocd + 16);
  if (entryCount === 65535 || cdSize === 4294967295 || cdOffset === 4294967295) {
    throw new SogZipError("zip64", "Zip64 field markers in the EOCD");
  }
  if (cdOffset !== tailOffset) {
    throw new SogZipError(
      "cd-mismatch",
      `central directory offset ${cdOffset} but the walk reached it at ${tailOffset}`
    );
  }
  const entries = [];
  let p = 0;
  for (let k = 0; k < entryCount; ++k) {
    if (p + 46 > n || u32(tail, p) !== SIG_CENTRAL) {
      throw new SogZipError("bad-header", `central directory entry ${k} is malformed`);
    }
    const method = u16(tail, p + 10);
    const crc32 = u32(tail, p + 16);
    const csize = u32(tail, p + 20);
    const fnLen = u16(tail, p + 28);
    const exLen = u16(tail, p + 30);
    const cmLen = u16(tail, p + 32);
    const headerOffset = u32(tail, p + 42);
    const name = utf8.decode(tail.subarray(p + 46, p + 46 + fnLen));
    if (method !== 0) throw new SogZipError("deflated", `entry ${name} uses compression method ${method}`);
    entries.push({ name, dataOffset: -1, size: csize, crc32, headerOffset });
    p += 46 + fnLen + exLen + cmLen;
  }
  return {
    entries,
    byName: new Map(entries.map((e) => [e.name, e])),
    centralDirectoryOffset: cdOffset
  };
}
const FULL_DETAIL_VERSION = "full-1";
class FullDetailError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = "FullDetailError";
    this.code = code;
    this.cause = cause;
  }
}
class FullWorkerHandle {
  constructor() {
    this.busy = false;
    this.nextId = 1;
    this.pending = /* @__PURE__ */ new Map();
    this.worker = new WorkerWrapper();
    this.worker.onmessage = (ev) => {
      const { id, result, error } = ev.data;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (error !== void 0) p.reject(new Error(String(error)));
      else p.resolve(result);
    };
    this.worker.onerror = (ev) => {
      const err = new Error(`full worker crashed: ${ev.message}`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
  }
  call(name, args, transfer = []) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, name, args }, transfer);
    });
  }
  terminate() {
    const err = new Error("full worker terminated");
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.worker.terminate();
  }
}
class FullWorkerPool {
  constructor(n) {
    this.waiters = [];
    this.workers = Array.from({ length: n }, () => new FullWorkerHandle());
  }
  acquire() {
    const free = this.workers.find((w) => !w.busy);
    if (free) {
      free.busy = true;
      return Promise.resolve(free);
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  release(w) {
    const next = this.waiters.shift();
    if (next) next(w);
    else w.busy = false;
  }
  /** Run one RPC on the next free worker. */
  async run(name, args, transfer = []) {
    const w = await this.acquire();
    try {
      return await w.call(name, args, transfer);
    } finally {
      this.release(w);
    }
  }
  /** Run one RPC on EVERY worker (tables are per-worker state). */
  broadcast(name, args) {
    return Promise.all(this.workers.map((w) => w.call(name, args)));
  }
  terminate() {
    for (const w of this.workers) w.terminate();
    this.waiters = [];
  }
}
const PER_SPLAT_PLANES = ["means_l", "means_u", "quats", "scales", "sh0", "shN_labels"];
function defaultWorkers() {
  const hc = typeof navigator !== "undefined" && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4;
  return Math.max(2, Math.min(6, hc - 2));
}
function baseName(entryName) {
  const i = Math.max(entryName.lastIndexOf("/"), entryName.lastIndexOf("\\"));
  return i >= 0 ? entryName.slice(i + 1) : entryName;
}
async function loadFullDetailSog(options) {
  var _a;
  const t0 = performance.now();
  const maxShRequested = Math.max(0, Math.min(3, options.maxSh ?? 3));
  const nBands = Math.max(1, Math.min(64, options.bands ?? 16));
  const nWorkers = Math.max(1, Math.min(16, options.workers ?? defaultWorkers()));
  const streamed = options.stream !== false;
  const encoding = options.splatEncoding ?? { ...DEFAULT_SPLAT_ENCODING };
  const signal = options.signal;
  const progress = (phase, loaded, total) => {
    var _a2;
    return (_a2 = options.onProgress) == null ? void 0 : _a2.call(options, { phase, loaded, total });
  };
  const pool = new FullWorkerPool(nWorkers);
  const decodes = /* @__PURE__ */ new Map();
  const entryBytes = /* @__PURE__ */ new Map();
  let meta = null;
  let metaError = null;
  let bytesTotal = options.expectedBytes ?? 0;
  let bytesLoaded = 0;
  const throwIfAborted = () => {
    if (signal == null ? void 0 : signal.aborted) throw new FullDetailError("cancel", "full-detail load cancelled");
  };
  const onAbort = () => pool.terminate();
  signal == null ? void 0 : signal.addEventListener("abort", onAbort, { once: true });
  const onEntry = (name, bytes) => {
    const base = baseName(name);
    entryBytes.set(base, bytes.length);
    if (base === "meta.json") {
      try {
        meta = parseSogMeta(JSON.parse(new TextDecoder("utf-8").decode(bytes)));
      } catch (e) {
        metaError = e;
      }
      return;
    }
    if (!/\.webp$/i.test(base)) return;
    const isCentroids = /centroids/i.test(base);
    const p = pool.run(
      "decodePlane",
      { name: base, bytes, bands: isCentroids ? 1 : nBands },
      [bytes.buffer]
    );
    decodes.set(base, p);
    p.then(
      () => progress("decode", decodes.size, 7),
      () => {
      }
    );
  };
  try {
    const fetchOnce = async (url) => {
      const headers = { ...options.requestHeader ?? {} };
      const resp2 = await fetch(url, {
        headers,
        credentials: options.withCredentials ? "include" : "same-origin",
        signal
      });
      if (!resp2.ok) throw new FullDetailError("fetch", `HTTP ${resp2.status} for ${url}`);
      return resp2;
    };
    let resp;
    try {
      resp = await fetchOnce(options.url);
    } catch (e) {
      if (signal == null ? void 0 : signal.aborted) throw new FullDetailError("cancel", "cancelled", e);
      if (!options.fallbackUrl) throw e instanceof FullDetailError ? e : new FullDetailError("fetch", String(e), e);
      resp = await fetchOnce(options.fallbackUrl);
    }
    const contentLength = Number(resp.headers.get("content-length") ?? 0);
    if (!bytesTotal && contentLength > 0) bytesTotal = contentLength;
    if (!resp.body) throw new FullDetailError("fetch", "response has no body");
    const tDownload0 = performance.now();
    if (streamed) {
      const walker = new SogStreamWalker((e) => onEntry(e.name, e.bytes));
      const reader = resp.body.getReader();
      for (; ; ) {
        const { done, value } = await reader.read();
        if (done) break;
        throwIfAborted();
        bytesLoaded += value.length;
        walker.push(value);
        progress("download", bytesLoaded, bytesTotal);
      }
      walker.finish();
    } else {
      const chunks = [];
      const reader = resp.body.getReader();
      for (; ; ) {
        const { done, value } = await reader.read();
        if (done) break;
        throwIfAborted();
        bytesLoaded += value.length;
        chunks.push(value);
        progress("download", bytesLoaded, bytesTotal);
      }
      const all = new Uint8Array(bytesLoaded);
      let o = 0;
      for (const c of chunks) {
        all.set(c, o);
        o += c.length;
      }
      const index = indexSogZip(all);
      for (const [name, view] of sliceSogEntries(all, index)) {
        onEntry(name, view.slice());
      }
    }
    const msDownload = performance.now() - tDownload0;
    if (bytesTotal > 0 && bytesLoaded !== bytesTotal) {
      throw new FullDetailError("bytes", `downloaded ${bytesLoaded} bytes, expected ${bytesTotal}`);
    }
    if (metaError) throw metaError;
    if (!meta) throw new FullDetailError("meta", "the archive has no meta.json");
    const m = meta;
    const tDecode0 = performance.now();
    const need = ["means_l", "means_u", "quats", "scales", "sh0"];
    const wantSh = maxShRequested > 0 && m.bands > 0;
    if (wantSh) need.push("shN_centroids", "shN_labels");
    const planes = /* @__PURE__ */ new Map();
    for (const role of need) {
      const file = m.files[role];
      if (!file) throw new FullDetailError("meta", `manifest names no ${role} plane`);
      const p = decodes.get(baseName(file));
      if (!p) throw new FullDetailError("zip", `plane ${file} (${role}) is not in the archive`);
      try {
        planes.set(role, await p);
      } catch (e) {
        throw new FullDetailError("decode", `decoding ${file} failed: ${String((e == null ? void 0 : e.message) ?? e)}`, e);
      }
      throwIfAborted();
    }
    const msDecodeTail = performance.now() - tDecode0;
    const ref = planes.get("means_l");
    for (const role of PER_SPLAT_PLANES) {
      const pl = planes.get(role);
      if (!pl) continue;
      if (pl.width !== ref.width || pl.height !== ref.height || pl.bands.length !== ref.bands.length) {
        throw new FullDetailError(
          "decode",
          `plane ${role} is ${pl.width}x${pl.height}/${pl.bands.length} bands, means_l is ${ref.width}x${ref.height}/${ref.bands.length}`
        );
      }
    }
    if (ref.width * ref.height < m.count) {
      throw new FullDetailError("decode", `planes hold ${ref.width * ref.height} pixels for ${m.count} splats`);
    }
    const rule = planeSize(m.count);
    const geometryMatchesRule = rule.width === ref.width && rule.height === ref.height;
    const tOrigin0 = performance.now();
    let oRel = [0, 0, 0];
    if (options.packOrigin !== false) {
      const meansU = planes.get("means_u");
      const hist = new SogMeanCodeHistogram();
      throwIfAborted();
      for (let k = 0; k < ref.bands.length; ++k) {
        const offset = ref.rowStart[k] * ref.width;
        const count = Math.min(ref.rows[k] * ref.width, m.count - offset);
        if (count <= 0) break;
        hist.add(ref.bands[k], meansU.bands[k], count);
      }
      oRel = sogPackOrigin(m, hist);
    }
    const centerOrigin = composeCenterOrigin(m.origin, oRel);
    const msOrigin = performance.now() - tOrigin0;
    const tTables0 = performance.now();
    const centroids = wantSh ? planes.get("shN_centroids") : null;
    const tableInfo = await pool.broadcast("buildTables", {
      meta: { ...m, json: void 0 },
      centroids: centroids ? { rgba: centroids.bands[0], width: centroids.width, height: centroids.height } : null,
      maxSh: maxShRequested,
      encoding,
      origin: oRel
    });
    const maxSh = ((_a = tableInfo[0]) == null ? void 0 : _a.maxSh) ?? 0;
    const msTables = performance.now() - tTables0;
    throwIfAborted();
    const maxSplats = computeMaxSplats(m.count);
    let packed;
    let sh1;
    let sh2;
    let sh3;
    try {
      packed = new Uint32Array(maxSplats * 4);
      if (maxSh >= 1) sh1 = new Uint32Array(maxSplats * 2);
      if (maxSh >= 2) sh2 = new Uint32Array(maxSplats * 4);
      if (maxSh >= 3) sh3 = new Uint32Array(maxSplats * 4);
    } catch (e) {
      throw new FullDetailError("alloc", `cannot allocate ${maxSplats} splats of output: ${String(e)}`, e);
    }
    const tPack0 = performance.now();
    const W = ref.width;
    let badLabels = 0;
    let bandsDone = 0;
    const labelsPlane = wantSh ? planes.get("shN_labels") : null;
    const jobs = [];
    for (let k = 0; k < ref.bands.length; ++k) {
      const offset = ref.rowStart[k] * W;
      const count = Math.min(ref.rows[k] * W, m.count - offset);
      if (count <= 0) break;
      const take = (role) => planes.get(role).bands[k];
      const bandPlanes = {
        meansL: take("means_l"),
        meansU: take("means_u"),
        quats: take("quats"),
        scales: take("scales"),
        sh0: take("sh0"),
        labels: labelsPlane ? labelsPlane.bands[k] : null
      };
      const transfer = [bandPlanes.meansL, bandPlanes.meansU, bandPlanes.quats, bandPlanes.scales, bandPlanes.sh0, bandPlanes.labels].filter((b) => !!b).map((b) => b.buffer);
      const job = pool.run(
        "packBand",
        { planes: bandPlanes, count },
        transfer
      ).then((res) => {
        packed.set(res.packed, offset * 4);
        if (sh1 && res.sh1) sh1.set(res.sh1, offset * 2);
        if (sh2 && res.sh2) sh2.set(res.sh2, offset * 4);
        if (sh3 && res.sh3) sh3.set(res.sh3, offset * 4);
        badLabels += res.badLabels;
        progress("pack", ++bandsDone, ref.bands.length);
      });
      jobs.push(job);
    }
    try {
      await Promise.all(jobs);
    } catch (e) {
      throw new FullDetailError("pack", `packing failed: ${String((e == null ? void 0 : e.message) ?? e)}`, e);
    }
    throwIfAborted();
    const msPack = performance.now() - tPack0;
    const extra = {};
    if (sh1) extra.sh1 = sh1;
    if (sh2) extra.sh2 = sh2;
    if (sh3) extra.sh3 = sh3;
    const packedSplats = new PackedSplats({
      packedArray: packed,
      numSplats: m.count,
      extra,
      splatEncoding: encoding,
      // [prec-1] / [prec-2] kcOrigin + o_rel; the mesh transform re-adds it
      centerOrigin
    });
    const perPlane = {};
    for (const [role, pl] of planes) {
      perPlane[role] = { bytes: entryBytes.get(pl.name) ?? 0, decodeMs: Math.round(pl.decodeMs), readMs: Math.round(pl.readMs) };
    }
    const stats = {
      bytes: bytesLoaded,
      numSplats: m.count,
      maxSplats,
      bands: ref.bands.length,
      maxSh,
      workers: nWorkers,
      streamed,
      badLabels,
      planeWidth: ref.width,
      planeHeight: ref.height,
      geometryMatchesRule,
      ms: {
        download: Math.round(msDownload),
        decodeTail: Math.round(msDecodeTail),
        origin: Math.round(msOrigin),
        tables: Math.round(msTables),
        pack: Math.round(msPack),
        total: Math.round(performance.now() - t0)
      },
      perPlane
    };
    progress("done", 1, 1);
    const packOrigin = oRel[0] !== 0 || oRel[1] !== 0 || oRel[2] !== 0 ? oRel : null;
    return {
      packedSplats,
      meta: m,
      numSplats: m.count,
      bounds: boundsFromMeta(m),
      packOrigin,
      stats
    };
  } catch (e) {
    if (e instanceof FullDetailError) throw e;
    if ((signal == null ? void 0 : signal.aborted) || (e == null ? void 0 : e.name) === "AbortError") throw new FullDetailError("cancel", "cancelled", e);
    if (e instanceof SogZipError) throw new FullDetailError("zip", e.message, e);
    if (e instanceof SogMetaError) throw new FullDetailError("meta", e.message, e);
    if (e instanceof RangeError) throw new FullDetailError("alloc", e.message, e);
    throw new FullDetailError("worker", String((e == null ? void 0 : e.message) ?? e), e);
  } finally {
    signal == null ? void 0 : signal.removeEventListener("abort", onAbort);
    pool.terminate();
  }
}
function createFullDetailMesh(result, options) {
  const mesh = new SplatMesh({ packedSplats: result.packedSplats });
  if ((options == null ? void 0 : options.maxSh) !== void 0) mesh.maxSh = options.maxSh;
  return mesh;
}
const SH_C0 = 0.28209479177387814;
const SQRT2 = Math.sqrt(2);
function buildPackTables(meta, centroids, maxShRequested, encoding = DEFAULT_SPLAT_ENCODING, origin = [0, 0, 0]) {
  const maxSh = Math.max(0, Math.min(3, meta.bands, Math.floor(maxShRequested)));
  const scratch = new Uint32Array(4);
  const centerHalf = [
    new Uint16Array(65536),
    new Uint16Array(65536),
    new Uint16Array(65536)
  ];
  for (let c = 0; c < 3; ++c) {
    const mn = meta.means.mins[c];
    const mx = meta.means.maxs[c];
    const oc = origin[c] || 0;
    const t = centerHalf[c];
    for (let n = 0; n < 65536; ++n) {
      const f = n / 65535;
      let v = mn + (mx - mn) * f;
      v = Math.sign(v) * (Math.exp(Math.abs(v)) - 1);
      t[n] = toHalf(v - oc);
    }
  }
  const scaleByte = new Uint8Array(256);
  for (let b = 0; b < 256; ++b) {
    const s = Math.exp(meta.scalesCodebook[b]);
    scratch[3] = 0;
    setPackedSplatScales(scratch, 0, s, s, s, encoding);
    scaleByte[b] = scratch[3] & 255;
  }
  const rgbByte = new Uint8Array(256);
  const alphaByte = new Uint8Array(256);
  for (let b = 0; b < 256; ++b) {
    const r = SH_C0 * meta.sh0Codebook[b] + 0.5;
    scratch[0] = 0;
    setPackedSplatRgba(scratch, 0, r, r, r, 0, encoding);
    rgbByte[b] = scratch[0] & 255;
    scratch[0] = 0;
    setPackedSplatRgba(scratch, 0, 0, 0, 0, b / 255, encoding);
    alphaByte[b] = scratch[0] >>> 24 & 255;
  }
  const quatComp = new Float64Array(256);
  for (let b = 0; b < 256; ++b) quatComp[b] = (b / 255 - 0.5) * SQRT2;
  let paletteEntries = 0;
  let paletteSh1 = null;
  let paletteSh2 = null;
  let paletteSh3 = null;
  if (maxSh > 0) {
    if (!centroids || !meta.shNCodebook) {
      throw new Error("buildPackTables: SH requested but no centroid plane / codebook");
    }
    const stride = centroidStride(centroids.width, meta.bands);
    const width = centroids.width;
    paletteEntries = Math.min(65536, centroids.height * 64);
    const lookup = meta.shNCodebook;
    const px = centroids.rgba;
    const sh1 = new Float32Array(9);
    const sh2 = new Float32Array(15);
    const sh3 = new Float32Array(21);
    if (maxSh >= 1) paletteSh1 = new Uint32Array(paletteEntries * 2);
    if (maxSh >= 2) paletteSh2 = new Uint32Array(paletteEntries * 4);
    if (maxSh >= 3) paletteSh3 = new Uint32Array(paletteEntries * 4);
    for (let label = 0; label < paletteEntries; ++label) {
      const col = (label & 63) * stride;
      const row = label >>> 6;
      const offset = row * width + col;
      for (let d = 0; d < 3; ++d) {
        if (maxSh >= 1) {
          for (let k = 0; k < 3; ++k) sh1[k * 3 + d] = lookup[px[(offset + k) * 4 + d]];
        }
        if (maxSh >= 2) {
          for (let k = 0; k < 5; ++k) sh2[k * 3 + d] = lookup[px[(offset + 3 + k) * 4 + d]];
        }
        if (maxSh >= 3) {
          for (let k = 0; k < 7; ++k) sh3[k * 3 + d] = lookup[px[(offset + 8 + k) * 4 + d]];
        }
      }
      if (paletteSh1) encodeSh1Rgb(paletteSh1, label, sh1, encoding);
      if (paletteSh2) encodeSh2Rgb(paletteSh2, label, sh2, encoding);
      if (paletteSh3) encodeSh3Rgb(paletteSh3, label, sh3, encoding);
    }
  }
  return {
    centerHalf,
    scaleByte,
    rgbByte,
    alphaByte,
    quatComp,
    maxSh,
    paletteEntries,
    paletteSh1,
    paletteSh2,
    paletteSh3
  };
}
function packRange(planes, count, tables, out, outIndex) {
  const { meansL, meansU, quats, scales, sh0 } = planes;
  const [tx, ty, tz] = tables.centerHalf;
  const scaleByte = tables.scaleByte;
  const rgbByte = tables.rgbByte;
  const alphaByte = tables.alphaByte;
  const quatComp = tables.quatComp;
  const packed = out.packed;
  const q = { x: 0, y: 0, z: 0, w: 1 };
  for (let i = 0; i < count; ++i) {
    const i4 = i * 4;
    const o4 = (outIndex + i) * 4;
    packed[o4] = rgbByte[sh0[i4]] | rgbByte[sh0[i4 + 1]] << 8 | rgbByte[sh0[i4 + 2]] << 16 | alphaByte[sh0[i4 + 3]] << 24;
    const nx = meansL[i4] | meansU[i4] << 8;
    const ny = meansL[i4 + 1] | meansU[i4 + 1] << 8;
    const nz = meansL[i4 + 2] | meansU[i4 + 2] << 8;
    packed[o4 + 1] = tx[nx] | ty[ny] << 16;
    const r0 = quatComp[quats[i4]];
    const r1 = quatComp[quats[i4 + 1]];
    const r2 = quatComp[quats[i4 + 2]];
    const rr = Math.sqrt(Math.max(0, 1 - r0 * r0 - r1 * r1 - r2 * r2));
    const rOrder = quats[i4 + 3] - 252;
    q.x = rOrder === 0 ? r0 : rOrder === 1 ? rr : r1;
    q.y = rOrder <= 1 ? r1 : rOrder === 2 ? rr : r2;
    q.z = rOrder <= 2 ? r2 : rr;
    q.w = rOrder === 0 ? rr : r0;
    const uQuat = encodeQuatOctXy88R8(q);
    const uQuatX = uQuat & 255;
    const uQuatY = uQuat >>> 8 & 255;
    const uQuatZ = uQuat >>> 16 & 255;
    packed[o4 + 2] = tz[nz] | uQuatX << 16 | uQuatY << 24;
    packed[o4 + 3] = scaleByte[scales[i4]] | scaleByte[scales[i4 + 1]] << 8 | scaleByte[scales[i4 + 2]] << 16 | uQuatZ << 24;
  }
  let badLabels = 0;
  if (tables.maxSh > 0) {
    const labels = planes.labels;
    if (!labels) throw new Error("packRange: labels plane missing");
    const n = tables.paletteEntries;
    const p1 = tables.paletteSh1;
    const p2 = tables.paletteSh2;
    const p3 = tables.paletteSh3;
    const s1 = out.sh1;
    const s2 = out.sh2;
    const s3 = out.sh3;
    for (let i = 0; i < count; ++i) {
      const i4 = i * 4;
      const label = labels[i4] | labels[i4 + 1] << 8;
      const o = outIndex + i;
      if (label < n) {
        if (p1 && s1) {
          s1[o * 2] = p1[label * 2];
          s1[o * 2 + 1] = p1[label * 2 + 1];
        }
        if (p2 && s2) {
          s2[o * 4] = p2[label * 4];
          s2[o * 4 + 1] = p2[label * 4 + 1];
          s2[o * 4 + 2] = p2[label * 4 + 2];
          s2[o * 4 + 3] = p2[label * 4 + 3];
        }
        if (p3 && s3) {
          s3[o * 4] = p3[label * 4];
          s3[o * 4 + 1] = p3[label * 4 + 1];
          s3[o * 4 + 2] = p3[label * 4 + 2];
          s3[o * 4 + 3] = p3[label * 4 + 3];
        }
      } else {
        badLabels++;
        if (s1) {
          s1[o * 2] = 0;
          s1[o * 2 + 1] = 0;
        }
        if (s2) s2.fill(0, o * 4, o * 4 + 4);
        if (s3) s3.fill(0, o * 4, o * 4 + 4);
      }
    }
  }
  return { badLabels };
}
export {
  FULL_DETAIL_VERSION,
  FullDetailError,
  SogMeanCodeHistogram,
  SogMetaError,
  SogStreamWalker,
  SogZipError,
  boundsFromMeta,
  buildPackTables,
  centroidStride,
  composeCenterOrigin,
  createFullDetailMesh,
  decodeMeanCode,
  indexSogZip,
  loadFullDetailSog,
  packRange,
  parseSogMeta,
  planeSize,
  sliceSogEntries,
  sogPackOrigin
};
//# sourceMappingURL=spark-full.module.js.map

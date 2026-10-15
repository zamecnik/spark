import * as TSL from "three/tsl";
import { uint, float, vec2, max, select, normalize, vec3, vec4, ivec3, int, exp, textureLoad, uniform, varyingProperty, Fn, bool, instanceIndex, positionGeometry, If, fract, cameraProjectionMatrix, ivec2, round, clamp, min, pow, mat3, transpose, sqrt, log, dot, Discard, mix, instancedArray, Return, atomicStore, workgroupArray, workgroupId, invocationLocalIndex, workgroupBarrier, storage, atomicAdd, atomicLoad, atomicOr } from "three/tsl";
import { MeshBasicNodeMaterial, Vector2, Vector4, Vector3, DoubleSide, CustomBlending, AddEquation, OneFactor, OneMinusSrcAlphaFactor, Matrix4, Quaternion, IndirectStorageBufferAttribute } from "three/webgpu";
import * as THREE from "three";
import { d as kcDisposeOldMaterial, b as kcRegrowLog } from "./kcRegrowDebug-gV7aMG4z.js";
const unpackHalf2x16$2 = TSL.unpackHalf2x16;
const SPLAT_TEX_WIDTH_BITS = 11;
const SPLAT_TEX_LAYER_BITS = 22;
const SPLAT_TEX_MASK = 2047;
function splatTexCoordTsl(index) {
  const u = uint(index);
  const x = u.bitAnd(uint(SPLAT_TEX_MASK));
  const y = u.shiftRight(uint(SPLAT_TEX_WIDTH_BITS)).bitAnd(uint(SPLAT_TEX_MASK));
  const z = u.shiftRight(uint(SPLAT_TEX_LAYER_BITS));
  return ivec3(int(x), int(y), int(z));
}
function pagedSplatTexCoordTsl(index) {
  const i = uint(index);
  return ivec3(
    int(i.bitAnd(uint(255))),
    int(i.shiftRight(uint(8)).bitAnd(uint(255))),
    int(i.shiftRight(uint(16)))
  );
}
function decodeQuatOctXy88R8Tsl(encoded) {
  const quantU = encoded.bitAnd(uint(255));
  const quantV = encoded.shiftRight(uint(8)).bitAnd(uint(255));
  const angleInt = encoded.shiftRight(uint(16));
  const uF = float(quantU).div(255);
  const vF = float(quantV).div(255);
  const f = vec2(uF.mul(2).sub(1), vF.mul(2).sub(1));
  const az = float(1).sub(f.x.abs()).sub(f.y.abs());
  const t = max(az.negate(), 0);
  const ax = f.x.add(select(f.x.greaterThanEqual(0), t.negate(), t));
  const ay = f.y.add(select(f.y.greaterThanEqual(0), t.negate(), t));
  const axis = normalize(vec3(ax, ay, az));
  const theta = float(angleInt).div(255).mul(3.14159265359);
  const halfTheta = theta.mul(0.5);
  const s = halfTheta.sin();
  const w = halfTheta.cos();
  return vec4(axis.mul(s), w);
}
function unpackSplatEncodingTsl(packedData, rgbMinMaxLnScaleMinMax) {
  const word0 = packedData.x;
  const word1 = packedData.y;
  const word2 = packedData.z;
  const word3 = packedData.w;
  const rgbMin = rgbMinMaxLnScaleMinMax.x;
  const rgbMax = rgbMinMaxLnScaleMinMax.y;
  const uR = float(word0.bitAnd(uint(255)));
  const uG = float(word0.shiftRight(uint(8)).bitAnd(uint(255)));
  const uB = float(word0.shiftRight(uint(16)).bitAnd(uint(255)));
  const uA = float(word0.shiftRight(uint(24)).bitAnd(uint(255)));
  const rgb = vec3(uR, uG, uB).div(255).mul(rgbMax.sub(rgbMin)).add(rgbMin);
  const rgba = vec4(rgb, uA.div(255));
  const xy = unpackHalf2x16$2(word1);
  const zw = unpackHalf2x16$2(word2.bitAnd(uint(65535)));
  const center = vec3(xy.x, xy.y, zw.x);
  const uSx = word3.bitAnd(uint(255));
  const uSy = word3.shiftRight(uint(8)).bitAnd(uint(255));
  const uSz = word3.shiftRight(uint(16)).bitAnd(uint(255));
  const lnScaleMin = rgbMinMaxLnScaleMinMax.z;
  const lnScaleMax = rgbMinMaxLnScaleMinMax.w;
  const lnScaleScale = lnScaleMax.sub(lnScaleMin).div(254);
  const decodeScale = (uS) => select(
    uS.equal(uint(0)),
    float(0),
    exp(lnScaleMin.add(float(uS.sub(uint(1))).mul(lnScaleScale)))
  );
  const scales = vec3(decodeScale(uSx), decodeScale(uSy), decodeScale(uSz));
  const uQuat = word2.shiftRight(uint(16)).bitAnd(uint(65535)).bitOr(word3.shiftRight(uint(8)).bitAnd(uint(16711680)));
  const quaternion = decodeQuatOctXy88R8Tsl(uQuat);
  return { center, scales, quaternion, rgba };
}
function quatVecTsl(q, v) {
  const qxyz = vec3(q.x, q.y, q.z);
  const t = qxyz.cross(v).mul(2);
  return v.add(t.mul(q.w)).add(qxyz.cross(t));
}
function quatQuatTsl(q1, q2) {
  return vec4(
    q1.w.mul(q2.x).add(q1.x.mul(q2.w)).add(q1.y.mul(q2.z)).sub(q1.z.mul(q2.y)),
    q1.w.mul(q2.y).sub(q1.x.mul(q2.z)).add(q1.y.mul(q2.w)).add(q1.z.mul(q2.x)),
    q1.w.mul(q2.z).add(q1.x.mul(q2.y)).sub(q1.y.mul(q2.x)).add(q1.z.mul(q2.w)),
    q1.w.mul(q2.w).sub(q1.x.mul(q2.x)).sub(q1.y.mul(q2.y)).sub(q1.z.mul(q2.z))
  );
}
function scaleQuaternionToMatrixColumnsTsl(s, q) {
  const two = float(2);
  const col0 = vec3(
    s.x.mul(float(1).sub(two.mul(q.y.mul(q.y).add(q.z.mul(q.z))))),
    s.x.mul(two.mul(q.x.mul(q.y).add(q.w.mul(q.z)))),
    s.x.mul(two.mul(q.x.mul(q.z).sub(q.w.mul(q.y))))
  );
  const col1 = vec3(
    s.y.mul(two.mul(q.x.mul(q.y).sub(q.w.mul(q.z)))),
    s.y.mul(float(1).sub(two.mul(q.x.mul(q.x).add(q.z.mul(q.z))))),
    s.y.mul(two.mul(q.y.mul(q.z).add(q.w.mul(q.x))))
  );
  const col2 = vec3(
    s.z.mul(two.mul(q.x.mul(q.z).add(q.w.mul(q.y)))),
    s.z.mul(two.mul(q.y.mul(q.z).sub(q.w.mul(q.x)))),
    s.z.mul(float(1).sub(two.mul(q.x.mul(q.x).add(q.y.mul(q.y)))))
  );
  return [col0, col1, col2];
}
function stripWebGLInternalFormat(tex) {
  if (tex.internalFormat != null) {
    tex.internalFormat = null;
    tex.needsUpdate = true;
  }
  return tex;
}
function sext(word, shl, sr) {
  const shifted = shl === 0 ? word : word.shiftLeft(uint(shl));
  return float(int(shifted).shiftRight(uint(sr)));
}
function sextStraddle(lo, loShr, hi, hiShl, sr) {
  const combined = lo.shiftRight(uint(loShr)).bitOr(hi.shiftLeft(uint(hiShl)));
  return float(int(combined).shiftRight(uint(sr)));
}
function evaluatePackedSH1Tsl(packedData, viewDir, sh1Max) {
  const px = packedData.x;
  const py = packedData.y;
  const sh1_0 = vec3(sext(px, 25, 25), sext(px, 18, 25), sext(px, 11, 25));
  const sh1_1 = vec3(
    sext(px, 4, 25),
    sextStraddle(px, 3, py, 29, 25),
    sext(py, 22, 25)
  );
  const sh1_2 = vec3(sext(py, 15, 25), sext(py, 8, 25), sext(py, 1, 25));
  const rgb = sh1_0.mul(viewDir.y.mul(-0.4886025)).add(sh1_1.mul(viewDir.z.mul(0.4886025))).add(sh1_2.mul(viewDir.x.mul(-0.4886025)));
  return rgb.mul(sh1Max.div(63));
}
function evaluatePackedSH2Tsl(packedData, viewDir, sh2Max) {
  const px = packedData.x;
  const py = packedData.y;
  const pz = packedData.z;
  const pw = packedData.w;
  const sh2_0 = vec3(sext(px, 24, 24), sext(px, 16, 24), sext(px, 8, 24));
  const sh2_1 = vec3(sext(px, 0, 24), sext(py, 24, 24), sext(py, 16, 24));
  const sh2_2 = vec3(sext(py, 8, 24), sext(py, 0, 24), sext(pz, 24, 24));
  const sh2_3 = vec3(sext(pz, 16, 24), sext(pz, 8, 24), sext(pz, 0, 24));
  const sh2_4 = vec3(sext(pw, 24, 24), sext(pw, 16, 24), sext(pw, 8, 24));
  const x = viewDir.x;
  const y = viewDir.y;
  const z = viewDir.z;
  const rgb = sh2_0.mul(x.mul(y).mul(1.0925484)).add(sh2_1.mul(y.mul(z).mul(-1.0925484))).add(
    sh2_2.mul(
      z.mul(z).mul(2).sub(x.mul(x)).sub(y.mul(y)).mul(0.3153915)
    )
  ).add(sh2_3.mul(x.mul(z).mul(-1.0925484))).add(sh2_4.mul(x.mul(x).sub(y.mul(y)).mul(0.5462742)));
  return rgb.mul(sh2Max.div(127));
}
function evaluatePackedSH3Tsl(packedData, viewDir, sh3Max) {
  const px = packedData.x;
  const py = packedData.y;
  const pz = packedData.z;
  const pw = packedData.w;
  const sh3_0 = vec3(sext(px, 26, 26), sext(px, 20, 26), sext(px, 14, 26));
  const sh3_1 = vec3(
    sext(px, 8, 26),
    sext(px, 2, 26),
    sextStraddle(px, 4, py, 28, 26)
  );
  const sh3_2 = vec3(sext(py, 22, 26), sext(py, 16, 26), sext(py, 10, 26));
  const sh3_3 = vec3(
    sext(py, 4, 26),
    sextStraddle(py, 2, pz, 30, 26),
    sext(pz, 24, 26)
  );
  const sh3_4 = vec3(sext(pz, 18, 26), sext(pz, 12, 26), sext(pz, 6, 26));
  const sh3_5 = vec3(sext(pz, 0, 26), sext(pw, 26, 26), sext(pw, 20, 26));
  const sh3_6 = vec3(sext(pw, 14, 26), sext(pw, 8, 26), sext(pw, 2, 26));
  const x = viewDir.x;
  const y = viewDir.y;
  const z = viewDir.z;
  const xx = x.mul(x);
  const yy = y.mul(y);
  const zz = z.mul(z);
  const xy = x.mul(y);
  const rgb = sh3_0.mul(y.mul(xx.mul(3).sub(yy)).mul(-0.5900436)).add(sh3_1.mul(xy.mul(z).mul(2.8906114))).add(sh3_2.mul(y.mul(zz.mul(4).sub(xx).sub(yy)).mul(-0.4570458))).add(
    sh3_3.mul(
      z.mul(zz.mul(2).sub(xx.mul(3)).sub(yy.mul(3))).mul(0.3731763)
    )
  ).add(sh3_4.mul(x.mul(zz.mul(4).sub(xx).sub(yy)).mul(-0.4570458))).add(sh3_5.mul(z.mul(xx.sub(yy)).mul(1.4453057))).add(sh3_6.mul(x.mul(xx.sub(yy.mul(3))).mul(-0.5900436)));
  return rgb.mul(sh3Max.div(31));
}
function evaluatePackedShTsl({
  coord,
  // ivec3 from splatTexCoordTsl — MUST be the packed-texture coord
  viewDir,
  // vec3, object space: normalize(center - viewOrigin)
  shMax,
  // vec3 uniform (sh1Max, sh2Max, sh3Max)
  sh1Texture,
  sh2Texture,
  sh3Texture
}) {
  let rgb = vec3(0);
  if (sh1Texture) {
    const t1 = textureLoad(sh1Texture, coord.xy).depth(coord.z);
    rgb = rgb.add(evaluatePackedSH1Tsl(t1, viewDir, shMax.x));
    if (sh2Texture) {
      const t2 = textureLoad(sh2Texture, coord.xy).depth(coord.z);
      rgb = rgb.add(evaluatePackedSH2Tsl(t2, viewDir, shMax.y));
      if (sh3Texture) {
        const t3 = textureLoad(sh3Texture, coord.xy).depth(coord.z);
        rgb = rgb.add(evaluatePackedSH3Tsl(t3, viewDir, shMax.z));
      }
    }
  }
  return rgb;
}
const unpackHalf2x16$1 = TSL.unpackHalf2x16;
const uvec4$1 = TSL.uvec4;
const LN_SCALE_MIN$1 = -12;
const LN_SCALE_MAX$1 = 9;
class SplatNodeMaterial extends MeshBasicNodeMaterial {
  constructor(options) {
    super();
    this.renderSize = uniform(new Vector2(1, 1));
    this.renderToViewQuat = uniform(new Vector4(0, 0, 0, 1));
    this.renderToViewPos = uniform(new Vector3());
    this.renderToViewScale = uniform(1);
    this.viewOrigin = uniform(new Vector3());
    this.maxStdDev = uniform(1);
    this.minPixelRadius = uniform(0);
    this.maxPixelRadius = uniform(512);
    this.ssogFillV2 = uniform(0);
    this.ssogMinContribution = uniform(1);
    this.pickMode = uniform(0);
    this.pickNear = uniform(0);
    this.pickFar = uniform(1);
    this.earlyExit = uniform(1);
    this.vsMinPixelRadius = uniform(4);
    this.vsMinExtent = uniform(4);
    this.batchNumSplats = uniform(0);
    this.minAlpha = uniform(0.5 * (1 / 255));
    this.preBlurAmount = uniform(0);
    this.blurAmount = uniform(0.3);
    this.falloff = uniform(1);
    this.clipXY = uniform(1.4);
    this.focalAdjustment = uniform(1);
    this.rgbMinMaxLnScaleMinMax = uniform(
      new Vector4(0, 1, LN_SCALE_MIN$1, LN_SCALE_MAX$1)
    );
    this.shMax = uniform(new Vector3(1, 1, 1));
    const {
      packedTexture,
      orderNode,
      cutIndicesTexture,
      sh1Texture,
      sh2Texture,
      sh3Texture,
      lodOpacity = false,
      paged = false,
      lodInflate = false,
      parityQuantize = true,
      vsMinimal = 0,
      batchSize = 1,
      projCache = void 0,
      projPacked = void 0,
      visCountNode = void 0
    } = options;
    stripWebGLInternalFormat(packedTexture);
    if (cutIndicesTexture) stripWebGLInternalFormat(cutIndicesTexture);
    for (const tex of [sh1Texture, sh2Texture, sh3Texture]) {
      if (tex) stripWebGLInternalFormat(tex);
    }
    const vRgba = varyingProperty("vec4", "vSplatRgba");
    const vSplatUv = varyingProperty("vec2", "vSplatUv");
    const vAdjustedStdDev = varyingProperty("float", "vSplatAdjStdDev");
    const vViewZ = varyingProperty("float", "vSplatViewZ");
    const uMaxStdDev = this.maxStdDev;
    const uMinAlpha = this.minAlpha;
    const uFalloff = this.falloff;
    if (projPacked) {
      this.vertexNode = Fn(() => {
        const rejectPos = vec4(0, 0, 2, 1);
        const rejected = bool(false).toVar();
        let drawIdx = instanceIndex;
        if (batchSize > 1) {
          const rawIdx = uint(instanceIndex).mul(uint(batchSize)).add(uint(positionGeometry.z));
          const inRange = float(rawIdx).lessThan(this.batchNumSplats);
          rejected.assign(inRange.not());
          drawIdx = select(inRange, rawIdx, uint(0)).toVar("kcBatchIdx");
        }
        if (visCountNode) {
          rejected.assign(
            rejected.or(
              uint(drawIdx).greaterThanEqual(visCountNode.element(uint(0)))
            )
          );
        }
        const p0 = vec4(0, 0, 0, 0).toVar();
        const p1 = uvec4$1(uint(0), uint(0), uint(0), uint(0)).toVar();
        const loadCache = () => {
          const slot = orderNode.element(drawIdx);
          p0.assign(projPacked.p0.element(slot));
          p1.assign(projPacked.p1.element(slot));
        };
        if (visCountNode) {
          If(rejected.not(), loadCache);
        } else {
          loadCache();
        }
        rejected.assign(
          rejected.or(
            p1.z.shiftRight(uint(24)).bitAnd(uint(1)).equal(uint(0))
          )
        );
        const axis1 = unpackHalf2x16$1(p1.x);
        const sa = unpackHalf2x16$1(p1.y);
        const rgb = vec3(
          float(p1.z.bitAnd(uint(255))),
          float(p1.z.shiftRight(uint(8)).bitAnd(uint(255))),
          float(p1.z.shiftRight(uint(16)).bitAnd(uint(255)))
        ).div(255);
        const ua = unpackHalf2x16$1(p1.w);
        const len = axis1.length();
        const n = select(
          len.greaterThan(0),
          axis1.div(len),
          vec2(0, 0)
        );
        const axis2 = vec2(n.y, n.x.negate()).mul(sa.x);
        vRgba.assign(vec4(rgb, sa.y));
        vSplatUv.assign(positionGeometry.xy.mul(ua.x));
        vAdjustedStdDev.assign(ua.y);
        vViewZ.assign(p0.w.negate());
        const scaledRenderSize = vec2(this.renderSize).mul(
          this.focalAdjustment
        );
        const pixelOffset = axis1.mul(positionGeometry.x).add(axis2.mul(positionGeometry.y));
        const ndcOffset = vec2(2).div(scaledRenderSize).mul(pixelOffset);
        const ndcCenter = p0.xyz.div(p0.w);
        return select(
          rejected,
          rejectPos,
          vec4(ndcCenter.xy.add(ndcOffset).mul(p0.w), p0.z, p0.w)
        );
      })();
    } else if (projCache && visCountNode) {
      this.vertexNode = Fn(() => {
        const rejectPos = vec4(0, 0, 2, 1);
        const rejected = bool(false).toVar();
        let drawIdx = instanceIndex;
        if (batchSize > 1) {
          const rawIdx = uint(instanceIndex).mul(uint(batchSize)).add(uint(positionGeometry.z));
          const inRange = float(rawIdx).lessThan(this.batchNumSplats);
          rejected.assign(inRange.not());
          drawIdx = select(inRange, rawIdx, uint(0)).toVar("kcBatchIdx");
        }
        rejected.assign(
          rejected.or(
            uint(drawIdx).greaterThanEqual(
              visCountNode.element(uint(0))
            )
          )
        );
        const c0 = vec4(0, 0, 0, 0).toVar();
        const c1 = vec4(0, 0, 0, 0).toVar();
        const c2 = vec4(0, 0, 0, 0).toVar();
        const c3 = vec4(0, 0, 0, 0).toVar();
        If(rejected.not(), () => {
          const slot = orderNode.element(drawIdx);
          c0.assign(projCache.c0.element(slot));
          c1.assign(projCache.c1.element(slot));
          c2.assign(projCache.c2.element(slot));
          c3.assign(projCache.c3.element(slot));
        });
        rejected.assign(rejected.or(c3.w.lessThan(0.5)));
        vRgba.assign(c2);
        vSplatUv.assign(positionGeometry.xy.mul(c3.x));
        vAdjustedStdDev.assign(c3.y);
        vViewZ.assign(c3.z);
        const scaledRenderSize = vec2(this.renderSize).mul(
          this.focalAdjustment
        );
        const pixelOffset = c1.xy.mul(positionGeometry.x).add(c1.zw.mul(positionGeometry.y));
        const ndcOffset = vec2(2).div(scaledRenderSize).mul(pixelOffset);
        const ndcCenter = c0.xyz.div(c0.w);
        return select(
          rejected,
          rejectPos,
          vec4(ndcCenter.xy.add(ndcOffset).mul(c0.w), c0.z, c0.w)
        );
      })();
    } else if (projCache) {
      this.vertexNode = Fn(() => {
        const rejectPos = vec4(0, 0, 2, 1);
        const rejected = bool(false).toVar();
        let drawIdx = instanceIndex;
        if (batchSize > 1) {
          const rawIdx = uint(instanceIndex).mul(uint(batchSize)).add(uint(positionGeometry.z));
          const inRange = float(rawIdx).lessThan(this.batchNumSplats);
          rejected.assign(inRange.not());
          drawIdx = select(inRange, rawIdx, uint(0)).toVar("kcBatchIdx");
        }
        const slot = orderNode.element(drawIdx);
        const c0 = projCache.c0.element(slot);
        const c1 = projCache.c1.element(slot);
        const c2 = projCache.c2.element(slot);
        const c3 = projCache.c3.element(slot);
        rejected.assign(rejected.or(c3.w.lessThan(0.5)));
        vRgba.assign(c2);
        vSplatUv.assign(positionGeometry.xy.mul(c3.x));
        vAdjustedStdDev.assign(c3.y);
        vViewZ.assign(c3.z);
        const scaledRenderSize = vec2(this.renderSize).mul(
          this.focalAdjustment
        );
        const pixelOffset = c1.xy.mul(positionGeometry.x).add(c1.zw.mul(positionGeometry.y));
        const ndcOffset = vec2(2).div(scaledRenderSize).mul(pixelOffset);
        const ndcCenter = c0.xyz.div(c0.w);
        return select(
          rejected,
          rejectPos,
          vec4(ndcCenter.xy.add(ndcOffset).mul(c0.w), c0.z, c0.w)
        );
      })();
    } else
      this.vertexNode = Fn(() => {
        const rejectPos = vec4(0, 0, 2, 1);
        const rejected = bool(false).toVar();
        let drawIdx = instanceIndex;
        if (batchSize > 1) {
          const rawIdx = uint(instanceIndex).mul(uint(batchSize)).add(uint(positionGeometry.z));
          const inRange = float(rawIdx).lessThan(this.batchNumSplats);
          rejected.assign(inRange.not());
          drawIdx = select(inRange, rawIdx, uint(0)).toVar("kcBatchIdx");
        }
        if (vsMinimal >= 2) {
          const fi = float(drawIdx);
          const centerSynth = vec3(
            fract(fi.mul(0.1031)),
            fract(fi.mul(0.103)),
            fract(fi.mul(0.0973))
          ).sub(0.5).mul(this.vsMinExtent);
          const viewCenterSynth = quatVecTsl(
            this.renderToViewQuat,
            centerSynth.mul(this.renderToViewScale)
          ).add(this.renderToViewPos);
          rejected.assign(rejected.or(viewCenterSynth.z.greaterThanEqual(0)));
          vViewZ.assign(viewCenterSynth.z);
          const clipCenterSynth = cameraProjectionMatrix.mul(
            vec4(viewCenterSynth, 1)
          );
          rejected.assign(
            rejected.or(
              clipCenterSynth.z.abs().greaterThanEqual(clipCenterSynth.w)
            )
          );
          const clipSynth = float(this.clipXY).mul(clipCenterSynth.w);
          rejected.assign(
            rejected.or(clipCenterSynth.x.abs().greaterThan(clipSynth)).or(clipCenterSynth.y.abs().greaterThan(clipSynth))
          );
          const ndcOffsetSynth = vec2(0, 0).toVar();
          If(rejected.not(), () => {
            const adjS = float(uMaxStdDev);
            vRgba.assign(vec4(0.5, 0.5, 0.5, 0.5));
            vSplatUv.assign(positionGeometry.xy.mul(adjS));
            vAdjustedStdDev.assign(adjS);
            const rsS = vec2(this.renderSize).mul(this.focalAdjustment);
            ndcOffsetSynth.assign(
              vec2(2).div(rsS).mul(positionGeometry.xy.mul(this.vsMinPixelRadius))
            );
          });
          const ndcCenterSynth = clipCenterSynth.xyz.div(clipCenterSynth.w);
          return select(
            rejected,
            rejectPos,
            vec4(
              ndcCenterSynth.xy.add(ndcOffsetSynth).mul(clipCenterSynth.w),
              clipCenterSynth.z,
              clipCenterSynth.w
            )
          );
        }
        const slot = orderNode.element(drawIdx);
        let splatIndex = slot;
        if (cutIndicesTexture) {
          const texel = textureLoad(
            cutIndicesTexture,
            ivec2(
              int(slot.shiftRight(uint(2)).bitAnd(uint(4095))),
              int(slot.shiftRight(uint(14)))
            )
          );
          const comp = slot.bitAnd(uint(3));
          splatIndex = select(
            comp.equal(uint(0)),
            texel.x,
            select(
              comp.equal(uint(1)),
              texel.y,
              select(comp.equal(uint(2)), texel.z, texel.w)
            )
          );
        }
        const texCoord = paged ? pagedSplatTexCoordTsl(int(splatIndex)) : splatTexCoordTsl(int(splatIndex));
        const packedData = textureLoad(packedTexture, texCoord.xy).depth(
          texCoord.z
        );
        const unpacked = unpackSplatEncodingTsl(
          packedData,
          this.rgbMinMaxLnScaleMinMax
        );
        const center = unpacked.center;
        const quaternion = unpacked.quaternion;
        const viewCenter = quatVecTsl(
          this.renderToViewQuat,
          center.mul(this.renderToViewScale)
        ).add(this.renderToViewPos);
        rejected.assign(rejected.or(viewCenter.z.greaterThanEqual(0)));
        vViewZ.assign(viewCenter.z);
        const clipCenter = cameraProjectionMatrix.mul(vec4(viewCenter, 1));
        rejected.assign(
          rejected.or(clipCenter.z.abs().greaterThanEqual(clipCenter.w))
        );
        const clip = float(this.clipXY).mul(clipCenter.w);
        rejected.assign(
          rejected.or(clipCenter.x.abs().greaterThan(clip)).or(clipCenter.y.abs().greaterThan(clip))
        );
        const scales = vec3(0, 0, 0).toVar();
        const rgba = vec4(0, 0, 0, 0).toVar();
        const ndcOffset = vec2(0, 0).toVar();
        If(rejected.not().or(this.earlyExit.lessThan(0.5)), () => {
          if (vsMinimal >= 1) {
            const keepAlive = unpacked.scales.x.add(unpacked.quaternion.x).mul(0);
            rgba.assign(vec4(unpacked.rgba));
            if (lodOpacity) {
              rgba.a.assign(rgba.a.mul(2));
            }
            rgba.a.assign(rgba.a.add(keepAlive));
            const adj = float(uMaxStdDev);
            vRgba.assign(rgba);
            vSplatUv.assign(positionGeometry.xy.mul(adj));
            vAdjustedStdDev.assign(adj);
            const scaledRenderSizeMin = vec2(this.renderSize).mul(
              this.focalAdjustment
            );
            ndcOffset.assign(
              vec2(2).div(scaledRenderSizeMin).mul(positionGeometry.xy.mul(this.vsMinPixelRadius))
            );
            return;
          }
          scales.assign(vec3(unpacked.scales.mul(this.renderToViewScale)));
          rgba.assign(vec4(unpacked.rgba));
          if (lodOpacity) {
            rgba.a.assign(rgba.a.mul(2));
          }
          if (sh1Texture) {
            const viewDir = normalize(center.sub(this.viewOrigin));
            const shRgb = evaluatePackedShTsl({
              coord: texCoord,
              viewDir,
              shMax: this.shMax,
              sh1Texture,
              sh2Texture,
              sh3Texture
            });
            rgba.assign(vec4(rgba.rgb.add(shRgb), rgba.a));
          }
          if (parityQuantize) {
            const rgbQ = round(clamp(rgba.rgb.mul(255), 0, 255)).div(255);
            const aQ = round(clamp(rgba.a.mul(0.5).mul(255), 0, 255)).div(255).mul(2);
            rgba.assign(vec4(rgbQ, aQ));
            const lnScaleScale = float(254 / (LN_SCALE_MAX$1 - LN_SCALE_MIN$1));
            const requantScale = (s) => select(
              s.equal(0),
              float(0),
              exp(
                round(
                  clamp(
                    s.log().sub(LN_SCALE_MIN$1).mul(lnScaleScale),
                    0,
                    254
                  )
                ).div(lnScaleScale).add(LN_SCALE_MIN$1)
              )
            );
            scales.assign(
              vec3(
                requantScale(scales.x),
                requantScale(scales.y),
                requantScale(scales.z)
              )
            );
          }
          const zeroScales = scales.equal(vec3(0));
          rejected.assign(rejected.or(zeroScales.all()));
          rejected.assign(
            rejected.or(rgba.a.equal(0)).or(rgba.a.lessThan(uMinAlpha))
          );
          const adjustedStdDev = float(uMaxStdDev).toVar();
          If(rgba.a.greaterThan(1), () => {
            rgba.a.assign(min(rgba.a.mul(4).sub(3), 5));
            if (lodInflate) {
              const opacity = exp(
                rgba.a.mul(rgba.a).sub(1).div(2.718281828459045)
              );
              const rescale = pow(opacity, 1 / 3);
              scales.assign(scales.mul(rescale));
              rgba.a.assign(1);
            }
            adjustedStdDev.assign(uMaxStdDev.add(rgba.a.sub(1).mul(0.7)));
          });
          vRgba.assign(rgba);
          vSplatUv.assign(positionGeometry.xy.mul(adjustedStdDev));
          const viewQuaternion = quatQuatTsl(this.renderToViewQuat, quaternion);
          const [rsC0, rsC1, rsC2] = scaleQuaternionToMatrixColumnsTsl(
            scales,
            viewQuaternion
          );
          const RS = mat3(rsC0, rsC1, rsC2);
          const cov3D = RS.mul(transpose(RS));
          const scaledRenderSize = vec2(this.renderSize).mul(this.focalAdjustment);
          const focal = scaledRenderSize.mul(0.5).mul(
            vec2(
              cameraProjectionMatrix.element(int(0)).element(int(0)),
              cameraProjectionMatrix.element(int(1)).element(int(1))
            )
          );
          const isOrthographic = cameraProjectionMatrix.element(int(2)).element(int(3)).notEqual(-1);
          const invZ = float(1).div(viewCenter.z);
          const J1 = focal.mul(invZ);
          const J2 = J1.mul(viewCenter.xy).negate().mul(invZ);
          const jC0 = select(
            isOrthographic,
            vec3(focal.x, 0, 0),
            vec3(J1.x, 0, J2.x)
          );
          const jC1 = select(
            isOrthographic,
            vec3(0, focal.y, 0),
            vec3(0, J1.y, J2.y)
          );
          const J = mat3(jC0, jC1, vec3(0, 0, 0));
          const cov2D = transpose(J).mul(cov3D).mul(J);
          const a = float(cov2D.element(int(0)).element(int(0))).toVar();
          const d = float(cov2D.element(int(1)).element(int(1))).toVar();
          const b = cov2D.element(int(0)).element(int(1));
          a.addAssign(this.preBlurAmount);
          d.addAssign(this.preBlurAmount);
          const fullBlurAmount = this.blurAmount;
          const detOrig = a.mul(d).sub(b.mul(b));
          a.addAssign(fullBlurAmount);
          d.addAssign(fullBlurAmount);
          const det = a.mul(d).sub(b.mul(b));
          const blurAdjust = sqrt(max(0, detOrig.div(det)));
          const rawAlpha = rgba.a.toVar("kcRawAlpha");
          rgba.a.assign(rgba.a.mul(blurAdjust));
          rejected.assign(rejected.or(rgba.a.lessThan(uMinAlpha)));
          vRgba.a.assign(rgba.a);
          vAdjustedStdDev.assign(adjustedStdDev);
          const fillOn = this.ssogFillV2.greaterThan(0.5);
          rejected.assign(
            rejected.or(fillOn.and(rawAlpha.lessThan(1 / 255)))
          );
          rejected.assign(
            rejected.or(
              fillOn.and(
                rawAlpha.mul(6.283185307179586).mul(sqrt(max(det, 0))).lessThan(this.ssogMinContribution)
              )
            )
          );
          const eigenAvg = a.add(d).mul(0.5);
          const eigenDelta = sqrt(max(0, eigenAvg.mul(eigenAvg).sub(det)));
          const eigen1 = eigenAvg.add(eigenDelta);
          const eigen2 = eigenAvg.sub(eigenDelta);
          const eigenVec1 = select(
            b.abs().greaterThan(1e-3),
            normalize(vec2(b, eigen1.sub(a))),
            select(
              a.greaterThanEqual(d),
              vec2(1, 0),
              vec2(0, 1)
            )
          );
          const eigenVec2 = vec2(eigenVec1.y, eigenVec1.x.negate());
          const r1 = adjustedStdDev.mul(sqrt(eigen1));
          const r2 = adjustedStdDev.mul(sqrt(eigen2));
          const fillCap = min(
            1024,
            min(this.renderSize.x, this.renderSize.y)
          );
          const capScale = min(1, fillCap.div(max(r1, r2)));
          const zStar = sqrt(
            max(0, log(rgba.a.mul(255))).mul(2)
          );
          const quadScale = min(1, zStar.div(adjustedStdDev));
          const scale1 = select(
            fillOn,
            r1.mul(capScale).mul(quadScale),
            min(this.maxPixelRadius, r1)
          );
          const scale2 = select(
            fillOn,
            r2.mul(capScale).mul(quadScale),
            min(this.maxPixelRadius, r2)
          );
          If(fillOn, () => {
            vSplatUv.assign(
              positionGeometry.xy.mul(adjustedStdDev.mul(quadScale))
            );
          });
          rejected.assign(
            rejected.or(
              scale1.lessThan(this.minPixelRadius).and(scale2.lessThan(this.minPixelRadius))
            )
          );
          const posXY = positionGeometry.xy;
          const pixelOffset = eigenVec1.mul(scale1).mul(posXY.x).add(eigenVec2.mul(scale2).mul(posXY.y));
          ndcOffset.assign(vec2(2).div(scaledRenderSize).mul(pixelOffset));
        });
        const ndcCenter = clipCenter.xyz.div(clipCenter.w);
        const ndc = vec3(ndcCenter.xy.add(ndcOffset), ndcCenter.z);
        return select(
          rejected,
          rejectPos,
          vec4(ndc.xy.mul(clipCenter.w), clipCenter.z, clipCenter.w)
        );
      })();
    this.fragmentNode = Fn(() => {
      const rgba = vec4(vRgba).toVar();
      const z2 = dot(vSplatUv, vSplatUv);
      const adj = float(vAdjustedStdDev);
      If(z2.greaterThan(adj.mul(adj)), () => {
        Discard();
      });
      If(rgba.a.lessThanEqual(1), () => {
        rgba.a.assign(
          mix(rgba.a, rgba.a.mul(exp(z2.mul(-0.5))), uFalloff)
        );
      }).Else(() => {
        const aPow = exp(rgba.a.mul(rgba.a).sub(1).div(2.718281828459045));
        const alpha = float(1).sub(
          pow(float(1).sub(exp(z2.mul(-0.5))), aPow)
        );
        rgba.a.assign(mix(1, alpha, uFalloff));
      });
      If(rgba.a.lessThan(uMinAlpha), () => {
        Discard();
      });
      const normDepth = float(vViewZ).negate().sub(this.pickNear).div(float(this.pickFar).sub(this.pickNear));
      return select(
        this.pickMode.greaterThan(0.5),
        vec4(normDepth.mul(rgba.a), 0, 0, rgba.a),
        vec4(rgba.rgb.mul(rgba.a), rgba.a)
      );
    })();
    this.transparent = true;
    this.depthWrite = false;
    this.depthTest = true;
    this.side = DoubleSide;
    this.forceSinglePass = true;
    this.blending = CustomBlending;
    this.blendEquation = AddEquation;
    this.blendSrc = OneFactor;
    this.blendDst = OneMinusSrcAlphaFactor;
    this.blendSrcAlpha = OneFactor;
    this.blendDstAlpha = OneMinusSrcAlphaFactor;
    this.fog = false;
    this.lights = false;
  }
}
function roundEven(x) {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}
function stockNetAlpha(u8, lodOpacity) {
  const aRead = (lodOpacity ? 2 : 1) * u8 / 255;
  const aAccum = roundEven(Math.min(Math.max(aRead * 0.5 * 255, 0), 255)) / 255;
  return 2 * aAccum;
}
function referenceAlphaChain(u8, lodOpacity, {
  maxStdDev = Math.sqrt(5),
  minAlpha = 0.5 / 255,
  parityQuantize = true
} = {}) {
  let a = u8 / 255 * (lodOpacity ? 2 : 1);
  if (parityQuantize) {
    a = roundEven(Math.min(Math.max(a * 0.5 * 255, 0), 255)) / 255 * 2;
  }
  if (a === 0 || a < minAlpha) {
    return { alpha: 0, adjustedStdDev: maxStdDev, rejected: true };
  }
  let adjustedStdDev = maxStdDev;
  if (a > 1) {
    a = Math.min(a * 4 - 3, 5);
    adjustedStdDev = maxStdDev + 0.7 * (a - 1);
  }
  return { alpha: a, adjustedStdDev, rejected: false };
}
const countOneBits = TSL.countOneBits;
const TPW = 256;
const EPT = 8;
const SCAN_ITEMS = 512;
const pad = (n, m) => Math.ceil(n / m) * m;
function createRadixSort({
  keysNode,
  count,
  numBits = 16,
  digitBits = 4,
  reorderThreads = 256,
  valuesNode,
  indirect
}) {
  if (digitBits !== 4 && digitBits !== 8)
    throw new Error("digitBits must be 4 or 8");
  if (numBits % digitBits !== 0)
    throw new Error("numBits must be a multiple of digitBits");
  if (![64, 128, 256].includes(reorderThreads))
    throw new Error("reorderThreads must be 64, 128 or 256");
  const BUCKETS = 1 << digitBits;
  const numPasses = numBits / digitBits;
  const RT = reorderThreads;
  const WORDS = RT / 32;
  const EPW_R = RT * EPT;
  const DPT = Math.ceil(BUCKETS / RT);
  const wgCount = Math.max(1, Math.ceil(count / EPW_R));
  const blockSumCount = BUCKETS * wgCount;
  const blockSums = instancedArray(pad(blockSumCount, SCAN_ITEMS), "uint");
  const keysA = instancedArray(count, "uint");
  const keysB = instancedArray(count, "uint");
  const valsA = instancedArray(count, "uint");
  const valsB = instancedArray(count, "uint");
  const levels = [];
  {
    let items = blockSums;
    let levelCount = blockSumCount;
    for (; ; ) {
      const wgs = Math.ceil(levelCount / SCAN_ITEMS);
      const level = {
        items,
        count: levelCount,
        wgs,
        blockSums: instancedArray(Math.max(1, pad(wgs, SCAN_ITEMS)), "uint")
      };
      levels.push(level);
      if (wgs <= 1) break;
      items = level.blockSums;
      levelCount = wgs;
    }
  }
  const makeHistogram = (srcKeys, bit) => {
    const hist = workgroupArray("uint", BUCKETS).setAtomic(true);
    return Fn(() => {
      const TID = invocationLocalIndex;
      const WGID = workgroupId.x;
      const WID = WGID.mul(uint(EPW_R));
      for (let k = 0; k < DPT; k++) {
        const dg = TID.add(uint(k * RT));
        If(dg.lessThan(uint(BUCKETS)), () => {
          atomicStore(hist.element(dg), uint(0));
        });
      }
      workgroupBarrier();
      for (let r = 0; r < EPT; r++) {
        const GID = WID.add(uint(r * RT)).add(TID);
        If(GID.lessThan(uint(count)), () => {
          const digit = srcKeys.element(GID).shiftRight(uint(bit)).bitAnd(uint(BUCKETS - 1));
          atomicAdd(hist.element(digit), uint(1));
        });
      }
      workgroupBarrier();
      for (let k = 0; k < DPT; k++) {
        const dg = TID.add(uint(k * RT));
        If(dg.lessThan(uint(BUCKETS)), () => {
          blockSums.element(dg.mul(uint(wgCount)).add(WGID)).assign(atomicLoad(hist.element(dg)));
        });
      }
    })().compute([wgCount], [RT]).setName(`radixHist_bit${bit}`);
  };
  const makeScan = (level, idx) => {
    const temp = workgroupArray("uint", SCAN_ITEMS * 2);
    const { items, count: n, blockSums: sumsOut } = level;
    return Fn(() => {
      const TID = invocationLocalIndex;
      const WGID = workgroupId.x;
      const GID = WGID.mul(uint(TPW)).add(TID);
      const ELM_TID = TID.mul(uint(2));
      const ELM_GID = GID.mul(uint(2));
      temp.element(ELM_TID).assign(
        select(
          ELM_GID.greaterThanEqual(uint(n)),
          uint(0),
          items.element(ELM_GID)
        )
      );
      temp.element(ELM_TID.add(uint(1))).assign(
        select(
          ELM_GID.add(uint(1)).greaterThanEqual(uint(n)),
          uint(0),
          items.element(ELM_GID.add(uint(1)))
        )
      );
      let offset = 1;
      for (let d = SCAN_ITEMS >> 1; d > 0; d >>= 1) {
        workgroupBarrier();
        const ai = uint(offset).mul(ELM_TID.add(uint(1))).sub(uint(1));
        const bi = uint(offset).mul(ELM_TID.add(uint(2))).sub(uint(1));
        If(TID.lessThan(uint(d)), () => {
          temp.element(bi).addAssign(temp.element(ai));
        });
        offset *= 2;
      }
      If(TID.equal(uint(0)), () => {
        sumsOut.element(WGID).assign(temp.element(uint(SCAN_ITEMS - 1)));
        temp.element(uint(SCAN_ITEMS - 1)).assign(uint(0));
      });
      for (let d = 1; d < SCAN_ITEMS; d *= 2) {
        offset >>= 1;
        workgroupBarrier();
        const ai = uint(offset).mul(ELM_TID.add(uint(1))).sub(uint(1));
        const bi = uint(offset).mul(ELM_TID.add(uint(2))).sub(uint(1));
        If(TID.lessThan(uint(d)), () => {
          const t = temp.element(ai).toVar();
          temp.element(ai).assign(temp.element(bi));
          temp.element(bi).addAssign(t);
        });
      }
      workgroupBarrier();
      If(ELM_GID.lessThan(uint(n)), () => {
        items.element(ELM_GID).assign(temp.element(ELM_TID));
      });
      If(ELM_GID.add(uint(1)).lessThan(uint(n)), () => {
        items.element(ELM_GID.add(uint(1))).assign(temp.element(ELM_TID.add(uint(1))));
      });
    })().compute([level.wgs], [TPW]).setName(`radixScan_L${idx}`);
  };
  const makeAddBlock = (level, idx) => {
    const { items, count: n, blockSums: sums } = level;
    return Fn(() => {
      const TID = invocationLocalIndex;
      const WGID = workgroupId.x;
      const GID = WGID.mul(uint(TPW)).add(TID);
      const ELM_ID = GID.mul(uint(2));
      If(ELM_ID.lessThan(uint(n)), () => {
        const bs = sums.element(WGID);
        items.element(ELM_ID).addAssign(bs);
        If(ELM_ID.add(uint(1)).lessThan(uint(n)), () => {
          items.element(ELM_ID.add(uint(1))).addAssign(bs);
        });
      });
    })().compute([level.wgs], [TPW]).setName(`radixScanAdd_L${idx}`);
  };
  const makeReorder = (inKeys, outKeys, inVals, outVals, bit, isFirst, isLast) => {
    const masks = workgroupArray("uint", BUCKETS * WORDS).setAtomic(
      true
    );
    const offsets = workgroupArray("uint", BUCKETS);
    return Fn(() => {
      const TID = invocationLocalIndex;
      const WGID = workgroupId.x;
      const WID = WGID.mul(uint(EPW_R));
      const wordIdx = TID.shiftRight(uint(5)).toVar();
      const bitIdx = TID.bitAnd(uint(31)).toVar();
      for (let k = 0; k < DPT; k++) {
        const dg = TID.add(uint(k * RT));
        If(dg.lessThan(uint(BUCKETS)), () => {
          offsets.element(dg).assign(uint(0));
          for (let w = 0; w < WORDS; w++) {
            atomicStore(
              masks.element(dg.mul(uint(WORDS)).add(uint(w))),
              uint(0)
            );
          }
        });
      }
      workgroupBarrier();
      for (let round2 = 0; round2 < EPT; round2++) {
        const GID = WID.add(uint(round2 * RT)).add(TID).toVar();
        const isValid = GID.lessThan(uint(count)).toVar();
        const k = select(isValid, inKeys.element(GID), uint(0)).toVar();
        const digit = select(
          isValid,
          k.shiftRight(uint(bit)).bitAnd(uint(BUCKETS - 1)),
          uint(BUCKETS)
        ).toVar();
        const v = (isFirst ? valuesNode ? select(isValid, valuesNode.element(GID), uint(0)) : GID : select(isValid, inVals.element(GID), uint(0))).toVar();
        If(isValid, () => {
          atomicOr(
            masks.element(digit.mul(uint(WORDS)).add(wordIdx)),
            uint(1).shiftLeft(bitIdx)
          );
        });
        workgroupBarrier();
        If(isValid, () => {
          const base = digit.mul(uint(WORDS)).toVar();
          const localPrefix = offsets.element(digit).toVar();
          for (let w = 0; w < WORDS - 1; w++) {
            If(uint(w).lessThan(wordIdx), () => {
              localPrefix.addAssign(
                countOneBits(atomicLoad(masks.element(base.add(uint(w)))))
              );
            });
          }
          localPrefix.addAssign(
            countOneBits(
              atomicLoad(masks.element(base.add(wordIdx))).bitAnd(
                uint(1).shiftLeft(bitIdx).sub(uint(1))
              )
            )
          );
          const pid = digit.mul(uint(wgCount)).add(WGID);
          const pos = blockSums.element(pid).add(localPrefix).toVar();
          if (!isLast) outKeys.element(pos).assign(k);
          outVals.element(pos).assign(v);
        });
        if (round2 < EPT - 1) {
          workgroupBarrier();
          for (let k2 = 0; k2 < DPT; k2++) {
            const dg = TID.add(uint(k2 * RT));
            If(dg.lessThan(uint(BUCKETS)), () => {
              const cnt = uint(0).toVar();
              for (let w = 0; w < WORDS; w++) {
                const idx = dg.mul(uint(WORDS)).add(uint(w));
                cnt.addAssign(countOneBits(atomicLoad(masks.element(idx))));
                atomicStore(masks.element(idx), uint(0));
              }
              offsets.element(dg).addAssign(cnt);
            });
          }
          workgroupBarrier();
        }
      }
    })().compute([wgCount], [RT]).setName(`radixReorder_bit${bit}`);
  };
  const makeArgs = () => {
    if (!indirect) return null;
    const dispatchStore = storage(
      // biome-ignore lint/suspicious/noExplicitAny: structural three attribute
      indirect.dispatchAttr,
      "uint",
      3
    );
    const vis = indirect.visCountNode;
    return Fn(() => {
      If(instanceIndex.greaterThanEqual(uint(1)), () => {
        Return();
      });
      const v = vis.element(uint(0)).toVar();
      dispatchStore.element(uint(0)).assign(v.add(uint(EPW_R - 1)).div(uint(EPW_R)));
      dispatchStore.element(uint(1)).assign(uint(1));
      dispatchStore.element(uint(2)).assign(uint(1));
    })().compute([1], [1]).setName("radixIndirectArgs");
  };
  const makeClearBlockSums = () => {
    const n = pad(blockSumCount, SCAN_ITEMS);
    return Fn(() => {
      const i = instanceIndex;
      If(i.greaterThanEqual(uint(n)), () => {
        Return();
      });
      blockSums.element(i).assign(uint(0));
    })().compute([Math.ceil(n / 256)], [256]).setName("radixClearBlockSums");
  };
  const scanNodes = levels.map((level, i) => makeScan(level, i));
  const addNodes = levels.map(
    (level, i) => level.wgs > 1 ? makeAddBlock(level, i) : null
  );
  const argsNode = makeArgs();
  const clearNode = indirect ? makeClearBlockSums() : null;
  const steps = [];
  const groups = indirect ? [] : null;
  let curKeys = keysNode;
  let curVals = valsA;
  let nxtKeys = keysA;
  let nxtVals = valsB;
  for (let pass = 0; pass < numPasses; pass++) {
    const bit = pass * digitBits;
    const isFirst = pass === 0;
    const isLast = pass === numPasses - 1;
    const hist = makeHistogram(curKeys, bit);
    const scanChain = [];
    for (let i = 0; i < levels.length; i++) scanChain.push(scanNodes[i]);
    for (let i = levels.length - 1; i >= 0; i--) {
      const addNode = addNodes[i];
      if (addNode) scanChain.push(addNode);
    }
    const reorder = makeReorder(
      curKeys,
      nxtKeys,
      curVals,
      nxtVals,
      bit,
      isFirst,
      isLast
    );
    steps.push(hist, ...scanChain, reorder);
    if (groups && argsNode && clearNode) {
      groups.push({
        nodes: isFirst ? [argsNode, clearNode] : [clearNode],
        indirect: false
      });
      groups.push({ nodes: [hist], indirect: true });
      groups.push({ nodes: scanChain, indirect: false });
      groups.push({ nodes: [reorder], indirect: true });
    }
    if (!isLast) {
      curKeys = nxtKeys;
      nxtKeys = curKeys === keysA ? keysB : keysA;
      const t = curVals;
      curVals = nxtVals;
      nxtVals = t;
    }
  }
  const sortedValues = (numPasses - 1) % 2 === 1 ? valsA : valsB;
  return {
    steps,
    groups,
    sortedValues,
    wgCount,
    dispatchesPerSort: groups ? groups.reduce((a, g) => a + g.nodes.length, 0) : steps.length
  };
}
function createVisibleClear({
  keysNode,
  count,
  quantMax,
  visCountNode
}) {
  return Fn(() => {
    const i = instanceIndex;
    If(i.greaterThanEqual(uint(Math.max(1, count))), () => {
      Return();
    });
    keysNode.element(i).assign(uint(quantMax));
    If(i.equal(uint(0)), () => {
      atomicStore(visCountNode.element(uint(0)), uint(0));
    });
  })().compute([Math.ceil(Math.max(1, count) / 256)], [256]).setName("visibleClear");
}
class BatchedSplatGeometry extends THREE.InstancedBufferGeometry {
  constructor(batchSize) {
    super();
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 4096) {
      throw new Error(`BatchedSplatGeometry: bad batchSize ${batchSize}`);
    }
    this.batchSize = batchSize;
    const verts = new Float32Array(batchSize * 4 * 3);
    const use32 = batchSize * 4 > 65535;
    const idx = use32 ? new Uint32Array(batchSize * 6) : new Uint16Array(batchSize * 6);
    for (let q = 0; q < batchSize; q++) {
      const v = q * 12;
      verts[v + 0] = -1;
      verts[v + 1] = -1;
      verts[v + 2] = q;
      verts[v + 3] = 1;
      verts[v + 4] = -1;
      verts[v + 5] = q;
      verts[v + 6] = 1;
      verts[v + 7] = 1;
      verts[v + 8] = q;
      verts[v + 9] = -1;
      verts[v + 10] = 1;
      verts[v + 11] = q;
      const i = q * 6;
      const b = q * 4;
      idx[i + 0] = b;
      idx[i + 1] = b + 1;
      idx[i + 2] = b + 2;
      idx[i + 3] = b;
      idx[i + 4] = b + 2;
      idx[i + 5] = b + 3;
    }
    this.setAttribute("position", new THREE.BufferAttribute(verts, 3));
    this.setIndex(new THREE.BufferAttribute(idx, 1));
  }
}
const ROBUST_Q = 5e-3;
const ROBUST_PAD = 0.05;
const ROBUST_SAMPLES = 32768;
const ROBUST_TAIL_SHARE = 1 / 16;
function selectKth(a, k, lo0, hi0) {
  let lo = lo0;
  let hi = hi0;
  while (hi > lo) {
    const mid = lo + hi >>> 1;
    if (a[mid] < a[lo]) [a[mid], a[lo]] = [a[lo], a[mid]];
    if (a[hi] < a[lo]) [a[hi], a[lo]] = [a[lo], a[hi]];
    if (a[hi] < a[mid]) [a[hi], a[mid]] = [a[mid], a[hi]];
    const pivot = a[mid];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) {
        const t = a[i];
        a[i] = a[j];
        a[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else break;
  }
  return a[k];
}
function paddedQuantileRange(a, m, q = ROBUST_Q, pad2 = ROBUST_PAD) {
  const kLo = Math.floor(q * (m - 1));
  const kHi = Math.ceil((1 - q) * (m - 1));
  const lo = selectKth(a, kLo, 0, m - 1);
  const hi = selectKth(a, kHi, kLo, m - 1);
  const p = pad2 * (hi - lo) + 1e-6;
  return [lo - p, hi + p];
}
function robustKeyMap(c0, m0, robustMin, robustMax) {
  let c1 = Math.min(Math.max(robustMin, c0), m0);
  let m1 = Math.min(Math.max(robustMax, c1), m0);
  if (!(c1 >= c0 * 1.01)) c1 = c0;
  if (!(m1 <= m0 / 1.01)) m1 = m0;
  if (m1 < c1 * 1.001) {
    m1 = Math.min(m0, c1 * 1.001);
    if (m1 < c1 * 1.001) c1 = Math.max(c0, m1 / 1.001);
  }
  const aN = c1 > c0 ? ROBUST_TAIL_SHARE : 0;
  const aF = m1 < m0 ? ROBUST_TAIL_SHARE : 0;
  const aM = 1 - aN - aF;
  const l0 = Math.log(c0 / c1);
  const l2 = Math.log(m1 / c1);
  const l3 = Math.log(m0 / c1);
  return {
    a: [c0, 1 / c1, l0, l2],
    g: [aN > 0 ? aN / -l0 : 0, aM / l2, aF > 0 ? aF / (l3 - l2) : 0],
    cap: [aN, aM, aF]
  };
}
const LN_SCALE_MIN = -12;
const LN_SCALE_MAX = 9;
const unpackHalf2x16 = TSL.unpackHalf2x16;
const packHalf2x16 = TSL.packHalf2x16;
const uvec4 = TSL.uvec4;
function packedCenterOrigin(mesh, kind) {
  var _a, _b, _c, _d, _e;
  const o = kind === "paged" ? (_a = mesh.paged) == null ? void 0 : _a.centerOrigin : kind === "lodPacked" ? ((_c = (_b = mesh.packedSplats) == null ? void 0 : _b.lodSplats) == null ? void 0 : _c.centerOrigin) ?? ((_d = mesh.packedSplats) == null ? void 0 : _d.centerOrigin) : (_e = mesh.packedSplats) == null ? void 0 : _e.centerOrigin;
  return o && (o.x !== 0 || o.y !== 0 || o.z !== 0) ? o : null;
}
const originTranslation = new Matrix4();
function meshPackedToWorld(mesh, kind, out) {
  out.copy(mesh.matrixWorld);
  const o = packedCenterOrigin(mesh, kind);
  if (o) {
    out.multiply(originTranslation.makeTranslation(o.x, o.y, o.z));
  }
  return out;
}
function fromHalf(h) {
  const s = (h & 32768) >> 15;
  const e = (h & 31744) >> 10;
  const f = h & 1023;
  if (e === 0) return (s ? -1 : 1) * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? Number.NaN : (s ? -1 : 1) * Number.POSITIVE_INFINITY;
  return (s ? -1 : 1) * 2 ** (e - 15) * (1 + f / 1024);
}
function scanBounds(words, offsets, count) {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let k = 0; k < count; k++) {
    const o = offsets();
    const w1 = words[o + 1];
    const w2 = words[o + 2];
    const x = fromHalf(w1 & 65535);
    const y = fromHalf(w1 >>> 16);
    const z = fromHalf(w2 & 65535);
    if (!Number.isFinite(x + y + z)) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return finishBounds(minX, minY, minZ, maxX, maxY, maxZ);
}
let halfTable = null;
function halfToFloatTable() {
  if (!halfTable) {
    halfTable = new Float32Array(65536);
    for (let h = 0; h < 65536; h++) halfTable[h] = fromHalf(h);
  }
  return halfTable;
}
function accumulateStaticBounds(words, start, end, acc) {
  const half = halfToFloatTable();
  let minX = acc[0];
  let minY = acc[1];
  let minZ = acc[2];
  let maxX = acc[3];
  let maxY = acc[4];
  let maxZ = acc[5];
  for (let k = start; k < end; k++) {
    const o = 4 * k;
    const w1 = words[o + 1];
    const w2 = words[o + 2];
    const x = half[w1 & 65535];
    const y = half[w1 >>> 16];
    const z = half[w2 & 65535];
    if (!Number.isFinite(x + y + z)) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  acc[0] = minX;
  acc[1] = minY;
  acc[2] = minZ;
  acc[3] = maxX;
  acc[4] = maxY;
  acc[5] = maxZ;
}
function finishBounds(minXIn, minYIn, minZIn, maxXIn, maxYIn, maxZIn) {
  let minX = minXIn;
  let minY = minYIn;
  let minZ = minZIn;
  let maxX = maxXIn;
  let maxY = maxYIn;
  let maxZ = maxZIn;
  if (minX > maxX) {
    minX = minY = minZ = 0;
    maxX = maxY = maxZ = 1;
  }
  const mx = 0.02 * (maxX - minX + 1e-6);
  const my = 0.02 * (maxY - minY + 1e-6);
  const mz = 0.02 * (maxZ - minZ + 1e-6);
  return {
    min: new Vector3(minX - mx, minY - my, minZ - mz),
    max: new Vector3(maxX + mx, maxY + my, maxZ + mz)
  };
}
function robustBounds(words, offsetOf, count, raw) {
  const n = Math.min(count, ROBUST_SAMPLES);
  const fallback = { min: raw.min.clone(), max: raw.max.clone() };
  if (n < 256) return fallback;
  const half = halfToFloatTable();
  const xs = new Float32Array(n);
  const ys = new Float32Array(n);
  const zs = new Float32Array(n);
  let m = 0;
  for (let s = 0; s < n; s++) {
    const o = offsetOf(Math.floor(s * count / n));
    const w1 = words[o + 1];
    const w2 = words[o + 2];
    const x = half[w1 & 65535];
    const y = half[w1 >>> 16];
    const z = half[w2 & 65535];
    if (!Number.isFinite(x + y + z)) continue;
    xs[m] = x;
    ys[m] = y;
    zs[m] = z;
    m++;
  }
  if (m < 256) return fallback;
  const out = fallback;
  const axes = [
    [xs, "x"],
    [ys, "y"],
    [zs, "z"]
  ];
  for (const [a, c] of axes) {
    const [lo, hi] = paddedQuantileRange(a, m);
    out.min[c] = Math.min(Math.max(lo, raw.min[c]), raw.max[c]);
    out.max[c] = Math.max(Math.min(hi, raw.max[c]), out.min[c]);
  }
  return out;
}
function boxDistanceRange(mn, mx, packedToWorld, worldToPacked, camPos, camDir, radial) {
  let minD = Number.POSITIVE_INFINITY;
  let maxD = Number.NEGATIVE_INFINITY;
  const corner = new Vector3();
  for (let c = 0; c < 8; c++) {
    corner.set(
      c & 1 ? mx.x : mn.x,
      c & 2 ? mx.y : mn.y,
      c & 4 ? mx.z : mn.z
    );
    corner.applyMatrix4(packedToWorld);
    const d = radial ? corner.distanceTo(camPos) : corner.sub(camPos).dot(camDir) + 100;
    if (d < minD) minD = d;
    if (d > maxD) maxD = d;
  }
  if (radial) {
    const camObj = camPos.clone().applyMatrix4(worldToPacked);
    const closest = new Vector3(
      Math.min(Math.max(camObj.x, mn.x), mx.x),
      Math.min(Math.max(camObj.y, mn.y), mx.y),
      Math.min(Math.max(camObj.z, mn.z), mx.z)
    ).applyMatrix4(packedToWorld);
    minD = Math.max(0, closest.distanceTo(camPos));
  }
  return [minD, maxD];
}
function dispatch2d(groups) {
  const MAX_PER_DIM = 65535;
  if (groups <= MAX_PER_DIM) return [groups];
  const y = Math.ceil(groups / MAX_PER_DIM);
  return [Math.ceil(groups / y), y];
}
const PREPARE_PIPELINE_TIMEOUT_MS = 3e4;
const PREPARE_SCHEDULED_TIMEOUT_MS = 8e3;
const PREPARE_BOUNDS_CHUNK = 1 << 20;
function yieldToPage() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
function createSyncInto(device, slot, descriptor) {
  try {
    slot.pipeline = device.createComputePipeline(descriptor);
  } catch (e) {
    console.warn("[splat] synchronous compute pipeline create threw", e);
  }
}
function settleWithin(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      }
    );
  });
}
function nowMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
function withSwapped(target, key, replacement, fn) {
  const rec = target;
  const hadOwn = Object.prototype.hasOwnProperty.call(target, key);
  const previous = rec[key];
  rec[key] = replacement;
  try {
    return fn();
  } finally {
    if (hadOwn) rec[key] = previous;
    else delete rec[key];
  }
}
class WebGpuSplatBackend {
  constructor() {
    this.sortRadial = true;
    this.sortKeyLog = true;
    this.sortKeyRobust = true;
    this.lastKeyMap = null;
    this.freezeOrder = false;
    this.vsMinimal = 0;
    this.parityQuantize = true;
    this.batchSize = 1;
    this.projectorEnabled = false;
    this.sortBits = 16;
    this.sortDigits = 4;
    this.sortTpw = 256;
    this.sortVisible = false;
    this.cachePack = 0;
    this.frames = 0;
    this.sorts = 0;
    this.lastSortFrame = -1;
    this.rebuilds = 0;
    this.prepareNewStates = false;
    this.onPrepared = null;
    this.lastPrepareReport = null;
    this.state = null;
    this.autoPrepareBroken = false;
    this.prepareScheduled = false;
    this.sortedOnce = false;
    this.warnedMultiMesh = false;
    this.preparing = false;
    this.needsRebuild = false;
    this.placeholderMaterial = new MeshBasicNodeMaterial();
  }
  // Called from SparkRenderer.updateInternal (WebGPU branch). Returns true
  // if a sort was submitted this frame (caller updates sortedCenter/Dir).
  update({
    spark,
    scene,
    camera,
    viewChanged
  }) {
    this.frames++;
    const mesh = this.findSplatMesh(scene);
    const src = mesh ? this.resolveSource(spark, mesh) : null;
    if (!mesh || !src || src.numSplats === 0 || this.preparing || this.prepareScheduled) {
      return this.drawNothing(spark);
    }
    this.sortRadial = spark.sortRadial ?? true;
    let rebuilt = false;
    if (this.needsRebuild || !this.stateMatches(mesh, src)) {
      if (this.prepareNewStates && !this.autoPrepareBroken && !this.needsRebuild && (!this.state || this.state.mesh !== mesh || !this.sortedOnce)) {
        this.schedulePrepare(spark, mesh, scene, camera);
        return this.drawNothing(spark);
      }
      this.buildState(spark, mesh, src);
      rebuilt = true;
      this.rebuilds++;
    }
    const state = this.state;
    const cutChanged = src.numSplats !== state.lastNumSplats || src.mappingVersion !== state.lastMappingVersion;
    const wantSort = !this.freezeOrder && (viewChanged || rebuilt || cutChanged || !this.sortedOnce);
    let didSort = false;
    if (wantSort) {
      if (rebuilt || cutChanged) {
        this.updateBounds(state, src);
      }
      state.uNumSplats.value = src.numSplats;
      this.updateKeygenUniforms(state, camera);
      this.sortedOnce = true;
      this.sorts++;
      this.lastSortFrame = this.frames;
      didSort = true;
      state.lastNumSplats = src.numSplats;
      state.lastMappingVersion = src.mappingVersion;
    }
    spark.activeSplats = src.numSplats;
    const drawInstances = this.batchSize > 1 ? Math.ceil(src.numSplats / this.batchSize) : src.numSplats;
    state.drawInstances = drawInstances;
    state.material.batchNumSplats.value = src.numSplats;
    spark.geometry.instanceCount = drawInstances;
    if (state.projector) {
      this.syncUniforms(spark, camera);
      if (state.uWriteKeys) state.uWriteKeys.value = wantSort ? 1 : 0;
    }
    for (const call of this.sortDispatchPlan(state, wantSort)) {
      spark.renderer.compute(
        call.nodes,
        call.indirect ? state.visDispatchAttr : null
      );
    }
    const ctx = mesh.context;
    if (ctx) {
      if (src.kind === "static" && ctx.numSplats) {
        ctx.numSplats.value = src.numSplats;
      } else if (src.kind === "lodPacked") {
        if (ctx.numSplats) ctx.numSplats.value = src.numSplats;
        if (ctx.enableLod) ctx.enableLod.value = true;
        if (ctx.lodIndices && src.cutTexture) {
          ctx.lodIndices.value = src.cutTexture;
        }
      }
    }
    return didSort;
  }
  /**
   * [full-3] Get `mesh` ready for its first frame WITHOUT freezing the
   * browser. Optional: a host that never calls it renders exactly as before.
   *
   * The first frame of a new state creates ~12 compute pipelines (keygen or
   * projector + the radix passes) and the draw pipeline through three's
   * SYNCHRONOUS entry points. Chrome compiles those (DXC on D3D12) on the GPU
   * process MAIN thread - the thread that also draws the browser's own UI.
   * Measured 2026-09-27 on a 4.6M-splat static scene: ~1.1 s of compiles in
   * 621 + 659 ms blocks, during which the whole browser froze (tabs could
   * not be switched), plus a 684 ms main-thread first render. The ASYNC
   * entry points compile on GPU-process worker threads, in parallel
   * (measured: 8 heavy shaders 7.5 s serial on the main thread vs 1.4 s with
   * the GPU main thread busy for 1 ms).
   *
   * So, before the mesh is shown, prepare():
   *   1. builds the state for `mesh` (as the first update() would),
   *   2. runs the static bounds scan in chunks (update() then skips it),
   *   3. dry-runs every compute node the first frame dispatches through
   *      three's own renderer.compute() - bindings, uploads, node building,
   *      dispose bookkeeping all exactly as a real first dispatch - with the
   *      dispatch disabled and each new pipeline's descriptor handed to
   *      createComputePipelineAsync instead of the synchronous create,
   *   4. compiles the draw pipeline through renderer.compileAsync,
   * yielding to the page between steps. While it runs, update() dispatches
   * and draws nothing; the SparkRenderer draws its placeholder material so
   * the host's render loop cannot create the draw pipeline synchronously.
   *
   * Never rejects, never strands a loading screen, and its worst case is the
   * old behaviour: a compute pipeline whose async creation rejects or does
   * not settle within PREPARE_PIPELINE_TIMEOUT_MS is created the synchronous
   * way (errors surface as before); a compute step that fails or leaves a
   * pipeline slot empty makes the next update() rebuild the state the old
   * way; a texture whose layered upload broke off gets one full upload on
   * its next bind; the draw pipeline's compile is awaited for at most the
   * same timeout (a pipeline already being created is waited for by three's
   * isReady check; a compile that hung before that point is created
   * synchronously by the first frame). report.ok is false on any of it.
   */
  async prepare(options) {
    var _a;
    const report = await this.prepareOnce(options);
    if (report.reason !== "busy" && report.reason !== "empty") {
      this.lastPrepareReport = report;
      try {
        (_a = this.onPrepared) == null ? void 0 : _a.call(this, report);
      } catch (e) {
        console.warn("[splat] onPrepared threw", e);
      }
    }
    return report;
  }
  /** [full-3b] a prepare() is scheduled or running: nothing is drawn yet. */
  get isPreparing() {
    return this.preparing || this.prepareScheduled;
  }
  // update()'s draw-nothing path (no mesh / empty cut / prepare pending)
  drawNothing(spark) {
    spark.activeSplats = 0;
    spark.geometry.instanceCount = 0;
    if (this.state) this.state.drawInstances = 0;
    return false;
  }
  // [full-3b] update() met a mesh it has no state for (prepareNewStates):
  // prepare it right AFTER this frame - never inside it: update() runs within
  // renderer.render(), and compileAsync resets the render list of the very
  // scene + camera being drawn. Until prepare() starts, prepareScheduled keeps
  // update() drawing nothing; prepare() itself then sets `preparing`.
  schedulePrepare(spark, mesh, scene, camera) {
    this.prepareScheduled = true;
    setTimeout(() => {
      this.prepareScheduled = false;
      this.prepare({
        spark,
        mesh,
        scene,
        camera,
        // shorter than an explicit prepare's: a host's loading overlay waits
        // for the first drawn splats, and past this the old in-frame compile
        // (a freeze, but a drawn scene) is the better outcome
        timeoutMs: PREPARE_SCHEDULED_TIMEOUT_MS
      }).then((report) => {
        var _a;
        if (!report.ok && report.reason !== "empty" && report.reason !== "busy") {
          this.autoPrepareBroken = true;
        }
        (_a = spark.setDirty) == null ? void 0 : _a.call(spark);
      });
    }, 0);
  }
  async prepareOnce({
    spark,
    mesh,
    scene,
    camera,
    onProgress,
    timeoutMs = PREPARE_PIPELINE_TIMEOUT_MS
  }) {
    var _a;
    const t0 = nowMs();
    const report = {
      ok: false,
      asyncComputePipelines: 0,
      syncFallbacks: 0,
      renderCompiled: false,
      uploadedLayers: 0,
      ms: { state: 0, bounds: 0, upload: 0, compute: 0, render: 0, total: 0 }
    };
    const finish = () => {
      report.ms.total = Math.round(nowMs() - t0);
      return report;
    };
    if (this.preparing) {
      report.reason = "busy";
      return finish();
    }
    this.preparing = true;
    const jobs = [];
    const uploading = /* @__PURE__ */ new Set();
    let device;
    let phase = "setup";
    let placeholderOn = false;
    try {
      const renderer = spark.renderer;
      const backend = renderer == null ? void 0 : renderer.backend;
      device = backend == null ? void 0 : backend.device;
      if (!backend || !device || typeof backend.compute !== "function" || typeof device.createComputePipelineAsync !== "function") {
        report.reason = "no-renderer";
        return finish();
      }
      const src = this.resolveSource(spark, mesh);
      if (!src || src.numSplats === 0) {
        report.reason = "empty";
        return finish();
      }
      let t = nowMs();
      this.sortRadial = spark.sortRadial ?? true;
      if (this.needsRebuild || !this.stateMatches(mesh, src)) {
        this.buildState(spark, mesh, src);
        this.rebuilds++;
      }
      const state = this.state;
      spark.material = this.placeholderMaterial;
      placeholderOn = true;
      report.ms.state = Math.round(nowMs() - t);
      const nodes = this.firstFrameComputeNodes(state);
      const layers = typeof renderer.initTexture === "function" ? this.staticUploadLayers(state) : [];
      const steps = 1 + layers.length + nodes.length + 2;
      let done = 0;
      const progress = () => onProgress == null ? void 0 : onProgress(++done, steps);
      await yieldToPage();
      t = nowMs();
      await this.prepareBounds(state, src);
      state.lastNumSplats = src.numSplats;
      state.lastMappingVersion = src.mappingVersion;
      report.ms.bounds = Math.round(nowMs() - t);
      progress();
      t = nowMs();
      for (const { texture, layer } of layers) {
        await yieldToPage();
        uploading.add(texture);
        texture.addLayerUpdate(layer);
        if (layer > 0) texture.needsUpdate = true;
        renderer.initTexture(texture);
        if (layer === Math.max(1, ((_a = texture.image) == null ? void 0 : _a.depth) ?? 1) - 1) uploading.delete(texture);
        report.uploadedLayers++;
        progress();
      }
      report.ms.upload = Math.round(nowMs() - t);
      phase = "compute";
      t = nowMs();
      for (const node of nodes) {
        await yieldToPage();
        this.dryRunCompute(renderer, node, jobs);
        progress();
      }
      await this.settleJobs(device, jobs, timeoutMs);
      report.asyncComputePipelines = jobs.length;
      report.syncFallbacks = jobs.filter((j) => j.fellBack).length;
      if (jobs.some((j) => !j.slot.pipeline)) {
        throw new Error("a compute pipeline slot stayed empty");
      }
      phase = "later";
      report.ms.compute = Math.round(nowMs() - t);
      progress();
      t = nowMs();
      const compileAsync = renderer.compileAsync;
      if (typeof compileAsync === "function") {
        spark.material = state.material;
        let compiling;
        try {
          compiling = compileAsync.call(renderer, spark, camera, scene);
        } finally {
          spark.material = this.placeholderMaterial;
        }
        report.renderCompiled = await settleWithin(compiling, timeoutMs);
        if (!report.renderCompiled) {
          report.reason = "failed";
          report.error = "the draw pipeline compile failed or did not settle in time";
        }
      }
      report.ms.render = Math.round(nowMs() - t);
      progress();
      report.ok = report.reason === void 0;
    } catch (e) {
      report.reason = "failed";
      report.error = String((e == null ? void 0 : e.message) ?? e).slice(0, 300);
      if (phase === "compute") this.needsRebuild = true;
      for (const texture of uploading) {
        texture.layerUpdates.clear();
        texture.needsUpdate = true;
      }
    } finally {
      if (device && jobs.some((j) => !j.done)) {
        await this.settleJobs(device, jobs, timeoutMs).catch(() => {
        });
      }
      if (placeholderOn && this.state) spark.material = this.state.material;
      this.preparing = false;
    }
    return finish();
  }
  // The renderer.compute() calls one update() submits, in order - the ONE
  // place the dispatch branches live (update() runs it every frame; prepare()
  // dry-runs its sort-frame plan, so the two can never drift apart).
  // `indirect` calls take state.visDispatchAttr as their dispatch size.
  sortDispatchPlan(state, wantSort) {
    if (state.projector) {
      if (wantSort && state.uWriteKeys && state.visGroups) {
        return [
          { nodes: [state.visPrePass, state.projector], indirect: false },
          ...state.visGroups.map((g) => ({ nodes: g.nodes, indirect: g.indirect }))
        ];
      }
      return [
        {
          nodes: wantSort && state.uWriteKeys ? [state.projector, ...state.radix.steps] : [state.projector],
          indirect: false
        }
      ];
    }
    return wantSort ? [{ nodes: [state.keygen, ...state.radix.steps], indirect: false }] : [];
  }
  // The compute nodes the first update() dispatches (its sort-frame plan),
  // each once - creation only, order irrelevant.
  firstFrameComputeNodes(state) {
    const list = [];
    for (const call of this.sortDispatchPlan(state, true)) list.push(...call.nodes);
    return [...new Set(list.filter(Boolean))];
  }
  // The (texture, layer) pairs prepare() uploads one per step: the static
  // source's packed + SH array textures, which are fresh (never uploaded) on
  // a new load. Cut kinds are skipped: their pool/cut textures are uploaded
  // incrementally by their own producers. Stripped of the WebGL internal
  // format already (buildState / the SplatNodeMaterial constructor) - an
  // unstripped texture would upload zeros.
  staticUploadLayers(state) {
    var _a;
    if (state.kind !== "static") return [];
    const out = [];
    for (const texture of [state.packedTexture, state.sh1, state.sh2, state.sh3]) {
      if (!texture || typeof texture.addLayerUpdate !== "function") continue;
      const depth = Math.max(1, ((_a = texture.image) == null ? void 0 : _a.depth) ?? 1);
      for (let layer = 0; layer < depth; layer++) out.push({ texture, layer });
    }
    return out;
  }
  // update()'s bounds step, done ahead: the static kind scans every splat
  // (chunked, yielding between chunks - identical result to scanBounds), the
  // cut kinds sample through updateBounds (<= 65,536 samples, sub-ms).
  async prepareBounds(state, src) {
    var _a;
    const arr = (_a = state.mesh.packedSplats) == null ? void 0 : _a.packedArray;
    if (src.kind !== "static" || !arr) {
      this.updateBounds(state, src);
      return;
    }
    const acc = new Float64Array([
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY
    ]);
    for (let s = 0; s < src.numSplats; s += PREPARE_BOUNDS_CHUNK) {
      if (s > 0) await yieldToPage();
      accumulateStaticBounds(
        arr,
        s,
        Math.min(src.numSplats, s + PREPARE_BOUNDS_CHUNK),
        acc
      );
    }
    const b = finishBounds(acc[0], acc[1], acc[2], acc[3], acc[4], acc[5]);
    state.boundsMin.copy(b.min);
    state.boundsMax.copy(b.max);
    this.updateRobustBounds(state, b, arr, (k) => 4 * k, src.numSplats);
  }
  // One compute node through three's real first-dispatch path, with the
  // dispatch disabled and a new pipeline's compile made async. three creates
  // a pipeline inside getForCompute (device.createComputePipeline, which the
  // hook captures) and then hands that pipeline to backend.compute (which the
  // hook turns into "create it async into the pipeline's slot").
  dryRunCompute(renderer, node, jobs) {
    const backend = renderer.backend;
    const device = backend.device;
    let captured = null;
    const captureCreate = (desc) => {
      captured = { label: desc.label, layout: desc.layout, compute: desc.compute };
      return void 0;
    };
    const noDispatch = (...args) => {
      const descriptor = captured;
      if (!descriptor) return;
      captured = null;
      const pipeline = args[3];
      if (!pipeline || pipeline.isComputePipeline !== true) {
        throw new Error("three's compute hook no longer passes the pipeline 4th");
      }
      const slot = backend.get(pipeline);
      const job = { slot, descriptor, done: false, fellBack: false };
      job.settled = device.createComputePipelineAsync(descriptor).then(
        (gpuPipeline) => {
          if (job.done) return;
          job.done = true;
          slot.pipeline = gpuPipeline;
        },
        (err) => {
          if (job.done) return;
          job.done = true;
          job.fellBack = true;
          console.warn(
            `[splat] async ${descriptor.label ?? "compute pipeline"} failed (${String((err == null ? void 0 : err.message) ?? err).slice(0, 200)}) - created synchronously`
          );
          createSyncInto(device, slot, descriptor);
        }
      );
      jobs.push(job);
    };
    withSwapped(
      device,
      "createComputePipeline",
      captureCreate,
      () => withSwapped(backend, "compute", noDispatch, () => renderer.compute(node))
    );
    if (captured) {
      throw new Error("a compute pipeline was created but never reached the dispatch hook");
    }
  }
  // Wait for every async pipeline; whatever has not settled in time is
  // created synchronously (the pre-[full-3] behaviour), so no slot is ever
  // left empty when the guard lifts.
  async settleJobs(device, jobs, timeoutMs) {
    let timer;
    await Promise.race([
      Promise.all(jobs.map((j) => j.settled.catch(() => {
      }))),
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      })
    ]);
    clearTimeout(timer);
    for (const j of jobs) {
      if (j.done) continue;
      j.done = true;
      j.fellBack = true;
      createSyncInto(device, j.slot, j.descriptor);
    }
  }
  // Called from SparkRenderer.onBeforeRender: per-frame material uniforms.
  applyPerFrame(spark, camera) {
    const state = this.state;
    if (!state) return;
    state.material;
    if (this.batchSize > 1) {
      spark.geometry.instanceCount = state.drawInstances;
    }
    this.syncUniforms(spark, camera);
  }
  // Per-frame uniform sync, shared by applyPerFrame (onBeforeRender) and -
  // when the projector is on - update(), because the projector compute is
  // submitted from update() and must see THIS frame's camera, not last
  // frame's. camera.updateMatrixWorld() + a manual inverse make the transform
  // fresh regardless of which caller runs first (matrixWorldInverse is only
  // refreshed inside renderer.render).
  syncUniforms(spark, camera) {
    const state = this.state;
    if (!state) return;
    const mat = state.material;
    camera.updateMatrixWorld();
    if (state.uProjection) {
      state.uProjection.value.copy(
        camera.projectionMatrix
      );
    }
    mat.renderSize.value.copy(spark.renderSize);
    mat.maxStdDev.value = spark.maxStdDev;
    mat.minPixelRadius.value = spark.minPixelRadius;
    mat.maxPixelRadius.value = spark.maxPixelRadius;
    mat.ssogFillV2.value = spark.ssogFillV2 ? 1 : 0;
    mat.ssogMinContribution.value = spark.ssogMinContribution;
    mat.earlyExit.value = globalThis.__kcSplatEarlyExit === 0 ? 0 : 1;
    mat.pickMode.value = spark.pickMode ?? 0;
    mat.pickNear.value = spark.pickNear ?? 0;
    mat.pickFar.value = spark.pickFar ?? 1;
    const g = globalThis;
    const vsPx = g.__kcSplatVsMinPx;
    mat.vsMinPixelRadius.value = typeof vsPx === "number" && vsPx > 0 ? vsPx : 4;
    const vsExt = g.__kcSplatVsMinExt;
    mat.vsMinExtent.value = typeof vsExt === "number" && vsExt > 0 ? vsExt : 4;
    mat.minAlpha.value = spark.minAlpha;
    mat.preBlurAmount.value = spark.preBlurAmount;
    mat.blurAmount.value = spark.blurAmount;
    mat.falloff.value = spark.falloff;
    mat.clipXY.value = spark.clipXY;
    mat.focalAdjustment.value = spark.focalAdjustment;
    const enc = this.currentEncoding(state.mesh, state.kind);
    mat.rgbMinMaxLnScaleMinMax.value.set(
      enc.rgbMin ?? 0,
      enc.rgbMax ?? 1,
      enc.lnScaleMin ?? -12,
      enc.lnScaleMax ?? 9
    );
    mat.shMax.value.set(enc.sh1Max ?? 1, enc.sh2Max ?? 1, enc.sh3Max ?? 1);
    const packedToWorld = meshPackedToWorld(
      state.mesh,
      state.kind,
      new Matrix4()
    );
    const objectToView = new Matrix4().copy(camera.matrixWorld).invert().multiply(packedToWorld);
    const pos = new Vector3();
    const quat = new Quaternion();
    const scl = new Vector3();
    objectToView.decompose(pos, quat, scl);
    mat.renderToViewQuat.value.set(quat.x, quat.y, quat.z, quat.w);
    mat.renderToViewPos.value.copy(pos);
    mat.renderToViewScale.value = scl.x;
    const worldToObject = new Matrix4().copy(packedToWorld).invert();
    const camWorld = camera.getWorldPosition(new Vector3());
    mat.viewOrigin.value.copy(camWorld.applyMatrix4(worldToObject));
  }
  // Debug/test access (harness reads the permutation + material;
  // SplatMeasure reads visCountAttr ONCE per phase boundary via
  // renderer.getArrayBufferAsync — never per frame).
  getState() {
    const s = this.state;
    if (!s) return null;
    return {
      kind: s.kind,
      numSplats: s.lastNumSplats,
      capacity: s.capacity,
      numShBound: s.sh3 ? 3 : s.sh2 ? 2 : s.sh1 ? 1 : 0,
      material: s.material,
      sortedValues: s.radix.sortedValues,
      keysNode: s.keysNode,
      visCountAttr: s.visCountAttr
    };
  }
  findSplatMesh(scene) {
    const found = [];
    scene.traverse((obj) => {
      const candidate = obj;
      const isSplatSource = candidate.packedSplats && typeof candidate.packedSplats.getTexture === "function" || candidate.paged && candidate.paged.dynoIndices !== void 0;
      if (obj.visible && isSplatSource) {
        found.push(obj);
      }
    });
    if (found.length > 1 && !this.warnedMultiMesh) {
      this.warnedMultiMesh = true;
      console.warn(
        "WebGpuSplatBackend: multiple SplatMeshes found; only the first is rendered on the WebGPU path (composite cuts are out of scope)."
      );
    }
    return found[0] ?? null;
  }
  currentEncoding(mesh, kind) {
    var _a, _b, _c, _d;
    if (kind === "paged") return ((_a = mesh.paged) == null ? void 0 : _a.splatEncoding) ?? {};
    if (kind === "lodPacked")
      return ((_c = (_b = mesh.packedSplats) == null ? void 0 : _b.lodSplats) == null ? void 0 : _c.splatEncoding) ?? {};
    return ((_d = mesh.packedSplats) == null ? void 0 : _d.splatEncoding) ?? {};
  }
  resolveSource(spark, mesh) {
    var _a, _b, _c, _d, _e, _f, _g;
    const maxShMesh = mesh.maxSh ?? 3;
    const paged = mesh.paged;
    if (paged == null ? void 0 : paged.pager) {
      const cutTexture = paged.dynoIndices.value;
      if (paged.numSplats === 0 || cutTexture.image.width !== 4096) {
        return {
          kind: "paged",
          packedTexture: paged.pager.packedTexture.value,
          pagedTiling: true,
          cutTexture: null,
          numSplats: 0,
          capacity: 0,
          encoding: paged.splatEncoding ?? {},
          numSh: 0,
          mappingVersion: mesh.mappingVersion ?? 0
        };
      }
      const numSh2 = Math.min(
        paged.numSh,
        paged.maxSh,
        paged.pager.maxSh,
        maxShMesh
      );
      const shReady = (t) => t.image.width === 256 && t.image.height === 256 ? t : void 0;
      return {
        kind: "paged",
        packedTexture: paged.pager.packedTexture.value,
        pagedTiling: true,
        cutTexture,
        numSplats: paged.numSplats,
        capacity: cutTexture.image.height * 16384,
        encoding: paged.splatEncoding ?? {},
        numSh: numSh2,
        sh1: numSh2 >= 1 ? shReady(paged.pager.sh1Texture.value) : void 0,
        sh2: numSh2 >= 2 ? shReady(paged.pager.sh2Texture.value) : void 0,
        sh3: numSh2 >= 3 ? shReady(paged.pager.sh3Texture.value) : void 0,
        mappingVersion: mesh.mappingVersion ?? 0
      };
    }
    const packed = mesh.packedSplats;
    if (!packed) return null;
    const lodSplats = packed.lodSplats;
    const instance = (_a = spark.lodInstances) == null ? void 0 : _a.get(mesh);
    if (lodSplats && instance) {
      const numSh2 = Math.min(lodSplats.getNumSh(), maxShMesh);
      const sh2 = numSh2 > 0 ? lodSplats.ensureShTextures() : {};
      return {
        kind: "lodPacked",
        packedTexture: lodSplats.getTexture(),
        pagedTiling: false,
        cutTexture: instance.texture,
        numSplats: instance.numSplats,
        capacity: instance.indices.length,
        encoding: lodSplats.splatEncoding ?? {},
        numSh: numSh2,
        sh1: numSh2 >= 1 ? (_b = sh2.sh1Texture) == null ? void 0 : _b.value : void 0,
        sh2: numSh2 >= 2 ? (_c = sh2.sh2Texture) == null ? void 0 : _c.value : void 0,
        sh3: numSh2 >= 3 ? (_d = sh2.sh3Texture) == null ? void 0 : _d.value : void 0,
        mappingVersion: mesh.mappingVersion ?? 0
      };
    }
    if (packed.numSplats === 0) return null;
    const numSh = Math.min(packed.getNumSh(), maxShMesh);
    const sh = numSh > 0 ? packed.ensureShTextures() : {};
    return {
      kind: "static",
      packedTexture: packed.getTexture(),
      pagedTiling: false,
      cutTexture: null,
      numSplats: packed.numSplats,
      capacity: packed.numSplats,
      encoding: packed.splatEncoding ?? {},
      numSh,
      sh1: numSh >= 1 ? (_e = sh.sh1Texture) == null ? void 0 : _e.value : void 0,
      sh2: numSh >= 2 ? (_f = sh.sh2Texture) == null ? void 0 : _f.value : void 0,
      sh3: numSh >= 3 ? (_g = sh.sh3Texture) == null ? void 0 : _g.value : void 0,
      mappingVersion: mesh.mappingVersion ?? 0
    };
  }
  // The baked state serves this mesh + source as-is (identities + capacity).
  stateMatches(mesh, src) {
    const st = this.state;
    return !!st && st.mesh === mesh && st.kind === src.kind && st.packedTexture === src.packedTexture && st.cutTexture === src.cutTexture && st.sh1 === src.sh1 && st.sh2 === src.sh2 && st.sh3 === src.sh3 && st.capacity === src.capacity;
  }
  buildState(spark, mesh, src) {
    const { capacity, cutTexture, packedTexture, pagedTiling } = src;
    stripWebGLInternalFormat(packedTexture);
    if (cutTexture) stripWebGLInternalFormat(cutTexture);
    const keysNode = instancedArray(Math.max(1, capacity), "uint");
    const sortBits = this.sortBits >= 4 && this.sortBits <= 16 && this.sortBits % 4 === 0 ? this.sortBits : 16;
    const quantMax = 2 ** sortBits - 1;
    const digitBits = this.sortDigits === 8 && sortBits % 8 === 0 ? 8 : 4;
    const reorderThreads = [64, 128, 256].includes(this.sortTpw) ? this.sortTpw : 256;
    const projOn = this.projectorEnabled && this.vsMinimal === 0;
    const visOn = projOn && this.sortVisible;
    let visCountAtomic = null;
    let visCountRead = null;
    let compactVals = null;
    let visDispatchAttr = null;
    let visCountAttr = null;
    if (visOn) {
      visCountAtomic = instancedArray(1, "uint").toAtomic();
      visCountAttr = visCountAtomic.value;
      visCountRead = storage(
        // biome-ignore lint/suspicious/noExplicitAny: shared attribute view
        visCountAttr,
        "uint",
        1
      );
      compactVals = instancedArray(Math.max(1, capacity), "uint");
      visDispatchAttr = new IndirectStorageBufferAttribute(
        new Uint32Array([0, 1, 1]),
        3
      );
    }
    const radix = createRadixSort({
      keysNode,
      count: Math.max(1, capacity),
      numBits: sortBits,
      digitBits,
      reorderThreads,
      ...visOn && visCountRead && compactVals ? {
        valuesNode: compactVals,
        indirect: {
          visCountNode: visCountRead,
          dispatchAttr: visDispatchAttr
        }
      } : {}
    });
    const visPrePass = visOn ? createVisibleClear({
      keysNode,
      count: Math.max(1, capacity),
      quantMax,
      visCountNode: visCountAtomic
    }) : null;
    const uNumSplats = uniform(0);
    const uMeshToWorld = uniform(new Matrix4());
    const uCameraPos = uniform(new Vector3());
    const uCameraDir = uniform(new Vector3(0, 0, -1));
    const uDistRange = uniform(new Vector3(0, 1, 0));
    const uKeyA = uniform(new Vector4(0.02, 50, 0, 1));
    const uKeyG = uniform(new Vector3(0, 1, 0));
    const uKeyCap = uniform(new Vector3(0, 1, 0));
    const sortRadial = this.sortRadial;
    const sortKeyLog = this.sortKeyLog;
    const robustKeys = sortKeyLog && this.sortKeyRobust;
    const keyNorm = (metric) => {
      if (robustKeys) {
        const A = uKeyA;
        const G = uKeyG;
        const C = uKeyCap;
        const l = log(max(metric, A.x).mul(A.y));
        return clamp(l.sub(A.z).mul(G.x), 0, C.x).add(clamp(l.mul(G.y), 0, C.y)).add(clamp(l.sub(A.w).mul(G.z), 0, C.z));
      }
      return sortKeyLog ? log(max(metric, uDistRange.z)).sub(uDistRange.x).div(uDistRange.y) : metric.sub(uDistRange.x).div(uDistRange.y.sub(uDistRange.x));
    };
    const keygen = Fn(() => {
      const i = instanceIndex;
      If(i.greaterThanEqual(uint(Math.max(1, capacity))), () => {
        Return();
      });
      If(float(i).greaterThanEqual(uNumSplats), () => {
        keysNode.element(i).assign(uint(quantMax));
        Return();
      });
      let splatIndex = i;
      if (cutTexture) {
        const texel = textureLoad(
          cutTexture,
          ivec2(
            int(i.shiftRight(uint(2)).bitAnd(uint(4095))),
            int(i.shiftRight(uint(14)))
          )
        );
        const comp = i.bitAnd(uint(3));
        splatIndex = select(
          comp.equal(uint(0)),
          texel.x,
          select(
            comp.equal(uint(1)),
            texel.y,
            select(comp.equal(uint(2)), texel.z, texel.w)
          )
        );
      }
      const texCoord = pagedTiling ? pagedSplatTexCoordTsl(int(splatIndex)) : splatTexCoordTsl(int(splatIndex));
      const t = textureLoad(packedTexture, texCoord.xy).depth(texCoord.z);
      const xy = unpackHalf2x16(t.y);
      const zw = unpackHalf2x16(t.z.bitAnd(uint(65535)));
      const world = uMeshToWorld.mul(vec4(vec3(xy.x, xy.y, zw.x), 1)).xyz.toVar();
      const metric = sortRadial ? world.sub(uCameraPos).length() : world.sub(uCameraPos).dot(uCameraDir).add(100);
      const norm = keyNorm(metric);
      const q = uint(float(1).sub(clamp(norm, 0, 1)).mul(quantMax));
      keysNode.element(i).assign(q);
    })().compute(dispatch2d(Math.ceil(Math.max(1, capacity) / 256)), [256]).setName("splatKeygen");
    const packLevel = projOn && (this.cachePack === 1 || this.cachePack === 2) ? this.cachePack : 0;
    const projC = projOn && packLevel < 2 ? {
      c0: instancedArray(Math.max(1, capacity), "vec4"),
      c1: instancedArray(Math.max(1, capacity), "vec4"),
      c2: instancedArray(Math.max(1, capacity), "vec4"),
      c3: instancedArray(Math.max(1, capacity), "vec4")
    } : null;
    const projP = projOn && packLevel === 2 ? {
      p0: instancedArray(Math.max(1, capacity), "vec4"),
      p1: instancedArray(Math.max(1, capacity), "uvec4")
    } : null;
    const material = new SplatNodeMaterial({
      packedTexture,
      orderNode: radix.sortedValues,
      cutIndicesTexture: cutTexture ?? void 0,
      sh1Texture: src.sh1,
      sh2Texture: src.sh2,
      sh3Texture: src.sh3,
      lodOpacity: src.encoding.lodOpacity ?? false,
      paged: pagedTiling,
      parityQuantize: this.parityQuantize,
      vsMinimal: this.vsMinimal,
      batchSize: this.batchSize,
      projCache: projC ?? void 0,
      projPacked: projP ?? void 0,
      visCountNode: visOn && visCountRead ? visCountRead : void 0
    });
    let projector = null;
    let uProjection = null;
    let uWriteKeys = null;
    if (projC || projP) {
      const uProj = uniform(new Matrix4());
      uProjection = uProj;
      const uWK = uniform(0);
      uWriteKeys = uWK;
      const lodOpacity = src.encoding.lodOpacity ?? false;
      const parityQuantize = this.parityQuantize;
      const sh1 = src.sh1;
      const sh2 = src.sh2;
      const sh3 = src.sh3;
      projector = Fn(() => {
        const i = instanceIndex;
        If(i.greaterThanEqual(uint(Math.max(1, capacity))), () => {
          Return();
        });
        If(float(i).greaterThanEqual(uNumSplats), () => {
          if (projC) {
            projC.c3.element(i).assign(vec4(0, 0, 0, 0));
          } else if (projP) {
            projP.p1.element(i).assign(uvec4(uint(0), uint(0), uint(0), uint(0)));
          }
          if (!visOn) {
            If(float(uWK).greaterThan(0.5), () => {
              keysNode.element(i).assign(uint(quantMax));
            });
          }
          Return();
        });
        let splatIndex = i;
        if (cutTexture) {
          const texel = textureLoad(
            cutTexture,
            ivec2(
              int(i.shiftRight(uint(2)).bitAnd(uint(4095))),
              int(i.shiftRight(uint(14)))
            )
          );
          const comp = i.bitAnd(uint(3));
          splatIndex = select(
            comp.equal(uint(0)),
            texel.x,
            select(
              comp.equal(uint(1)),
              texel.y,
              select(comp.equal(uint(2)), texel.z, texel.w)
            )
          );
        }
        const texCoord = pagedTiling ? pagedSplatTexCoordTsl(int(splatIndex)) : splatTexCoordTsl(int(splatIndex));
        const packedData = textureLoad(packedTexture, texCoord.xy).depth(
          texCoord.z
        );
        const unpacked = unpackSplatEncodingTsl(
          packedData,
          material.rgbMinMaxLnScaleMinMax
        );
        const center = unpacked.center;
        const quaternion = unpacked.quaternion;
        const rejected = bool(false).toVar();
        const viewCenter = quatVecTsl(
          material.renderToViewQuat,
          center.mul(material.renderToViewScale)
        ).add(material.renderToViewPos);
        rejected.assign(rejected.or(viewCenter.z.greaterThanEqual(0)));
        const clipCenter = uProj.mul(vec4(viewCenter, 1));
        rejected.assign(
          rejected.or(clipCenter.z.abs().greaterThanEqual(clipCenter.w))
        );
        const clip = float(material.clipXY).mul(clipCenter.w);
        rejected.assign(
          rejected.or(clipCenter.x.abs().greaterThan(clip)).or(clipCenter.y.abs().greaterThan(clip))
        );
        const rgba = vec4(0, 0, 0, 0).toVar();
        const axis1 = vec2(0, 0).toVar();
        const axis2 = vec2(0, 0).toVar();
        const uvStd = float(0).toVar();
        const adjOut = float(0).toVar();
        const scl2 = projP ? float(0).toVar() : null;
        If(rejected.not(), () => {
          const scales = vec3(
            unpacked.scales.mul(material.renderToViewScale)
          ).toVar();
          rgba.assign(vec4(unpacked.rgba));
          if (lodOpacity) {
            rgba.a.assign(rgba.a.mul(2));
          }
          if (sh1) {
            const viewDir = normalize(center.sub(material.viewOrigin));
            const shRgb = evaluatePackedShTsl({
              coord: texCoord,
              viewDir,
              shMax: material.shMax,
              sh1Texture: sh1,
              sh2Texture: sh2,
              sh3Texture: sh3
            });
            rgba.assign(vec4(rgba.rgb.add(shRgb), rgba.a));
          }
          if (parityQuantize) {
            const rgbQ = round(clamp(rgba.rgb.mul(255), 0, 255)).div(
              255
            );
            const aQ = round(clamp(rgba.a.mul(0.5).mul(255), 0, 255)).div(255).mul(2);
            rgba.assign(vec4(rgbQ, aQ));
            const lnScaleScale = float(254 / (LN_SCALE_MAX - LN_SCALE_MIN));
            const requantScale = (sc) => select(
              sc.equal(0),
              float(0),
              exp(
                round(
                  clamp(
                    sc.log().sub(LN_SCALE_MIN).mul(lnScaleScale),
                    0,
                    254
                  )
                ).div(lnScaleScale).add(LN_SCALE_MIN)
              )
            );
            scales.assign(
              vec3(
                requantScale(scales.x),
                requantScale(scales.y),
                requantScale(scales.z)
              )
            );
          }
          const zeroScales = scales.equal(vec3(0));
          rejected.assign(rejected.or(zeroScales.all()));
          rejected.assign(
            rejected.or(rgba.a.equal(0)).or(rgba.a.lessThan(material.minAlpha))
          );
          const adjustedStdDev = float(material.maxStdDev).toVar();
          If(rgba.a.greaterThan(1), () => {
            rgba.a.assign(min(rgba.a.mul(4).sub(3), 5));
            adjustedStdDev.assign(
              float(material.maxStdDev).add(rgba.a.sub(1).mul(0.7))
            );
          });
          const viewQuaternion = quatQuatTsl(
            material.renderToViewQuat,
            quaternion
          );
          const [rsC0, rsC1, rsC2] = scaleQuaternionToMatrixColumnsTsl(
            scales,
            viewQuaternion
          );
          const RS = mat3(rsC0, rsC1, rsC2);
          const cov3D = RS.mul(transpose(RS));
          const scaledRenderSize = vec2(material.renderSize).mul(
            material.focalAdjustment
          );
          const focal = scaledRenderSize.mul(0.5).mul(
            vec2(
              uProj.element(int(0)).element(int(0)),
              uProj.element(int(1)).element(int(1))
            )
          );
          const isOrthographic = uProj.element(int(2)).element(int(3)).notEqual(-1);
          const invZ = float(1).div(viewCenter.z);
          const J1 = focal.mul(invZ);
          const J2 = J1.mul(viewCenter.xy).negate().mul(invZ);
          const jC0 = select(
            isOrthographic,
            vec3(focal.x, 0, 0),
            vec3(J1.x, 0, J2.x)
          );
          const jC1 = select(
            isOrthographic,
            vec3(0, focal.y, 0),
            vec3(0, J1.y, J2.y)
          );
          const J = mat3(jC0, jC1, vec3(0, 0, 0));
          const cov2D = transpose(J).mul(cov3D).mul(J);
          const a = float(cov2D.element(int(0)).element(int(0))).toVar();
          const d = float(cov2D.element(int(1)).element(int(1))).toVar();
          const b = cov2D.element(int(0)).element(int(1));
          a.addAssign(material.preBlurAmount);
          d.addAssign(material.preBlurAmount);
          const detOrig = a.mul(d).sub(b.mul(b));
          a.addAssign(material.blurAmount);
          d.addAssign(material.blurAmount);
          const det = a.mul(d).sub(b.mul(b));
          const blurAdjust = sqrt(max(0, detOrig.div(det)));
          const rawAlpha = rgba.a.toVar("kcRawAlphaP");
          rgba.a.assign(rgba.a.mul(blurAdjust));
          rejected.assign(
            rejected.or(rgba.a.lessThan(material.minAlpha))
          );
          const fillOn = material.ssogFillV2.greaterThan(0.5);
          rejected.assign(
            rejected.or(fillOn.and(rawAlpha.lessThan(1 / 255)))
          );
          rejected.assign(
            rejected.or(
              fillOn.and(
                rawAlpha.mul(6.283185307179586).mul(sqrt(max(det, 0))).lessThan(material.ssogMinContribution)
              )
            )
          );
          const eigenAvg = a.add(d).mul(0.5);
          const eigenDelta = sqrt(
            max(0, eigenAvg.mul(eigenAvg).sub(det))
          );
          const eigen1 = eigenAvg.add(eigenDelta);
          const eigen2 = eigenAvg.sub(eigenDelta);
          const eigenVec1 = select(
            b.abs().greaterThan(1e-3),
            normalize(vec2(b, eigen1.sub(a))),
            select(a.greaterThanEqual(d), vec2(1, 0), vec2(0, 1))
          );
          const eigenVec2 = vec2(eigenVec1.y, eigenVec1.x.negate());
          const r1 = adjustedStdDev.mul(sqrt(eigen1));
          const r2 = adjustedStdDev.mul(sqrt(eigen2));
          const fillCap = min(
            1024,
            min(material.renderSize.x, material.renderSize.y)
          );
          const capScale = min(1, fillCap.div(max(r1, r2)));
          const zStar = sqrt(max(0, log(rgba.a.mul(255))).mul(2));
          const quadScale = min(1, zStar.div(adjustedStdDev));
          const scale1 = select(
            fillOn,
            r1.mul(capScale).mul(quadScale),
            min(material.maxPixelRadius, r1)
          );
          const scale2 = select(
            fillOn,
            r2.mul(capScale).mul(quadScale),
            min(material.maxPixelRadius, r2)
          );
          rejected.assign(
            rejected.or(
              scale1.lessThan(material.minPixelRadius).and(scale2.lessThan(material.minPixelRadius))
            )
          );
          axis1.assign(eigenVec1.mul(scale1));
          axis2.assign(eigenVec2.mul(scale2));
          if (scl2) scl2.assign(scale2);
          uvStd.assign(
            select(fillOn, adjustedStdDev.mul(quadScale), adjustedStdDev)
          );
          adjOut.assign(adjustedStdDev);
        });
        If(float(uWK).greaterThan(0.5), () => {
          const metric = sortRadial ? viewCenter.length() : viewCenter.z.negate().add(100);
          const normK = keyNorm(metric);
          const qk = uint(float(1).sub(clamp(normK, 0, 1)).mul(quantMax));
          if (visOn && visCountAtomic && compactVals) {
            If(rejected.not(), () => {
              const j = atomicAdd(
                visCountAtomic.element(uint(0)),
                uint(1)
              ).toVar();
              keysNode.element(j).assign(qk);
              compactVals.element(j).assign(i);
            });
          } else {
            keysNode.element(i).assign(qk);
          }
        });
        if (projC && packLevel === 0) {
          projC.c0.element(i).assign(clipCenter);
          projC.c1.element(i).assign(vec4(axis1, axis2));
          projC.c2.element(i).assign(rgba);
          projC.c3.element(i).assign(
            vec4(uvStd, adjOut, viewCenter.z, select(rejected, 0, 1))
          );
        } else if (projC) {
          If(rejected.not(), () => {
            projC.c0.element(i).assign(clipCenter);
            projC.c1.element(i).assign(vec4(axis1, axis2));
            projC.c2.element(i).assign(rgba);
          });
          projC.c3.element(i).assign(
            vec4(uvStd, adjOut, viewCenter.z, select(rejected, 0, 1))
          );
        } else if (projP) {
          If(rejected.not(), () => {
            const w4 = packHalf2x16(axis1);
            const w5 = packHalf2x16(vec2(scl2, rgba.a));
            const r8 = uint(round(clamp(rgba.r.mul(255), 0, 255)));
            const g8 = uint(round(clamp(rgba.g.mul(255), 0, 255)));
            const b8 = uint(round(clamp(rgba.b.mul(255), 0, 255)));
            const w6 = r8.bitOr(g8.shiftLeft(uint(8))).bitOr(b8.shiftLeft(uint(16))).bitOr(uint(1).shiftLeft(uint(24)));
            const w7 = packHalf2x16(vec2(uvStd, adjOut));
            projP.p0.element(i).assign(clipCenter);
            projP.p1.element(i).assign(uvec4(w4, w5, w6, w7));
          }).Else(() => {
            projP.p1.element(i).assign(uvec4(uint(0), uint(0), uint(0), uint(0)));
          });
        }
      })().compute(dispatch2d(Math.ceil(Math.max(1, capacity) / 256)), [256]).setName("splatProjector");
    }
    if (this.state) {
      kcDisposeOldMaterial(spark.renderer, this.state.material);
    }
    kcRegrowLog("buildState", { capacity });
    this.state = {
      mesh,
      kind: src.kind,
      packedTexture,
      cutTexture,
      sh1: src.sh1,
      sh2: src.sh2,
      sh3: src.sh3,
      capacity,
      material,
      keysNode,
      keygen,
      radix,
      uNumSplats,
      uMeshToWorld,
      uCameraPos,
      uCameraDir,
      uDistRange,
      uKeyA,
      uKeyG,
      uKeyCap,
      robustKeys,
      boundsMin: new Vector3(0, 0, 0),
      boundsMax: new Vector3(1, 1, 1),
      robustMin: new Vector3(0, 0, 0),
      robustMax: new Vector3(1, 1, 1),
      lastNumSplats: -1,
      lastMappingVersion: -1,
      drawInstances: 0,
      projector,
      uProjection,
      uWriteKeys,
      visPrePass,
      visGroups: radix.groups,
      visDispatchAttr,
      visCountAttr
    };
    this.sortedOnce = false;
    this.needsRebuild = false;
    spark.material = material;
    if (this.batchSize > 1 && !(spark.geometry instanceof BatchedSplatGeometry)) {
      spark.geometry = new BatchedSplatGeometry(this.batchSize);
    }
  }
  // (Re)compute object-space bounds for the CURRENT cut/source. Static
  // sources scan the whole packedArray once; cut sources sample the cut
  // through the CPU mirrors (cut indices texture image.data → pool/lodSplats
  // mirror) at each re-cut (≤ ~65k samples, sub-ms).
  updateBounds(state, src) {
    var _a, _b, _c, _d, _e, _f, _g;
    const mesh = state.mesh;
    let bounds = null;
    let words = null;
    let offsetOf = null;
    if (src.kind === "static") {
      const arr = (_a = mesh.packedSplats) == null ? void 0 : _a.packedArray;
      if (arr) {
        let i = 0;
        bounds = scanBounds(arr, () => 4 * i++, src.numSplats);
        words = arr;
        offsetOf = (k) => 4 * k;
      }
    } else if (src.kind === "lodPacked") {
      const arr = (_c = (_b = mesh.packedSplats) == null ? void 0 : _b.lodSplats) == null ? void 0 : _c.packedArray;
      const cut = (_d = state.cutTexture) == null ? void 0 : _d.image.data;
      if (arr && cut) {
        const step = Math.max(1, Math.floor(src.numSplats / 65536));
        let i = 0;
        bounds = scanBounds(
          arr,
          () => {
            const idx = cut[i];
            i += step;
            return 4 * idx;
          },
          Math.floor(src.numSplats / step)
        );
        words = arr;
        offsetOf = (k) => 4 * cut[k];
      }
    } else {
      const pool = (_f = (_e = mesh.paged) == null ? void 0 : _e.pager) == null ? void 0 : _f.packedTexture.value.image.data;
      const cut = (_g = state.cutTexture) == null ? void 0 : _g.image.data;
      if (pool && cut) {
        const step = Math.max(1, Math.floor(src.numSplats / 65536));
        let i = 0;
        bounds = scanBounds(
          pool,
          () => {
            const idx = cut[i];
            i += step;
            return 4 * ((idx >>> 16) * 65536 + (idx & 65535));
          },
          Math.floor(src.numSplats / step)
        );
        words = pool;
        offsetOf = (k) => {
          const idx = cut[k];
          return 4 * ((idx >>> 16) * 65536 + (idx & 65535));
        };
      }
    }
    if (bounds) {
      state.boundsMin.copy(bounds.min);
      state.boundsMax.copy(bounds.max);
      this.updateRobustBounds(state, bounds, words, offsetOf, src.numSplats);
    }
  }
  // [fov-1] state.robustMin/Max from the source's centres (the raw box when
  // the robust keys are off or nothing can be sampled).
  updateRobustBounds(state, raw, words, offsetOf, count) {
    const r = state.robustKeys && words && offsetOf ? robustBounds(words, offsetOf, count, raw) : raw;
    state.robustMin.copy(r.min);
    state.robustMax.copy(r.max);
  }
  updateKeygenUniforms(state, camera) {
    state.mesh.updateWorldMatrix(true, false);
    const packedToWorld = meshPackedToWorld(
      state.mesh,
      state.kind,
      new Matrix4()
    );
    state.uMeshToWorld.value.copy(packedToWorld);
    const camPos = camera.getWorldPosition(new Vector3());
    state.uCameraPos.value.copy(camPos);
    const camDir = camera.getWorldDirection(new Vector3());
    state.uCameraDir.value.copy(camDir);
    const worldToPacked = new Matrix4().copy(packedToWorld).invert();
    let [minD, maxD] = boxDistanceRange(
      state.boundsMin,
      state.boundsMax,
      packedToWorld,
      worldToPacked,
      camPos,
      camDir,
      this.sortRadial
    );
    if (this.sortKeyLog) {
      const minClamp = Math.max(minD, 0.02);
      if (maxD <= minClamp * 1.001) maxD = minClamp * 2;
      const logMin = Math.log(minClamp);
      state.uDistRange.value.set(
        logMin,
        Math.log(maxD) - logMin,
        minClamp
      );
      if (state.robustKeys) {
        const [rMin, rMax] = boxDistanceRange(
          state.robustMin,
          state.robustMax,
          packedToWorld,
          worldToPacked,
          camPos,
          camDir,
          this.sortRadial
        );
        const map = robustKeyMap(minClamp, maxD, rMin, rMax);
        state.uKeyA.value.set(...map.a);
        state.uKeyG.value.set(...map.g);
        state.uKeyCap.value.set(...map.cap);
        this.lastKeyMap = map;
      }
      return;
    }
    if (maxD <= minD) maxD = minD + 1;
    state.uDistRange.value.set(minD, maxD, 0);
  }
}
export {
  SPLAT_TEX_LAYER_BITS,
  SPLAT_TEX_MASK,
  SPLAT_TEX_WIDTH_BITS,
  SplatNodeMaterial,
  WebGpuSplatBackend,
  createRadixSort,
  createVisibleClear,
  decodeQuatOctXy88R8Tsl,
  evaluatePackedSH1Tsl,
  evaluatePackedSH2Tsl,
  evaluatePackedSH3Tsl,
  evaluatePackedShTsl,
  pagedSplatTexCoordTsl,
  quatQuatTsl,
  quatVecTsl,
  referenceAlphaChain,
  roundEven,
  scaleQuaternionToMatrixColumnsTsl,
  splatTexCoordTsl,
  stockNetAlpha,
  stripWebGLInternalFormat,
  unpackSplatEncodingTsl
};
//# sourceMappingURL=spark-webgpu.module.js.map

"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const TSL = require("three/tsl");
const webgpu = require("three/webgpu");
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const TSL__namespace = /* @__PURE__ */ _interopNamespaceDefault(TSL);
const unpackHalf2x16 = TSL__namespace.unpackHalf2x16;
const SPLAT_TEX_WIDTH_BITS = 11;
const SPLAT_TEX_LAYER_BITS = 22;
const SPLAT_TEX_MASK = 2047;
function splatTexCoordTsl(index) {
  const u = TSL.uint(index);
  const x = u.bitAnd(TSL.uint(SPLAT_TEX_MASK));
  const y = u.shiftRight(TSL.uint(SPLAT_TEX_WIDTH_BITS)).bitAnd(TSL.uint(SPLAT_TEX_MASK));
  const z = u.shiftRight(TSL.uint(SPLAT_TEX_LAYER_BITS));
  return TSL.ivec3(TSL.int(x), TSL.int(y), TSL.int(z));
}
function pagedSplatTexCoordTsl(index) {
  const i = TSL.uint(index);
  return TSL.ivec3(
    TSL.int(i.bitAnd(TSL.uint(255))),
    TSL.int(i.shiftRight(TSL.uint(8)).bitAnd(TSL.uint(255))),
    TSL.int(i.shiftRight(TSL.uint(16)))
  );
}
function decodeQuatOctXy88R8Tsl(encoded) {
  const quantU = encoded.bitAnd(TSL.uint(255));
  const quantV = encoded.shiftRight(TSL.uint(8)).bitAnd(TSL.uint(255));
  const angleInt = encoded.shiftRight(TSL.uint(16));
  const uF = TSL.float(quantU).div(255);
  const vF = TSL.float(quantV).div(255);
  const f = TSL.vec2(uF.mul(2).sub(1), vF.mul(2).sub(1));
  const az = TSL.float(1).sub(f.x.abs()).sub(f.y.abs());
  const t = TSL.max(az.negate(), 0);
  const ax = f.x.add(TSL.select(f.x.greaterThanEqual(0), t.negate(), t));
  const ay = f.y.add(TSL.select(f.y.greaterThanEqual(0), t.negate(), t));
  const axis = TSL.normalize(TSL.vec3(ax, ay, az));
  const theta = TSL.float(angleInt).div(255).mul(3.14159265359);
  const halfTheta = theta.mul(0.5);
  const s = halfTheta.sin();
  const w = halfTheta.cos();
  return TSL.vec4(axis.mul(s), w);
}
function unpackSplatEncodingTsl(packedData, rgbMinMaxLnScaleMinMax) {
  const word0 = packedData.x;
  const word1 = packedData.y;
  const word2 = packedData.z;
  const word3 = packedData.w;
  const rgbMin = rgbMinMaxLnScaleMinMax.x;
  const rgbMax = rgbMinMaxLnScaleMinMax.y;
  const uR = TSL.float(word0.bitAnd(TSL.uint(255)));
  const uG = TSL.float(word0.shiftRight(TSL.uint(8)).bitAnd(TSL.uint(255)));
  const uB = TSL.float(word0.shiftRight(TSL.uint(16)).bitAnd(TSL.uint(255)));
  const uA = TSL.float(word0.shiftRight(TSL.uint(24)).bitAnd(TSL.uint(255)));
  const rgb = TSL.vec3(uR, uG, uB).div(255).mul(rgbMax.sub(rgbMin)).add(rgbMin);
  const rgba = TSL.vec4(rgb, uA.div(255));
  const xy = unpackHalf2x16(word1);
  const zw = unpackHalf2x16(word2.bitAnd(TSL.uint(65535)));
  const center = TSL.vec3(xy.x, xy.y, zw.x);
  const uSx = word3.bitAnd(TSL.uint(255));
  const uSy = word3.shiftRight(TSL.uint(8)).bitAnd(TSL.uint(255));
  const uSz = word3.shiftRight(TSL.uint(16)).bitAnd(TSL.uint(255));
  const lnScaleMin = rgbMinMaxLnScaleMinMax.z;
  const lnScaleMax = rgbMinMaxLnScaleMinMax.w;
  const lnScaleScale = lnScaleMax.sub(lnScaleMin).div(254);
  const decodeScale = (uS) => TSL.select(
    uS.equal(TSL.uint(0)),
    TSL.float(0),
    TSL.exp(lnScaleMin.add(TSL.float(uS.sub(TSL.uint(1))).mul(lnScaleScale)))
  );
  const scales = TSL.vec3(decodeScale(uSx), decodeScale(uSy), decodeScale(uSz));
  const uQuat = word2.shiftRight(TSL.uint(16)).bitAnd(TSL.uint(65535)).bitOr(word3.shiftRight(TSL.uint(8)).bitAnd(TSL.uint(16711680)));
  const quaternion = decodeQuatOctXy88R8Tsl(uQuat);
  return { center, scales, quaternion, rgba };
}
function quatVecTsl(q, v) {
  const qxyz = TSL.vec3(q.x, q.y, q.z);
  const t = qxyz.cross(v).mul(2);
  return v.add(t.mul(q.w)).add(qxyz.cross(t));
}
function quatQuatTsl(q1, q2) {
  return TSL.vec4(
    q1.w.mul(q2.x).add(q1.x.mul(q2.w)).add(q1.y.mul(q2.z)).sub(q1.z.mul(q2.y)),
    q1.w.mul(q2.y).sub(q1.x.mul(q2.z)).add(q1.y.mul(q2.w)).add(q1.z.mul(q2.x)),
    q1.w.mul(q2.z).add(q1.x.mul(q2.y)).sub(q1.y.mul(q2.x)).add(q1.z.mul(q2.w)),
    q1.w.mul(q2.w).sub(q1.x.mul(q2.x)).sub(q1.y.mul(q2.y)).sub(q1.z.mul(q2.z))
  );
}
function scaleQuaternionToMatrixColumnsTsl(s, q) {
  const two = TSL.float(2);
  const col0 = TSL.vec3(
    s.x.mul(TSL.float(1).sub(two.mul(q.y.mul(q.y).add(q.z.mul(q.z))))),
    s.x.mul(two.mul(q.x.mul(q.y).add(q.w.mul(q.z)))),
    s.x.mul(two.mul(q.x.mul(q.z).sub(q.w.mul(q.y))))
  );
  const col1 = TSL.vec3(
    s.y.mul(two.mul(q.x.mul(q.y).sub(q.w.mul(q.z)))),
    s.y.mul(TSL.float(1).sub(two.mul(q.x.mul(q.x).add(q.z.mul(q.z))))),
    s.y.mul(two.mul(q.y.mul(q.z).add(q.w.mul(q.x))))
  );
  const col2 = TSL.vec3(
    s.z.mul(two.mul(q.x.mul(q.z).add(q.w.mul(q.y)))),
    s.z.mul(two.mul(q.y.mul(q.z).sub(q.w.mul(q.x)))),
    s.z.mul(TSL.float(1).sub(two.mul(q.x.mul(q.x).add(q.y.mul(q.y)))))
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
  const shifted = shl === 0 ? word : word.shiftLeft(TSL.uint(shl));
  return TSL.float(TSL.int(shifted).shiftRight(TSL.uint(sr)));
}
function sextStraddle(lo, loShr, hi, hiShl, sr) {
  const combined = lo.shiftRight(TSL.uint(loShr)).bitOr(hi.shiftLeft(TSL.uint(hiShl)));
  return TSL.float(TSL.int(combined).shiftRight(TSL.uint(sr)));
}
function evaluatePackedSH1Tsl(packedData, viewDir, sh1Max) {
  const px = packedData.x;
  const py = packedData.y;
  const sh1_0 = TSL.vec3(sext(px, 25, 25), sext(px, 18, 25), sext(px, 11, 25));
  const sh1_1 = TSL.vec3(
    sext(px, 4, 25),
    sextStraddle(px, 3, py, 29, 25),
    sext(py, 22, 25)
  );
  const sh1_2 = TSL.vec3(sext(py, 15, 25), sext(py, 8, 25), sext(py, 1, 25));
  const rgb = sh1_0.mul(viewDir.y.mul(-0.4886025)).add(sh1_1.mul(viewDir.z.mul(0.4886025))).add(sh1_2.mul(viewDir.x.mul(-0.4886025)));
  return rgb.mul(sh1Max.div(63));
}
function evaluatePackedSH2Tsl(packedData, viewDir, sh2Max) {
  const px = packedData.x;
  const py = packedData.y;
  const pz = packedData.z;
  const pw = packedData.w;
  const sh2_0 = TSL.vec3(sext(px, 24, 24), sext(px, 16, 24), sext(px, 8, 24));
  const sh2_1 = TSL.vec3(sext(px, 0, 24), sext(py, 24, 24), sext(py, 16, 24));
  const sh2_2 = TSL.vec3(sext(py, 8, 24), sext(py, 0, 24), sext(pz, 24, 24));
  const sh2_3 = TSL.vec3(sext(pz, 16, 24), sext(pz, 8, 24), sext(pz, 0, 24));
  const sh2_4 = TSL.vec3(sext(pw, 24, 24), sext(pw, 16, 24), sext(pw, 8, 24));
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
  const sh3_0 = TSL.vec3(sext(px, 26, 26), sext(px, 20, 26), sext(px, 14, 26));
  const sh3_1 = TSL.vec3(
    sext(px, 8, 26),
    sext(px, 2, 26),
    sextStraddle(px, 4, py, 28, 26)
  );
  const sh3_2 = TSL.vec3(sext(py, 22, 26), sext(py, 16, 26), sext(py, 10, 26));
  const sh3_3 = TSL.vec3(
    sext(py, 4, 26),
    sextStraddle(py, 2, pz, 30, 26),
    sext(pz, 24, 26)
  );
  const sh3_4 = TSL.vec3(sext(pz, 18, 26), sext(pz, 12, 26), sext(pz, 6, 26));
  const sh3_5 = TSL.vec3(sext(pz, 0, 26), sext(pw, 26, 26), sext(pw, 20, 26));
  const sh3_6 = TSL.vec3(sext(pw, 14, 26), sext(pw, 8, 26), sext(pw, 2, 26));
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
  let rgb = TSL.vec3(0);
  if (sh1Texture) {
    const t1 = TSL.textureLoad(sh1Texture, coord.xy).depth(coord.z);
    rgb = rgb.add(evaluatePackedSH1Tsl(t1, viewDir, shMax.x));
    if (sh2Texture) {
      const t2 = TSL.textureLoad(sh2Texture, coord.xy).depth(coord.z);
      rgb = rgb.add(evaluatePackedSH2Tsl(t2, viewDir, shMax.y));
      if (sh3Texture) {
        const t3 = TSL.textureLoad(sh3Texture, coord.xy).depth(coord.z);
        rgb = rgb.add(evaluatePackedSH3Tsl(t3, viewDir, shMax.z));
      }
    }
  }
  return rgb;
}
const LN_SCALE_MIN = -12;
const LN_SCALE_MAX = 9;
class SplatNodeMaterial extends webgpu.MeshBasicNodeMaterial {
  constructor(options) {
    super();
    this.renderSize = TSL.uniform(new webgpu.Vector2(1, 1));
    this.renderToViewQuat = TSL.uniform(new webgpu.Vector4(0, 0, 0, 1));
    this.renderToViewPos = TSL.uniform(new webgpu.Vector3());
    this.viewOrigin = TSL.uniform(new webgpu.Vector3());
    this.maxStdDev = TSL.uniform(1);
    this.minPixelRadius = TSL.uniform(0);
    this.maxPixelRadius = TSL.uniform(512);
    this.minAlpha = TSL.uniform(0.5 * (1 / 255));
    this.preBlurAmount = TSL.uniform(0);
    this.blurAmount = TSL.uniform(0.3);
    this.falloff = TSL.uniform(1);
    this.clipXY = TSL.uniform(1.4);
    this.focalAdjustment = TSL.uniform(1);
    this.rgbMinMaxLnScaleMinMax = TSL.uniform(
      new webgpu.Vector4(0, 1, LN_SCALE_MIN, LN_SCALE_MAX)
    );
    this.shMax = TSL.uniform(new webgpu.Vector3(1, 1, 1));
    const {
      packedTexture,
      orderNode,
      sh1Texture,
      sh2Texture,
      sh3Texture,
      lodOpacity = false,
      paged = false,
      lodInflate = false,
      parityQuantize = true
    } = options;
    stripWebGLInternalFormat(packedTexture);
    for (const tex of [sh1Texture, sh2Texture, sh3Texture]) {
      if (tex) stripWebGLInternalFormat(tex);
    }
    const vRgba = TSL.varyingProperty("vec4", "vSplatRgba");
    const vSplatUv = TSL.varyingProperty("vec2", "vSplatUv");
    const vAdjustedStdDev = TSL.varyingProperty("float", "vSplatAdjStdDev");
    const uMaxStdDev = this.maxStdDev;
    const uMinAlpha = this.minAlpha;
    const uFalloff = this.falloff;
    this.vertexNode = TSL.Fn(() => {
      const rejectPos = TSL.vec4(0, 0, 2, 1);
      const rejected = TSL.bool(false).toVar();
      const splatIndex = orderNode.element(TSL.instanceIndex);
      const texCoord = paged ? pagedSplatTexCoordTsl(TSL.int(splatIndex)) : splatTexCoordTsl(TSL.int(splatIndex));
      const packedData = TSL.textureLoad(packedTexture, texCoord.xy).depth(
        texCoord.z
      );
      const unpacked = unpackSplatEncodingTsl(
        packedData,
        this.rgbMinMaxLnScaleMinMax
      );
      const center = unpacked.center;
      const quaternion = unpacked.quaternion;
      const scales = TSL.vec3(unpacked.scales).toVar();
      const rgba = TSL.vec4(unpacked.rgba).toVar();
      if (lodOpacity) {
        rgba.a.assign(rgba.a.mul(2));
      }
      if (sh1Texture) {
        const viewDir = TSL.normalize(center.sub(this.viewOrigin));
        const shRgb = evaluatePackedShTsl({
          coord: texCoord,
          viewDir,
          shMax: this.shMax,
          sh1Texture,
          sh2Texture,
          sh3Texture
        });
        rgba.assign(TSL.vec4(rgba.rgb.add(shRgb), rgba.a));
      }
      if (parityQuantize) {
        const rgbQ = TSL.round(TSL.clamp(rgba.rgb.mul(255), 0, 255)).div(255);
        const aQ = TSL.round(TSL.clamp(rgba.a.mul(0.5).mul(255), 0, 255)).div(255).mul(2);
        rgba.assign(TSL.vec4(rgbQ, aQ));
        const lnScaleScale = TSL.float(254 / (LN_SCALE_MAX - LN_SCALE_MIN));
        const requantScale = (s) => TSL.select(
          s.equal(0),
          TSL.float(0),
          TSL.exp(
            TSL.round(
              TSL.clamp(
                s.log().sub(LN_SCALE_MIN).mul(lnScaleScale),
                0,
                254
              )
            ).div(lnScaleScale).add(LN_SCALE_MIN)
          )
        );
        scales.assign(
          TSL.vec3(
            requantScale(scales.x),
            requantScale(scales.y),
            requantScale(scales.z)
          )
        );
      }
      const zeroScales = scales.equal(TSL.vec3(0));
      rejected.assign(rejected.or(zeroScales.all()));
      rejected.assign(
        rejected.or(rgba.a.equal(0)).or(rgba.a.lessThan(uMinAlpha))
      );
      const adjustedStdDev = TSL.float(uMaxStdDev).toVar();
      TSL.If(rgba.a.greaterThan(1), () => {
        rgba.a.assign(TSL.min(rgba.a.mul(4).sub(3), 5));
        if (lodInflate) {
          const opacity = TSL.exp(
            rgba.a.mul(rgba.a).sub(1).div(2.718281828459045)
          );
          const rescale = TSL.pow(opacity, 1 / 3);
          scales.assign(scales.mul(rescale));
          rgba.a.assign(1);
        }
        adjustedStdDev.assign(uMaxStdDev.add(rgba.a.sub(1).mul(0.7)));
      });
      const viewCenter = quatVecTsl(this.renderToViewQuat, center).add(
        this.renderToViewPos
      );
      rejected.assign(rejected.or(viewCenter.z.greaterThanEqual(0)));
      const clipCenter = TSL.cameraProjectionMatrix.mul(TSL.vec4(viewCenter, 1));
      rejected.assign(
        rejected.or(clipCenter.z.abs().greaterThanEqual(clipCenter.w))
      );
      const clip = TSL.float(this.clipXY).mul(clipCenter.w);
      rejected.assign(
        rejected.or(clipCenter.x.abs().greaterThan(clip)).or(clipCenter.y.abs().greaterThan(clip))
      );
      vRgba.assign(rgba);
      vSplatUv.assign(TSL.positionGeometry.xy.mul(adjustedStdDev));
      const viewQuaternion = quatQuatTsl(this.renderToViewQuat, quaternion);
      const [rsC0, rsC1, rsC2] = scaleQuaternionToMatrixColumnsTsl(
        scales,
        viewQuaternion
      );
      const RS = TSL.mat3(rsC0, rsC1, rsC2);
      const cov3D = RS.mul(TSL.transpose(RS));
      const scaledRenderSize = TSL.vec2(this.renderSize).mul(this.focalAdjustment);
      const focal = scaledRenderSize.mul(0.5).mul(
        TSL.vec2(
          TSL.cameraProjectionMatrix.element(TSL.int(0)).element(TSL.int(0)),
          TSL.cameraProjectionMatrix.element(TSL.int(1)).element(TSL.int(1))
        )
      );
      const isOrthographic = TSL.cameraProjectionMatrix.element(TSL.int(2)).element(TSL.int(3)).notEqual(-1);
      const invZ = TSL.float(1).div(viewCenter.z);
      const J1 = focal.mul(invZ);
      const J2 = J1.mul(viewCenter.xy).negate().mul(invZ);
      const jC0 = TSL.select(
        isOrthographic,
        TSL.vec3(focal.x, 0, 0),
        TSL.vec3(J1.x, 0, J2.x)
      );
      const jC1 = TSL.select(
        isOrthographic,
        TSL.vec3(0, focal.y, 0),
        TSL.vec3(0, J1.y, J2.y)
      );
      const J = TSL.mat3(jC0, jC1, TSL.vec3(0, 0, 0));
      const cov2D = TSL.transpose(J).mul(cov3D).mul(J);
      const a = TSL.float(cov2D.element(TSL.int(0)).element(TSL.int(0))).toVar();
      const d = TSL.float(cov2D.element(TSL.int(1)).element(TSL.int(1))).toVar();
      const b = cov2D.element(TSL.int(0)).element(TSL.int(1));
      a.addAssign(this.preBlurAmount);
      d.addAssign(this.preBlurAmount);
      const fullBlurAmount = this.blurAmount;
      const detOrig = a.mul(d).sub(b.mul(b));
      a.addAssign(fullBlurAmount);
      d.addAssign(fullBlurAmount);
      const det = a.mul(d).sub(b.mul(b));
      const blurAdjust = TSL.sqrt(TSL.max(0, detOrig.div(det)));
      rgba.a.assign(rgba.a.mul(blurAdjust));
      rejected.assign(rejected.or(rgba.a.lessThan(uMinAlpha)));
      vRgba.a.assign(rgba.a);
      vAdjustedStdDev.assign(adjustedStdDev);
      const eigenAvg = a.add(d).mul(0.5);
      const eigenDelta = TSL.sqrt(TSL.max(0, eigenAvg.mul(eigenAvg).sub(det)));
      const eigen1 = eigenAvg.add(eigenDelta);
      const eigen2 = eigenAvg.sub(eigenDelta);
      const eigenVec1 = TSL.select(
        b.abs().greaterThan(1e-3),
        TSL.normalize(TSL.vec2(b, eigen1.sub(a))),
        TSL.select(
          a.greaterThanEqual(d),
          TSL.vec2(1, 0),
          TSL.vec2(0, 1)
        )
      );
      const eigenVec2 = TSL.vec2(eigenVec1.y, eigenVec1.x.negate());
      const scale1 = TSL.min(this.maxPixelRadius, adjustedStdDev.mul(TSL.sqrt(eigen1)));
      const scale2 = TSL.min(this.maxPixelRadius, adjustedStdDev.mul(TSL.sqrt(eigen2)));
      rejected.assign(
        rejected.or(
          scale1.lessThan(this.minPixelRadius).and(scale2.lessThan(this.minPixelRadius))
        )
      );
      const posXY = TSL.positionGeometry.xy;
      const pixelOffset = eigenVec1.mul(scale1).mul(posXY.x).add(eigenVec2.mul(scale2).mul(posXY.y));
      const ndcOffset = TSL.vec2(2).div(scaledRenderSize).mul(pixelOffset);
      const ndcCenter = clipCenter.xyz.div(clipCenter.w);
      const ndc = TSL.vec3(ndcCenter.xy.add(ndcOffset), ndcCenter.z);
      return TSL.select(
        rejected,
        rejectPos,
        TSL.vec4(ndc.xy.mul(clipCenter.w), clipCenter.z, clipCenter.w)
      );
    })();
    this.fragmentNode = TSL.Fn(() => {
      const rgba = TSL.vec4(vRgba).toVar();
      const z2 = TSL.dot(vSplatUv, vSplatUv);
      const adj = TSL.float(vAdjustedStdDev);
      TSL.If(z2.greaterThan(adj.mul(adj)), () => {
        TSL.Discard();
      });
      TSL.If(rgba.a.lessThanEqual(1), () => {
        rgba.a.assign(
          TSL.mix(rgba.a, rgba.a.mul(TSL.exp(z2.mul(-0.5))), uFalloff)
        );
      }).Else(() => {
        const aPow = TSL.exp(rgba.a.mul(rgba.a).sub(1).div(2.718281828459045));
        const alpha = TSL.float(1).sub(
          TSL.pow(TSL.float(1).sub(TSL.exp(z2.mul(-0.5))), aPow)
        );
        rgba.a.assign(TSL.mix(1, alpha, uFalloff));
      });
      TSL.If(rgba.a.lessThan(uMinAlpha), () => {
        TSL.Discard();
      });
      return TSL.vec4(rgba.rgb.mul(rgba.a), rgba.a);
    })();
    this.transparent = true;
    this.depthWrite = false;
    this.depthTest = true;
    this.side = webgpu.DoubleSide;
    this.blending = webgpu.CustomBlending;
    this.blendEquation = webgpu.AddEquation;
    this.blendSrc = webgpu.OneFactor;
    this.blendDst = webgpu.OneMinusSrcAlphaFactor;
    this.blendSrcAlpha = webgpu.OneFactor;
    this.blendDstAlpha = webgpu.OneMinusSrcAlphaFactor;
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
exports.SPLAT_TEX_LAYER_BITS = SPLAT_TEX_LAYER_BITS;
exports.SPLAT_TEX_MASK = SPLAT_TEX_MASK;
exports.SPLAT_TEX_WIDTH_BITS = SPLAT_TEX_WIDTH_BITS;
exports.SplatNodeMaterial = SplatNodeMaterial;
exports.decodeQuatOctXy88R8Tsl = decodeQuatOctXy88R8Tsl;
exports.evaluatePackedSH1Tsl = evaluatePackedSH1Tsl;
exports.evaluatePackedSH2Tsl = evaluatePackedSH2Tsl;
exports.evaluatePackedSH3Tsl = evaluatePackedSH3Tsl;
exports.evaluatePackedShTsl = evaluatePackedShTsl;
exports.pagedSplatTexCoordTsl = pagedSplatTexCoordTsl;
exports.quatQuatTsl = quatQuatTsl;
exports.quatVecTsl = quatVecTsl;
exports.referenceAlphaChain = referenceAlphaChain;
exports.scaleQuaternionToMatrixColumnsTsl = scaleQuaternionToMatrixColumnsTsl;
exports.splatTexCoordTsl = splatTexCoordTsl;
exports.stockNetAlpha = stockNetAlpha;
exports.stripWebGLInternalFormat = stripWebGLInternalFormat;
exports.unpackSplatEncodingTsl = unpackSplatEncodingTsl;
//# sourceMappingURL=spark-webgpu.cjs.js.map

"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const TSL = require("three/tsl");
const webgpu = require("three/webgpu");
const kcRegrowDebug = require("./kcRegrowDebug-C_gpgxNu.cjs");
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
const unpackHalf2x16$1 = TSL__namespace.unpackHalf2x16;
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
  const xy = unpackHalf2x16$1(word1);
  const zw = unpackHalf2x16$1(word2.bitAnd(TSL.uint(65535)));
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
    this.renderToViewScale = TSL.uniform(1);
    this.viewOrigin = TSL.uniform(new webgpu.Vector3());
    this.maxStdDev = TSL.uniform(1);
    this.minPixelRadius = TSL.uniform(0);
    this.maxPixelRadius = TSL.uniform(512);
    this.ssogFillV2 = TSL.uniform(0);
    this.ssogMinContribution = TSL.uniform(1);
    this.pickMode = TSL.uniform(0);
    this.pickNear = TSL.uniform(0);
    this.pickFar = TSL.uniform(1);
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
      cutIndicesTexture,
      sh1Texture,
      sh2Texture,
      sh3Texture,
      lodOpacity = false,
      paged = false,
      lodInflate = false,
      parityQuantize = true
    } = options;
    stripWebGLInternalFormat(packedTexture);
    if (cutIndicesTexture) stripWebGLInternalFormat(cutIndicesTexture);
    for (const tex of [sh1Texture, sh2Texture, sh3Texture]) {
      if (tex) stripWebGLInternalFormat(tex);
    }
    const vRgba = TSL.varyingProperty("vec4", "vSplatRgba");
    const vSplatUv = TSL.varyingProperty("vec2", "vSplatUv");
    const vAdjustedStdDev = TSL.varyingProperty("float", "vSplatAdjStdDev");
    const vViewZ = TSL.varyingProperty("float", "vSplatViewZ");
    const uMaxStdDev = this.maxStdDev;
    const uMinAlpha = this.minAlpha;
    const uFalloff = this.falloff;
    this.vertexNode = TSL.Fn(() => {
      const rejectPos = TSL.vec4(0, 0, 2, 1);
      const rejected = TSL.bool(false).toVar();
      const slot = orderNode.element(TSL.instanceIndex);
      let splatIndex = slot;
      if (cutIndicesTexture) {
        const texel = TSL.textureLoad(
          cutIndicesTexture,
          TSL.ivec2(
            TSL.int(slot.shiftRight(TSL.uint(2)).bitAnd(TSL.uint(4095))),
            TSL.int(slot.shiftRight(TSL.uint(14)))
          )
        );
        const comp = slot.bitAnd(TSL.uint(3));
        splatIndex = TSL.select(
          comp.equal(TSL.uint(0)),
          texel.x,
          TSL.select(
            comp.equal(TSL.uint(1)),
            texel.y,
            TSL.select(comp.equal(TSL.uint(2)), texel.z, texel.w)
          )
        );
      }
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
      const scales = TSL.vec3(unpacked.scales.mul(this.renderToViewScale)).toVar();
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
      const viewCenter = quatVecTsl(
        this.renderToViewQuat,
        center.mul(this.renderToViewScale)
      ).add(this.renderToViewPos);
      rejected.assign(rejected.or(viewCenter.z.greaterThanEqual(0)));
      vViewZ.assign(viewCenter.z);
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
            rawAlpha.mul(6.283185307179586).mul(TSL.sqrt(TSL.max(det, 0))).lessThan(this.ssogMinContribution)
          )
        )
      );
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
      const r1 = adjustedStdDev.mul(TSL.sqrt(eigen1));
      const r2 = adjustedStdDev.mul(TSL.sqrt(eigen2));
      const fillCap = TSL.min(
        1024,
        TSL.min(this.renderSize.x, this.renderSize.y)
      );
      const capScale = TSL.min(1, fillCap.div(TSL.max(r1, r2)));
      const zStar = TSL.sqrt(
        TSL.max(0, TSL.log(rgba.a.mul(255))).mul(2)
      );
      const quadScale = TSL.min(1, zStar.div(adjustedStdDev));
      const scale1 = TSL.select(
        fillOn,
        r1.mul(capScale).mul(quadScale),
        TSL.min(this.maxPixelRadius, r1)
      );
      const scale2 = TSL.select(
        fillOn,
        r2.mul(capScale).mul(quadScale),
        TSL.min(this.maxPixelRadius, r2)
      );
      TSL.If(fillOn, () => {
        vSplatUv.assign(
          TSL.positionGeometry.xy.mul(adjustedStdDev.mul(quadScale))
        );
      });
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
      const normDepth = TSL.float(vViewZ).negate().sub(this.pickNear).div(TSL.float(this.pickFar).sub(this.pickNear));
      return TSL.select(
        this.pickMode.greaterThan(0.5),
        TSL.vec4(normDepth.mul(rgba.a), 0, 0, rgba.a),
        TSL.vec4(rgba.rgb.mul(rgba.a), rgba.a)
      );
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
const countOneBits = TSL__namespace.countOneBits;
const TPW = 256;
const EPT = 8;
const EPW = TPW * EPT;
const BUCKETS = 16;
const SCAN_ITEMS = 512;
const pad = (n, m) => Math.ceil(n / m) * m;
function createRadixSort({
  keysNode,
  count,
  numBits = 16
}) {
  if (numBits % 4 !== 0) throw new Error("numBits must be a multiple of 4");
  const numPasses = numBits / 4;
  const wgCount = Math.max(1, Math.ceil(count / EPW));
  const blockSumCount = BUCKETS * wgCount;
  const blockSums = TSL.instancedArray(pad(blockSumCount, SCAN_ITEMS), "uint");
  const keysA = TSL.instancedArray(count, "uint");
  const keysB = TSL.instancedArray(count, "uint");
  const valsA = TSL.instancedArray(count, "uint");
  const valsB = TSL.instancedArray(count, "uint");
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
        blockSums: TSL.instancedArray(Math.max(1, pad(wgs, SCAN_ITEMS)), "uint")
      };
      levels.push(level);
      if (wgs <= 1) break;
      items = level.blockSums;
      levelCount = wgs;
    }
  }
  const makeHistogram = (srcKeys, bit) => {
    const hist = TSL.workgroupArray("uint", BUCKETS).setAtomic(true);
    return TSL.Fn(() => {
      const TID = TSL.invocationLocalIndex;
      const WGID = TSL.workgroupId.x;
      const WID = WGID.mul(TSL.uint(EPW));
      TSL.If(TID.lessThan(TSL.uint(BUCKETS)), () => {
        TSL.atomicStore(hist.element(TID), TSL.uint(0));
      });
      TSL.workgroupBarrier();
      for (let r = 0; r < EPT; r++) {
        const GID = WID.add(TSL.uint(r * TPW)).add(TID);
        TSL.If(GID.lessThan(TSL.uint(count)), () => {
          const digit = srcKeys.element(GID).shiftRight(TSL.uint(bit)).bitAnd(TSL.uint(15));
          TSL.atomicAdd(hist.element(digit), TSL.uint(1));
        });
      }
      TSL.workgroupBarrier();
      TSL.If(TID.lessThan(TSL.uint(BUCKETS)), () => {
        blockSums.element(TID.mul(TSL.uint(wgCount)).add(WGID)).assign(TSL.atomicLoad(hist.element(TID)));
      });
    })().compute([wgCount], [TPW]).setName(`radixHist_bit${bit}`);
  };
  const makeScan = (level, idx) => {
    const temp = TSL.workgroupArray("uint", SCAN_ITEMS * 2);
    const { items, count: n, blockSums: sumsOut } = level;
    return TSL.Fn(() => {
      const TID = TSL.invocationLocalIndex;
      const WGID = TSL.workgroupId.x;
      const GID = WGID.mul(TSL.uint(TPW)).add(TID);
      const ELM_TID = TID.mul(TSL.uint(2));
      const ELM_GID = GID.mul(TSL.uint(2));
      temp.element(ELM_TID).assign(
        TSL.select(
          ELM_GID.greaterThanEqual(TSL.uint(n)),
          TSL.uint(0),
          items.element(ELM_GID)
        )
      );
      temp.element(ELM_TID.add(TSL.uint(1))).assign(
        TSL.select(
          ELM_GID.add(TSL.uint(1)).greaterThanEqual(TSL.uint(n)),
          TSL.uint(0),
          items.element(ELM_GID.add(TSL.uint(1)))
        )
      );
      let offset = 1;
      for (let d = SCAN_ITEMS >> 1; d > 0; d >>= 1) {
        TSL.workgroupBarrier();
        const ai = TSL.uint(offset).mul(ELM_TID.add(TSL.uint(1))).sub(TSL.uint(1));
        const bi = TSL.uint(offset).mul(ELM_TID.add(TSL.uint(2))).sub(TSL.uint(1));
        TSL.If(TID.lessThan(TSL.uint(d)), () => {
          temp.element(bi).addAssign(temp.element(ai));
        });
        offset *= 2;
      }
      TSL.If(TID.equal(TSL.uint(0)), () => {
        sumsOut.element(WGID).assign(temp.element(TSL.uint(SCAN_ITEMS - 1)));
        temp.element(TSL.uint(SCAN_ITEMS - 1)).assign(TSL.uint(0));
      });
      for (let d = 1; d < SCAN_ITEMS; d *= 2) {
        offset >>= 1;
        TSL.workgroupBarrier();
        const ai = TSL.uint(offset).mul(ELM_TID.add(TSL.uint(1))).sub(TSL.uint(1));
        const bi = TSL.uint(offset).mul(ELM_TID.add(TSL.uint(2))).sub(TSL.uint(1));
        TSL.If(TID.lessThan(TSL.uint(d)), () => {
          const t = temp.element(ai).toVar();
          temp.element(ai).assign(temp.element(bi));
          temp.element(bi).addAssign(t);
        });
      }
      TSL.workgroupBarrier();
      TSL.If(ELM_GID.lessThan(TSL.uint(n)), () => {
        items.element(ELM_GID).assign(temp.element(ELM_TID));
      });
      TSL.If(ELM_GID.add(TSL.uint(1)).lessThan(TSL.uint(n)), () => {
        items.element(ELM_GID.add(TSL.uint(1))).assign(temp.element(ELM_TID.add(TSL.uint(1))));
      });
    })().compute([level.wgs], [TPW]).setName(`radixScan_L${idx}`);
  };
  const makeAddBlock = (level, idx) => {
    const { items, count: n, blockSums: sums } = level;
    return TSL.Fn(() => {
      const TID = TSL.invocationLocalIndex;
      const WGID = TSL.workgroupId.x;
      const GID = WGID.mul(TSL.uint(TPW)).add(TID);
      const ELM_ID = GID.mul(TSL.uint(2));
      TSL.If(ELM_ID.lessThan(TSL.uint(n)), () => {
        const bs = sums.element(WGID);
        items.element(ELM_ID).addAssign(bs);
        TSL.If(ELM_ID.add(TSL.uint(1)).lessThan(TSL.uint(n)), () => {
          items.element(ELM_ID.add(TSL.uint(1))).addAssign(bs);
        });
      });
    })().compute([level.wgs], [TPW]).setName(`radixScanAdd_L${idx}`);
  };
  const makeReorder = (inKeys, outKeys, inVals, outVals, bit, isFirst, isLast) => {
    const masks = TSL.workgroupArray("uint", 128).setAtomic(true);
    const offsets = TSL.workgroupArray("uint", BUCKETS);
    return TSL.Fn(() => {
      const TID = TSL.invocationLocalIndex;
      const WGID = TSL.workgroupId.x;
      const WID = WGID.mul(TSL.uint(EPW));
      const wordIdx = TID.shiftRight(TSL.uint(5)).toVar();
      const bitIdx = TID.bitAnd(TSL.uint(31)).toVar();
      TSL.If(TID.lessThan(TSL.uint(BUCKETS)), () => {
        offsets.element(TID).assign(TSL.uint(0));
      });
      TSL.If(TID.lessThan(TSL.uint(128)), () => {
        TSL.atomicStore(masks.element(TID), TSL.uint(0));
      });
      TSL.workgroupBarrier();
      for (let round = 0; round < EPT; round++) {
        const GID = WID.add(TSL.uint(round * TPW)).add(TID).toVar();
        const isValid = GID.lessThan(TSL.uint(count)).toVar();
        const k = TSL.select(isValid, inKeys.element(GID), TSL.uint(0)).toVar();
        const digit = TSL.select(
          isValid,
          k.shiftRight(TSL.uint(bit)).bitAnd(TSL.uint(15)),
          TSL.uint(16)
        ).toVar();
        const v = (isFirst ? GID : TSL.select(isValid, inVals.element(GID), TSL.uint(0))).toVar();
        TSL.If(isValid, () => {
          TSL.atomicOr(
            masks.element(digit.mul(TSL.uint(8)).add(wordIdx)),
            TSL.uint(1).shiftLeft(bitIdx)
          );
        });
        TSL.workgroupBarrier();
        TSL.If(isValid, () => {
          const base = digit.mul(TSL.uint(8)).toVar();
          const localPrefix = offsets.element(digit).toVar();
          for (let w = 0; w < 7; w++) {
            TSL.If(TSL.uint(w).lessThan(wordIdx), () => {
              localPrefix.addAssign(
                countOneBits(TSL.atomicLoad(masks.element(base.add(TSL.uint(w)))))
              );
            });
          }
          localPrefix.addAssign(
            countOneBits(
              TSL.atomicLoad(masks.element(base.add(wordIdx))).bitAnd(
                TSL.uint(1).shiftLeft(bitIdx).sub(TSL.uint(1))
              )
            )
          );
          const pid = digit.mul(TSL.uint(wgCount)).add(WGID);
          const pos = blockSums.element(pid).add(localPrefix).toVar();
          if (!isLast) outKeys.element(pos).assign(k);
          outVals.element(pos).assign(v);
        });
        if (round < EPT - 1) {
          TSL.workgroupBarrier();
          TSL.If(TID.lessThan(TSL.uint(BUCKETS)), () => {
            const cnt = TSL.uint(0).toVar();
            for (let w = 0; w < 8; w++) {
              const idx = TID.mul(TSL.uint(8)).add(TSL.uint(w));
              cnt.addAssign(countOneBits(TSL.atomicLoad(masks.element(idx))));
              TSL.atomicStore(masks.element(idx), TSL.uint(0));
            }
            offsets.element(TID).addAssign(cnt);
          });
          TSL.workgroupBarrier();
        }
      }
    })().compute([wgCount], [TPW]).setName(`radixReorder_bit${bit}`);
  };
  const scanNodes = levels.map((level, i) => makeScan(level, i));
  const addNodes = levels.map(
    (level, i) => level.wgs > 1 ? makeAddBlock(level, i) : null
  );
  const steps = [];
  let curKeys = keysNode;
  let curVals = valsA;
  let nxtKeys = keysA;
  let nxtVals = valsB;
  for (let pass = 0; pass < numPasses; pass++) {
    const bit = pass * 4;
    const isFirst = pass === 0;
    const isLast = pass === numPasses - 1;
    steps.push(makeHistogram(curKeys, bit));
    for (let i = 0; i < levels.length; i++) steps.push(scanNodes[i]);
    for (let i = levels.length - 1; i >= 0; i--) {
      const addNode = addNodes[i];
      if (addNode) steps.push(addNode);
    }
    steps.push(makeReorder(curKeys, nxtKeys, curVals, nxtVals, bit, isFirst, isLast));
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
    sortedValues,
    wgCount,
    dispatchesPerSort: steps.length
  };
}
const unpackHalf2x16 = TSL__namespace.unpackHalf2x16;
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
  if (minX > maxX) {
    minX = minY = minZ = 0;
    maxX = maxY = maxZ = 1;
  }
  const mx = 0.02 * (maxX - minX + 1e-6);
  const my = 0.02 * (maxY - minY + 1e-6);
  const mz = 0.02 * (maxZ - minZ + 1e-6);
  return {
    min: new webgpu.Vector3(minX - mx, minY - my, minZ - mz),
    max: new webgpu.Vector3(maxX + mx, maxY + my, maxZ + mz)
  };
}
class WebGpuSplatBackend {
  constructor() {
    this.sortRadial = true;
    this.freezeOrder = false;
    this.frames = 0;
    this.sorts = 0;
    this.lastSortFrame = -1;
    this.rebuilds = 0;
    this.state = null;
    this.sortedOnce = false;
    this.warnedMultiMesh = false;
    this.placeholderMaterial = new webgpu.MeshBasicNodeMaterial();
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
    if (!mesh || !src || src.numSplats === 0) {
      spark.activeSplats = 0;
      spark.geometry.instanceCount = 0;
      return false;
    }
    this.sortRadial = spark.sortRadial ?? true;
    let rebuilt = false;
    const st = this.state;
    if (!st || st.mesh !== mesh || st.kind !== src.kind || st.packedTexture !== src.packedTexture || st.cutTexture !== src.cutTexture || st.sh1 !== src.sh1 || st.sh2 !== src.sh2 || st.sh3 !== src.sh3 || st.capacity !== src.capacity) {
      this.buildState(spark, mesh, src);
      rebuilt = true;
      this.rebuilds++;
    }
    const state = this.state;
    const cutChanged = src.numSplats !== state.lastNumSplats || src.mappingVersion !== state.lastMappingVersion;
    let didSort = false;
    if (!this.freezeOrder && (viewChanged || rebuilt || cutChanged || !this.sortedOnce)) {
      if (rebuilt || cutChanged) {
        this.updateBounds(state, src);
      }
      state.uNumSplats.value = src.numSplats;
      this.updateKeygenUniforms(state, camera);
      spark.renderer.compute([state.keygen, ...state.radix.steps]);
      this.sortedOnce = true;
      this.sorts++;
      this.lastSortFrame = this.frames;
      didSort = true;
      state.lastNumSplats = src.numSplats;
      state.lastMappingVersion = src.mappingVersion;
    }
    spark.activeSplats = src.numSplats;
    spark.geometry.instanceCount = src.numSplats;
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
  // Called from SparkRenderer.onBeforeRender: per-frame material uniforms.
  applyPerFrame(spark, camera) {
    const state = this.state;
    if (!state) return;
    const mat = state.material;
    mat.renderSize.value.copy(spark.renderSize);
    mat.maxStdDev.value = spark.maxStdDev;
    mat.minPixelRadius.value = spark.minPixelRadius;
    mat.maxPixelRadius.value = spark.maxPixelRadius;
    mat.ssogFillV2.value = spark.ssogFillV2 ? 1 : 0;
    mat.ssogMinContribution.value = spark.ssogMinContribution;
    mat.pickMode.value = spark.pickMode ?? 0;
    mat.pickNear.value = spark.pickNear ?? 0;
    mat.pickFar.value = spark.pickFar ?? 1;
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
    const objectToView = new webgpu.Matrix4().copy(camera.matrixWorldInverse).multiply(state.mesh.matrixWorld);
    const pos = new webgpu.Vector3();
    const quat = new webgpu.Quaternion();
    const scl = new webgpu.Vector3();
    objectToView.decompose(pos, quat, scl);
    mat.renderToViewQuat.value.set(quat.x, quat.y, quat.z, quat.w);
    mat.renderToViewPos.value.copy(pos);
    mat.renderToViewScale.value = scl.x;
    const worldToObject = new webgpu.Matrix4().copy(state.mesh.matrixWorld).invert();
    const camWorld = camera.getWorldPosition(new webgpu.Vector3());
    mat.viewOrigin.value.copy(camWorld.applyMatrix4(worldToObject));
  }
  // Debug/test access (harness reads the permutation + material).
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
      keysNode: s.keysNode
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
  buildState(spark, mesh, src) {
    const { capacity, cutTexture, packedTexture, pagedTiling } = src;
    stripWebGLInternalFormat(packedTexture);
    if (cutTexture) stripWebGLInternalFormat(cutTexture);
    const keysNode = TSL.instancedArray(Math.max(1, capacity), "uint");
    const radix = createRadixSort({
      keysNode,
      count: Math.max(1, capacity),
      numBits: 16
    });
    const uNumSplats = TSL.uniform(0);
    const uMeshToWorld = TSL.uniform(new webgpu.Matrix4());
    const uCameraPos = TSL.uniform(new webgpu.Vector3());
    const uCameraDir = TSL.uniform(new webgpu.Vector3(0, 0, -1));
    const uDistRange = TSL.uniform(new webgpu.Vector3(0, 1, 0));
    const sortRadial = this.sortRadial;
    const keygen = TSL.Fn(() => {
      const i = TSL.instanceIndex;
      TSL.If(i.greaterThanEqual(TSL.uint(Math.max(1, capacity))), () => {
        TSL.Return();
      });
      TSL.If(TSL.float(i).greaterThanEqual(uNumSplats), () => {
        keysNode.element(i).assign(TSL.uint(65535));
        TSL.Return();
      });
      let splatIndex = i;
      if (cutTexture) {
        const texel = TSL.textureLoad(
          cutTexture,
          TSL.ivec2(
            TSL.int(i.shiftRight(TSL.uint(2)).bitAnd(TSL.uint(4095))),
            TSL.int(i.shiftRight(TSL.uint(14)))
          )
        );
        const comp = i.bitAnd(TSL.uint(3));
        splatIndex = TSL.select(
          comp.equal(TSL.uint(0)),
          texel.x,
          TSL.select(
            comp.equal(TSL.uint(1)),
            texel.y,
            TSL.select(comp.equal(TSL.uint(2)), texel.z, texel.w)
          )
        );
      }
      const texCoord = pagedTiling ? pagedSplatTexCoordTsl(TSL.int(splatIndex)) : splatTexCoordTsl(TSL.int(splatIndex));
      const t = TSL.textureLoad(packedTexture, texCoord.xy).depth(texCoord.z);
      const xy = unpackHalf2x16(t.y);
      const zw = unpackHalf2x16(t.z.bitAnd(TSL.uint(65535)));
      const world = uMeshToWorld.mul(TSL.vec4(TSL.vec3(xy.x, xy.y, zw.x), 1)).xyz.toVar();
      const metric = sortRadial ? world.sub(uCameraPos).length() : world.sub(uCameraPos).dot(uCameraDir).add(100);
      const q = TSL.uint(
        TSL.float(1).sub(
          TSL.clamp(
            metric.sub(uDistRange.x).div(uDistRange.y.sub(uDistRange.x)),
            0,
            1
          )
        ).mul(65535)
      );
      keysNode.element(i).assign(q);
    })().compute([Math.ceil(Math.max(1, capacity) / 256)], [256]).setName("splatKeygen");
    const material = new SplatNodeMaterial({
      packedTexture,
      orderNode: radix.sortedValues,
      cutIndicesTexture: cutTexture ?? void 0,
      sh1Texture: src.sh1,
      sh2Texture: src.sh2,
      sh3Texture: src.sh3,
      lodOpacity: src.encoding.lodOpacity ?? false,
      paged: pagedTiling
    });
    if (this.state) {
      kcRegrowDebug.kcDisposeOldMaterial(spark.renderer, this.state.material);
    }
    kcRegrowDebug.kcRegrowLog("buildState", { capacity });
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
      boundsMin: new webgpu.Vector3(0, 0, 0),
      boundsMax: new webgpu.Vector3(1, 1, 1),
      lastNumSplats: -1,
      lastMappingVersion: -1
    };
    this.sortedOnce = false;
    spark.material = material;
  }
  // (Re)compute object-space bounds for the CURRENT cut/source. Static
  // sources scan the whole packedArray once; cut sources sample the cut
  // through the CPU mirrors (cut indices texture image.data → pool/lodSplats
  // mirror) at each re-cut (≤ ~65k samples, sub-ms).
  updateBounds(state, src) {
    var _a, _b, _c, _d, _e, _f, _g;
    const mesh = state.mesh;
    let bounds = null;
    if (src.kind === "static") {
      const arr = (_a = mesh.packedSplats) == null ? void 0 : _a.packedArray;
      if (arr) {
        let i = 0;
        bounds = scanBounds(arr, () => 4 * i++, src.numSplats);
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
      }
    }
    if (bounds) {
      state.boundsMin.copy(bounds.min);
      state.boundsMax.copy(bounds.max);
    }
  }
  updateKeygenUniforms(state, camera) {
    state.mesh.updateWorldMatrix(true, false);
    state.uMeshToWorld.value.copy(state.mesh.matrixWorld);
    const camPos = camera.getWorldPosition(new webgpu.Vector3());
    state.uCameraPos.value.copy(camPos);
    const camDir = camera.getWorldDirection(new webgpu.Vector3());
    state.uCameraDir.value.copy(camDir);
    const { boundsMin: mn, boundsMax: mx } = state;
    let minD = Number.POSITIVE_INFINITY;
    let maxD = Number.NEGATIVE_INFINITY;
    const corner = new webgpu.Vector3();
    for (let c = 0; c < 8; c++) {
      corner.set(
        c & 1 ? mx.x : mn.x,
        c & 2 ? mx.y : mn.y,
        c & 4 ? mx.z : mn.z
      );
      corner.applyMatrix4(state.mesh.matrixWorld);
      const d = this.sortRadial ? corner.distanceTo(camPos) : corner.sub(camPos).dot(camDir) + 100;
      if (d < minD) minD = d;
      if (d > maxD) maxD = d;
    }
    if (this.sortRadial) {
      const camObj = camPos.clone().applyMatrix4(new webgpu.Matrix4().copy(state.mesh.matrixWorld).invert());
      const closest = new webgpu.Vector3(
        Math.min(Math.max(camObj.x, mn.x), mx.x),
        Math.min(Math.max(camObj.y, mn.y), mx.y),
        Math.min(Math.max(camObj.z, mn.z), mx.z)
      ).applyMatrix4(state.mesh.matrixWorld);
      minD = Math.max(0, closest.distanceTo(camPos));
    }
    if (maxD <= minD) maxD = minD + 1;
    state.uDistRange.value.set(minD, maxD, 0);
  }
}
exports.SPLAT_TEX_LAYER_BITS = SPLAT_TEX_LAYER_BITS;
exports.SPLAT_TEX_MASK = SPLAT_TEX_MASK;
exports.SPLAT_TEX_WIDTH_BITS = SPLAT_TEX_WIDTH_BITS;
exports.SplatNodeMaterial = SplatNodeMaterial;
exports.WebGpuSplatBackend = WebGpuSplatBackend;
exports.createRadixSort = createRadixSort;
exports.decodeQuatOctXy88R8Tsl = decodeQuatOctXy88R8Tsl;
exports.evaluatePackedSH1Tsl = evaluatePackedSH1Tsl;
exports.evaluatePackedSH2Tsl = evaluatePackedSH2Tsl;
exports.evaluatePackedSH3Tsl = evaluatePackedSH3Tsl;
exports.evaluatePackedShTsl = evaluatePackedShTsl;
exports.pagedSplatTexCoordTsl = pagedSplatTexCoordTsl;
exports.quatQuatTsl = quatQuatTsl;
exports.quatVecTsl = quatVecTsl;
exports.referenceAlphaChain = referenceAlphaChain;
exports.roundEven = roundEven;
exports.scaleQuaternionToMatrixColumnsTsl = scaleQuaternionToMatrixColumnsTsl;
exports.splatTexCoordTsl = splatTexCoordTsl;
exports.stockNetAlpha = stockNetAlpha;
exports.stripWebGLInternalFormat = stripWebGLInternalFormat;
exports.unpackSplatEncodingTsl = unpackSplatEncodingTsl;
//# sourceMappingURL=spark-webgpu.cjs.js.map

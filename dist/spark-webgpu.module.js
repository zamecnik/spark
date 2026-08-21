import * as TSL from "three/tsl";
import { uint, float, vec2, max, select, normalize, vec3, vec4, ivec3, int, exp, textureLoad, uniform, varyingProperty, Fn, bool, instanceIndex, ivec2, round, clamp, If, min, pow, cameraProjectionMatrix, positionGeometry, mat3, transpose, sqrt, log, dot, Discard, mix, instancedArray, workgroupArray, workgroupId, invocationLocalIndex, workgroupBarrier, atomicStore, atomicAdd, atomicLoad, atomicOr, Return } from "three/tsl";
import { MeshBasicNodeMaterial, Vector2, Vector4, Vector3, DoubleSide, CustomBlending, AddEquation, OneFactor, OneMinusSrcAlphaFactor, Matrix4, Quaternion } from "three/webgpu";
import { d as kcDisposeOldMaterial, b as kcRegrowLog } from "./kcRegrowDebug-gV7aMG4z.js";
const unpackHalf2x16$1 = TSL.unpackHalf2x16;
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
  const xy = unpackHalf2x16$1(word1);
  const zw = unpackHalf2x16$1(word2.bitAnd(uint(65535)));
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
const LN_SCALE_MIN = -12;
const LN_SCALE_MAX = 9;
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
    this.minAlpha = uniform(0.5 * (1 / 255));
    this.preBlurAmount = uniform(0);
    this.blurAmount = uniform(0.3);
    this.falloff = uniform(1);
    this.clipXY = uniform(1.4);
    this.focalAdjustment = uniform(1);
    this.rgbMinMaxLnScaleMinMax = uniform(
      new Vector4(0, 1, LN_SCALE_MIN, LN_SCALE_MAX)
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
      parityQuantize = true
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
    this.vertexNode = Fn(() => {
      const rejectPos = vec4(0, 0, 2, 1);
      const rejected = bool(false).toVar();
      const slot = orderNode.element(instanceIndex);
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
      const scales = vec3(unpacked.scales.mul(this.renderToViewScale)).toVar();
      const rgba = vec4(unpacked.rgba).toVar();
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
        const lnScaleScale = float(254 / (LN_SCALE_MAX - LN_SCALE_MIN));
        const requantScale = (s) => select(
          s.equal(0),
          float(0),
          exp(
            round(
              clamp(
                s.log().sub(LN_SCALE_MIN).mul(lnScaleScale),
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
      const ndcOffset = vec2(2).div(scaledRenderSize).mul(pixelOffset);
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
      const WID = WGID.mul(uint(EPW));
      If(TID.lessThan(uint(BUCKETS)), () => {
        atomicStore(hist.element(TID), uint(0));
      });
      workgroupBarrier();
      for (let r = 0; r < EPT; r++) {
        const GID = WID.add(uint(r * TPW)).add(TID);
        If(GID.lessThan(uint(count)), () => {
          const digit = srcKeys.element(GID).shiftRight(uint(bit)).bitAnd(uint(15));
          atomicAdd(hist.element(digit), uint(1));
        });
      }
      workgroupBarrier();
      If(TID.lessThan(uint(BUCKETS)), () => {
        blockSums.element(TID.mul(uint(wgCount)).add(WGID)).assign(atomicLoad(hist.element(TID)));
      });
    })().compute([wgCount], [TPW]).setName(`radixHist_bit${bit}`);
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
    const masks = workgroupArray("uint", 128).setAtomic(true);
    const offsets = workgroupArray("uint", BUCKETS);
    return Fn(() => {
      const TID = invocationLocalIndex;
      const WGID = workgroupId.x;
      const WID = WGID.mul(uint(EPW));
      const wordIdx = TID.shiftRight(uint(5)).toVar();
      const bitIdx = TID.bitAnd(uint(31)).toVar();
      If(TID.lessThan(uint(BUCKETS)), () => {
        offsets.element(TID).assign(uint(0));
      });
      If(TID.lessThan(uint(128)), () => {
        atomicStore(masks.element(TID), uint(0));
      });
      workgroupBarrier();
      for (let round2 = 0; round2 < EPT; round2++) {
        const GID = WID.add(uint(round2 * TPW)).add(TID).toVar();
        const isValid = GID.lessThan(uint(count)).toVar();
        const k = select(isValid, inKeys.element(GID), uint(0)).toVar();
        const digit = select(
          isValid,
          k.shiftRight(uint(bit)).bitAnd(uint(15)),
          uint(16)
        ).toVar();
        const v = (isFirst ? GID : select(isValid, inVals.element(GID), uint(0))).toVar();
        If(isValid, () => {
          atomicOr(
            masks.element(digit.mul(uint(8)).add(wordIdx)),
            uint(1).shiftLeft(bitIdx)
          );
        });
        workgroupBarrier();
        If(isValid, () => {
          const base = digit.mul(uint(8)).toVar();
          const localPrefix = offsets.element(digit).toVar();
          for (let w = 0; w < 7; w++) {
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
          If(TID.lessThan(uint(BUCKETS)), () => {
            const cnt = uint(0).toVar();
            for (let w = 0; w < 8; w++) {
              const idx = TID.mul(uint(8)).add(uint(w));
              cnt.addAssign(countOneBits(atomicLoad(masks.element(idx))));
              atomicStore(masks.element(idx), uint(0));
            }
            offsets.element(TID).addAssign(cnt);
          });
          workgroupBarrier();
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
const unpackHalf2x16 = TSL.unpackHalf2x16;
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
    min: new Vector3(minX - mx, minY - my, minZ - mz),
    max: new Vector3(maxX + mx, maxY + my, maxZ + mz)
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
    const objectToView = new Matrix4().copy(camera.matrixWorldInverse).multiply(state.mesh.matrixWorld);
    const pos = new Vector3();
    const quat = new Quaternion();
    const scl = new Vector3();
    objectToView.decompose(pos, quat, scl);
    mat.renderToViewQuat.value.set(quat.x, quat.y, quat.z, quat.w);
    mat.renderToViewPos.value.copy(pos);
    mat.renderToViewScale.value = scl.x;
    const worldToObject = new Matrix4().copy(state.mesh.matrixWorld).invert();
    const camWorld = camera.getWorldPosition(new Vector3());
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
    const keysNode = instancedArray(Math.max(1, capacity), "uint");
    const radix = createRadixSort({
      keysNode,
      count: Math.max(1, capacity),
      numBits: 16
    });
    const uNumSplats = uniform(0);
    const uMeshToWorld = uniform(new Matrix4());
    const uCameraPos = uniform(new Vector3());
    const uCameraDir = uniform(new Vector3(0, 0, -1));
    const uDistRange = uniform(new Vector3(0, 1, 0));
    const sortRadial = this.sortRadial;
    const keygen = Fn(() => {
      const i = instanceIndex;
      If(i.greaterThanEqual(uint(Math.max(1, capacity))), () => {
        Return();
      });
      If(float(i).greaterThanEqual(uNumSplats), () => {
        keysNode.element(i).assign(uint(65535));
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
      const q = uint(
        float(1).sub(
          clamp(
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
      boundsMin: new Vector3(0, 0, 0),
      boundsMax: new Vector3(1, 1, 1),
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
    const camPos = camera.getWorldPosition(new Vector3());
    state.uCameraPos.value.copy(camPos);
    const camDir = camera.getWorldDirection(new Vector3());
    state.uCameraDir.value.copy(camDir);
    const { boundsMin: mn, boundsMax: mx } = state;
    let minD = Number.POSITIVE_INFINITY;
    let maxD = Number.NEGATIVE_INFINITY;
    const corner = new Vector3();
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
      const camObj = camPos.clone().applyMatrix4(new Matrix4().copy(state.mesh.matrixWorld).invert());
      const closest = new Vector3(
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
export {
  SPLAT_TEX_LAYER_BITS,
  SPLAT_TEX_MASK,
  SPLAT_TEX_WIDTH_BITS,
  SplatNodeMaterial,
  WebGpuSplatBackend,
  createRadixSort,
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

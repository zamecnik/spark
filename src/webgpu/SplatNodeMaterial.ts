// Kroscloud WebGPU fork (2026) — see FORK-CHANGES.md.
//
// SplatNodeMaterial: hand-written TSL node material for the WebGPU draw path,
// reproducing shaders/splatVertex.glsl + shaders/splatFragment.glsl in the
// vertex/fragment stages (fork plan §4.3 checklist). It reads the SAME packed
// textures as the WebGL2 path and draws the same instanced quad
// (SplatGeometry); draw order comes from an `order` storage buffer indexed by
// instanceIndex (identity in P1, GPU radix sort producer in P2).
//
// Ported verbatim from splatVertex.glsl (structure and comments track the
// GLSL line by line — do not re-derive):
//   - all three centre-only rejects, incl. abs(clipCenter.z) >= clipCenter.w
//   - clipXY guard band
//   - RS·RSᵀ covariance and the column-major Jacobian literal
//   - preBlur-before-detOrig / blur-after ordering; both uniforms live so the
//     __splatLod A/B debug toggle stays valid
//   - eigen decomposition with the abs(b) > 0.001 fallback
//   - maxPixelRadius clamp AFTER the adjustedStdDev multiply
//   - the a>1 merged-ancestor chain with the file u8 ×2 applied EXACTLY ONCE
//   - fragment: circle-in-UV discard, falloff, minAlpha discard, premultiplied
//     vec4(rgb·a, a)
//
// Deliberately NOT ported (all default-off/dead in upstream and unused by the
// Kroscloud apps; parity documented in FORK-CHANGES.md):
//   - enable2DGS zero-thickness branch, depth-of-field (focalDistance/
//     apertureAngle), the dead `if(false)` fragment falloff branch,
//     encodeLinear sRGB conversion (passthrough, parity row 27),
//     logarithmicDepthBuffer support, ext/cov splat inputs (WebGL2-only).
//
// Pass-A replication: upstream re-quantizes rgba and scales through the
// accumulator's DEFAULT-encoding u8 lattice every repack (packSplatEncoding
// with (0,1,LN_SCALE_MIN,LN_SCALE_MAX)). With `parityQuantize` (default true)
// this material replicates that lattice after SH addition, so the vertex
// input matches the stock draw's input except for the two plan-blessed
// deviations (per-frame SH camera; deleted fp16 center re-quantization) and
// the quaternion octahedral re-encode round-trip (≤1 lattice step, skipped).
//
// Blending is CustomBlending with explicit ONE/ONE_MINUS_SRC_ALPHA on BOTH
// channels: the r185 WebGPU pipeline IGNORES premultipliedAlpha on
// NormalBlending (P0/S3).

import {
  AddEquation,
  CustomBlending,
  DoubleSide,
  MeshBasicNodeMaterial,
  OneFactor,
  OneMinusSrcAlphaFactor,
  Vector2,
  Vector3,
  Vector4,
} from "three/webgpu";
import type * as THREE from "three";
import {
  Discard,
  Fn,
  If,
  bool,
  cameraProjectionMatrix,
  clamp,
  dot,
  exp,
  float,
  fract,
  instanceIndex,
  int,
  ivec2,
  log,
  mat3,
  max,
  min,
  mix,
  normalize,
  positionGeometry,
  pow,
  round,
  select,
  sqrt,
  textureLoad,
  transpose,
  uint,
  uniform,
  varyingProperty,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import {
  type TslNode,
  pagedSplatTexCoordTsl,
  quatQuatTsl,
  quatVecTsl,
  scaleQuaternionToMatrixColumnsTsl,
  splatTexCoordTsl,
  stripWebGLInternalFormat,
  unpackSplatEncodingTsl,
} from "./packedSplatsTsl";
import { evaluatePackedShTsl } from "./shTsl";

// Duplicated from src/defines.ts (must match): src/webgpu/ is deliberately
// self-contained so the webgpu entry produces no shared chunks with the main
// bundle (lazy-load requirement, fork plan §4.6 item 9).
const LN_SCALE_MIN = -12.0;
const LN_SCALE_MAX = 9.0;

export type SplatNodeMaterialOptions = {
  // RGBA32UI packed splat DataArrayTexture (PackedSplats.getTexture() for the
  // non-paged source; the pager pool texture for the paged path).
  packedTexture: THREE.DataArrayTexture;
  // u32 storage buffer node (e.g. instancedArray(n, "uint")); element i is
  // the splat index drawn by instance i. Identity in P1; P2's sort writes it.
  orderNode: TslNode;
  // LOD cut-index DataTexture (4096-wide RGBA32UI, 4 u32 indices per texel —
  // Spark's dynoIndices/lodInstances layout). When present, order[i] yields a
  // cut SLOT which is resolved through this texture to the actual splat
  // index ((page<<16)|slot for the paged pool). P3 path.
  cutIndicesTexture?: THREE.DataTexture;
  // SH coefficient textures; pass only the degrees to evaluate
  // (min(fileSh, maxSh) clamping = pass fewer textures).
  sh1Texture?: THREE.DataArrayTexture;
  sh2Texture?: THREE.DataArrayTexture;
  sh3Texture?: THREE.DataArrayTexture;
  // File uses the expanded LoD opacity encoding (splatEncoding.lodOpacity):
  // alpha = 2 × u8/255, applied EXACTLY ONCE here (the WebGL2 pipeline's
  // read-×2 / accumulator-halve / draw-×2 nets to the same single ×2).
  lodOpacity?: boolean;
  // Index tiling: false (default) = 2048-wide splatTexCoord (non-paged
  // source), true = 256-wide pagedSplatTexCoord (pager pool, P3).
  paged?: boolean;
  // Implement the lodInflate branch (upstream uniform, default false).
  lodInflate?: boolean;
  // Replicate the accumulator repack u8 lattice for rgba + scales (see
  // header). Default true.
  parityQuantize?: boolean;
  // DIAGNOSTIC ABLATION (?splatvsmin=1). Keeps every texel load, the unpack
  // and the phase-1 centre transform, but replaces the entire phase-2 body -
  // SH, the parity lattice, RS.RS^T, the Jacobian, the 2D covariance and the
  // eigen-decomposition - with a fixed-size screen-space quad.
  //
  // The point is to separate two explanations of the Adreno deficit that the
  // measured data cannot tell apart: our WebGPU path runs the whole
  // projection chain in the VERTEX stage, four times per splat (once per quad
  // corner), where PlayCanvas runs it once per splat in a compute pass and
  // draws 128 splats per instance from a tiny cache-reading shader. If the
  // vertex arithmetic (or the register pressure it creates) is the cost, this
  // ablation is a step change; if the cost is memory traffic or the draw
  // front-end, it barely moves - and the expensive rewrite would disappoint.
  //
  // Level 2 (?splatvsmin=2) goes one step further: it also drops the three
  // per-vertex memory reads (order -> cut index -> packed texel) and the
  // unpack, synthesising a centre arithmetically from `instanceIndex`. Level 1
  // measured 125 -> 87 ms on the Pixel, i.e. the whole projection chain is
  // only 30 % of the frame, so the remaining 87 ms is reads + unpack + the
  // 1M-instance draw front-end. Level 2 splits those: if it stays near 87 ms
  // with no reads and no maths at all, the cost is the front-end, and the
  // thing to copy is PlayCanvas's 128-splats-per-instance batching rather
  // than their compute projection.
  //
  // NOT pixel-correct. Diagnostic only. 0 = off, 1 = no projection, 2 = also
  // no memory reads.
  vsMinimal?: number;
  // [dbg-adreno] N splats per instance (?splatbatch=N). Requires the mesh to
  // carry a BatchedSplatGeometry(N); the shader reconstructs
  //   splat = instanceIndex * N + position.z
  // and rejects the tail overshoot of the last instance against the
  // batchNumSplats uniform. Round-2 ablation left a 70 ms remainder on the
  // Pixel with all arithmetic AND all reads removed - nothing in the frame
  // but the 1M-instance submission - while our WebGL2 path issues the same
  // 1M instances inside a 51 ms whole-job frame. PlayCanvas draws 128 splats
  // per instance; this is that shape. Default 1 = the stock draw, and the
  // emitted WGSL is byte-identical to today's in that case.
  batchSize?: number;

  // [proj] Projector cache (?splatproj=1): when set, the whole projection
  // chain has ALREADY run once per splat in a compute pass (the backend's
  // splatProjector kernel, a verbatim port of the vertex body below), and
  // this material's vertex stage becomes a READER - order lookup, four vec4
  // cache loads, quad expand. Motivation is measured, not speculative: on the
  // Pixel 4 (Adreno) the vertex stage re-ran the chain 4x per splat and the
  // L1+batch ablation (row 58) put the once-per-splat version at 34 ms
  // against the batched baseline's 68. Layout (indexed by CUT SLOT, the same
  // domain the keygen iterates):
  //   c0 = clip-space center (xyzw)
  //   c1 = (axis1.xy, axis2.xy)  pixel-space eigen axes, scaleN * eigenVecN
  //   c2 = rgba, final (post SH / parity / blur-adjust)
  //   c3 = (uvStd, adjustedStdDev, viewZ, live 0|1)
  projCache?: { c0: TslNode; c1: TslNode; c2: TslNode; c3: TslNode };
};

export class SplatNodeMaterial extends MeshBasicNodeMaterial {
  // Uniforms mirror SparkRenderer.makeUniforms() names and defaults.
  renderSize = uniform(new Vector2(1, 1));
  renderToViewQuat = uniform(new Vector4(0, 0, 0, 1));
  renderToViewPos = uniform(new Vector3());
  // Uniform scale factor of the object→view transform. Stock bakes the mesh
  // transform (uniform scale only — SplatTransformer) into Pass A at read
  // time; without Pass A it is applied here: center·s then rotate+translate,
  // splat scales ·s BEFORE the repack lattice (matching stock's
  // transform-then-quantize order).
  renderToViewScale = uniform(1.0);
  // Camera position in splat object space, for SH viewDir (the stock
  // generator's viewOrigin = viewToObject.translate).
  viewOrigin = uniform(new Vector3());
  maxStdDev = uniform(1.0);
  minPixelRadius = uniform(0.0);
  maxPixelRadius = uniform(512.0);
  // Kroscloud [ssog-5]: SSOG_FILL_V2 fill layer (plan §2.6, ssog meshes
  // only). Float 0/1 gate (WGSL disallows bool in the uniform address
  // space); expression-identical twin of the splatVertex.glsl block (the
  // R13 cross-path SSIM gate enforces the twin discipline).
  ssogFillV2 = uniform(0.0);
  ssogMinContribution = uniform(1.0);
  // Kroscloud [ssog-9]: expected-depth pick mode (float 0/1 gate + the
  // dedicated depth-normalization window); expression-identical twin of the
  // splatFragment.glsl pick branch — see the comment there.
  pickMode = uniform(0.0);
  pickNear = uniform(0.0);
  pickFar = uniform(1.0);
  // Kroscloud [T1-3]: vertex early-exit A/B gate. 1 (default) = the cheap
  // centre-only rejects guard the expensive phase-2 body; 0 = the guard is
  // uniformly true, which restores the pre-T1-3 straight-line body exactly.
  // Diagnostic only - the two states are specified to be pixel-identical,
  // and the SSIM harness is what proves it.
  earlyExit = uniform(1.0);
  // ?splatvsminpx=N - quad half-extent in pixels for the vsMinimal ablation.
  // Tunable because fragment cost is the confound: sweep it (2/4/8) and a
  // result that moves WITH the radius is fill, while a result that is high at
  // every radius is the vertex body.
  vsMinPixelRadius = uniform(4.0);
  // ?splatvsminext=N - half-extent of the cube the level-2 ablation scatters
  // its synthesised centres through, in splat object space. Only needs to be
  // roughly the scene's size so a comparable number of quads survive the
  // frustum rejects and reach the rasteriser.
  vsMinExtent = uniform(4.0);
  // [dbg-adreno] live splat count for the batched draw's tail reject (float;
  // exact for counts < 2^24, the keygen uses the same convention). Only read
  // when batchSize > 1; the backend refreshes it every update().
  batchNumSplats = uniform(0.0);
  minAlpha = uniform(0.5 * (1.0 / 255.0));
  preBlurAmount = uniform(0.0);
  blurAmount = uniform(0.3);
  falloff = uniform(1.0);
  clipXY = uniform(1.4);
  focalAdjustment = uniform(1.0);
  // (rgbMin, rgbMax, lnScaleMin, lnScaleMax) of the FILE encoding.
  rgbMinMaxLnScaleMinMax = uniform(
    new Vector4(0, 1, LN_SCALE_MIN, LN_SCALE_MAX),
  );
  shMax = uniform(new Vector3(1, 1, 1));

  constructor(options: SplatNodeMaterialOptions) {
    super();

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
      projCache = undefined,
    } = options;

    stripWebGLInternalFormat(packedTexture);
    if (cutIndicesTexture) stripWebGLInternalFormat(cutIndicesTexture);
    for (const tex of [sh1Texture, sh2Texture, sh3Texture]) {
      if (tex) stripWebGLInternalFormat(tex);
    }

    // splatVertex.glsl varyings (vSplatIndex is omitted: it only feeds the
    // dead `if(false)` falloff branch, which is not ported).
    const vRgba = varyingProperty("vec4", "vSplatRgba");
    const vSplatUv = varyingProperty("vec2", "vSplatUv");
    const vAdjustedStdDev = varyingProperty("float", "vSplatAdjStdDev");
    // [ssog-9] view-space splat-center z for the pick branch (GLSL vViewZ)
    const vViewZ = varyingProperty("float", "vSplatViewZ");

    const uMaxStdDev = this.maxStdDev;
    const uMinAlpha = this.minAlpha;
    const uFalloff = this.falloff;

    // The GLSL uses early `return` (gl_Position pre-set outside the
    // frustum); r185 TSL has no valued Return, so the port keeps an
    // accumulated `rejected` flag and a final select. [T1-3] splits the body
    // in two: PHASE 1 runs the three CENTRE-ONLY rejects (behind-camera,
    // near/far, clipXY guard band) against nothing but the unpacked centre;
    // PHASE 2 - SH, the parity lattice, the covariance/Jacobian/2D-cov/eigen
    // chain and the fill gates - runs inside `If(rejected.not(), ...)`, so a
    // splat that cannot produce a pixel pays only the centre transform.
    //
    // Why this is output-IDENTICAL, not an approximation:
    //   - `rejected` is a monotone OR accumulator and nothing reads it
    //     mid-body, so hoisting three of its terms cannot change its final
    //     value, and the guarded terms can only re-assert an already-true
    //     flag. The order of the terms INSIDE phase 2 is untouched (the
    //     alpha rejects still run after parityQuantize, which is what makes
    //     them what they are).
    //   - the guarded block writes ONLY vars declared outside it. r185's
    //     WGSLNodeBuilder sets allowGlobalVariables = true (:327) and emits
    //     every `.toVar()` as a MODULE-scope `var<private>` in the vertex
    //     template (:2515-2532; NodeBuilder.getVarFromNode :2114), so a var
    //     assigned inside an If and read after it is legal WGSL and reads
    //     the zero value when the branch is skipped. Varyings likewise live
    //     in `var<private> varyings : VaryingsStruct`. NOTE the corollary:
    //     never let a value be FIRST generated inside the block and read at
    //     top level unless it is such a var - three only re-emits hoisted
    //     flow code into another BLOCK (NodeBuilder.addFlowCodeHierarchy),
    //     never back out to the top level.
    //   - centre-rejected lanes emit rejectPos (z/w = 2), so their quad is
    //     clipped whole and never samples the varyings left unwritten.
    // Lanes rejected INSIDE the block may still compute inf/NaN downstream -
    // the final select masks them, and NaN comparisons (always false) can
    // never un-set `rejected`.
    //
    // `earlyExit` = 0 makes the guard uniformly true, restoring the exact
    // pre-T1-3 straight-line body for an in-session A/B with nothing else
    // varying (WebGpuSplatBackend.applyPerFrame / __kcSplatEarlyExit).
    if (projCache) {
      // [proj] reader vertex stage - see the projCache option comment. The
      // batch tail reject is replicated here because the projector indexes by
      // slot and knows nothing about the draw's instance packing.
      this.vertexNode = Fn(() => {
        const rejectPos = vec4(0.0, 0.0, 2.0, 1.0);
        const rejected = bool(false).toVar();
        let drawIdx: TslNode = instanceIndex;
        if (batchSize > 1) {
          const rawIdx = uint(instanceIndex)
            .mul(uint(batchSize))
            .add(uint(positionGeometry.z));
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
          this.focalAdjustment,
        );
        const pixelOffset = c1.xy
          .mul(positionGeometry.x)
          .add(c1.zw.mul(positionGeometry.y));
        const ndcOffset = vec2(2.0).div(scaledRenderSize).mul(pixelOffset);
        const ndcCenter = c0.xyz.div(c0.w);
        return select(
          rejected,
          rejectPos,
          vec4(ndcCenter.xy.add(ndcOffset).mul(c0.w), c0.z, c0.w),
        );
      })();
    } else
    this.vertexNode = Fn(() => {
      const rejectPos = vec4(0.0, 0.0, 2.0, 1.0); // outside the frustum
      const rejected = bool(false).toVar();

      // [dbg-adreno] batched draw: with N splats per instance the draw index
      // is instanceIndex*N + position.z (BatchedSplatGeometry carries the
      // quad's batch-local index in z). The last instance overshoots numSplats
      // by up to N-1 - those vertices are rejected against the batchNumSplats
      // uniform and their load index clamped to 0, because order[] slots past
      // numSplats hold sort padding that resolves to a REAL splat (page 0,
      // slot 0) and would draw it N-1 extra times. batchSize 1 leaves this
      // whole block out and the emitted WGSL is byte-identical to stock.
      let drawIdx: TslNode = instanceIndex;
      if (batchSize > 1) {
        const rawIdx = uint(instanceIndex)
          .mul(uint(batchSize))
          .add(uint(positionGeometry.z));
        const inRange = float(rawIdx).lessThan(this.batchNumSplats);
        rejected.assign(inRange.not());
        drawIdx = select(inRange, rawIdx, uint(0)).toVar("kcBatchIdx");
      }

      // LEVEL 2 ABLATION (?splatvsmin=2): no memory reads at all. The centre
      // is a cheap hash of instanceIndex scattered through a cube, so the
      // draw submits exactly the same instance and vertex count through the
      // front-end while touching no ordering buffer, no cut-index texture and
      // no packed texture. Everything downstream is the level-1 fixed quad.
      if (vsMinimal >= 2) {
        const fi = float(drawIdx);
        const centerSynth = vec3(
          fract(fi.mul(0.1031)),
          fract(fi.mul(0.1030)),
          fract(fi.mul(0.0973)),
        )
          .sub(0.5)
          .mul(this.vsMinExtent);

        const viewCenterSynth = quatVecTsl(
          this.renderToViewQuat,
          centerSynth.mul(this.renderToViewScale),
        ).add(this.renderToViewPos);
        rejected.assign(rejected.or(viewCenterSynth.z.greaterThanEqual(0.0)));
        vViewZ.assign(viewCenterSynth.z);

        const clipCenterSynth = cameraProjectionMatrix.mul(
          vec4(viewCenterSynth, 1.0),
        );
        rejected.assign(
          rejected.or(
            clipCenterSynth.z.abs().greaterThanEqual(clipCenterSynth.w),
          ),
        );
        const clipSynth = float(this.clipXY).mul(clipCenterSynth.w);
        rejected.assign(
          rejected
            .or(clipCenterSynth.x.abs().greaterThan(clipSynth))
            .or(clipCenterSynth.y.abs().greaterThan(clipSynth)),
        );

        const ndcOffsetSynth = vec2(0.0, 0.0).toVar();
        If(rejected.not(), () => {
          const adjS = float(uMaxStdDev);
          vRgba.assign(vec4(0.5, 0.5, 0.5, 0.5));
          vSplatUv.assign(positionGeometry.xy.mul(adjS));
          vAdjustedStdDev.assign(adjS);
          const rsS = vec2(this.renderSize).mul(this.focalAdjustment);
          ndcOffsetSynth.assign(
            vec2(2.0)
              .div(rsS)
              .mul(positionGeometry.xy.mul(this.vsMinPixelRadius)),
          );
        });

        const ndcCenterSynth = clipCenterSynth.xyz.div(clipCenterSynth.w);
        return select(
          rejected,
          rejectPos,
          vec4(
            ndcCenterSynth.xy.add(ndcOffsetSynth).mul(clipCenterSynth.w),
            clipCenterSynth.z,
            clipCenterSynth.w,
          ),
        );
      }

      // order[instanceIndex] → slot; with a cut, slot resolves through the
      // cut-index texture (verbatim readIndex: ivec2((i>>2)&4095, i>>14),
      // component [i&3] via select-cascade — P0/S2 pattern)
      const slot = orderNode.element(drawIdx);
      let splatIndex: TslNode = slot;
      if (cutIndicesTexture) {
        const texel = textureLoad(
          cutIndicesTexture,
          ivec2(
            int(slot.shiftRight(uint(2)).bitAnd(uint(4095))),
            int(slot.shiftRight(uint(14))),
          ),
        );
        const comp = slot.bitAnd(uint(3));
        splatIndex = select(
          comp.equal(uint(0)),
          texel.x,
          select(
            comp.equal(uint(1)),
            texel.y,
            select(comp.equal(uint(2)), texel.z, texel.w),
          ),
        );
      }

      const texCoord = paged
        ? pagedSplatTexCoordTsl(int(splatIndex))
        : splatTexCoordTsl(int(splatIndex));
      const packedData = textureLoad(packedTexture, texCoord.xy).depth(
        texCoord.z,
      );

      const unpacked = unpackSplatEncodingTsl(
        packedData,
        this.rgbMinMaxLnScaleMinMax,
      );
      const center = unpacked.center;
      const quaternion = unpacked.quaternion;

      // -- PHASE 1 [T1-3]: centre-only rejects -------------------------------
      // Hoisted VERBATIM from their old position after the SH / parity /
      // covariance work; every input here is the unpacked centre plus
      // camera state, so none of it depends on what phase 2 computes.

      // Compute the view space center of the splat
      const viewCenter = quatVecTsl(
        this.renderToViewQuat,
        center.mul(this.renderToViewScale),
      ).add(this.renderToViewPos);

      // Discard splats behind the camera
      rejected.assign(rejected.or(viewCenter.z.greaterThanEqual(0.0)));
      vViewZ.assign(viewCenter.z);

      // Compute the clip space center of the splat
      const clipCenter = cameraProjectionMatrix.mul(vec4(viewCenter, 1.0));

      // Discard splats outside near/far planes
      rejected.assign(
        rejected.or(clipCenter.z.abs().greaterThanEqual(clipCenter.w)),
      );

      // Discard splats more than clipXY times outside the XY frustum
      const clip = float(this.clipXY).mul(clipCenter.w);
      rejected.assign(
        rejected
          .or(clipCenter.x.abs().greaterThan(clip))
          .or(clipCenter.y.abs().greaterThan(clip)),
      );

      // -- PHASE 2 [T1-3]: work only a drawable splat needs ------------------
      // Declared out here so the emitted WGSL puts them at module scope and
      // the tail below can read them (see the note in the header).
      const scales = vec3(0.0, 0.0, 0.0).toVar();
      const rgba = vec4(0.0, 0.0, 0.0, 0.0).toVar();
      const ndcOffset = vec2(0.0, 0.0).toVar();

      If(rejected.not().or(this.earlyExit.lessThan(0.5)), () => {
        if (vsMinimal >= 1) {
          // ABLATION (?splatvsmin=1): fixed-size quad, no projection maths.
          // `keepAlive` folds the otherwise-unused unpacked values into alpha
          // with zero weight, so the texel loads and the unpack survive
          // dead-code elimination - this ablation must remove the ARITHMETIC,
          // not the memory traffic it would otherwise take with it.
          const keepAlive = unpacked.scales.x
            .add(unpacked.quaternion.x)
            .mul(0.0);
          rgba.assign(vec4(unpacked.rgba));
          if (lodOpacity) {
            rgba.a.assign(rgba.a.mul(2.0));
          }
          rgba.a.assign(rgba.a.add(keepAlive));
          const adj = float(uMaxStdDev);
          vRgba.assign(rgba);
          vSplatUv.assign(positionGeometry.xy.mul(adj));
          vAdjustedStdDev.assign(adj);
          const scaledRenderSizeMin = vec2(this.renderSize).mul(
            this.focalAdjustment,
          );
          ndcOffset.assign(
            vec2(2.0)
              .div(scaledRenderSizeMin)
              .mul(positionGeometry.xy.mul(this.vsMinPixelRadius)),
          );
          return;
        }
        scales.assign(vec3(unpacked.scales.mul(this.renderToViewScale)));
        rgba.assign(vec4(unpacked.rgba));

        // File u8 ×2 applied EXACTLY ONCE (lodOpacity encoding); see header.
        if (lodOpacity) {
          rgba.a.assign(rgba.a.mul(2.0));
        }

        // SH added at read time in object space (stock fetchSplat), with the
        // per-frame camera (plan-blessed deviation #1).
        if (sh1Texture) {
          const viewDir = normalize(center.sub(this.viewOrigin));
          const shRgb = evaluatePackedShTsl({
            coord: texCoord,
            viewDir,
            shMax: this.shMax,
            sh1Texture,
            sh2Texture,
            sh3Texture,
          });
          // (no multi-component swizzle assignment in WGSL — rebuild the vec4)
          rgba.assign(vec4(rgba.rgb.add(shRgb), rgba.a));
        }

        if (parityQuantize) {
          // Accumulator repack lattice (packSplatEncoding with the DEFAULT
          // encoding + the halve/re-double alpha round trip); see header.
          const rgbQ = round(clamp(rgba.rgb.mul(255.0), 0.0, 255.0)).div(255.0);
          const aQ = round(clamp(rgba.a.mul(0.5).mul(255.0), 0.0, 255.0))
            .div(255.0)
            .mul(2.0);
          rgba.assign(vec4(rgbQ, aQ));
          const lnScaleScale = float(254.0 / (LN_SCALE_MAX - LN_SCALE_MIN));
          const requantScale = (s: TslNode) =>
            select(
              s.equal(0.0),
              float(0.0),
              exp(
                round(
                  clamp(
                    s.log().sub(LN_SCALE_MIN).mul(lnScaleScale),
                    0.0,
                    254.0,
                  ),
                )
                  .div(lnScaleScale)
                  .add(LN_SCALE_MIN),
              ),
            );
          scales.assign(
            vec3(
              requantScale(scales.x),
              requantScale(scales.y),
              requantScale(scales.z),
            ),
          );
        }

        // -- splatVertex.glsl main(), non-ext non-cov path ---------------------
        const zeroScales = scales.equal(vec3(0.0));
        rejected.assign(rejected.or(zeroScales.all()));

        rejected.assign(
          rejected.or(rgba.a.equal(0.0)).or(rgba.a.lessThan(uMinAlpha)),
        );

        const adjustedStdDev = float(uMaxStdDev).toVar();
        If(rgba.a.greaterThan(1.0), () => {
          // Stretch 1..2 to 1..5
          rgba.a.assign(min(rgba.a.mul(4.0).sub(3.0), 5.0));

          if (lodInflate) {
            // Adjust size to compensate for loss of opacity
            const opacity = exp(
              rgba.a.mul(rgba.a).sub(1.0).div(2.718281828459045),
            );
            const rescale = pow(opacity, 1.0 / 3.0);
            scales.assign(scales.mul(rescale));
            rgba.a.assign(1.0);
          }

          // Expand the maximum std dev to approximately cover the larger range
          adjustedStdDev.assign(uMaxStdDev.add(rgba.a.sub(1.0).mul(0.7)));
        });

        vRgba.assign(rgba);
        vSplatUv.assign(positionGeometry.xy.mul(adjustedStdDev));

        // Compute view space quaternion of splat
        const viewQuaternion = quatQuatTsl(this.renderToViewQuat, quaternion);

        // (enable2DGS zero-thickness branch not ported — see header)

        // Compute the 3D covariance matrix of the splat
        const [rsC0, rsC1, rsC2] = scaleQuaternionToMatrixColumnsTsl(
          scales,
          viewQuaternion,
        );
        // mat3 from three column vec3s — how three itself builds TBN matrices;
        // the 0.180 type declarations only list the 1/9-scalar overloads.
        const RS = (mat3 as TslNode)(rsC0, rsC1, rsC2);
        const cov3D = RS.mul(transpose(RS));

        // Compute the Jacobian of the splat's projection at its center.
        // Column-major literal port of the GLSL mat3 constructors.
        const scaledRenderSize = vec2(this.renderSize).mul(this.focalAdjustment);
        const focal = scaledRenderSize
          .mul(0.5)
          .mul(
            vec2(
              cameraProjectionMatrix.element(int(0)).element(int(0)),
              cameraProjectionMatrix.element(int(1)).element(int(1)),
            ),
          );

        const isOrthographic = cameraProjectionMatrix
          .element(int(2))
          .element(int(3))
          .notEqual(-1.0);
        const invZ = float(1.0).div(viewCenter.z);
        const J1 = focal.mul(invZ);
        const J2 = J1.mul(viewCenter.xy).negate().mul(invZ);
        const jC0 = select(
          isOrthographic,
          vec3(focal.x, 0.0, 0.0),
          vec3(J1.x, 0.0, J2.x),
        );
        const jC1 = select(
          isOrthographic,
          vec3(0.0, focal.y, 0.0),
          vec3(0.0, J1.y, J2.y),
        );
        const J = (mat3 as TslNode)(jC0, jC1, vec3(0.0, 0.0, 0.0));

        // Compute the 2D covariance by projecting the 3D covariance
        // and picking out the XY plane components.
        const cov2D = transpose(J).mul(cov3D).mul(J);
        const a = float(cov2D.element(int(0)).element(int(0))).toVar();
        const d = float(cov2D.element(int(1)).element(int(1))).toVar();
        const b = cov2D.element(int(0)).element(int(1));

        // Optionally pre-blur the splat to match non-antialias optimized splats
        a.addAssign(this.preBlurAmount);
        d.addAssign(this.preBlurAmount);

        // (depth-of-field focusRadius branch not ported — see header)
        const fullBlurAmount = this.blurAmount;

        // Do convolution with a 0.5-pixel Gaussian for anti-aliasing
        const detOrig = a.mul(d).sub(b.mul(b));
        a.addAssign(fullBlurAmount);
        d.addAssign(fullBlurAmount);
        const det = a.mul(d).sub(b.mul(b));

        // Compute anti-aliasing intensity scaling factor
        const blurAdjust = sqrt(max(0.0, detOrig.div(det)));
        const rawAlpha = rgba.a.toVar("kcRawAlpha");
        rgba.a.assign(rgba.a.mul(blurAdjust));
        rejected.assign(rejected.or(rgba.a.lessThan(uMinAlpha)));
        vRgba.a.assign(rgba.a);
        vAdjustedStdDev.assign(adjustedStdDev);

        // SSOG_FILL_V2 elements 1 + 3-discard (§2.6; CORRECTED [ssog-8] —
        // RAW alpha × POST-blur (dilated) det, upstream compute-path
        // semantics; the old post-blurAdjust form cancelled the dilation and
        // tested true undilated ink, deleting every σ≤0.4 px splat at any
        // opacity = the far-view dense-region black patches). GLSL twin in
        // splatVertex.glsl.
        const fillOn = this.ssogFillV2.greaterThan(0.5);
        rejected.assign(
          rejected.or(fillOn.and(rawAlpha.lessThan(1.0 / 255.0))),
        );
        rejected.assign(
          rejected.or(
            fillOn.and(
              rawAlpha
                .mul(6.2831853071795862)
                .mul(sqrt(max(det, 0.0)))
                .lessThan(this.ssogMinContribution),
            ),
          ),
        );

        // Compute the eigenvalues and eigenvectors of the 2D covariance matrix
        const eigenAvg = a.add(d).mul(0.5);
        const eigenDelta = sqrt(max(0.0, eigenAvg.mul(eigenAvg).sub(det)));
        const eigen1 = eigenAvg.add(eigenDelta);
        const eigen2 = eigenAvg.sub(eigenDelta);

        const eigenVec1 = select(
          b.abs().greaterThan(0.001),
          normalize(vec2(b, eigen1.sub(a))),
          select(
            a.greaterThanEqual(d),
            vec2(1.0, 0.0),
            vec2(0.0, 1.0),
          ),
        );
        const eigenVec2 = vec2(eigenVec1.y, eigenVec1.x.negate());

        // maxPixelRadius clamp AFTER the adjustedStdDev multiply
        const r1 = adjustedStdDev.mul(sqrt(eigen1));
        const r2 = adjustedStdDev.mul(sqrt(eigen2));
        // SSOG_FILL_V2 element 2 (§2.6): kernel cap WITH covariance rescale —
        // upstream's viewport-adaptive cap, BOTH axes scaled by one factor so
        // anisotropy survives; element 3 (alpha quad shrink): beyond z*
        // std-devs the falloff drops below alphaClip = 1/255 — shrink the quad
        // AND the UV span together (same pixels-per-std-dev, identical
        // Gaussian, fewer pixels filled). GLSL twin in splatVertex.glsl.
        const fillCap = min(
          1024.0,
          min(this.renderSize.x, this.renderSize.y),
        );
        const capScale = min(1.0, fillCap.div(max(r1, r2)));
        const zStar = sqrt(
          max(0.0, log(rgba.a.mul(255.0))).mul(2.0),
        );
        const quadScale = min(1.0, zStar.div(adjustedStdDev));
        const scale1 = select(
          fillOn,
          r1.mul(capScale).mul(quadScale),
          min(this.maxPixelRadius, r1),
        );
        const scale2 = select(
          fillOn,
          r2.mul(capScale).mul(quadScale),
          min(this.maxPixelRadius, r2),
        );
        If(fillOn, () => {
          vSplatUv.assign(
            positionGeometry.xy.mul(adjustedStdDev.mul(quadScale)),
          );
        });
        rejected.assign(
          rejected.or(
            scale1
              .lessThan(this.minPixelRadius)
              .and(scale2.lessThan(this.minPixelRadius)),
          ),
        );

        // Compute the NDC coordinates for the ellipsoid's diagonal axes.
        const posXY = positionGeometry.xy;
        const pixelOffset = eigenVec1
          .mul(scale1)
          .mul(posXY.x)
          .add(eigenVec2.mul(scale2).mul(posXY.y));
        ndcOffset.assign(vec2(2.0).div(scaledRenderSize).mul(pixelOffset));
      });

      // Compute NDC center of the splat
      const ndcCenter = clipCenter.xyz.div(clipCenter.w);
      const ndc = vec3(ndcCenter.xy.add(ndcOffset), ndcCenter.z);

      return select(
        rejected,
        rejectPos,
        vec4(ndc.xy.mul(clipCenter.w), clipCenter.z, clipCenter.w),
      );
    })();

    // -- splatFragment.glsl (live path only) ---------------------------------
    this.fragmentNode = Fn(() => {
      const rgba = vec4(vRgba).toVar();

      const z2 = dot(vSplatUv, vSplatUv);
      const adj = float(vAdjustedStdDev);
      If(z2.greaterThan(adj.mul(adj)), () => {
        Discard();
      });

      // "New falloff function" (the `if(false)` legacy branch is not ported)
      If(rgba.a.lessThanEqual(1.0), () => {
        rgba.a.assign(
          mix(rgba.a, rgba.a.mul(exp(z2.mul(-0.5))), uFalloff),
        );
      }).Else(() => {
        const aPow = exp(rgba.a.mul(rgba.a).sub(1.0).div(2.718281828459045));
        const alpha = float(1.0).sub(
          pow(float(1.0).sub(exp(z2.mul(-0.5))), aPow),
        );
        rgba.a.assign(mix(1.0, alpha, uFalloff));
      });

      If(rgba.a.lessThan(uMinAlpha), () => {
        Discard();
      });

      // encodeLinear=false passthrough (parity row 27); premultiplied output.
      // [ssog-9] pick mode: premultiplied (normDepth·a, 0, 0, a) — the GLSL
      // twin lives inside the PREMULTIPLIED_ALPHA arm; this material is
      // premultiplied by construction (CustomBlending ONE/OMSA below).
      const normDepth = float(vViewZ)
        .negate()
        .sub(this.pickNear)
        .div(float(this.pickFar).sub(this.pickNear));
      return select(
        this.pickMode.greaterThan(0.5),
        vec4(normDepth.mul(rgba.a), 0.0, 0.0, rgba.a),
        vec4(rgba.rgb.mul(rgba.a), rgba.a),
      );
    })();

    // Premultiplied over: r185 WebGPU ignores premultipliedAlpha on
    // NormalBlending — explicit CustomBlending factors on BOTH channels.
    this.transparent = true;
    this.depthWrite = false;
    this.depthTest = true;
    this.side = DoubleSide;
    // [ssog-11] MANDATORY with transparent + DoubleSide: three's renderers
    // otherwise submit the mesh TWICE per frame - a BackSide pass and a
    // FrontSide pass (r185 Renderer.js:3620 / WebGLRenderer.js:2133) - and
    // the vertex stage runs in full on BOTH, because face culling happens
    // after it. Splat quads are camera-facing billboards with one winding,
    // so one of those passes shades every splat and emits zero fragments:
    // 100% waste of the dominant per-frame cost (field-measured 2026-08-21:
    // splat COUNT, not resolution, dominates on iPhone 13 / Pixel 4).
    // With a single pass, side stays DoubleSide => cullMode none => identical
    // coverage, in the correct depth-sorted order.
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

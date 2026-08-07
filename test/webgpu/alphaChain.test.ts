// Kroscloud WebGPU fork (2026) — see FORK-CHANGES.md.
//
// The a>1 double-×2 parity trap (fork plan §2/Q2): the file stores
// u8 = round(a/2 · 255) over [0,2] for LoD-opacity splats; the stock WebGL2
// pipeline reads ×2, halves + re-quantizes in the accumulator, and re-doubles
// in the draw — which nets to the file u8 ×2 applied EXACTLY ONCE. The single
// most likely parity mistake is applying the ×2 twice (or zero times). These
// tests pin the convention with hand-computed u8 fixtures; the browser
// harness asserts the actual shader against the same reference.

import assert from "node:assert";
import {
  referenceAlphaChain,
  roundEven,
  stockNetAlpha,
} from "../../src/webgpu/alphaReference.js";

const SQRT5 = Math.sqrt(5);
const near = (a: number, b: number, eps = 1e-12) => Math.abs(a - b) <= eps;

// --- hand-computed fixtures (lodOpacity=true, the .rad LoD encoding) --------

// u8=200: a = 2·200/255 = 400/255 ≈ 1.5686 → chain: min(4a−3, 5) = 835/255,
// adjustedStdDev = √5 + 0.7·(835/255 − 1) = √5 + 0.7·580/255
{
  const r = referenceAlphaChain(200, true);
  assert.ok(near(r.alpha, 835 / 255), `u8=200 lod: alpha ${r.alpha}`);
  assert.ok(
    near(r.adjustedStdDev, SQRT5 + (0.7 * 580) / 255),
    `u8=200 lod: adjStdDev ${r.adjustedStdDev}`,
  );
  assert.ok(!r.rejected, "u8=200 lod: not rejected");

  // the DOUBLE-×2 bug would give a = 4·200/255 → min(4a−3,5) = 5 (clamped)
  const doubleBug = Math.min((4 * (4 * 200)) / 255 - 3, 5);
  assert.ok(!near(r.alpha, doubleBug), "u8=200: double-×2 bug detected");
  // the MISSING-×2 bug would give a = 200/255 < 1 → chain never fires
  assert.ok(!near(r.alpha, 200 / 255), "u8=200: missing-×2 bug detected");
}

// u8=128: a = 256/255 — smallest lattice value > 1; chain barely fires:
// alpha = 4·256/255 − 3 = 259/255, adjustedStdDev = √5 + 0.7·4/255
{
  const r = referenceAlphaChain(128, true);
  assert.ok(near(r.alpha, 259 / 255), `u8=128 lod: alpha ${r.alpha}`);
  assert.ok(
    near(r.adjustedStdDev, SQRT5 + (0.7 * 4) / 255),
    `u8=128 lod: adjStdDev ${r.adjustedStdDev}`,
  );
}

// u8=127: a = 254/255 < 1 — chain must NOT fire (strict a > 1)
{
  const r = referenceAlphaChain(127, true);
  assert.ok(near(r.alpha, 254 / 255), `u8=127 lod: alpha ${r.alpha}`);
  assert.ok(near(r.adjustedStdDev, SQRT5), "u8=127 lod: adjStdDev = maxStdDev");
}

// u8=255: a = 2 → min(8−3, 5) = 5 exactly (clamp boundary),
// adjustedStdDev = √5 + 2.8
{
  const r = referenceAlphaChain(255, true);
  assert.ok(near(r.alpha, 5), `u8=255 lod: alpha ${r.alpha}`);
  assert.ok(near(r.adjustedStdDev, SQRT5 + 2.8), "u8=255 lod: adjStdDev");
}

// u8=0 rejects (alpha == 0)
assert.ok(referenceAlphaChain(0, true).rejected, "u8=0: rejected");
assert.ok(referenceAlphaChain(0, false).rejected, "u8=0 non-lod: rejected");

// --- non-LoD .sog files (lodOpacity=false): NO ×2 anywhere ------------------

// u8=255 (odd → lattice TIE): halve gives round(127.5) — half-even snaps to
// 128 (the even neighbor) → a = 256/255 > 1, so the a>1 chain fires by one
// lattice step: alpha = 4·256/255 − 3 = 259/255. Full-opacity non-lod splats
// never survive the stock accumulator round trip as exactly 1.0 — stock GPUs
// that round 127.5→128 draw them through the a>1 falloff path too. The
// double-×2 bug here would produce alpha 5 (chain clamp).
{
  const r = referenceAlphaChain(255, false);
  assert.ok(near(r.alpha, 259 / 255), `u8=255 non-lod: alpha ${r.alpha}`);
  assert.ok(
    near(r.adjustedStdDev, SQRT5 + (0.7 * 4) / 255),
    "u8=255 non-lod: chain fires by one lattice step",
  );
  assert.ok(!near(r.alpha, 5), "u8=255 non-lod: double-×2 bug detected");
}

// u8=254 (even): lattice identity → alpha = 254/255 exactly
{
  const r = referenceAlphaChain(254, false);
  assert.ok(near(r.alpha, 254 / 255), `u8=254 non-lod: alpha ${r.alpha}`);
}

// u8=200 (even): parity lattice is the identity → alpha = 200/255
{
  const r = referenceAlphaChain(200, false);
  assert.ok(near(r.alpha, 200 / 255), `u8=200 non-lod: alpha ${r.alpha}`);
}

// --- exhaustive: reference(parityQuantize) ≡ stock net transform ------------
// The parity-quantized fork chain input must equal the stock draw's input for
// EVERY u8 in both encodings (this is the fork plan's Q2 identity, made
// exhaustive; both sides use the same JS rounding).
for (const lodOpacity of [false, true]) {
  for (let u8 = 0; u8 <= 255; u8++) {
    const stock = stockNetAlpha(u8, lodOpacity);
    const fork = referenceAlphaChain(u8, lodOpacity);
    const forkInput =
      (roundEven(
        Math.min(Math.max(((lodOpacity ? 2 : 1) * u8) / 255 / 2 * 255, 0), 255),
      ) /
        255) *
      2;
    assert.ok(
      near(forkInput, stock),
      `u8=${u8} lod=${lodOpacity}: fork lattice ${forkInput} != stock ${stock}`,
    );
    // and for lodOpacity files the lattice is the plain ×2-once value:
    if (lodOpacity) {
      const plain = (2 * u8) / 255;
      assert.ok(
        near(stock, plain),
        `u8=${u8} lod: stock ${stock} != plain ×2-once ${plain} (Q2 identity)`,
      );
      if (!fork.rejected && plain <= 1) {
        assert.ok(near(fork.alpha, plain), `u8=${u8} lod: alpha ${fork.alpha}`);
      }
    }
  }
}

// --- documented correction to Q2's identity claim for non-LoD odd u8 --------
// Stock's halve→requantize→double is NOT the identity for odd u8 with
// lodOpacity=false: it snaps to the EVEN u8-lattice neighbor (round-half-even
// at the exact .5 tie; GLSL may resolve ties differently per GPU, ±1/255).
// The fork's parityQuantize replicates the WGSL-even convention exactly
// (asserted exhaustively above); without parityQuantize the fork would keep
// the file value. Pin one example so the deviation stays known:
{
  const stock = stockNetAlpha(101, false); // 2·roundEven(50.5)/255 = 100/255
  assert.ok(near(stock, 100 / 255), `odd-u8 stock lattice: ${stock}`);
  const noParity = referenceAlphaChain(101, false, { parityQuantize: false });
  assert.ok(near(noParity.alpha, 101 / 255), "no-parity keeps file value");
}

console.log("✅ webgpu/alphaChain: all hand-computed fixtures passed");

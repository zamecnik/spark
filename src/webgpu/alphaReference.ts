// Kroscloud WebGPU fork (2026) — see FORK-CHANGES.md.
//
// Pure-math reference of the SplatNodeMaterial vertex-stage alpha chain, kept
// in lockstep with the TSL implementation. It exists so the "file u8 ×2
// applied EXACTLY ONCE" convention (fork plan §2/Q2 — the named double-×2
// parity trap) is pinned by unit tests with hand-computed fixtures
// (test/webgpu/alphaChain.test.ts), and so the browser parity probe can
// assert shader ≡ reference.
//
// NOTE on rounding: WGSL round() is round-half-even, and TSL round() maps to
// it, so this reference uses round-half-even too — reference ≡ shader by
// construction. GLSL round() is implementation-defined at exact .5, so the
// STOCK WebGL2 pipeline may resolve tie inputs (odd u8 with
// lodOpacity=false, e.g. the u8=255 full-opacity tie at round(127.5))
// ±1/255 differently per GPU. That drift is inherent to upstream, not
// introduced by the fork.

// WGSL round(): round half to even.
export function roundEven(x: number): number {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

export type AlphaChainResult = {
  // alpha entering the fragment stage (before blurAdjust), or 0 if rejected
  alpha: number;
  adjustedStdDev: number;
  rejected: boolean;
};

// The stock WebGL2 pipeline's net alpha transform for the identity-recolor
// product surface: dyno read (×2 iff lodOpacity) → accumulator halve +
// u8 re-quantize → draw ×2. This is the value the stock draw shader sees.
export function stockNetAlpha(u8: number, lodOpacity: boolean): number {
  const aRead = ((lodOpacity ? 2 : 1) * u8) / 255;
  const aAccum = roundEven(Math.min(Math.max(aRead * 0.5 * 255, 0), 255)) / 255;
  return 2 * aAccum;
}

// The fork's vertex-stage chain (SplatNodeMaterial with parityQuantize).
export function referenceAlphaChain(
  u8: number,
  lodOpacity: boolean,
  {
    maxStdDev = Math.sqrt(5),
    minAlpha = 0.5 / 255,
    parityQuantize = true,
  }: { maxStdDev?: number; minAlpha?: number; parityQuantize?: boolean } = {},
): AlphaChainResult {
  // File u8 ×2 applied EXACTLY ONCE
  let a = (u8 / 255) * (lodOpacity ? 2 : 1);

  if (parityQuantize) {
    // accumulator repack lattice (halve, u8 quantize, re-double)
    a = (roundEven(Math.min(Math.max(a * 0.5 * 255, 0), 255)) / 255) * 2;
  }

  if (a === 0 || a < minAlpha) {
    return { alpha: 0, adjustedStdDev: maxStdDev, rejected: true };
  }

  let adjustedStdDev = maxStdDev;
  if (a > 1) {
    // Stretch 1..2 to 1..5
    a = Math.min(a * 4 - 3, 5);
    // Expand the maximum std dev to approximately cover the larger range
    adjustedStdDev = maxStdDev + 0.7 * (a - 1);
  }

  return { alpha: a, adjustedStdDev, rejected: false };
}

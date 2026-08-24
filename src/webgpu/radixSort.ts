// Kroscloud WebGPU fork (2026) — see FORK-CHANGES.md.
//
// TSL port of PlayCanvas's portable multipass 4-bit radix sort (MIT,
// PlayCanvas Ltd). Reference: playcanvas/engine
//   src/scene/graphics/radix-sort/compute-radix-sort-multipass.js
//   src/scene/graphics/prefix-sum-kernel.js
//   src/scene/shader-lib/wgsl/chunks/radix-sort/{compute-radix-sort-4bit,
//     compute-prefix-sum, compute-radix-sort-reorder}.js
// which follows "Fast 4-way parallel radix sorting on GPUs" via
// kishimisu/WebGPU-Radix-Sort (MIT).
//
// Ported to Spark from the Kroscloud PoC (poc/webgpu-sort/radix-sort-tsl.js,
// verified stable + correct at 1K/64K/1M/4.59M/8M; 4.59M × 16-bit = 1.95 ms
// GPU on Turing). Stable sort of u32 keys; produces the sorted index
// permutation. All counts and bit offsets are baked as compile-time
// constants — build one instance per (count, numBits) and re-dispatch its
// `steps` every sort.
//
// Requires the Viewme three.webgpu.js patch that adds
// `workgroupArray(...).setAtomic(true)` (workgroup-scope atomic<u32> arrays —
// upstream three r185 cannot declare them; the atomic call-site codegen
// itself is stock three).

import {
  Fn,
  If,
  atomicAdd,
  atomicLoad,
  atomicOr,
  atomicStore,
  instancedArray,
  invocationLocalIndex,
  select,
  uint,
  workgroupArray,
  workgroupBarrier,
  workgroupId,
} from "three/tsl";
import * as TSL from "three/tsl";
import type { TslNode } from "./packedSplatsTsl";

// Runtime-present TSL pieces the 0.180 type declarations don't know about:
// countOneBits is stock r185; setAtomic on workgroupArray is added by the
// Viewme three patch (see header).
// biome-ignore lint/suspicious/noExplicitAny: types lag the (patched) runtime
const countOneBits: (node: unknown) => any = (TSL as any).countOneBits;

const TPW = 256; // threads per workgroup
const EPT = 8; // elements per thread
const EPW = TPW * EPT; // 2048 elements per workgroup
// BUCKETS is per-instance now: 1 << digitBits (16 for the classic 4-bit
// kernel, 256 for the 8-bit-digit variant). See createRadixSort.
const SCAN_ITEMS = 512; // Blelloch scan: 2 items per thread

const pad = (n: number, m: number) => Math.ceil(n / m) * m;

export type RadixSort = {
  // ordered ComputeNodes — dispatch all, in order, per sort
  steps: TslNode[];
  // storage node holding the permutation after the run
  sortedValues: TslNode;
  wgCount: number;
  dispatchesPerSort: number;
};

export function createRadixSort({
  keysNode,
  count,
  numBits = 16,
  digitBits = 4,
  reorderThreads = 256,
}: {
  keysNode: TslNode;
  count: number;
  numBits?: number;
  // [digit] radix digit width: 4 (classic, 16 buckets) or 8 (256 buckets,
  // HALF the passes at the same key precision). The per-element reorder work
  // is identical either way - each digit's ballot spans 8 words of 256 bits
  // regardless of bucket count - so passes are the whole cost, and rows 78/79
  // measured them at ~9.5 ms each over 1.16M keys on Adreno 640. Workgroup
  // memory at 8: masks 256x8 u32 = 8 KB + offsets 1 KB, inside the 16 KB
  // WebGPU floor. The sorted permutation is IDENTICAL for both widths (LSD
  // radix stability composes the same total order), so this is a pure
  // performance knob.
  digitBits?: number;
  // [tpw] threads per workgroup for the histogram/reorder kernels (the scan
  // keeps its own 256). Row 81: digit-8 at 256 threads REGRESSED on Adreno
  // (86 vs 74 ms orbit; ~29 ms/pass vs the 4-bit kernel's 9.5) while the
  // desktop rig ran it faster - the 9 KB mask footprint (256 buckets x 8
  // ballot words) is the occupancy suspect. Fewer threads shrink the ballot:
  // words/digit = threads/32, so 128 threads = 4 KB masks, 64 = 2 KB, at the
  // price of more workgroups (EPW = threads x EPT). Same permutation always.
  reorderThreads?: number;
}): RadixSort {
  if (digitBits !== 4 && digitBits !== 8)
    throw new Error("digitBits must be 4 or 8");
  if (numBits % digitBits !== 0)
    throw new Error("numBits must be a multiple of digitBits");
  if (![64, 128, 256].includes(reorderThreads))
    throw new Error("reorderThreads must be 64, 128 or 256");

  const BUCKETS = 1 << digitBits;
  const numPasses = numBits / digitBits;
  const RT = reorderThreads; // hist/reorder thread count
  const WORDS = RT / 32; // ballot words per digit
  const EPW_R = RT * EPT; // elements per hist/reorder workgroup
  // Digit-slots per thread for per-digit housekeeping (clears, histogram
  // publish, offsets): with RT < BUCKETS one thread must own several digits -
  // the rig caught exactly this (digits >= RT never written at tpw 128/64).
  const DPT = Math.ceil(BUCKETS / RT);
  const wgCount = Math.max(1, Math.ceil(count / EPW_R));
  const blockSumCount = BUCKETS * wgCount;

  // ---- buffers (all zero-initialised u32) --------------------------------

  const blockSums = instancedArray(pad(blockSumCount, SCAN_ITEMS), "uint");
  const keysA = instancedArray(count, "uint");
  const keysB = instancedArray(count, "uint");
  const valsA = instancedArray(count, "uint");
  const valsB = instancedArray(count, "uint");

  // ---- hierarchical scan levels (mirrors PrefixSumKernel.createPassesRecursive)

  type ScanLevel = {
    items: TslNode;
    count: number;
    wgs: number;
    blockSums: TslNode;
  };
  const levels: ScanLevel[] = [];
  {
    let items: TslNode = blockSums;
    let levelCount = blockSumCount;

    for (;;) {
      const wgs = Math.ceil(levelCount / SCAN_ITEMS);
      const level: ScanLevel = {
        items,
        count: levelCount,
        wgs,
        blockSums: instancedArray(Math.max(1, pad(wgs, SCAN_ITEMS)), "uint"),
      };
      levels.push(level);
      if (wgs <= 1) break;
      items = level.blockSums;
      levelCount = wgs;
    }
  }

  // ---- kernel factories ---------------------------------------------------

  // Histogram: per-workgroup 16-bucket digit counts → block_sums (column-major:
  // block_sums[digit * wgCount + workgroup]).
  const makeHistogram = (srcKeys: TslNode, bit: number) => {
    const hist = (workgroupArray("uint", BUCKETS) as TslNode).setAtomic(true);

    return (Fn(() => {
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
          const digit = srcKeys
            .element(GID)
            .shiftRight(uint(bit))
            .bitAnd(uint(BUCKETS - 1));
          atomicAdd(hist.element(digit), uint(1));
        });
      }
      workgroupBarrier();

      for (let k = 0; k < DPT; k++) {
        const dg = TID.add(uint(k * RT));
        If(dg.lessThan(uint(BUCKETS)), () => {
          blockSums
            .element(dg.mul(uint(wgCount)).add(WGID))
            .assign(atomicLoad(hist.element(dg)));
        });
      }
    })() as TslNode)
      .compute([wgCount], [RT])
      .setName(`radixHist_bit${bit}`);
  };

  // Exclusive Blelloch scan of one level, in place; workgroup total →
  // level.blockSums. Loops fully unrolled from JS (offsets compile-time).
  const makeScan = (level: ScanLevel, idx: number) => {
    const temp = workgroupArray("uint", SCAN_ITEMS * 2); // reference size (incl. legacy padding)
    const { items, count: n, blockSums: sumsOut } = level;

    return (Fn(() => {
      const TID = invocationLocalIndex;
      const WGID = workgroupId.x;
      const GID = WGID.mul(uint(TPW)).add(TID);
      const ELM_TID = TID.mul(uint(2));
      const ELM_GID = GID.mul(uint(2));

      // buffers are padded to SCAN_ITEMS multiples and zero-initialised, so
      // the out-of-range select() operand still reads in-bounds zeros
      temp
        .element(ELM_TID)
        .assign(
          select(
            ELM_GID.greaterThanEqual(uint(n)),
            uint(0),
            items.element(ELM_GID),
          ),
        );
      temp
        .element(ELM_TID.add(uint(1)))
        .assign(
          select(
            ELM_GID.add(uint(1)).greaterThanEqual(uint(n)),
            uint(0),
            items.element(ELM_GID.add(uint(1))),
          ),
        );

      let offset = 1;

      // up-sweep
      // NOTE: If() bodies run lazily at node-BUILD time — a closure must
      // never read a loop-MUTATED JS variable (it would see the final
      // value). Index nodes are therefore built eagerly per iteration.
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

      // down-sweep (same eager-index rule as the up-sweep)
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
        items
          .element(ELM_GID.add(uint(1)))
          .assign(temp.element(ELM_TID.add(uint(1))));
      });
    })() as TslNode)
      .compute([level.wgs], [TPW])
      .setName(`radixScan_L${idx}`);
  };

  // Adds the (recursively scanned) block totals back into a level.
  const makeAddBlock = (level: ScanLevel, idx: number) => {
    const { items, count: n, blockSums: sums } = level;

    return (Fn(() => {
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
    })() as TslNode)
      .compute([level.wgs], [TPW])
      .setName(`radixScanAdd_L${idx}`);
  };

  // Ranked scatter: per-digit 256-bit bitmasks in workgroup memory, local
  // rank via popcount, scatter to prefix_block_sum[digit][wg] + cumulative
  // rank.
  const makeReorder = (
    inKeys: TslNode,
    outKeys: TslNode,
    inVals: TslNode,
    outVals: TslNode,
    bit: number,
    isFirst: boolean,
    isLast: boolean,
  ) => {
    const masks = (workgroupArray("uint", BUCKETS * WORDS) as TslNode).setAtomic(
      true,
    ); // BUCKETS digits × WORDS words × 32 bits
    const offsets = workgroupArray("uint", BUCKETS); // cumulative per-digit round offsets

    return (Fn(() => {
      const TID = invocationLocalIndex;
      const WGID = workgroupId.x;
      const WID = WGID.mul(uint(EPW_R));
      const wordIdx = TID.shiftRight(uint(5)).toVar();
      const bitIdx = TID.bitAnd(uint(31)).toVar();

      // one thread per digit clears its offsets slot and its 8 mask words -
      // the same shape the per-round clear below uses, valid for 16 and 256
      for (let k = 0; k < DPT; k++) {
        const dg = TID.add(uint(k * RT));
        If(dg.lessThan(uint(BUCKETS)), () => {
          offsets.element(dg).assign(uint(0));
          for (let w = 0; w < WORDS; w++) {
            atomicStore(
              masks.element(dg.mul(uint(WORDS)).add(uint(w))),
              uint(0),
            );
          }
        });
      }
      workgroupBarrier();

      for (let round = 0; round < EPT; round++) {
        const GID = WID.add(uint(round * RT)).add(TID).toVar();
        const isValid = GID.lessThan(uint(count)).toVar();
        const k = select(isValid, inKeys.element(GID), uint(0)).toVar();
        const digit = select(
          isValid,
          k.shiftRight(uint(bit)).bitAnd(uint(BUCKETS - 1)),
          uint(BUCKETS),
        ).toVar();
        // pre-fetch value before the barrier (reference does this for
        // latency overlap)
        const v = (
          isFirst ? GID : select(isValid, inVals.element(GID), uint(0))
        ).toVar();

        If(isValid, () => {
          atomicOr(
            masks.element(digit.mul(uint(WORDS)).add(wordIdx)),
            uint(1).shiftLeft(bitIdx),
          );
        });
        workgroupBarrier();

        If(isValid, () => {
          const base = digit.mul(uint(WORDS)).toVar();
          const localPrefix = offsets.element(digit).toVar();

          for (let w = 0; w < WORDS - 1; w++) {
            If(uint(w).lessThan(wordIdx), () => {
              localPrefix.addAssign(
                countOneBits(atomicLoad(masks.element(base.add(uint(w))))),
              );
            });
          }

          localPrefix.addAssign(
            countOneBits(
              atomicLoad(masks.element(base.add(wordIdx))).bitAnd(
                uint(1).shiftLeft(bitIdx).sub(uint(1)),
              ),
            ),
          );

          const pid = digit.mul(uint(wgCount)).add(WGID);
          const pos = blockSums.element(pid).add(localPrefix).toVar();

          if (!isLast) outKeys.element(pos).assign(k);
          outVals.element(pos).assign(v);
        });

        // update cumulative offsets and clear masks for the next round
        if (round < EPT - 1) {
          workgroupBarrier();
          for (let k = 0; k < DPT; k++) {
            const dg = TID.add(uint(k * RT));
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
    })() as TslNode)
      .compute([wgCount], [RT])
      .setName(`radixReorder_bit${bit}`);
  };

  // ---- assemble pass sequence (mirrors ComputeRadixSortMultipass._execute) --

  // scan/add nodes operate in place on the same buffers → build once, reuse
  // every pass
  const scanNodes = levels.map((level, i) => makeScan(level, i));
  const addNodes = levels.map((level, i) =>
    level.wgs > 1 ? makeAddBlock(level, i) : null,
  );

  const steps: TslNode[] = [];
  let curKeys = keysNode;
  let curVals: TslNode = valsA; // dummy on pass 0 (isFirst → v = GID)
  let nxtKeys: TslNode = keysA;
  let nxtVals: TslNode = valsB;

  for (let pass = 0; pass < numPasses; pass++) {
    const bit = pass * digitBits;
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

  // pass i writes vals into (i even ? valsB : valsA)
  const sortedValues = (numPasses - 1) % 2 === 1 ? valsA : valsB;

  return {
    steps,
    sortedValues,
    wgCount,
    dispatchesPerSort: steps.length,
  };
}

import { TslNode } from './packedSplatsTsl';
export type RadixSort = {
    steps: TslNode[];
    sortedValues: TslNode;
    wgCount: number;
    dispatchesPerSort: number;
};
export declare function createRadixSort({ keysNode, count, numBits, }: {
    keysNode: TslNode;
    count: number;
    numBits?: number;
}): RadixSort;

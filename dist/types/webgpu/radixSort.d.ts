import { TslNode } from './packedSplatsTsl';
export type RadixSortGroup = {
    nodes: TslNode[];
    indirect: boolean;
};
export type RadixSort = {
    steps: TslNode[];
    groups: RadixSortGroup[] | null;
    sortedValues: TslNode;
    wgCount: number;
    dispatchesPerSort: number;
};
export declare function createRadixSort({ keysNode, count, numBits, digitBits, reorderThreads, valuesNode, indirect, }: {
    keysNode: TslNode;
    count: number;
    numBits?: number;
    digitBits?: number;
    reorderThreads?: number;
    valuesNode?: TslNode;
    indirect?: {
        visCountNode: TslNode;
        dispatchAttr: unknown;
    };
}): RadixSort;
export declare function createVisibleClear({ keysNode, count, quantMax, visCountNode, }: {
    keysNode: TslNode;
    count: number;
    quantMax: number;
    visCountNode: TslNode;
}): TslNode;

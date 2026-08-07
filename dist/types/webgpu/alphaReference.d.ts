export declare function roundEven(x: number): number;
export type AlphaChainResult = {
    alpha: number;
    adjustedStdDev: number;
    rejected: boolean;
};
export declare function stockNetAlpha(u8: number, lodOpacity: boolean): number;
export declare function referenceAlphaChain(u8: number, lodOpacity: boolean, { maxStdDev, minAlpha, parityQuantize, }?: {
    maxStdDev?: number;
    minAlpha?: number;
    parityQuantize?: boolean;
}): AlphaChainResult;

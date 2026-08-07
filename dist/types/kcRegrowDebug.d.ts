type DisposableTexture = {
    dispose(): void;
    image?: {
        height?: number;
    };
};
export declare function kcRegrowMode(): string;
export declare function kcInitialCutRows(budgetSplats: number): number;
export declare function kcGrowthCapRows(): number;
export declare function kcRegrowLog(ev: string, data?: Record<string, unknown>): void;
export declare function kcDisposeGrownTexture(renderer: unknown, texture: DisposableTexture): void;
export declare function kcDisposeOldMaterial(renderer: unknown, material: {
    dispose(): void;
}): void;
export {};

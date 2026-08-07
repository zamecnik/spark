import { TslNode } from './packedSplatsTsl';
import { SplatNodeMaterial } from './SplatNodeMaterial';
import type * as THREE from "three";
type SparkRendererLike = THREE.Mesh & {
    renderer: {
        compute(nodes: TslNode | TslNode[]): void;
    };
    activeSplats: number;
    sortRadial?: boolean;
    maxStdDev: number;
    minPixelRadius: number;
    maxPixelRadius: number;
    minAlpha: number;
    preBlurAmount: number;
    blurAmount: number;
    falloff: number;
    clipXY: number;
    focalAdjustment: number;
    renderSize: THREE.Vector2;
};
export declare class WebGpuSplatBackend {
    placeholderMaterial: THREE.Material;
    sortRadial: boolean;
    freezeOrder: boolean;
    frames: number;
    sorts: number;
    lastSortFrame: number;
    private state;
    private sortedOnce;
    private warnedMultiMesh;
    constructor();
    update({ spark, scene, camera, viewChanged, }: {
        spark: SparkRendererLike;
        scene: THREE.Scene;
        camera: THREE.Camera;
        viewChanged: boolean;
    }): boolean;
    applyPerFrame(spark: SparkRendererLike, camera: THREE.Camera): void;
    getState(): {
        numSplats: number;
        material: SplatNodeMaterial;
        sortedValues: TslNode;
        keysNode: TslNode;
    } | null;
    private findSplatMesh;
    private buildState;
    private updateKeygenUniforms;
}
export {};

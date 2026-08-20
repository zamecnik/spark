import { TslNode } from './packedSplatsTsl';
import { SplatNodeMaterial } from './SplatNodeMaterial';
import type * as THREE from "three";
type LodInstanceLike = {
    numSplats: number;
    indices: Uint32Array;
    texture: THREE.DataTexture;
};
type SparkRendererLike = THREE.Mesh & {
    renderer: {
        compute(nodes: TslNode | TslNode[]): void;
    };
    activeSplats: number;
    sortRadial?: boolean;
    maxStdDev: number;
    minPixelRadius: number;
    maxPixelRadius: number;
    ssogFillV2: boolean;
    ssogMinContribution: number;
    pickMode?: number;
    pickNear?: number;
    pickFar?: number;
    minAlpha: number;
    preBlurAmount: number;
    blurAmount: number;
    falloff: number;
    clipXY: number;
    focalAdjustment: number;
    renderSize: THREE.Vector2;
    lodInstances?: Map<unknown, LodInstanceLike>;
};
type SourceKind = "static" | "lodPacked" | "paged";
export declare class WebGpuSplatBackend {
    placeholderMaterial: THREE.Material;
    sortRadial: boolean;
    freezeOrder: boolean;
    frames: number;
    sorts: number;
    lastSortFrame: number;
    rebuilds: number;
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
        kind: SourceKind;
        numSplats: number;
        capacity: number;
        numShBound: number;
        material: SplatNodeMaterial;
        sortedValues: TslNode;
        keysNode: TslNode;
    } | null;
    private findSplatMesh;
    private currentEncoding;
    private resolveSource;
    private buildState;
    private updateBounds;
    private updateKeygenUniforms;
}
export {};

import { MeshBasicNodeMaterial, Vector2, Vector3, Vector4 } from 'three/webgpu';
import { TslNode } from './packedSplatsTsl';
import type * as THREE from "three";
import * as TSL from "three/tsl";
export type SplatNodeMaterialOptions = {
    packedTexture: THREE.DataArrayTexture;
    orderNode: TslNode;
    cutIndicesTexture?: THREE.DataTexture;
    sh1Texture?: THREE.DataArrayTexture;
    sh2Texture?: THREE.DataArrayTexture;
    sh3Texture?: THREE.DataArrayTexture;
    lodOpacity?: boolean;
    paged?: boolean;
    lodInflate?: boolean;
    parityQuantize?: boolean;
    vsMinimal?: number;
    batchSize?: number;
    projCache?: {
        c0: TslNode;
        c1: TslNode;
        c2: TslNode;
        c3: TslNode;
    };
    projPacked?: {
        p0: TslNode;
        p1: TslNode;
    };
    visCountNode?: TslNode;
};
export declare class SplatNodeMaterial extends MeshBasicNodeMaterial {
    renderSize: TSL.ShaderNodeObject<import('three/webgpu').UniformNode<Vector2>>;
    renderToViewQuat: TSL.ShaderNodeObject<import('three/webgpu').UniformNode<Vector4>>;
    renderToViewPos: TSL.ShaderNodeObject<import('three/webgpu').UniformNode<Vector3>>;
    renderToViewScale: TSL.ShaderNodeObject<import('three/webgpu').UniformNode<number>>;
    viewOrigin: TSL.ShaderNodeObject<import('three/webgpu').UniformNode<Vector3>>;
    maxStdDev: TSL.ShaderNodeObject<import('three/webgpu').UniformNode<number>>;
    minPixelRadius: TSL.ShaderNodeObject<import('three/webgpu').UniformNode<number>>;
    maxPixelRadius: TSL.ShaderNodeObject<import('three/webgpu').UniformNode<number>>;
    ssogFillV2: TSL.ShaderNodeObject<import('three/webgpu').UniformNode<number>>;
    ssogMinContribution: TSL.ShaderNodeObject<import('three/webgpu').UniformNode<number>>;
    pickMode: TSL.ShaderNodeObject<import('three/webgpu').UniformNode<number>>;
    pickNear: TSL.ShaderNodeObject<import('three/webgpu').UniformNode<number>>;
    pickFar: TSL.ShaderNodeObject<import('three/webgpu').UniformNode<number>>;
    earlyExit: TSL.ShaderNodeObject<import('three/webgpu').UniformNode<number>>;
    vsMinPixelRadius: TSL.ShaderNodeObject<import('three/webgpu').UniformNode<number>>;
    vsMinExtent: TSL.ShaderNodeObject<import('three/webgpu').UniformNode<number>>;
    batchNumSplats: TSL.ShaderNodeObject<import('three/webgpu').UniformNode<number>>;
    minAlpha: TSL.ShaderNodeObject<import('three/webgpu').UniformNode<number>>;
    preBlurAmount: TSL.ShaderNodeObject<import('three/webgpu').UniformNode<number>>;
    blurAmount: TSL.ShaderNodeObject<import('three/webgpu').UniformNode<number>>;
    falloff: TSL.ShaderNodeObject<import('three/webgpu').UniformNode<number>>;
    clipXY: TSL.ShaderNodeObject<import('three/webgpu').UniformNode<number>>;
    focalAdjustment: TSL.ShaderNodeObject<import('three/webgpu').UniformNode<number>>;
    rgbMinMaxLnScaleMinMax: TSL.ShaderNodeObject<import('three/webgpu').UniformNode<Vector4>>;
    shMax: TSL.ShaderNodeObject<import('three/webgpu').UniformNode<Vector3>>;
    constructor(options: SplatNodeMaterialOptions);
}

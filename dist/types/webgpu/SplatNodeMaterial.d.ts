import { MeshBasicNodeMaterial, Vector2, Vector3, Vector4 } from 'three/webgpu';
import { TslNode } from './packedSplatsTsl';
import type * as THREE from "three";
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
};
export declare class SplatNodeMaterial extends MeshBasicNodeMaterial {
    renderSize: import('three/tsl').ShaderNodeObject<import('three/webgpu').UniformNode<Vector2>>;
    renderToViewQuat: import('three/tsl').ShaderNodeObject<import('three/webgpu').UniformNode<Vector4>>;
    renderToViewPos: import('three/tsl').ShaderNodeObject<import('three/webgpu').UniformNode<Vector3>>;
    renderToViewScale: import('three/tsl').ShaderNodeObject<import('three/webgpu').UniformNode<number>>;
    viewOrigin: import('three/tsl').ShaderNodeObject<import('three/webgpu').UniformNode<Vector3>>;
    maxStdDev: import('three/tsl').ShaderNodeObject<import('three/webgpu').UniformNode<number>>;
    minPixelRadius: import('three/tsl').ShaderNodeObject<import('three/webgpu').UniformNode<number>>;
    maxPixelRadius: import('three/tsl').ShaderNodeObject<import('three/webgpu').UniformNode<number>>;
    minAlpha: import('three/tsl').ShaderNodeObject<import('three/webgpu').UniformNode<number>>;
    preBlurAmount: import('three/tsl').ShaderNodeObject<import('three/webgpu').UniformNode<number>>;
    blurAmount: import('three/tsl').ShaderNodeObject<import('three/webgpu').UniformNode<number>>;
    falloff: import('three/tsl').ShaderNodeObject<import('three/webgpu').UniformNode<number>>;
    clipXY: import('three/tsl').ShaderNodeObject<import('three/webgpu').UniformNode<number>>;
    focalAdjustment: import('three/tsl').ShaderNodeObject<import('three/webgpu').UniformNode<number>>;
    rgbMinMaxLnScaleMinMax: import('three/tsl').ShaderNodeObject<import('three/webgpu').UniformNode<Vector4>>;
    shMax: import('three/tsl').ShaderNodeObject<import('three/webgpu').UniformNode<Vector3>>;
    constructor(options: SplatNodeMaterialOptions);
}

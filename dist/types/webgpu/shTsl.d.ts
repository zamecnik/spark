import { TslNode } from './packedSplatsTsl';
import type * as THREE from "three";
export declare function evaluatePackedSH1Tsl(packedData: TslNode, // .x/.y = the RG32UI texel words
viewDir: TslNode, sh1Max: TslNode): TslNode;
export declare function evaluatePackedSH2Tsl(packedData: TslNode, viewDir: TslNode, sh2Max: TslNode): TslNode;
export declare function evaluatePackedSH3Tsl(packedData: TslNode, viewDir: TslNode, sh3Max: TslNode): TslNode;
export declare function evaluatePackedShTsl({ coord, // ivec3 from splatTexCoordTsl — MUST be the packed-texture coord
viewDir, // vec3, object space: normalize(center - viewOrigin)
shMax, // vec3 uniform (sh1Max, sh2Max, sh3Max)
sh1Texture, sh2Texture, sh3Texture, }: {
    coord: TslNode;
    viewDir: TslNode;
    shMax: TslNode;
    sh1Texture?: THREE.DataArrayTexture;
    sh2Texture?: THREE.DataArrayTexture;
    sh3Texture?: THREE.DataArrayTexture;
}): TslNode;

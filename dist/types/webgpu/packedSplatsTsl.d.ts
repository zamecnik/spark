import type * as THREE from "three";
export type TslNode = any;
export declare const SPLAT_TEX_WIDTH_BITS = 11;
export declare const SPLAT_TEX_LAYER_BITS = 22;
export declare const SPLAT_TEX_MASK = 2047;
export declare function splatTexCoordTsl(index: TslNode): TslNode;
export declare function pagedSplatTexCoordTsl(index: TslNode): TslNode;
export declare function decodeQuatOctXy88R8Tsl(encoded: TslNode): TslNode;
export type UnpackedSplatTsl = {
    center: TslNode;
    scales: TslNode;
    quaternion: TslNode;
    rgba: TslNode;
};
export declare function unpackSplatEncodingTsl(packedData: TslNode, rgbMinMaxLnScaleMinMax: TslNode): UnpackedSplatTsl;
export declare function quatVecTsl(q: TslNode, v: TslNode): TslNode;
export declare function quatQuatTsl(q1: TslNode, q2: TslNode): TslNode;
export declare function scaleQuaternionToMatrixColumnsTsl(s: TslNode, q: TslNode): [TslNode, TslNode, TslNode];
export declare function stripWebGLInternalFormat<T extends THREE.Texture>(tex: T): T;

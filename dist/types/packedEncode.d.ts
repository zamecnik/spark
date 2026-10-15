export declare const toHalf: typeof toHalfNative;
export declare const fromHalf: typeof fromHalfNative;
declare function toHalfNative(f: number): number;
export declare function toHalfJS(f: number): number;
declare function fromHalfNative(u: number): number;
export declare function fromHalfJS(h: number): number;
export declare function floatToUint8(v: number): number;
export type QuatXyzw = {
    x: number;
    y: number;
    z: number;
    w: number;
};
/**
 * Encodes a quaternion into 24 bits via folded octahedral axis mapping +
 * 8-bit angle quantization. Same bit layout and math as the pre-carve-out
 * utils.ts implementation (which used THREE.Quaternion temps); decode stays
 * in utils.ts (`decodeQuatOctXy88R8` needs a THREE.Quaternion out-param).
 */
export declare function encodeQuatOctXy88R8(q: QuatXyzw): number;
export declare function setPackedSplatCenter(packedSplats: Uint32Array, index: number, x: number, y: number, z: number): void;
export declare function setPackedSplatScales(packedSplats: Uint32Array, index: number, scaleX: number, scaleY: number, scaleZ: number, encoding?: {
    lnScaleMin?: number;
    lnScaleMax?: number;
}): void;
export declare function setPackedSplatQuat(packedSplats: Uint32Array, index: number, quatX: number, quatY: number, quatZ: number, quatW: number): void;
export declare function setPackedSplatRgba(packedSplats: Uint32Array, index: number, r: number, g: number, b: number, a: number, encoding?: {
    rgbMin?: number;
    rgbMax?: number;
    lodOpacity?: boolean;
}): void;
export declare function computeMaxSplats(numSplats: number): number;
export declare function encodeSh1Rgb(sh1Array: Uint32Array, index: number, sh1Rgb: Float32Array, encoding?: {
    sh1Max?: number;
}): void;
export declare function encodeSh2Rgb(sh2Array: Uint32Array, index: number, sh2Rgb: Float32Array, encoding?: {
    sh2Max?: number;
}): void;
export declare function encodeSh3Rgb(sh3Array: Uint32Array, index: number, sh3Rgb: Float32Array, encoding?: {
    sh3Max?: number;
}): void;
export {};

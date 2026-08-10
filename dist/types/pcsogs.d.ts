import { SplatEncoding } from './defines';
export { unpackPcSogs, decodeImage, decodeImageRgba } from './pcsogsDecode';
export declare function unpackPcSogsZip(fileBytes: Uint8Array, splatEncoding: SplatEncoding): Promise<{
    packedArray: Uint32Array;
    numSplats: number;
    extra: Record<string, unknown>;
}>;

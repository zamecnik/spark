import { PcSogsJson, PcSogsV2Json } from './SplatLoader';
import { SplatEncoding } from './defines';
export declare function unpackPcSogs(json: PcSogsJson | PcSogsV2Json, extraFiles: Record<string, ArrayBuffer>, splatEncoding: SplatEncoding): Promise<{
    packedArray: Uint32Array;
    numSplats: number;
    extra: Record<string, unknown>;
}>;
export declare function decodeImage(fileBytes: ArrayBuffer): Promise<{
    rgba: Uint8Array<ArrayBuffer>;
    width: number;
    height: number;
}>;
export declare function decodeImageRgba(fileBytes: ArrayBuffer): Promise<Uint8Array<ArrayBuffer>>;

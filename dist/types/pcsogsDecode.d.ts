import { PcSogsJson, PcSogsV2Json } from './SplatLoader';
import { SplatEncoding } from './defines';
export type DecodedImage = {
    rgba: Uint8Array;
    width: number;
    height: number;
};
export declare function unpackPcSogs(json: PcSogsJson | PcSogsV2Json, extraFiles: Record<string, ArrayBuffer>, splatEncoding: SplatEncoding, options?: {
    /**
     * [ssog-22] decoded shared SH palette (shN_centroids image) for units that
     * carry labels only (`json.shN.palette` set, one file in `shN.files`).
     */
    centroidsImage?: Promise<DecodedImage> | DecodedImage;
}): Promise<{
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

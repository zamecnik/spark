// Modified by Kroscloud, 2026 — see FORK-CHANGES.md [ssog-1]: the decode core
// (unpackPcSogs + decodeImage) moved VERBATIM to pcsogsDecode.ts so the inline
// worker bundle can use it without pulling three/SplatLoader; this module
// keeps the ZIP unpack (the only SplatLoader value import, tryPcSogsZip) and
// re-exports the moved functions so existing consumers are unchanged.
import { unzip } from "fflate";
import { tryPcSogsZip } from "./SplatLoader";
import type { SplatEncoding } from "./defines";
import { unpackPcSogs } from "./pcsogsDecode";

export { unpackPcSogs, decodeImage, decodeImageRgba } from "./pcsogsDecode";

export async function unpackPcSogsZip(
  fileBytes: Uint8Array,
  splatEncoding: SplatEncoding,
): Promise<{
  packedArray: Uint32Array;
  numSplats: number;
  extra: Record<string, unknown>;
}> {
  const nameJson = tryPcSogsZip(fileBytes);
  if (!nameJson) {
    throw new Error("Invalid PC SOGS zip file");
  }
  const { name, json } = nameJson;
  // Find path prefix, will be -1 if no / or \
  const lastSlash = name.lastIndexOf("/");
  const lastBackslash = name.lastIndexOf("\\");
  const prefix = name.slice(0, Math.max(lastSlash, lastBackslash) + 1);

  const fileMap = new Map<string, string>();
  const refFiles = [
    ...json.means.files,
    ...json.scales.files,
    ...json.quats.files,
    ...json.sh0.files,
    ...(json.shN?.files ?? []),
  ];
  for (const file of refFiles) {
    fileMap.set(prefix + file, file);
  }

  const unzipped = await new Promise<Record<string, ArrayBuffer>>(
    (resolve, reject) => {
      unzip(
        fileBytes,
        {
          filter: ({ name }) => {
            return fileMap.has(name);
          },
        },
        (err, files) => {
          if (err) {
            reject(err);
          } else {
            resolve(files);
          }
        },
      );
    },
  );

  const extraFiles: Record<string, ArrayBuffer> = {};
  for (const [full, name] of fileMap.entries()) {
    extraFiles[name] = unzipped[full];
  }

  return await unpackPcSogs(json, extraFiles, splatEncoding);
}

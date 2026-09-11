"""Dump the WebP planes of a scene.sog as raw RGBA for the Node unit tests.

Node has no WebP decoder, so test/full/sogPack.test.ts works on raw RGBA
dumps produced here with Pillow (premultiplication disabled: the planes are
data, not pictures). Rows are top-down (row 0 first), pixel i = splat i.

Usage:  python gen-planes.py <scene.sog> <outdir>
Writes  <outdir>/<plane>.rgba (width*height*4 bytes) + <outdir>/planes.json
"""
import io
import json
import os
import sys
import zipfile

from PIL import Image

src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
z = zipfile.ZipFile(src)
meta = json.loads(z.read("meta.json"))
planes = {}
for info in z.infolist():
    name = info.filename.rsplit("/", 1)[-1]
    if not name.lower().endswith(".webp"):
        continue
    im = Image.open(io.BytesIO(z.read(info.filename)))
    im.load()
    if im.mode != "RGBA":
        im = im.convert("RGBA")
    w, h = im.size
    raw = im.tobytes()
    assert len(raw) == w * h * 4, (name, len(raw), w, h)
    stem = name[:-5]
    with open(os.path.join(out, stem + ".rgba"), "wb") as f:
        f.write(raw)
    planes[stem] = {"width": w, "height": h, "bytes": len(raw), "zipEntry": info.filename, "zipSize": info.file_size}
with open(os.path.join(out, "planes.json"), "w", encoding="utf-8") as f:
    json.dump({"count": meta["count"], "bands": meta.get("shN", {}).get("bands", 0), "planes": planes}, f, indent=1)
print("wrote", len(planes), "planes to", out, "count", meta["count"])

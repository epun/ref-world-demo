/** Crop a region of a png and nearest-upscale it, for reading a texture pattern.
 *  node scratch/crop.mjs in.png out.png x y w h scale */
import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const [, , inPath, outPath, xs, ys, ws, hs, ss] = process.argv;
const x = Number(xs);
const y = Number(ys);
const w = Number(ws);
const h = Number(hs);
const s = Number(ss ?? 1);
const src = PNG.sync.read(readFileSync(inPath));
const out = new PNG({ width: w * s, height: h * s });
for (let oy = 0; oy < h * s; oy++) {
  for (let ox = 0; ox < w * s; ox++) {
    const sx = x + Math.floor(ox / s);
    const sy = y + Math.floor(oy / s);
    const si = (sy * src.width + sx) * 4;
    const oi = (oy * out.width + ox) * 4;
    out.data[oi] = src.data[si];
    out.data[oi + 1] = src.data[si + 1];
    out.data[oi + 2] = src.data[si + 2];
    out.data[oi + 3] = 255;
  }
}
writeFileSync(outPath, PNG.sync.write(out));
console.log('wrote', outPath, out.width, out.height);

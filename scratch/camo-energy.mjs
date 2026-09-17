/**
 * How much MOTTLE is in a frame's sea and in its land — the number the
 * 2026-09-17 low-tilt camo report is about (scratch/tilt-camo.mjs writes the
 * frames; this reads them).
 *
 * A BLOTCH IS BIGGER THAN A PATCH. The blobs in the screenshot are two to four
 * hundred pixels across, so the standard deviation of a 96-pixel patch cannot
 * see one: inside a single blob the frame is smooth, and all a small patch
 * measures is the blob's own gradient. So the region is the WHOLE sea (or the
 * whole island), found by colour, and the measure is taken at two scales:
 *
 *   sd        the luminance spread over the region, mottle and marks together
 *   sdBlur24  the same after a 24-pixel box blur, which keeps a soft blob and
 *             throws away every fleck, stroke and prop — this is the camo
 *   hpRms     the residual, which is the fine speckle
 *
 * The UI bands are cut off top and bottom (the size readout, the tray, the
 * stick, the minimap) so a white pill cannot stand in for a wave.
 *
 *   node scratch/camo-energy.mjs scratch/tilt-before-phone-lowtilt.png \
 *                               scratch/tilt-after-phone-lowtilt.png
 */

import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const files = process.argv.slice(2);
if (files.length === 0) throw new Error('usage: camo-energy.mjs <png>...');

function plane(png) {
  const out = new Float64Array(png.width * png.height);
  for (let i = 0; i < out.length; i++) {
    out[i] =
      0.2126 * png.data[i * 4] + 0.7152 * png.data[i * 4 + 1] + 0.0722 * png.data[i * 4 + 2];
  }
  return { width: png.width, height: png.height, out };
}

function blur(p, r) {
  const { width, height, out } = p;
  const a = new Float64Array(width * height);
  const b = new Float64Array(width * height);
  for (let y = 0; y < height; y++) {
    let sum = 0;
    let n = 0;
    for (let x = 0; x < width; x++) {
      if (x === 0) {
        for (let k = 0; k <= r && k < width; k++) {
          sum += out[y * width + k];
          n++;
        }
      } else {
        const add = x + r;
        const drop = x - r - 1;
        if (add < width) {
          sum += out[y * width + add];
          n++;
        }
        if (drop >= 0) {
          sum -= out[y * width + drop];
          n--;
        }
      }
      a[y * width + x] = sum / n;
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = 0;
    let n = 0;
    for (let y = 0; y < height; y++) {
      if (y === 0) {
        for (let k = 0; k <= r && k < height; k++) {
          sum += a[k * width + x];
          n++;
        }
      } else {
        const add = y + r;
        const drop = y - r - 1;
        if (add < height) {
          sum += a[add * width + x];
          n++;
        }
        if (drop >= 0) {
          sum -= a[drop * width + x];
          n--;
        }
      }
      b[y * width + x] = sum / n;
    }
  }
  return { width, height, out: b };
}

/** sea = blue dominant, land = green dominant, both away from the UI bands. */
function masks(png) {
  const sea = new Uint8Array(png.width * png.height);
  const land = new Uint8Array(png.width * png.height);
  const top = Math.round(png.height * 0.06);
  const bottom = Math.round(png.height * 0.85);
  for (let y = top; y < bottom; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = y * png.width + x;
      const r = png.data[i * 4];
      const g = png.data[i * 4 + 1];
      const b = png.data[i * 4 + 2];
      if (b > g + 4 && b > r + 4) sea[i] = 1;
      else if (g > b + 12 && g > r + 4) land[i] = 1;
    }
  }
  return { sea: erode(sea, png.width, png.height, 26), land: erode(land, png.width, png.height, 26) };
}

/**
 * Pull a mask in by r pixels.
 *
 * THE BLUR LEAKS ACROSS THE COAST. The blurred plane is computed over the
 * whole frame, so a sea pixel within a blur radius of the bright island holds
 * some of the island — which put more spread in the blurred sea than in the
 * raw sea and swamped the measure. Eroding the mask by more than the radius is
 * the fix: every pixel measured has only its own region inside its blur.
 */
function erode(mask, width, height, r) {
  const rows = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let ok = 1;
      for (let k = -r; k <= r && ok; k++) {
        const xx = Math.min(width - 1, Math.max(0, x + k));
        if (!mask[y * width + xx]) ok = 0;
      }
      rows[y * width + x] = ok;
    }
  }
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let ok = 1;
      for (let k = -r; k <= r && ok; k++) {
        const yy = Math.min(height - 1, Math.max(0, y + k));
        if (!rows[yy * width + x]) ok = 0;
      }
      out[y * width + x] = ok;
    }
  }
  return out;
}

function spread(p, mask) {
  let s = 0;
  let s2 = 0;
  let n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const v = p.out[i];
    s += v;
    s2 += v * v;
    n++;
  }
  if (n === 0) return null;
  const mean = s / n;
  return { mean, sd: Math.sqrt(Math.max(0, s2 / n - mean * mean)), n };
}

for (const file of files) {
  const png = PNG.sync.read(readFileSync(file));
  const luma = plane(png);
  const soft = blur(luma, 24);
  const hp = { width: png.width, height: png.height, out: new Float64Array(luma.out.length) };
  for (let i = 0; i < luma.out.length; i++) hp.out[i] = luma.out[i] - soft.out[i];
  const { sea, land } = masks(png);
  const row = {};
  for (const [name, mask] of [['sea', sea], ['land', land]]) {
    const raw = spread(luma, mask);
    if (!raw) {
      row[name] = 'empty';
      continue;
    }
    row[name] = {
      px: raw.n,
      mean: Number(raw.mean.toFixed(2)),
      sd: Number(raw.sd.toFixed(3)),
      sdBlur24: Number(spread(soft, mask).sd.toFixed(3)),
      hpRms: Number(spread(hp, mask).sd.toFixed(3)),
    };
  }
  console.log(file.replace(/^.*\//, ''), JSON.stringify(row));
}

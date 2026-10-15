/**
 * RGBA pixel operations for atlas repacking: cut a region out of a page in its
 * logical (unrotated) orientation, store it rotated, blit with edge extrusion,
 * and convert between straight and premultiplied alpha.
 */

/** An RGBA8 image, rows top to bottom. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export function createImage(width: number, height: number): RgbaImage {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

/**
 * The `width`×`height` logical image of a region stored at (x, y) of `page`.
 * Spine atlases store a 90°-rotated region with its logical top-right corner
 * at the top-left of the packed rectangle: stored (px, py) = logical (w-1-py, px).
 */
export function readRegion(page: RgbaImage, x: number, y: number, width: number, height: number, degrees: number): RgbaImage {
  if (degrees !== 0 && degrees !== 90) throw new Error(`Unsupported region rotation ${degrees}`);
  const out = createImage(width, height);
  const src = page.data;
  const dst = out.data;
  for (let ly = 0; ly < height; ly++) {
    for (let lx = 0; lx < width; lx++) {
      const px = degrees === 90 ? x + ly : x + lx;
      const py = degrees === 90 ? y + (width - 1 - lx) : y + ly;
      if (px >= page.width || py >= page.height) throw new Error(`Region pixel (${px}, ${py}) outside the ${page.width}x${page.height} page`);
      const s = (py * page.width + px) * 4;
      const d = (ly * width + lx) * 4;
      dst[d] = src[s]!;
      dst[d + 1] = src[s + 1]!;
      dst[d + 2] = src[s + 2]!;
      dst[d + 3] = src[s + 3]!;
    }
  }
  return out;
}

/** The stored form of a logical image packed with a 90° rotation (inverse of {@link readRegion}). */
export function rotateForStorage(img: RgbaImage): RgbaImage {
  const { width: w, height: h } = img;
  const out = createImage(h, w);
  for (let py = 0; py < w; py++) {
    for (let px = 0; px < h; px++) {
      const s = (px * w + (w - 1 - py)) * 4;
      const d = (py * h + px) * 4;
      out.data.set(img.data.subarray(s, s + 4), d);
    }
  }
  return out;
}

/** Copy `src` into `dst` at (x, y) and repeat its edge pixels `extrude` pixels outwards. */
export function blit(dst: RgbaImage, src: RgbaImage, x: number, y: number, extrude: number): void {
  for (let sy = -extrude; sy < src.height + extrude; sy++) {
    const dy = y + sy;
    if (dy < 0 || dy >= dst.height) continue;
    const cy = Math.min(src.height - 1, Math.max(0, sy));
    for (let sx = -extrude; sx < src.width + extrude; sx++) {
      const dx = x + sx;
      if (dx < 0 || dx >= dst.width) continue;
      const cx = Math.min(src.width - 1, Math.max(0, sx));
      const s = (cy * src.width + cx) * 4;
      dst.data.set(src.data.subarray(s, s + 4), (dy * dst.width + dx) * 4);
    }
  }
}

/** Straight → premultiplied alpha, in place. */
export function premultiply(img: RgbaImage): void {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3]!;
    if (a === 255) continue;
    d[i] = Math.round((d[i]! * a) / 255);
    d[i + 1] = Math.round((d[i + 1]! * a) / 255);
    d[i + 2] = Math.round((d[i + 2]! * a) / 255);
  }
}

/** Premultiplied → straight alpha, in place (lossy for low alpha). */
export function unpremultiply(img: RgbaImage): void {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3]!;
    if (a === 255 || a === 0) continue;
    d[i] = Math.min(255, Math.round((d[i]! * 255) / a));
    d[i + 1] = Math.min(255, Math.round((d[i + 1]! * 255) / a));
    d[i + 2] = Math.min(255, Math.round((d[i + 2]! * 255) / a));
  }
}

/**
 * Area-average (box) resample to `width`×`height`, for lower-resolution
 * page tiers. Run it on premultiplied pixels: each output pixel is the
 * coverage-weighted mean of the source pixels under it, so a filter
 * footprint never exceeds one output pixel (≤ 2 source pixels at 0.5×)
 * and never reaches a neighbouring region across the atlas padding, as a
 * wider kernel (Lanczos, cubic) would.
 */
export function resizeArea(img: RgbaImage, width: number, height: number): RgbaImage {
  if (width === img.width && height === img.height) return { width, height, data: img.data.slice() };
  // Horizontal then vertical pass, float accumulation.
  const tmp = new Float32Array(width * img.height * 4);
  const xWeights = areaWeights(img.width, width);
  for (let y = 0; y < img.height; y++) {
    const row = y * img.width * 4;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      for (const [sx, w] of xWeights[x]!) {
        const s = row + sx * 4;
        tmp[o] = tmp[o]! + img.data[s]! * w;
        tmp[o + 1] = tmp[o + 1]! + img.data[s + 1]! * w;
        tmp[o + 2] = tmp[o + 2]! + img.data[s + 2]! * w;
        tmp[o + 3] = tmp[o + 3]! + img.data[s + 3]! * w;
      }
    }
  }
  const out = createImage(width, height);
  const yWeights = areaWeights(img.height, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (const [sy, w] of yWeights[y]!) {
        const s = (sy * width + x) * 4;
        r += tmp[s]! * w;
        g += tmp[s + 1]! * w;
        b += tmp[s + 2]! * w;
        a += tmp[s + 3]! * w;
      }
      const o = (y * width + x) * 4;
      out.data[o] = Math.round(r);
      out.data[o + 1] = Math.round(g);
      out.data[o + 2] = Math.round(b);
      out.data[o + 3] = Math.round(a);
    }
  }
  return out;
}

/** Per output index: [source index, weight] pairs covering it (weights sum to 1). */
function areaWeights(srcSize: number, dstSize: number): [number, number][][] {
  const scale = srcSize / dstSize;
  const out: [number, number][][] = [];
  for (let d = 0; d < dstSize; d++) {
    const start = d * scale;
    const end = start + scale;
    const list: [number, number][] = [];
    for (let s = Math.floor(start); s < Math.min(srcSize, Math.ceil(end)); s++) {
      const w = Math.min(end, s + 1) - Math.max(start, s);
      if (w > 1e-9) list.push([s, w / scale]);
    }
    out.push(list);
  }
  return out;
}

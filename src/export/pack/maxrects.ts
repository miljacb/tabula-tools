/**
 * MaxRects bin packing (Jukka Jylänki, "A Thousand Ways to Pack the Bin"),
 * best-short-side-fit with optional 90° rotation, plus multi-page packing that
 * shrinks each page to the smallest size that still holds its rectangles.
 */

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where {@link packPages} put a rectangle. */
export interface Placement {
  /** Index into the input list. */
  id: number;
  page: number;
  x: number;
  y: number;
  /** Stored rotated by 90° (width and height swapped in the page). */
  rotated: boolean;
}

/** One packed page. */
export interface PackedPage {
  width: number;
  height: number;
  /** Sum of the rectangles' areas / page area. */
  fill: number;
}

/** Options for {@link packPages}. */
export interface PackOptions {
  maxWidth: number;
  maxHeight: number;
  /** Allow 90° rotation. */
  rotation: boolean;
  /** Page sizes are powers of two. */
  powerOfTwo: boolean;
}

/** A single MaxRects bin. */
export class MaxRectsBin {
  private free: Rect[];
  usedArea = 0;

  constructor(readonly width: number, readonly height: number, private readonly rotation: boolean) {
    this.free = [{ x: 0, y: 0, width, height }];
  }

  /** Place a `w`×`h` rectangle; null if it does not fit. */
  insert(w: number, h: number): { x: number; y: number; rotated: boolean } | null {
    let best: { x: number; y: number; rotated: boolean } | null = null;
    let bestShort = Infinity;
    let bestLong = Infinity;
    const consider = (fr: Rect, rw: number, rh: number, rotated: boolean): void => {
      if (rw > fr.width || rh > fr.height) return;
      const dw = fr.width - rw;
      const dh = fr.height - rh;
      const short = Math.min(dw, dh);
      const long = Math.max(dw, dh);
      if (short < bestShort || (short === bestShort && long < bestLong)) {
        best = { x: fr.x, y: fr.y, rotated };
        bestShort = short;
        bestLong = long;
      }
    };
    for (const fr of this.free) {
      consider(fr, w, h, false);
      if (this.rotation && w !== h) consider(fr, h, w, true);
    }
    if (!best) return null;
    const placed: { x: number; y: number; rotated: boolean } = best;
    const used = placed.rotated ? { x: placed.x, y: placed.y, width: h, height: w } : { x: placed.x, y: placed.y, width: w, height: h };
    this.place(used);
    this.usedArea += w * h;
    return placed;
  }

  private place(used: Rect): void {
    const next: Rect[] = [];
    for (const fr of this.free) {
      if (used.x >= fr.x + fr.width || used.x + used.width <= fr.x || used.y >= fr.y + fr.height || used.y + used.height <= fr.y) {
        next.push(fr);
        continue;
      }
      if (used.x > fr.x) next.push({ x: fr.x, y: fr.y, width: used.x - fr.x, height: fr.height });
      if (used.x + used.width < fr.x + fr.width) {
        next.push({ x: used.x + used.width, y: fr.y, width: fr.x + fr.width - used.x - used.width, height: fr.height });
      }
      if (used.y > fr.y) next.push({ x: fr.x, y: fr.y, width: fr.width, height: used.y - fr.y });
      if (used.y + used.height < fr.y + fr.height) {
        next.push({ x: fr.x, y: used.y + used.height, width: fr.width, height: fr.y + fr.height - used.y - used.height });
      }
    }
    // Drop free rectangles contained in another.
    this.free = next.filter((a, i) => !next.some((b, j) => j !== i && contains(b, a) && (!contains(a, b) || j < i)));
  }
}

function contains(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}

/** Pack all `sizes` into one bin of `width`×`height`, in the given order; null if any does not fit. */
function packAll(sizes: readonly { width: number; height: number }[], order: readonly number[], width: number, height: number, rotation: boolean) {
  const bin = new MaxRectsBin(width, height, rotation);
  const out: { id: number; x: number; y: number; rotated: boolean }[] = [];
  for (const id of order) {
    const p = bin.insert(sizes[id]!.width, sizes[id]!.height);
    if (!p) return null;
    out.push({ id, ...p });
  }
  return out;
}

/** Candidate page sizes up to the maximum, smallest area first (squarer first on ties). */
function pageSizes(options: PackOptions): [number, number][] {
  const steps = (max: number): number[] => {
    if (!options.powerOfTwo) return [max];
    const out: number[] = [];
    for (let s = 16; s < max; s *= 2) out.push(s);
    out.push(max);
    return out;
  };
  const sizes: [number, number][] = [];
  for (const w of steps(options.maxWidth)) for (const h of steps(options.maxHeight)) sizes.push([w, h]);
  return sizes.sort((a, b) => a[0] * a[1] - b[0] * b[1] || Math.abs(a[0] - a[1]) - Math.abs(b[0] - b[1]));
}

/**
 * Pack rectangles into as few pages as possible (each at most
 * maxWidth×maxHeight), largest first; every page is then shrunk to the
 * smallest candidate size that still holds its rectangles.
 * Throws if a rectangle is larger than a page.
 */
export function packPages(sizes: readonly { width: number; height: number }[], options: PackOptions): { pages: PackedPage[]; placements: Placement[] } {
  const fits = (s: { width: number; height: number }): boolean =>
    (s.width <= options.maxWidth && s.height <= options.maxHeight) || (options.rotation && s.height <= options.maxWidth && s.width <= options.maxHeight);
  sizes.forEach((s, i) => {
    if (!fits(s)) throw new Error(`Rectangle ${i} (${s.width}x${s.height}) does not fit a ${options.maxWidth}x${options.maxHeight} page`);
  });
  const order = sizes.map((_, i) => i).sort((a, b) =>
    Math.max(sizes[b]!.width, sizes[b]!.height) - Math.max(sizes[a]!.width, sizes[a]!.height) ||
    sizes[b]!.width * sizes[b]!.height - sizes[a]!.width * sizes[a]!.height);

  const pages: PackedPage[] = [];
  const placements: Placement[] = [];
  let remaining = order;
  const candidates = pageSizes(options);
  while (remaining.length > 0) {
    // Fill a full-size page greedily; what does not fit goes to the next page.
    const bin = new MaxRectsBin(options.maxWidth, options.maxHeight, options.rotation);
    const taken: number[] = [];
    const rest: number[] = [];
    for (const id of remaining) (bin.insert(sizes[id]!.width, sizes[id]!.height) ? taken : rest).push(id);
    const area = taken.reduce((n, id) => n + sizes[id]!.width * sizes[id]!.height, 0);
    let packed: { id: number; x: number; y: number; rotated: boolean }[] | null = null;
    let size: [number, number] = [options.maxWidth, options.maxHeight];
    for (const [w, h] of candidates) {
      if (w * h < area) continue;
      packed = packAll(sizes, taken, w, h, options.rotation);
      if (packed) {
        size = [w, h];
        break;
      }
    }
    packed ??= packAll(sizes, taken, options.maxWidth, options.maxHeight, options.rotation)!;
    const page = pages.length;
    pages.push({ width: size[0], height: size[1], fill: area / (size[0] * size[1]) });
    for (const p of packed) placements.push({ ...p, page });
    remaining = rest;
  }
  placements.sort((a, b) => a.id - b.id);
  return { pages, placements };
}

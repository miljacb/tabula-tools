/**
 * Atlas repacking: rebuild atlas pages so skeletons drawn together (a
 * "co-draw group", e.g. reel symbols + reel frame + buttons) share as few
 * pages as possible. Regions a group's skeletons use are cut from the source
 * pages and packed (MaxRects) into the group's own pages; a region used by
 * several groups is copied into each. Trim offsets and original sizes are
 * kept, so attachments map exactly as before.
 */

import type { AtlasData, AtlasPage, AtlasRegion, SkeletonData } from '../../core/types.js';
import { regionPathsOf } from '../../core/regions.js';
import { packPages } from './maxrects.js';
import { blit, createImage, premultiply, readRegion, resizeArea, rotateForStorage, unpremultiply } from './image.js';
import type { RgbaImage } from './image.js';

/** A skeleton to repack with the atlas it was exported with. */
export interface RepackSkeleton {
  data: SkeletonData;
  atlas: AtlasData;
  /** Directory the atlas page images are in. */
  atlasDir: string;
  /**
   * Higher-resolution exports of the same skeleton for tiers above 1, by
   * tier (e.g. 2 → `<name>@2x.atlas`): same region names, pixels at that scale.
   */
  hiRes?: Map<number, { atlas: AtlasData; atlasDir: string }>;
}

/** A co-draw group: skeleton name patterns (`*` and `?` wildcards). */
export interface RepackGroupSpec {
  name: string;
  skeletons: string[];
}

/** Options for {@link repackAtlases}. */
export interface RepackOptions {
  /** Largest page side, e.g. 2048 or 4096. */
  maxSize: number;
  /** Empty pixels between regions. */
  padding: number;
  /** Edge pixels repeated around each region (helps filtering at region borders). */
  extrude: number;
  /** Premultiply alpha in the output pages. Default: as the source pages. */
  pma?: boolean;
  /** Allow 90° rotation. */
  rotation: boolean;
  /** Power-of-two page sizes. */
  powerOfTwo: boolean;
  /** Page image extension, e.g. 'png'. */
  extension: string;
}

/** One repacked group. */
export interface RepackedGroup {
  name: string;
  skeletons: SkeletonData[];
  atlas: AtlasData;
  images: RgbaImage[];
  /** Source pages (by atlasDir/name) the group's regions came from. */
  sourcePages: { key: string; page: AtlasPage }[];
  /** Region pixels (trimmed sizes). */
  regionPixels: number;
  /** Regions also packed into another group. */
  sharedRegions: string[];
  /** Where each region was packed and where it came from (for tiers rendered from higher-resolution exports). */
  placements: RegionPlacement[];
}

/** A packed region: its 1× rectangle in the output and its source. */
export interface RegionPlacement {
  key: string;
  page: number;
  /** Top-left of the stored pixels in the output page. */
  x: number;
  y: number;
  rotated: boolean;
  /** The region in its source atlas. */
  source: AtlasRegion;
  /** The member's higher-resolution exports, by tier. */
  hiRes?: Map<number, { atlas: AtlasData; atlasDir: string }>;
}

/** Loads a source page image as straight or premultiplied RGBA (as stored). */
export type PageLoader = (atlasDir: string, page: AtlasPage) => Promise<RgbaImage>;

/** Glob match on skeleton names (`*`, `?`). */
export function matchesPattern(name: string, pattern: string): boolean {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  return re.test(name);
}

/**
 * Assign skeletons to groups (a group naming the skeleton exactly, else the
 * first group with a matching pattern; unmatched skeletons
 * form a group named "misc"). Without specs, everything is one group "atlas".
 */
export function assignGroups(skeletons: RepackSkeleton[], specs: RepackGroupSpec[]): Map<string, RepackSkeleton[]> {
  const groups = new Map<string, RepackSkeleton[]>();
  if (specs.length === 0) {
    groups.set('atlas', skeletons);
    return groups;
  }
  for (const spec of specs) groups.set(spec.name, []);
  for (const s of skeletons) {
    // A group listing the exact name wins over patterns that also match.
    const spec = specs.find((g) => g.skeletons.includes(s.data.name)) ?? specs.find((g) => g.skeletons.some((p) => matchesPattern(s.data.name, p)));
    const name = spec?.name ?? 'misc';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name)!.push(s);
  }
  for (const [name, list] of groups) if (list.length === 0) groups.delete(name);
  return groups;
}

interface SourceRegion {
  key: string;
  region: AtlasRegion;
  atlasDir: string;
  hiRes?: Map<number, { atlas: AtlasData; atlasDir: string }>;
}

/** Repack the atlases of `skeletons` into one atlas per co-draw group. */
export async function repackAtlases(
  skeletons: RepackSkeleton[], specs: RepackGroupSpec[], options: RepackOptions, loadPage: PageLoader,
): Promise<RepackedGroup[]> {
  const groups = assignGroups(skeletons, specs);
  const usedBy = new Map<string, Set<string>>();
  const plans: { name: string; members: RepackSkeleton[]; regions: SourceRegion[] }[] = [];
  for (const [name, members] of groups) {
    const regions = new Map<string, SourceRegion>();
    for (const member of members) {
      for (const key of regionPathsOf(member.data)) {
        const region = member.atlas.regions.get(key);
        if (!region) throw new Error(`${member.data.name}: region "${key}" is not in its atlas`);
        const existing = regions.get(key);
        if (existing && !sameSource(existing, region, member.atlasDir)) {
          throw new Error(`Region "${key}" differs between the atlases of group "${name}"`);
        }
        regions.set(key, { key, region, atlasDir: member.atlasDir, hiRes: member.hiRes });
        if (!usedBy.has(key)) usedBy.set(key, new Set());
        usedBy.get(key)!.add(name);
      }
    }
    plans.push({ name, members, regions: [...regions.values()] });
  }

  const load = cachedLoader(loadPage);
  const page = (s: SourceRegion): Promise<RgbaImage> => load(s.atlasDir, s.region.page);

  const out: RepackedGroup[] = [];
  for (const plan of plans) {
    const pma = options.pma ?? plan.regions.every((s) => s.region.page.pma);
    const border = 2 * options.extrude + options.padding;
    const sizes = plan.regions.map((s) => ({ width: s.region.width + border, height: s.region.height + border }));
    const packed = packPages(sizes, { maxWidth: options.maxSize, maxHeight: options.maxSize, rotation: options.rotation, powerOfTwo: options.powerOfTwo });
    const template = plan.regions[0]?.region.page;
    const pages: AtlasPage[] = packed.pages.map((p, i) => ({
      name: `${plan.name}${i === 0 ? '' : `_${i + 1}`}.${options.extension}`,
      width: p.width,
      height: p.height,
      format: 'RGBA8888',
      minFilter: template?.minFilter ?? 'Linear',
      magFilter: template?.magFilter ?? 'Linear',
      uWrap: 'ClampToEdge',
      vWrap: 'ClampToEdge',
      pma,
    }));
    const images = pages.map((p) => createImage(p.width, p.height));
    const regions = new Map<string, AtlasRegion>();
    const placements: RegionPlacement[] = [];
    let regionPixels = 0;
    for (let i = 0; i < plan.regions.length; i++) {
      const source = plan.regions[i]!;
      const r = source.region;
      const placement = packed.placements[i]!;
      let pixels = readRegion(await page(source), r.x, r.y, r.width, r.height, r.degrees);
      if (r.page.pma !== pma) {
        pixels = { ...pixels, data: pixels.data.slice() };
        (pma ? premultiply : unpremultiply)(pixels);
      }
      const stored = placement.rotated ? rotateForStorage(pixels) : pixels;
      const x = placement.x + options.extrude + Math.floor(options.padding / 2);
      const y = placement.y + options.extrude + Math.floor(options.padding / 2);
      blit(images[placement.page]!, stored, x, y, options.extrude);
      regions.set(source.key, { ...r, page: pages[placement.page]!, x, y, degrees: placement.rotated ? 90 : 0 });
      placements.push({ key: source.key, page: placement.page, x, y, rotated: placement.rotated, source: r, hiRes: source.hiRes });
      regionPixels += r.width * r.height;
    }
    // Keep the source order of regions (atlas keys of indexed regions depend on it).
    const ordered = new Map([...regions].sort((a, b) => order(plan.members, a[0]) - order(plan.members, b[0])));
    const sourcePages = new Map<string, AtlasPage>();
    for (const s of plan.regions) sourcePages.set(`${s.atlasDir}/${s.region.page.name}`, s.region.page);
    out.push({
      name: plan.name,
      skeletons: plan.members.map((m) => m.data),
      atlas: { pages, regions: ordered },
      images,
      sourcePages: [...sourcePages].map(([key, p]) => ({ key, page: p })),
      regionPixels,
      sharedRegions: plan.regions.filter((s) => usedBy.get(s.key)!.size > 1).map((s) => s.key),
      placements,
    });
  }
  return out;
}

/** `loadPage` that loads each source page (by folder and name) once. */
function cachedLoader(loadPage: PageLoader): PageLoader {
  const cache = new Map<string, Promise<RgbaImage>>();
  return (dir, page) => {
    const key = `${dir}/${page.name}`;
    if (!cache.has(key)) cache.set(key, loadPage(dir, page));
    return cache.get(key)!;
  };
}

function sameSource(a: SourceRegion, b: AtlasRegion, atlasDir: string): boolean {
  const r = a.region;
  return a.atlasDir === atlasDir && r.page.name === b.page.name && r.x === b.x && r.y === b.y && r.width === b.width && r.height === b.height && r.degrees === b.degrees;
}

function order(members: RepackSkeleton[], key: string): number {
  for (const m of members) {
    let i = 0;
    for (const k of m.atlas.regions.keys()) {
      if (k === key) return i;
      i++;
    }
  }
  return Number.MAX_SAFE_INTEGER;
}

/**
 * The pages of `group` at a tier above 1, from the members' higher-resolution
 * exports (never upscaled): the 1× layout scaled to the tier page size, each
 * region cut from the export at that tier. The regions are matched by name;
 * their trim may differ from the 1× export, so each is cut in original-image
 * space to the 1× trim rectangle. Pixels are in the group's alpha mode;
 * resampling is done premultiplied.
 */
export async function renderTierPages(group: RepackedGroup, tier: number, pageSize: (page: AtlasPage) => { width: number; height: number }, loadPage: PageLoader): Promise<RgbaImage[]> {
  const pma = group.atlas.pages[0]?.pma ?? false;
  const sizes = group.atlas.pages.map(pageSize);
  const images = sizes.map((s) => createImage(s.width, s.height));
  const page = cachedLoader(loadPage);
  for (const pl of group.placements) {
    const hi = pl.hiRes?.get(tier);
    if (!hi) throw new Error(`Tier ${tier}x: region "${pl.key}" has no ${tier}x export`);
    const h = hi.atlas.regions.get(pl.key);
    if (!h) throw new Error(`Tier ${tier}x: region "${pl.key}" is not in the ${tier}x atlas`);
    const r = pl.source;
    const k = h.originalWidth / r.originalWidth; // the export's actual scale
    // The 1× trim rectangle (top-left origin) in the hi-res original image.
    const left = r.offsetX * k;
    const top = (r.originalHeight - r.offsetY - r.height) * k;
    const cropW = Math.max(1, Math.round(r.width * k));
    const cropH = Math.max(1, Math.round(r.height * k));
    const hiPixels = readRegion(await page(hi.atlasDir, h.page), h.x, h.y, h.width, h.height, h.degrees);
    if (!h.page.pma) premultiply(hiPixels); // resample premultiplied (readRegion returned a copy)
    const crop = createImage(cropW, cropH);
    const dx = Math.round(h.offsetX - left);
    const dy = Math.round(h.originalHeight - h.offsetY - h.height - top);
    blit(crop, hiPixels, dx, dy, 0);
    // Scale the 1× placement to the tier page.
    const out = group.atlas.pages[pl.page]!;
    const sx = sizes[pl.page]!.width / out.width;
    const sy = sizes[pl.page]!.height / out.height;
    const x0 = Math.round(pl.x * sx);
    const y0 = Math.round(pl.y * sy);
    const w = Math.round((pl.x + (pl.rotated ? r.height : r.width)) * sx) - x0;
    const hgt = Math.round((pl.y + (pl.rotated ? r.width : r.height)) * sy) - y0;
    const logical = resizeArea(crop, pl.rotated ? hgt : w, pl.rotated ? w : hgt);
    blit(images[pl.page]!, pl.rotated ? rotateForStorage(logical) : logical, x0, y0, 0);
  }
  if (!pma) for (const image of images) unpremultiply(image);
  return images;
}

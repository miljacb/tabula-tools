/**
 * Page output: decode and encode page images (sharp), pick KTX2 codecs per
 * page, write every tier of a repacked group, and load the higher-resolution
 * exports behind tiers above 1.
 */

import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { AtlasParser } from '../core/adapters/atlas-parser.js';
import type { RepackGroupSpec, RepackedGroup } from './pack/repack.js';
import { premultiply, resizeArea, unpremultiply } from './pack/image.js';
import type { RgbaImage } from './pack/image.js';
import { encodeKtx2 } from './pack/ktx2.js';
import type { Ktx2EncodeOptions } from './pack/ktx2.js';
import type { AtlasData, AtlasPage } from '../core/types.js';
import { tierFileName, tierSize } from '../core/texture-formats.js';
import type { BasisCodec, TextureManifest } from '../core/texture-formats.js';

/** Page image encodings. */
export type PageImageFormat = 'png' | 'webp' | 'webp-lossless';

/**
 * Groups file. Besides packing settings, `ktx2` (default codec), `tiers`, and
 * per group `ktx2` and `pages` (page name or base name, e.g. "game_1", →
 * codec or "none") choose the compressed pages.
 */
export interface RepackGroupsFile {
  maxSize?: number;
  padding?: number;
  extrude?: number;
  ktx2?: BasisCodec | 'none';
  tiers?: number[];
  groups?: (RepackGroupSpec & { ktx2?: BasisCodec | 'none'; pages?: Record<string, BasisCodec | 'none'> })[];
}

/** How {@link encodeGroupPages} encodes a group's pages. */
export interface PageOutputOptions {
  imageFormat: PageImageFormat;
  /** WebP quality (lossy). */
  quality?: number;
  /** Tiers, 1 included. */
  tiers: readonly number[];
  /** KTX2 codec of a page, or null for none. */
  ktx2For: (pageName: string, index: number) => BasisCodec | null;
  ktx2Quality?: number;
  /**
   * KTX2 encoder (default: the `ktx` tool); the export passes a caching one
   * (`cachedKtx2`). Returning null drops KTX2 for that page (it loads as an image).
   */
  encodeKtx2?: (image: RgbaImage, options: Ktx2EncodeOptions, file: string) => Promise<Uint8Array | null>;
  /** Pages at a tier above 1 (rendered from higher-resolution exports, see `renderTierPages`); required for such tiers. */
  tierPages?: (tier: number) => Promise<RgbaImage[]>;
}

/** KTX2 codec per page from the groups file and the CLI default. */
export function ktx2Selector(config: RepackGroupsFile, groupName: string, cliDefault?: BasisCodec | 'none'): (pageName: string) => BasisCodec | null {
  const spec = config.groups?.find((g) => g.name === groupName);
  return (pageName) => {
    const base = pageName.replace(/\.[^.]+$/, '');
    const choice = spec?.pages?.[pageName] ?? spec?.pages?.[base] ?? spec?.ktx2 ?? cliDefault ?? config.ktx2 ?? 'none';
    return choice === 'none' ? null : choice;
  };
}

/**
 * Encode every page of `group` at every tier: the image format, plus KTX2
 * where `ktx2For` picks a codec. Tier images are area-resampled in
 * premultiplied space; KTX2 pages are always premultiplied (flagged in the
 * DFD). `emit` receives each file. Returns the group's texture manifest.
 */
export async function encodeGroupPages(
  group: RepackedGroup,
  options: PageOutputOptions,
  emit: (name: string, bytes: Uint8Array) => Promise<void> | void,
): Promise<TextureManifest> {
  const tiers = [...new Set([1, ...options.tiers])].sort((a, b) => b - a);
  const encodeKtx = options.encodeKtx2 ?? encodeKtx2;
  const manifest: TextureManifest = { version: 1, tiers, pages: {} };
  const above = new Map<number, RgbaImage[]>();
  for (const tier of tiers.filter((t) => t > 1)) {
    if (!options.tierPages) throw new Error(`Tier ${tier}x needs higher-resolution exports (tierPages)`);
    above.set(tier, await options.tierPages(tier));
  }
  for (let i = 0; i < group.images.length; i++) {
    const page = group.atlas.pages[i]!;
    const source = group.images[i]!;
    let codec = options.ktx2For(page.name, i);
    const files: Record<string, number> = {};
    let pma: RgbaImage | null = null;
    if (page.pma) pma = source;
    else if (codec || tiers.length > 1) { pma = { ...source, data: source.data.slice() }; premultiply(pma); }
    for (const tier of tiers) {
      const size = tierSize(page.width, page.height, tier);
      let pmaTier = tier === 1 ? pma : tier < 1 ? resizeArea(pma!, size.width, size.height) : null;
      let image = source;
      if (tier > 1) {
        image = above.get(tier)![i]!;
        if (page.pma) pmaTier = image;
        else { pmaTier = { ...image, data: image.data.slice() }; premultiply(pmaTier); }
      } else if (tier !== 1) {
        image = pmaTier!;
        if (!page.pma) { image = { ...pmaTier!, data: pmaTier!.data.slice() }; unpremultiply(image); }
      }
      const imageName = tierFileName(page.name, tier);
      const bytes = new Uint8Array(await encodePageImage(image, options.imageFormat, options.quality));
      await emit(imageName, bytes);
      files[imageName] = bytes.length;
      if (codec) {
        const ktxName = tierFileName(page.name, tier, 'ktx2');
        const ktx = await encodeKtx(pmaTier!, {
          codec, quality: options.ktx2Quality, mipmaps: page.minFilter.toLowerCase().includes('mipmap'),
        }, ktxName);
        if (ktx) {
          await emit(ktxName, ktx);
          files[ktxName] = ktx.length;
        } else {
          codec = null;
          for (const name of Object.keys(files)) if (name.endsWith('.ktx2')) delete files[name];
        }
      }
    }
    manifest.pages[page.name] = { width: page.width, height: page.height, ktx2: codec, files };
  }
  return manifest;
}

/** `<group>.textures.json`. */
export function manifestFileName(groupName: string): string {
  return `${groupName}.textures.json`;
}

type Sharp = typeof import('sharp');
let sharpModule: Promise<Sharp> | null = null;

/** sharp (image codec) is an optional dependency, loaded on the first page decode or encode. */
function loadSharp(): Promise<Sharp> {
  sharpModule ??= import('sharp').then((m) => (m as unknown as { default: Sharp }).default ?? m, () => {
    throw new Error('Reading and writing page images needs the optional dependency "sharp" (npm install sharp)');
  });
  return sharpModule;
}

/** Decode an image file to RGBA8 (straight alpha, as stored). */
export async function decodeImage(path: string): Promise<RgbaImage> {
  const sharp = await loadSharp();
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
}

/** Decode a page image to RGBA8 (straight alpha, as stored). */
export async function loadPageImage(atlasDir: string, page: AtlasPage): Promise<RgbaImage> {
  const image = await decodeImage(join(atlasDir, page.name));
  if (image.width !== page.width || image.height !== page.height) {
    throw new Error(`${page.name} is ${image.width}x${image.height}, the atlas says ${page.width}x${page.height}`);
  }
  return image;
}

/** Encode an RGBA8 page. */
export async function encodePageImage(image: RgbaImage, format: PageImageFormat, quality = 90): Promise<Buffer> {
  const sharp = await loadSharp();
  const img = sharp(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength), {
    raw: { width: image.width, height: image.height, channels: 4 },
  });
  if (format === 'png') return img.png({ compressionLevel: 9 }).toBuffer();
  if (format === 'webp-lossless') return img.webp({ lossless: true, effort: 6 }).toBuffer();
  return img.webp({ quality, alphaQuality: 100, effort: 6 }).toBuffer();
}

/**
 * Higher-resolution exports for the tiers above 1: `<name>@<tier>x.atlas`
 * next to the skeleton JSON (e.g. `symbol1@2x.atlas`), pages next to it.
 * A missing one is an error: tiers above 1 are never upscaled.
 */
export async function loadHiResAtlases(jsonFile: string, tiers: readonly number[]): Promise<Map<number, { atlas: AtlasData; atlasDir: string }> | undefined> {
  const above = tiers.filter((t) => t > 1);
  if (!above.length) return undefined;
  const out = new Map<number, { atlas: AtlasData; atlasDir: string }>();
  for (const tier of above) {
    const path = `${jsonFile.replace(/\.json$/, '')}@${+tier.toFixed(4)}x.atlas`;
    const text = await readFile(path, 'utf-8').catch(() => null);
    if (text === null) throw new Error(`Tier ${tier}x needs ${basename(path)} (the ${tier}x export of ${basename(jsonFile)})`);
    out.set(tier, { atlas: new AtlasParser().parse(text), atlasDir: dirname(path) });
  }
  return out;
}

/** Repack statistics: per group regions, page fill, file sizes and GPU memory per tier. */

import { stat } from 'node:fs/promises';
import type { RepackedGroup } from './pack/repack.js';
import type { AtlasPage } from 'tabula-pixi/core/types.js';
import { tierSize, transcodedBytes } from 'tabula-pixi/core/texture-formats.js';
import type { BasisCodec, TextureManifest } from 'tabula-pixi/core/texture-formats.js';

/** Summary of one group, as written to repack-report.json. */
export interface RepackGroupReport {
  name: string;
  skeletons: string[];
  regions: number;
  sharedRegions: number;
  regionMegapixels: number;
  source: { pages: string[]; megapixels: number; vramBytes: number; fileBytes: number };
  output: {
    pages: { name: string; width: number; height: number; fill: number; fileBytes: number; ktx2: BasisCodec | null; files: Record<string, number> }[];
    megapixels: number;
    /** RGBA8 at 1×. */
    vramBytes: number;
    /** GPU memory per tier when KTX2 pages are transcoded to an 8 bpp block format (ASTC 4×4, BC7, ETC2) and the rest load as RGBA8. */
    compressedVramBytes: Record<string, number>;
    /** RGBA8 per tier. */
    tierVramBytes: Record<string, number>;
    fileBytes: number;
  };
}

/** Size, fill and memory summary of a repacked group and its encoded pages. */
export async function groupReport(group: RepackedGroup, manifest: TextureManifest): Promise<RepackGroupReport> {
  const mpx = (n: number): number => +(n / 1e6).toFixed(3);
  let sourceFileBytes = 0;
  for (const { key } of group.sourcePages) sourceFileBytes += (await stat(key).catch(() => null))?.size ?? 0;
  const sourcePixels = group.sourcePages.reduce((n, { page }) => n + page.width * page.height, 0);
  const outPixels = group.atlas.pages.reduce((n, p) => n + p.width * p.height, 0);
  return {
    name: group.name,
    skeletons: group.skeletons.map((s) => s.name),
    regions: group.atlas.regions.size,
    sharedRegions: group.sharedRegions.length,
    regionMegapixels: mpx(group.regionPixels),
    source: { pages: group.sourcePages.map((p) => p.page.name), megapixels: mpx(sourcePixels), vramBytes: sourcePixels * 4, fileBytes: sourceFileBytes },
    output: {
      pages: group.atlas.pages.map((p) => ({
        name: p.name, width: p.width, height: p.height,
        fill: +(regionPixelsOn(group, p) / (p.width * p.height)).toFixed(3), fileBytes: manifest.pages[p.name]!.files[p.name]!,
        ktx2: manifest.pages[p.name]!.ktx2, files: manifest.pages[p.name]!.files,
      })),
      megapixels: mpx(outPixels),
      vramBytes: outPixels * 4,
      ...tierVram(group, manifest),
      fileBytes: group.atlas.pages.reduce((n, p) => n + manifest.pages[p.name]!.files[p.name]!, 0),
    },
  };
}

function tierVram(group: RepackedGroup, manifest: TextureManifest): { compressedVramBytes: Record<string, number>; tierVramBytes: Record<string, number> } {
  const compressedVramBytes: Record<string, number> = {};
  const tierVramBytes: Record<string, number> = {};
  for (const tier of manifest.tiers) {
    let rgba = 0;
    let compressed = 0;
    for (const p of group.atlas.pages) {
      const { width, height } = tierSize(p.width, p.height, tier);
      rgba += width * height * 4;
      compressed += manifest.pages[p.name]!.ktx2 ? transcodedBytes('astc', width, height) : width * height * 4;
    }
    tierVramBytes[String(tier)] = rgba;
    compressedVramBytes[String(tier)] = compressed;
  }
  return { compressedVramBytes, tierVramBytes };
}

function regionPixelsOn(group: RepackedGroup, page: AtlasPage): number {
  let n = 0;
  for (const r of group.atlas.regions.values()) if (r.page === page) n += r.width * r.height;
  return n;
}

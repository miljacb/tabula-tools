/**
 * `tabula repack`: rebuild atlas pages per co-draw group (see
 * export/pack/repack.ts), write the pages, one `.atlas` per group, optionally
 * compiled `.tabula` files that embed their group's atlas, and a report.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { collectSkeletonFiles, loadAtlasNextTo } from '../../export/sources.js';
import { compileSkeleton } from '../../core/slb-writer.js';
import { bakeToBuffer } from '../../core/bake-report.js';
import { loadValidatedSkeleton } from '../../export/compile.js';
import { encodeGroupPages, ktx2Selector, loadHiResAtlases, loadPageImage, manifestFileName } from '../../export/pages.js';
import type { PageImageFormat, RepackGroupsFile } from '../../export/pages.js';
import { writeAtlasText } from '../../export/atlas-writer.js';
import { renderTierPages, repackAtlases } from '../../export/pack/repack.js';
import type { RepackSkeleton } from '../../export/pack/repack.js';
import { DEFAULT_BAKE_MAX_ERROR } from '../../core/baked-format.js';
import { groupReport } from '../../export/repack-report.js';
import type { RepackGroupReport } from '../../export/repack-report.js';
import { tierFileName, tierSize } from '../../core/texture-formats.js';
import type { BasisCodec } from '../../core/texture-formats.js';
import { printBakeSummary } from './bake.js';
import { printWarning } from './compile.js';

/** Options for {@link repackCommand}. */
export interface RepackCommandOptions {
  outDir: string;
  /** Groups file: `{ "maxSize"?, "padding"?, "extrude"?, "groups": [{ "name": "reel", "skeletons": ["symbol*", ...] }] }` (options override it). */
  groups?: string;
  maxSize?: number;
  padding?: number;
  extrude?: number;
  pma?: boolean;
  rotation?: boolean;
  powerOfTwo?: boolean;
  imageFormat?: PageImageFormat;
  /** WebP quality (lossy). */
  quality?: number;
  /** Also write `<skeleton>.tabula` with the group atlas embedded. */
  compile?: boolean;
  /** With `compile`: also write `<skeleton>.baked` (all animations, auto rate). */
  bake?: boolean;
  /** Vertex error budget for `bake`, skeleton units. */
  maxError?: number;
  /** Bake tolerance (with `bake`), skeleton units. */
  tolerance?: number;
  /** Also write KTX2 (Basis Universal) pages with this codec; the groups file can override it per group and page. */
  ktx2?: BasisCodec | 'none';
  /** KTX2 quality: UASTC pack level 0-4 (default 2), ETC1S 1-255 (default 128). */
  ktx2Quality?: number;
  /** Resolution tiers to write, e.g. [1, 0.75, 0.5] (default [1], or the groups file's "tiers"). */
  tiers?: number[];
}

/** Repack the atlases of every Spine JSON under `paths`. Returns the per-group report. */
export async function repackCommand(paths: string[], options: RepackCommandOptions): Promise<RepackGroupReport[]> {
  if (options.bake && !options.compile) throw new Error('repack --bake needs --compile (baked files pair with the compiled .tabula)');
  const config: RepackGroupsFile = options.groups ? (JSON.parse(await readFile(options.groups, 'utf-8')) as RepackGroupsFile) : {};
  const skeletons: RepackSkeleton[] = [];
  const tiers = options.tiers ?? config.tiers ?? [1];
  for (const t of tiers) if (!(t > 0 && t <= 8)) throw new Error(`Tier ${t} is not in (0, 8]`);
  for (const file of await collectSkeletonFiles(paths)) {
    const atlas = await loadAtlasNextTo(file);
    if (!atlas) throw new Error(`${file}: no .atlas next to it`);
    skeletons.push({ data: await loadValidatedSkeleton(file, atlas, printWarning), atlas, atlasDir: dirname(file), hiRes: await loadHiResAtlases(file, tiers) });
  }
  const format = options.imageFormat ?? 'png';
  const groups = await repackAtlases(skeletons, config.groups ?? [], {
    maxSize: options.maxSize ?? config.maxSize ?? 2048,
    padding: options.padding ?? config.padding ?? 2,
    extrude: options.extrude ?? config.extrude ?? 0,
    pma: options.pma,
    rotation: options.rotation ?? true,
    powerOfTwo: options.powerOfTwo ?? true,
    extension: format === 'png' ? 'png' : 'webp',
  }, loadPageImage);

  await mkdir(options.outDir, { recursive: true });
  const reports: RepackGroupReport[] = [];
  for (const group of groups) {
    const manifest = await encodeGroupPages(group, {
      imageFormat: format, quality: options.quality, tiers, ktx2Quality: options.ktx2Quality,
      ktx2For: ktx2Selector(config, group.name, options.ktx2),
      tierPages: (tier) => renderTierPages(group, tier, (p) => tierSize(p.width, p.height, tier), loadPageImage),
    }, (name, bytes) => writeFile(join(options.outDir, name), bytes));
    await writeFile(join(options.outDir, `${group.name}.atlas`), writeAtlasText(group.atlas));
    await writeFile(join(options.outDir, manifestFileName(group.name)), JSON.stringify(manifest, null, 2));
    if (options.compile) {
      for (const data of group.skeletons) {
        await writeFile(join(options.outDir, `${data.name}.tabula`), new Uint8Array(compileSkeleton(data, group.atlas)));
        if (options.bake) {
          const baked = bakeToBuffer(data, group.atlas, { maxError: options.maxError, tolerance: options.tolerance });
          const output = join(options.outDir, `${data.name}.baked`);
          await writeFile(output, new Uint8Array(baked.bytes));
          printBakeSummary(data.name, baked, output, options.maxError ?? DEFAULT_BAKE_MAX_ERROR);
        }
      }
    }
    const report = await groupReport(group, manifest);
    reports.push(report);
    printGroup(report);
  }
  await writeFile(join(options.outDir, 'repack-report.json'), JSON.stringify(reports, null, 2));
  return reports;
}

function printGroup(r: RepackGroupReport): void {
  const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(1)} MiB`;
  console.log(`${r.name}: ${r.skeletons.length} skeletons, ${r.regions} regions (${r.regionMegapixels} Mpx${r.sharedRegions ? `, ${r.sharedRegions} shared with other groups` : ''})`);
  console.log(`  source: ${r.source.pages.length} pages (${r.source.pages.join(', ')}), ${mb(r.source.vramBytes)} VRAM, ${mb(r.source.fileBytes)} files`);
  console.log(`  output: ${r.output.pages.length} pages (${r.output.pages.map((p) => `${p.name} ${p.width}x${p.height} ${(p.fill * 100).toFixed(0)}% full`).join(', ')}), ` +
    `${mb(r.output.vramBytes)} VRAM, ${mb(r.output.fileBytes)} files`);
  const tiers = Object.keys(r.output.tierVramBytes);
  const ktx = r.output.pages.filter((p) => p.ktx2);
  if (tiers.length > 1 || ktx.length) {
    for (const tier of tiers) {
      const sum = (ext: string): number => r.output.pages.reduce((n, p) => n + (p.files[tierFileName(p.name, +tier, ext === 'image' ? undefined : ext)] ?? 0), 0);
      console.log(`  tier ${tier}x: images ${mb(sum('image'))}${ktx.length ? `, ktx2 ${mb(sum('ktx2'))} (${ktx.map((p) => p.ktx2).join('/')})` : ''}, ` +
        `VRAM ${mb(r.output.tierVramBytes[tier]!)} RGBA${ktx.length ? ` / ${mb(r.output.compressedVramBytes[tier]!)} transcoded` : ''}`);
    }
  }
}

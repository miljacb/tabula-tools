/**
 * `tabula compile`: validates Spine JSON exports and writes compiled
 * skeletons (`.tabula`, see core/slb.ts) with the used part of the atlas
 * embedded, so the runtime never parses JSON or atlas text.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AtlasParser } from '../../core/adapters/atlas-parser.js';
import { compileSkeleton } from '../../core/slb-writer.js';
import { bakeToBuffer } from '../../core/bake-report.js';
import { loadValidatedSkeleton } from '../../export/compile.js';
import { collectSkeletonFiles, loadAtlasNextTo } from '../../export/sources.js';
import { printBakeSummary } from './bake.js';
import { DEFAULT_BAKE_MAX_ERROR } from '../../core/baked-format.js';

/** Options for {@link compileCommand}. */
export interface CompileCommandOptions {
  /** Output directory. Default: next to each input. */
  outDir?: string;
  /** Atlas to embed for every input. Default: `<name>.atlas` next to each JSON. */
  atlas?: string;
  /** Do not embed an atlas. */
  noAtlas?: boolean;
  /** Also write `<name>.baked` (all animations, auto rate) next to each `.tabula`. */
  bake?: boolean;
  /** Vertex error budget for `bake`, skeleton units (default: core DEFAULT_BAKE_MAX_ERROR). */
  maxError?: number;
  /** Bake tolerance (with `bake`), skeleton units. */
  tolerance?: number;
}

/** Compile every Spine JSON under `paths`. Returns the written files. */
export async function compileCommand(paths: string[], options: CompileCommandOptions): Promise<string[]> {
  const shared = options.atlas ? new AtlasParser().parse(await readFile(options.atlas, 'utf-8')) : null;
  const written: string[] = [];
  for (const file of await collectSkeletonFiles(paths)) {
    const atlas = options.noAtlas ? null : shared ?? (await loadAtlasNextTo(file));
    const data = await loadValidatedSkeleton(file, atlas, printWarning);
    const bytes = compileSkeleton(data, atlas);
    const output = join(options.outDir ?? dirname(file), `${data.name}.tabula`);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, new Uint8Array(bytes));
    console.log(`${data.name}: ${(bytes.byteLength / 1024).toFixed(1)} KiB${atlas ? '' : ' (no atlas)'} -> ${output}`);
    written.push(output);
    if (options.bake) {
      const baked = bakeToBuffer(data, atlas, { maxError: options.maxError, tolerance: options.tolerance });
      const bakedOutput = output.replace(/\.tabula$/, '.baked');
      await writeFile(bakedOutput, new Uint8Array(baked.bytes));
      printBakeSummary(data.name, baked, bakedOutput, options.maxError ?? DEFAULT_BAKE_MAX_ERROR);
      written.push(bakedOutput);
    }
  }
  return written;
}

/** Print a validation warning. */
export function printWarning(warning: string, skeleton: string): void {
  console.warn(`  warning (${skeleton}): ${warning}`);
}

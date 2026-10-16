/**
 * `tabula bake`: validates a Spine JSON export and writes compressed
 * baked samples (bone world matrices, slot colors, deform) as a binary
 * `.baked` file, with a per-animation error report.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadValidatedSkeleton } from '../../export/compile.js';
import { loadAtlasNextTo } from '../../export/sources.js';
import { bakeToBuffer } from '../../core/bake-report.js';
import type { BakeOptions, BakeResult } from '../../core/bake-report.js';
import { DEFAULT_BAKE_MAX_ERROR } from '../../core/baked-format.js';
import { printWarning } from './compile.js';

/** Interpolation error (skeleton units) above which the report warns. */
const INTERPOLATION_WARNING = 1;

/** Options for {@link bakeCommand}. */
export interface BakeCommandOptions extends BakeOptions {
  /** Output file. Default: `<input>.baked` next to the input. */
  output?: string;
}

/** Bake one skeleton. Throws if validation finds errors. Returns the output path. */
export async function bakeCommand(inputPath: string, options: BakeCommandOptions): Promise<string> {
  const atlas = await loadAtlasNextTo(inputPath);
  const data = await loadValidatedSkeleton(inputPath, atlas, printWarning);
  const result = bakeToBuffer(data, atlas, options);
  const output = options.output ?? join(dirname(inputPath), `${data.name}.baked`);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, new Uint8Array(result.bytes));
  printBakeSummary(data.name, result, output, options.maxError ?? DEFAULT_BAKE_MAX_ERROR);
  return output;
}

/** Log size and the error report of a bake. */
export function printBakeSummary(name: string, result: BakeResult, output: string, maxError: number): void {
  const kib = (n: number): string => `${(n / 1024).toFixed(1)} KiB`;
  console.log(`${name}: ${kib(result.bytes.byteLength)} (lossless ${kib(result.losslessBytes)}, max error ${maxError}) -> ${output}`);
  if (!result.report) {
    console.log('  (no atlas next to the export: error report skipped)');
    return;
  }
  for (const r of result.report) {
    console.log(
      `  ${r.animation.padEnd(28)} ${String(r.samples).padStart(4)} samples (${r.refinedSamples} refined)  encode ${r.encodeError.toFixed(4)}  ` +
        `color ${(r.colorError * 255).toFixed(2)}/255  between samples vs live ${r.interpolationError.toFixed(3)}`,
    );
    if (r.encodeError > maxError) console.warn(`  warning: ${r.animation} exceeds the error budget (${r.encodeError} > ${maxError})`);
    if (r.interpolationError > INTERPOLATION_WARNING) {
      console.warn(`  warning: ${r.animation} deviates ${r.interpolationError.toFixed(2)} units from live between samples; consider a lower --tolerance`);
    }
  }
}

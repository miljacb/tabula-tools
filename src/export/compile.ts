/**
 * Read a Spine JSON export for compiling: parse and validate it. Writing the
 * compiled skeleton is `compileSkeleton` (tabula-pixi core/slb-writer.ts).
 */

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { SpineJsonParser } from 'tabula-pixi/core/adapters/spine-json-parser.js';
import { validateSkeleton } from 'tabula-pixi/core/validate.js';
import type { AtlasData, SkeletonData } from 'tabula-pixi/core/types.js';

/**
 * Parse and validate one Spine JSON export. Throws on validation errors;
 * warnings go to `onWarning` (prefixed with the skeleton name by the caller if wanted).
 */
export async function loadValidatedSkeleton(
  jsonPath: string,
  atlas: AtlasData | null,
  onWarning?: (warning: string, skeleton: string) => void,
): Promise<SkeletonData> {
  const json = JSON.parse(await readFile(jsonPath, 'utf-8'));
  const data = new SpineJsonParser().parse(json, basename(jsonPath, '.json'));
  const validation = validateSkeleton(data, atlas ?? undefined);
  if (onWarning) for (const w of validation.warnings) onWarning(w, data.name);
  if (validation.errors.length) throw new Error(`${jsonPath} cannot be compiled:\n  ${validation.errors.join('\n  ')}`);
  return data;
}

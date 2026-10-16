/** Finding Spine exports on disk: skeleton JSON files and the atlas next to each. */

import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { AtlasParser } from '../core/adapters/atlas-parser.js';
import { isSpineJson } from '../core/manifest.js';
import type { AtlasData } from '../core/types.js';

/** A higher-resolution export for a tier above 1: `<name>@<tier>x.json` / `.atlas`. */
export function isTierExport(path: string): boolean {
  return /@\d+(\.\d+)?x\.(json|atlas)$/.test(path);
}

/**
 * Recursively collect Spine skeleton JSON files from files and directories.
 * Other JSON found in directories (fonts, manifests, sprite sheets) and
 * higher-resolution tier exports (`symbol1@2x.json`) are skipped;
 * a file named explicitly is always returned.
 */
export async function collectSkeletonFiles(paths: string[]): Promise<string[]> {
  const out: string[] = [];
  const walk = async (p: string, explicit: boolean): Promise<void> => {
    const s = await stat(p).catch(() => null);
    if (!s) throw new Error(`Path not found: ${p}`);
    if (s.isDirectory()) {
      for (const entry of await readdir(p)) await walk(join(p, entry), false);
    } else if (p.endsWith('.json') && (explicit || (!isTierExport(p) && isSpineJson(await readFile(p, 'utf-8').then((t) => JSON.parse(t) as unknown).catch(() => null))))) out.push(p);
  };
  for (const p of paths) await walk(p, true);
  return out.sort();
}

/** Load `<name>.atlas` next to a skeleton JSON, if present. */
export async function loadAtlasNextTo(jsonFile: string): Promise<AtlasData | null> {
  const atlasFile = join(dirname(jsonFile), basename(jsonFile, '.json') + '.atlas');
  const text = await readFile(atlasFile, 'utf-8').catch(() => null);
  return text === null ? null : new AtlasParser().parse(text);
}

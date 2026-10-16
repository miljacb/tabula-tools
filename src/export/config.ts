/**
 * `tabula.config.json`: the project settings the Tabula app and
 * {@link exportProject} share (tiers, texture compression, atlas groups,
 * baking, load groups). Every field is optional.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BasisCodec } from '../core/texture-formats.js';
import type { LoadGroupsSpec } from '../core/manifest.js';
import type { PageImageFormat, RepackGroupsFile } from './pages.js';

/** File name of the project settings, in the source folder. */
export const PROJECT_CONFIG_FILE = 'tabula.config.json';

/** Project settings. */
export interface TabulaProjectConfig {
  /**
   * Output: `tbla` (default) packs the export into `.tbla` bundles, one per
   * tier; `files` writes every file loose (inspect, debug).
   */
  format?: 'tbla' | 'files';
  /**
   * `release` (default): one bundle per load group and tier, skeletons
   * repacked into the shared pages of `atlas.groups`. `development`: one
   * bundle per asset and tier (swap one asset at a time), each asset with
   * its own pages.
   */
  mode?: 'release' | 'development';
  /** Standalone images (PNG / WebP / JPG not used by an atlas, sprite sheet or font): exported as textures (default true). */
  images?: boolean;
  /** Resolution tiers to export, e.g. [2, 1, 0.5] (default [1]). Tiers above 1 need `<name>@2x` exports. */
  tiers?: number[];
  /** KTX2 codec for atlas pages (default 'none'); per group / page in `atlas.groups`. */
  ktx2?: BasisCodec | 'none';
  /** UASTC level 0-4 (default 2) / ETC1S quality 1-255 (default 128). */
  ktx2Quality?: number;
  /** Page image format (default: webp when most source atlas pages are WebP, png otherwise). */
  imageFormat?: PageImageFormat;
  /** Lossy WebP quality (default 90). */
  quality?: number;
  /** Atlas packing and co-draw groups (skeletons sharing pages). Default: one group. */
  atlas?: Pick<RepackGroupsFile, 'maxSize' | 'padding' | 'extrude' | 'groups'>;
  /** Baked animations (default on); false plays every animation live. */
  bake?: false | { fps?: number; maxError?: number; tolerance?: number };
  /** Load groups of the manifest. */
  loadGroups?: LoadGroupsSpec;
}

/** Read `tabula.config.json` from `dir` (empty settings when there is none). */
export async function loadProjectConfig(dir: string): Promise<TabulaProjectConfig> {
  const text = await readFile(join(dir, PROJECT_CONFIG_FILE), 'utf-8').catch(() => null);
  if (text === null) return {};
  try {
    return validateProjectConfig(JSON.parse(text));
  } catch (err) {
    throw new Error(`${PROJECT_CONFIG_FILE}: ${(err as Error).message}`);
  }
}

/** Check the shape of parsed settings; throws with the first problem. */
export function validateProjectConfig(json: unknown): TabulaProjectConfig {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('expected an object');
  const c = json as TabulaProjectConfig;
  if (c.tiers !== undefined && (!Array.isArray(c.tiers) || c.tiers.some((t) => typeof t !== 'number' || !(t > 0 && t <= 8)))) {
    throw new Error('"tiers" must be numbers in (0, 8]');
  }
  if (c.ktx2 !== undefined && !['uastc', 'etc1s', 'none'].includes(c.ktx2)) throw new Error('"ktx2" must be uastc, etc1s or none');
  if (c.format !== undefined && c.format !== 'tbla' && c.format !== 'files') throw new Error('"format" must be tbla or files');
  if (c.mode !== undefined && c.mode !== 'release' && c.mode !== 'development') throw new Error('"mode" must be release or development');
  if (c.imageFormat !== undefined && !['png', 'webp', 'webp-lossless'].includes(c.imageFormat)) throw new Error('"imageFormat" must be png, webp or webp-lossless');
  if (c.bake !== undefined && c.bake !== false && (typeof c.bake !== 'object' || c.bake === null)) throw new Error('"bake" must be false or an object');
  return c;
}

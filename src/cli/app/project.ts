/**
 * What the exporter page lists for a project folder (GET /api/project). Only
 * file reads, so it also runs in the web exporter's worker over the in-memory
 * files (app/web/).
 */

import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { SpineJsonParser } from 'tabula-pixi/core/adapters/spine-json-parser.js';
import { AtlasParser } from 'tabula-pixi/core/adapters/atlas-parser.js';
import { validateSkeleton } from 'tabula-pixi/core/validate.js';
import { inspectBundle } from '../commands/inspect.js';
import { loadProjectConfig } from '../../export/config.js';
import { GAME_BUNDLE_FILE, MANIFEST_FILE, REPORT_FILE, discoverProject } from '../../export/export-project.js';

/** A skeleton as the app lists it. */
export interface AppSkeleton {
  name: string;
  /** Paths relative to the project. */
  json: string;
  atlas: string;
  spineVersion: string;
  animations: string[];
  skins: string[];
  errors: string[];
  warnings: string[];
  /** JSON + atlas + page bytes. */
  bytes: number;
  /** The skeleton JSON's own bytes. */
  jsonBytes: number;
  pages: string[];
}

/** GET /api/project. */
export interface AppProject {
  dir: string;
  outDir: string;
  config: unknown;
  skeletons: AppSkeleton[];
  sprites: string[];
  fonts: string[];
  /** Spine binary exports (not supported). */
  skel: string[];
  /** Last export (export-report.json), if any. */
  report: unknown;
  /** The export folder has a manifest (the preview can load exported assets). */
  exported: boolean;
  /** File of the export to open it from: its manifest, or the single game.tbla of a simple release export. */
  entry: string | null;
  /** `.tbla` bundles in the project folder (outside the export), e.g. sent by a designer. */
  bundles: AppBundle[];
}

/** A `.tbla` in the project, as the app lists it. */
export interface AppBundle {
  /** Relative to the project. */
  path: string;
  bytes: number;
  meta: Record<string, unknown>;
  /** Assets of its manifest (a self-contained bundle), else null. */
  members: { skeletons: string[]; sprites: string[]; images: string[]; fonts: string[] } | null;
  files: { path: string; bytes: number }[];
  /** Why it could not be read (damaged, not a bundle). */
  error?: string;
}

/** Everything the app lists for the project folder. */
export async function readProject(projectDir: string, outDir: string): Promise<AppProject> {
  const files = await discoverProject(projectDir, outDir);
  const rel = (p: string): string => relative(projectDir, p).split(sep).join('/');
  const skeletons: AppSkeleton[] = [];
  for (const s of files.skeletons) {
    const entry: AppSkeleton = { name: s.name, json: rel(s.json), atlas: rel(s.atlas), spineVersion: '', animations: [], skins: [], errors: [], warnings: [], bytes: 0, jsonBytes: 0, pages: [] };
    skeletons.push(entry);
    try {
      const json = JSON.parse(await readFile(s.json, 'utf-8')) as { skeleton?: { spine?: string } };
      entry.spineVersion = String(json.skeleton?.spine ?? '');
      entry.jsonBytes = (await stat(s.json)).size;
      entry.bytes += entry.jsonBytes;
      const atlasText = await readFile(s.atlas, 'utf-8').catch(() => null);
      if (atlasText === null) throw new Error(`no ${rel(s.atlas)}`);
      entry.bytes += new TextEncoder().encode(atlasText).length;
      const atlas = new AtlasParser().parse(atlasText);
      for (const page of atlas.pages) {
        entry.pages.push(page.name);
        const size = (await stat(join(dirname(s.atlas), page.name)).catch(() => null))?.size;
        if (size === undefined) entry.errors.push(`page ${page.name} is missing`);
        else entry.bytes += size;
      }
      const data = new SpineJsonParser().parse(json, s.name);
      entry.animations = data.animations.map((a) => a.name);
      entry.skins = data.skins.map((k) => k.name);
      const validation = validateSkeleton(data, atlas);
      entry.errors.push(...validation.errors);
      entry.warnings.push(...validation.warnings);
    } catch (err) {
      entry.errors.push((err as Error).message);
    }
  }
  const report = await readFile(join(outDir, REPORT_FILE), 'utf-8').then((t) => JSON.parse(t) as unknown, () => null);
  const bundles: AppBundle[] = [];
  for (const file of files.bundles) {
    try {
      const info = await inspectBundle(file);
      bundles.push({ path: rel(file), bytes: info.bytes, meta: info.meta, members: info.members, files: info.files });
    } catch (err) {
      bundles.push({ path: rel(file), bytes: 0, meta: {}, members: null, files: [], error: (err as Error).message });
    }
  }
  const entry = [MANIFEST_FILE, GAME_BUNDLE_FILE].find((file) => existsSync(join(outDir, file))) ?? null;
  return {
    dir: projectDir, outDir, config: await loadProjectConfig(projectDir).catch((err: Error) => ({ error: err.message })),
    skeletons, sprites: files.sprites.map(rel), fonts: files.fonts.map(rel), skel: files.skel.map(rel),
    report, exported: entry !== null, entry, bundles,
  };
}

/**
 * `tabula manifest`: build `assets.manifest.json` (see core/manifest.ts)
 * from build outputs: `.tabula`, `.baked`, page images and KTX2 tiers,
 * `*.textures.json`, sprite sheets, `*.font.json` SDF fonts. Paths in the manifest are relative to
 * the manifest file.
 */

import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { buildAssetManifest } from '../../core/manifest.js';
import type { AssetManifest, LoadGroupsSpec, ManifestInputFile } from '../../core/manifest.js';

/** Options for {@link manifestCommand}. */
export interface ManifestCommandOptions {
  /** Output file (default `<first input dir>/assets.manifest.json`). */
  output?: string;
  /** Load groups JSON file ({@link LoadGroupsSpec}), or the spec itself. */
  groups?: string | LoadGroupsSpec;
  /** Do not print the summary. */
  quiet?: boolean;
}

const EXTENSIONS = /\.(tabula|baked|png|webp|jpe?g|avif|ktx2|json|atlas)$/i;

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else if (EXTENSIONS.test(entry.name)) out.push(path);
  }
  return out;
}

/** Read the inputs (directories are scanned recursively) and write the manifest. Returns it. */
export async function manifestCommand(inputs: string[], options: ManifestCommandOptions = {}): Promise<AssetManifest> {
  if (!inputs.length) throw new Error('Usage: tabula manifest <dir...> [-o assets.manifest.json] [--load-groups groups.json]');
  const output = resolve(options.output ?? join(inputs[0]!, 'assets.manifest.json'));
  const root = dirname(output);
  const paths = new Set<string>();
  for (const input of inputs) {
    const abs = resolve(input);
    const files = abs.match(EXTENSIONS) ? [abs] : await walk(abs);
    for (const f of files) if (f !== output) paths.add(f);
  }
  const files: ManifestInputFile[] = [];
  for (const path of [...paths].sort()) {
    files.push({ path: relative(root, path).split(sep).join('/'), bytes: new Uint8Array(await readFile(path)) });
  }
  const spec: LoadGroupsSpec = typeof options.groups === 'string' ? JSON.parse(await readFile(options.groups, 'utf-8')) as LoadGroupsSpec : options.groups ?? {};
  const { manifest, warnings } = buildAssetManifest(files, spec);
  await mkdir(root, { recursive: true });
  await writeFile(output, `${JSON.stringify(manifest, null, 1)}\n`);
  if (!options.quiet) {
    const kib = (n: number): string => `${(n / 1024).toFixed(0)} KiB`;
    console.log(`${relative(process.cwd(), output) || output}: ${Object.keys(manifest.skeletons).length} skeletons, ${Object.keys(manifest.pages).length} pages, ` +
      `${Object.keys(manifest.textureSets).length} texture sets, ${Object.keys(manifest.sprites).length} sprite sheets, ${Object.keys(manifest.fonts ?? {}).length} fonts`);
    for (const [name, g] of Object.entries(manifest.groups)) {
      console.log(`  group ${name}: ${g.skeletons.length} skeletons, ${g.sprites.length} sprite sheets, ${g.fonts?.length ?? 0} fonts, ${g.pages.length} pages, ${kib(g.bytes)} (1× images)`);
    }
    for (const w of warnings) console.log(`  warning: ${w}`);
  }
  return manifest;
}

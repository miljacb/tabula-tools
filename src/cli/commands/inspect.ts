/**
 * `tabula inspect <file.tbla>`: what a bundle holds (files, sizes, the
 * manifest inside), checked; `--unpack <dir>` writes its files out.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { readBundle } from 'tabula-pixi/core/tbla.js';

/** What {@link inspectBundle} reports. */
export interface BundleInspection {
  meta: Record<string, unknown>;
  bytes: number;
  /** `bytes` unpacked; `stored` in the bundle (smaller when deflated). */
  files: { path: string; bytes: number; stored: number }[];
  /** Skeletons, sprite sheets, images and fonts of the manifest inside (a development bundle), if any. */
  members: { skeletons: string[]; sprites: string[]; images: string[]; fonts: string[] } | null;
}

/** Read and check a bundle (every file's checksum). */
export async function inspectBundle(path: string): Promise<BundleInspection> {
  const bytes = new Uint8Array(await readFile(path));
  const { toc, files } = await readBundle(bytes);
  const inside = files.get('assets.manifest.json');
  const manifest = inside ? JSON.parse(new TextDecoder().decode(inside)) as { skeletons?: object; sprites?: object; images?: object; fonts?: object } : null;
  return {
    meta: toc.meta,
    bytes: bytes.length,
    files: toc.files.map((f) => ({ path: f.path, bytes: f.size ?? f.length, stored: f.length })),
    members: manifest && {
      skeletons: Object.keys(manifest.skeletons ?? {}), sprites: Object.keys(manifest.sprites ?? {}),
      images: Object.keys(manifest.images ?? {}), fonts: Object.keys(manifest.fonts ?? {}),
    },
  };
}

/** `tabula inspect`: print the bundle, or unpack it into `unpackDir`. */
export async function inspectCommand(path: string | undefined, options: { unpack?: string; json?: boolean } = {}): Promise<BundleInspection> {
  if (!path) throw new Error('Usage: tabula inspect <file.tbla> [--unpack <dir>] [-f json]');
  const info = await inspectBundle(path);
  if (options.unpack) {
    const root = resolve(options.unpack);
    const { files } = await readBundle(new Uint8Array(await readFile(path)));
    for (const [file, bytes] of files) {
      const target = resolve(root, file);
      if (!target.startsWith(root + sep)) throw new Error(`Refusing to write outside ${root}: ${file}`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
    console.log(`${files.size} files written to ${root}`);
    return info;
  }
  if (options.json) {
    console.log(JSON.stringify(info, null, 2));
    return info;
  }
  const kib = (n: number): string => `${(n / 1024).toFixed(1)} KiB`;
  console.log(`${path}: ${kib(info.bytes)}, ${info.files.length} files, checksums OK`);
  console.log(`  ${Object.entries(info.meta).map(([k, v]) => `${k}: ${String(v)}`).join(', ')}`);
  if (info.members) {
    for (const [kind, names] of Object.entries(info.members)) if (names.length) console.log(`  ${kind}: ${names.join(', ')}`);
  }
  for (const f of info.files) console.log(`  ${kib(f.bytes).padStart(12)}  ${f.path}${f.stored !== f.bytes ? ` (deflated to ${kib(f.stored)})` : ''}`);
  return info;
}


/**
 * Export a project folder for a game: the engine behind the Tabula app's
 * "Export". Reads the raw exports (Spine JSON + atlas + pages, sprite
 * sheets, compiled SDF fonts), compresses the chosen skeletons (repack per
 * co-draw group, compile, bake, tiers, KTX2), copies everything else as is,
 * and writes `assets.manifest.json` over the result.
 *
 * Nothing is reused from earlier exports: the output folder is emptied
 * first, so the game only ever loads what this export wrote. A skeleton that
 * cannot be compressed is exported raw (the game plays it from its JSON)
 * and reported with the reason. Only KTX2 encodings are cached (by content
 * hash), because encoding takes seconds per page; a cached file is the
 * encoder's output for the same pixels and settings.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { SpineJsonParser } from 'tabula-pixi/core/adapters/spine-json-parser.js';
import { AtlasParser } from 'tabula-pixi/core/adapters/atlas-parser.js';
import { validateSkeleton } from 'tabula-pixi/core/validate.js';
import { compileSkeleton } from 'tabula-pixi/core/slb-writer.js';
import { bakeToBuffer } from 'tabula-pixi/core/bake-report.js';
import { isTierExport } from './sources.js';
import {
  decodeImage, encodeGroupPages, ktx2Selector, loadHiResAtlases, loadPageImage, manifestFileName,
} from './pages.js';
import type { PageImageFormat, RepackGroupsFile } from './pages.js';
import { writeAtlasText } from './atlas-writer.js';
import { renderTierPages, repackAtlases } from './pack/repack.js';
import type { RepackSkeleton } from './pack/repack.js';
import { blit, createImage, premultiply, resizeArea, unpremultiply } from './pack/image.js';
import type { RgbaImage } from './pack/image.js';
import { checkKtxTool, encodeKtx2 } from './pack/ktx2.js';
import type { Ktx2EncodeOptions } from './pack/ktx2.js';
import { availableTiers, buildAssetManifest, contentHash, globToRegExp, isSpineJson } from 'tabula-pixi/core/manifest.js';
import type { AssetManifest, ManifestBundle, ManifestExtras, ManifestGroup, ManifestInputFile, TierCost } from 'tabula-pixi/core/manifest.js';
import { writeBundle } from 'tabula-pixi/core/tbla.js';
import { resolveTier, tierFileName, tierSize } from 'tabula-pixi/core/texture-formats.js';
import type { BasisCodec, TextureManifest } from 'tabula-pixi/core/texture-formats.js';
import type { AtlasPage } from 'tabula-pixi/core/types.js';
import type { TabulaProjectConfig } from './config.js';

/** Marks a folder written by {@link exportProject} (only such a folder is emptied). */
export const EXPORT_MARKER = '.tabula-export';
/** File name of the manifest in the output folder. */
export const MANIFEST_FILE = 'assets.manifest.json';
/** Export summary (the report without the manifest), next to the manifest. */
export const REPORT_FILE = 'export-report.json';

/** Something the export reports while it runs (the app shows these). */
export type ExportEvent =
  | { type: 'step'; message: string }
  /**
   * Progress: `fraction` of the whole export (0..1), and the phase's own
   * count (`done` of `total`) with what is being worked on.
   */
  | { type: 'progress'; fraction: number; phase: ExportPhase; done: number; total: number; item: string }
  | { type: 'warning'; asset?: string; message: string }
  /** A skeleton exported raw instead of compressed. */
  | { type: 'fallback'; asset: string; reason: string };

/** Export phases, in order. */
export type ExportPhase = 'read' | 'pack' | 'pages' | 'skeletons' | 'copy' | 'manifest';

/** Share of the export each phase takes (page encoding, KTX2 above all, dominates). */
const PHASE_WEIGHTS: Record<ExportPhase, number> = { read: 0.06, pack: 0.06, pages: 0.55, skeletons: 0.25, copy: 0.05, manifest: 0.03 };

/** Let the event loop run (stream writes reach the app) between synchronous steps. */
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

/** Options for {@link exportProject}. */
export interface ExportOptions {
  /** Folder with the raw exports. */
  sourceDir: string;
  /** Output folder: created, or emptied if an earlier export wrote it; any other non-empty folder is refused. */
  outDir: string;
  config?: TabulaProjectConfig;
  /** Skeletons to compress (names or globs); the rest are exported raw. Default: all. */
  compress?: string[];
  /** KTX2 encodings cache (default `<sourceDir>/.tabula-cache/ktx2`). */
  cacheDir?: string;
  onEvent?: (event: ExportEvent) => void;
  /** KTX2 encoder (default: the `ktx` tool, cached); returning null keeps the page as an image. */
  encodeKtx2?: (image: RgbaImage, options: Ktx2EncodeOptions, file: string) => Promise<Uint8Array | null>;
}

/** What one skeleton became. */
export interface SkeletonExport {
  format: 'tabula' | 'json';
  /** Why it is raw: not selected, or the reason compression failed. */
  reason?: string;
  /** Co-draw group (compressed skeletons). */
  group?: string;
  /** Validation warnings (supported but costly or ignored content). */
  warnings: string[];
  /** Bytes of its own files (skeleton, atlas, baked; pages are shared and counted per group). */
  bytes: number;
  /** Source bytes: JSON + atlas. */
  sourceBytes: number;
}

/** Result of {@link exportProject}. */
export interface ExportReport {
  manifest: AssetManifest;
  mode: 'release' | 'development';
  format: 'tbla' | 'files';
  skeletons: Record<string, SkeletonExport>;
  /** Sprite sheets and the tiers written for each. */
  sprites: Record<string, number[]>;
  /** Standalone images. */
  images: string[];
  fonts: string[];
  /** `.tbla` bundles written (format tbla). */
  bundles: BundleReport[];
  /** Pages shared by several load groups (see {@link pageConflicts}). */
  conflicts: string[];
  /** Download and GPU memory per tier, all pages. */
  tiers: TierCost[];
  warnings: string[];
  /** Bytes of the raw exports (skeletons with their pages, sprite sheets, fonts). */
  sourceBytes: number;
  /** Bytes written. */
  outputBytes: number;
  ms: number;
}

/** A Spine export: name and absolute paths of its JSON and atlas. */
export interface SourceSkeleton {
  name: string;
  json: string;
  atlas: string;
}

/** Export `sourceDir` to `outDir`. See the module comment. */
export async function exportProject(options: ExportOptions): Promise<ExportReport> {
  const t0 = performance.now();
  const config = options.config ?? {};
  const sourceDir = resolve(options.sourceDir);
  const outDir = resolve(options.outDir);
  const emit = (event: ExportEvent): void => options.onEvent?.(event);
  const warnings: string[] = [];
  const warn = (message: string, asset?: string): void => {
    warnings.push(asset ? `${asset}: ${message}` : message);
    emit({ type: 'warning', asset, message });
  };
  const tiers = [...new Set([1, ...(config.tiers ?? [1])])].sort((a, b) => b - a);
  const phases = Object.keys(PHASE_WEIGHTS) as ExportPhase[];
  const progress = async (phase: ExportPhase, done: number, total: number, item: string): Promise<void> => {
    const before = phases.slice(0, phases.indexOf(phase)).reduce((n, p) => n + PHASE_WEIGHTS[p], 0);
    const fraction = Math.min(1, before + PHASE_WEIGHTS[phase] * (total ? Math.min(done, total) / total : 1));
    emit({ type: 'progress', fraction, phase, done, total, item });
    await tick();
  };

  await checkOutDir(outDir);
  const mode = config.mode ?? 'release';
  const format = config.format ?? 'tbla';
  // Everything is staged here first; the output folder is only replaced once the export succeeded.
  const written = new Map<string, Uint8Array>();
  const posix = (path: string): string => path.split(sep).join('/');
  const write = (path: string, bytes: Uint8Array): void => void written.set(posix(path), bytes);
  const copy = async (from: string, to: string): Promise<number> => {
    const bytes = new Uint8Array(await readFile(from));
    written.set(posix(to), bytes);
    return bytes.length;
  };
  const extras: ManifestExtras = { images: {}, spritePages: {} };
  let imageFormat: PageImageFormat = config.imageFormat ?? 'png';
  const groupsFile: RepackGroupsFile = { ...config.atlas, ktx2: config.ktx2, tiers };
  const baseEncode = options.encodeKtx2 ?? cachedKtx2(options.cacheDir ?? join(sourceDir, '.tabula-cache', 'ktx2'), warn);
  let pageFiles = 0;
  let pageTotal = 0;
  const encode: typeof baseEncode = async (image, opts, file) => {
    await progress('pages', pageFiles, pageTotal, `Encoding ${file} (KTX2 ${opts.codec}, can take a while)`);
    return baseEncode(image, opts, file);
  };
  const onPageFile = async (dir: string, name: string, bytes: Uint8Array): Promise<void> => {
    write(join(dir, name), bytes);
    await progress('pages', ++pageFiles, pageTotal, `Wrote ${name}`);
  };

  emit({ type: 'step', message: `Reading the project (${mode}, ${format === 'tbla' ? '.tbla bundles' : 'loose files'})` });
  const found = await discoverProject(sourceDir, outDir, options.cacheDir);
  if (config.images === false) found.images = [];
  // No format set: follow the source. Lossy WebP pages saved as PNG grow several times (the PNG keeps the WebP artifacts losslessly).
  if (!config.imageFormat && found.skeletons.length) {
    const atlases = await Promise.all(found.skeletons.map((s) => readFile(s.atlas, 'utf-8').catch(() => '')));
    const pages = atlases.flatMap((text) => text.split('\n').map((l) => l.trim()).filter((l) => /\.(png|webp|jpe?g)$/i.test(l)));
    if (pages.length && pages.filter((p) => /\.webp$/i.test(p)).length * 2 > pages.length) imageFormat = 'webp';
  }
  for (const skel of found.skel) warn(`${relative(sourceDir, skel)}: Spine binary (.skel) is not supported; export the skeleton as JSON`);
  let sourceBytes = 0;
  const skeletons: Record<string, SkeletonExport> = {};
  const compressPatterns = options.compress?.map(globToRegExp);
  const fallback = (name: string, reason: string): void => {
    skeletons[name] = { ...(skeletons[name] ?? { warnings: [], bytes: 0, sourceBytes: 0 }), format: 'json', reason };
    emit({ type: 'fallback', asset: name, reason });
  };

  // Skeletons: validate the ones to compress; the rest go raw.
  const toPack: RepackSkeleton[] = [];
  const countedPages = new Set<string>();
  let read = 0;
  for (const s of found.skeletons) {
    await progress('read', read++, found.skeletons.length, `Checking ${s.name}`);
    const src = (await stat(s.json)).size + (existsSync(s.atlas) ? (await stat(s.atlas)).size : 0);
    sourceBytes += src;
    if (existsSync(s.atlas)) {
      for (const page of new AtlasParser().parse(await readFile(s.atlas, 'utf-8')).pages) {
        const path = join(dirname(s.atlas), page.name);
        if (countedPages.has(path) || !existsSync(path)) continue;
        countedPages.add(path);
        sourceBytes += (await stat(path)).size;
      }
    }
    skeletons[s.name] = { format: 'json', warnings: [], bytes: 0, sourceBytes: src };
    if (!existsSync(s.atlas)) {
      warn(`no ${basename(s.atlas)} next to ${basename(s.json)}: not exported`, s.name);
      delete skeletons[s.name];
      continue;
    }
    if (compressPatterns && !compressPatterns.some((re) => re.test(s.name))) {
      skeletons[s.name]!.reason = 'not selected for compression';
      continue;
    }
    try {
      const atlas = new AtlasParser().parse(await readFile(s.atlas, 'utf-8'));
      const data = new SpineJsonParser().parse(JSON.parse(await readFile(s.json, 'utf-8')), s.name);
      const validation = validateSkeleton(data, atlas);
      skeletons[s.name]!.warnings = validation.warnings;
      if (validation.errors.length) throw new Error(validation.errors.join('; '));
      toPack.push({ data, atlas, atlasDir: dirname(s.atlas), hiRes: await loadHiResAtlases(s.json, tiers) });
    } catch (err) {
      fallback(s.name, (err as Error).message);
    }
  }

  // Images and sprite sheet images, read now so the page count is known.
  const imagePlans: { name: string; kind: 'image' | 'sprites'; source: string; outDir: string; json?: SpriteSheetJson; sheet?: string }[] = [];
  for (const sheet of found.sprites) {
    try {
      const json = JSON.parse(await readFile(sheet, 'utf-8')) as SpriteSheetJson;
      const source = join(dirname(sheet), json.meta.image);
      sourceBytes += (await stat(sheet)).size + (await stat(source)).size;
      imagePlans.push({ name: basename(sheet, '.json'), kind: 'sprites', source, outDir: join('sprites', relative(sourceDir, dirname(sheet))), json, sheet });
    } catch (err) {
      warn(`sprite sheet not exported: ${(err as Error).message}`, basename(sheet, '.json'));
    }
  }
  const imageNames = new Set<string>();
  for (const image of found.images) {
    const name = basename(image).replace(/\.[^.]+$/, '');
    if (imageNames.has(name)) {
      warn(`a second image named "${name}" (${relative(sourceDir, image)}) is not exported: rename one`, name);
      continue;
    }
    imageNames.add(name);
    sourceBytes += (await stat(image)).size;
    imagePlans.push({ name, kind: 'image', source: image, outDir: join('images', relative(sourceDir, dirname(image))) });
  }
  const codecDefault = config.ktx2 && config.ktx2 !== 'none' ? config.ktx2 : null;
  pageTotal += imagePlans.length * tiers.length * (codecDefault ? 2 : 1);

  // Compress: repack per co-draw page group (release) or per skeleton (development), encode tiers / KTX2, compile, bake.
  if (toPack.length) {
    emit({ type: 'step', message: `Compressing ${toPack.length} skeletons` });
    await progress('pack', 0, 1, `Packing the atlas regions of ${toPack.length} skeletons`);
    const pageGroups = mode === 'development'
      ? toPack.map((s) => ({ name: s.data.name, skeletons: [s.data.name.replace(/[*?[\]]/g, '?')] }))
      : config.atlas?.groups ?? [];
    let groups: Awaited<ReturnType<typeof repackAtlases>> = [];
    try {
      groups = await repackAtlases(toPack, pageGroups, {
        maxSize: config.atlas?.maxSize ?? 2048, padding: config.atlas?.padding ?? 2, extrude: config.atlas?.extrude ?? 0,
        rotation: true, powerOfTwo: true, extension: imageFormat === 'png' ? 'png' : 'webp',
      }, loadPageImage);
    } catch (err) {
      for (const s of toPack) fallback(s.data.name, `atlas repack failed: ${(err as Error).message}`);
    }
    for (const group of groups) {
      const codecOf = ktx2Selector(groupsFile, group.name);
      for (const page of group.atlas.pages) pageTotal += tiers.length * (codecOf(page.name) ? 2 : 1);
    }
    const skeletonTotal = groups.reduce((n, g) => n + g.skeletons.length, 0);
    let skeletonsDone = 0;
    for (const group of groups) {
      emit({ type: 'step', message: `Pages "${group.name}": ${group.skeletons.length} skeletons, ${group.atlas.pages.length} pages` });
      const files = new Map<string, Uint8Array>();
      try {
        const textures = await encodeGroupPages(group, {
          imageFormat, quality: config.quality, tiers, ktx2Quality: config.ktx2Quality,
          ktx2For: ktx2Selector(groupsFile, group.name), encodeKtx2: encode,
          tierPages: (tier) => renderTierPages(group, tier, (p) => tierSize(p.width, p.height, tier), loadPageImage),
        }, async (name, bytes) => {
          files.set(name, bytes);
          await progress('pages', ++pageFiles, pageTotal, `Wrote ${name}`);
        });
        files.set(manifestFileName(group.name), new TextEncoder().encode(JSON.stringify(textures, null, 2)));
        files.set(`${group.name}.atlas`, new TextEncoder().encode(writeAtlasText(group.atlas)));
      } catch (err) {
        for (const data of group.skeletons) fallback(data.name, `pages "${group.name}" failed: ${(err as Error).message}`);
        continue;
      }
      for (const [name, bytes] of files) write(name, bytes);
      for (const data of group.skeletons) {
        const entry = skeletons[data.name]!;
        await progress('skeletons', skeletonsDone++, skeletonTotal, `${config.bake !== false ? 'Compiling and baking' : 'Compiling'} ${data.name}`);
        try {
          const tabula = new Uint8Array(compileSkeleton(data, group.atlas));
          let baked: Uint8Array | null = null;
          if (config.bake !== false) {
            try {
              baked = new Uint8Array(bakeToBuffer(data, group.atlas, { ...config.bake, noReport: true }).bytes);
            } catch (err) {
              warn(`not baked, plays live: ${(err as Error).message}`, data.name);
            }
          }
          write(`${data.name}.tabula`, tabula);
          if (baked) write(`${data.name}.baked`, baked);
          Object.assign(entry, { format: 'tabula', group: group.name, bytes: tabula.length + (baked?.length ?? 0) });
          delete entry.reason;
        } catch (err) {
          fallback(data.name, `compile failed: ${(err as Error).message}`);
        }
      }
    }
  }

  // Raw skeletons: JSON, atlas and pages as exported, under raw/.
  const copyTotal = found.skeletons.length + found.fonts.length;
  let copied = 0;
  for (const s of found.skeletons) {
    await progress('copy', copied++, copyTotal, `Copying ${s.name}`);
    const entry = skeletons[s.name];
    if (!entry || entry.format !== 'json') continue;
    const dir = join('raw', relative(sourceDir, dirname(s.json)));
    const atlas = new AtlasParser().parse(await readFile(s.atlas, 'utf-8'));
    const missing = atlas.pages.filter((p) => !existsSync(join(dirname(s.atlas), p.name))).map((p) => p.name);
    if (missing.length) {
      warn(`page ${missing.join(', ')} not found: not exported`, s.name);
      delete skeletons[s.name];
      continue;
    }
    let bytes = await copy(s.json, join(dir, basename(s.json)));
    bytes += await copy(s.atlas, join(dir, basename(s.atlas)));
    for (const page of atlas.pages) {
      const target = join(dir, page.name);
      if (!written.has(posix(target))) bytes += await copy(join(dirname(s.atlas), page.name), target);
    }
    entry.bytes = bytes;
  }

  // Sprite sheet images and standalone images: pages of their own (tiers, KTX2), like atlas pages.
  const sprites: Record<string, number[]> = {};
  const images: string[] = [];
  for (const plan of imagePlans) {
    try {
      const written1 = await encodeImagePage(plan, tiers, {
        imageFormat, quality: config.quality, ktx2: codecDefault, ktx2Quality: config.ktx2Quality, encode,
        onFile: (name, bytes) => onPageFile(plan.outDir, name, bytes), warn: (m) => warn(m, plan.name),
      });
      write(join(plan.outDir, `${written1.setName}.textures.json`), json2bytes(written1.textures));
      const padded = written1.frame.width !== written1.width || written1.frame.height !== written1.height;
      const entry = { path: posix(join(plan.outDir, written1.page)), width: written1.width, height: written1.height, ...(padded && plan.kind === 'image' ? { frame: written1.frame } : {}) };
      if (plan.kind === 'image') {
        extras.images![plan.name] = entry;
        images.push(plan.name);
        continue;
      }
      // The frames, at 1× and at each tier written (scaled to that tier's exact page size).
      const json = plan.json!;
      write(join(plan.outDir, `${plan.name}.json`), json2bytes({ ...json, meta: { ...json.meta, image: written1.page } }));
      for (const tier of written1.tiers.filter((t) => t !== 1)) {
        const size = tierSize(written1.width, written1.height, tier);
        const imageName = tierFileName(written1.page, tier);
        const scaled = tier > 1 && written1.hiJson.get(tier)
          ? { ...written1.hiJson.get(tier)!, meta: { ...written1.hiJson.get(tier)!.meta, image: imageName, scale: String(tier * Number(json.meta.scale ?? 1)) } }
          : scaleSpriteSheet(json, tier, imageName, { w: written1.width, h: written1.height }, { w: size.width, h: size.height });
        write(join(plan.outDir, tierFileName(`${plan.name}.json`, tier)), json2bytes(scaled));
      }
      extras.spritePages![plan.name] = entry;
      sprites[plan.name] = written1.tiers;
    } catch (err) {
      warn(`${plan.kind === 'image' ? 'image' : 'sprite sheet'} not exported: ${(err as Error).message}`, plan.name);
    }
  }

  // SDF fonts (`tabula font` output): copied with their pages.
  const fonts: string[] = [];
  for (const font of found.fonts) {
    await progress('copy', copied++, copyTotal, `Font ${basename(font)}`);
    const name = basename(font, '.font.json');
    const dir = join('fonts', relative(sourceDir, dirname(font)));
    try {
      const json = JSON.parse(await readFile(font, 'utf-8')) as { pages?: { file: string; ktx2?: string }[] };
      sourceBytes += await copy(font, join(dir, basename(font)));
      for (const page of json.pages ?? []) {
        for (const file of [page.file, page.ktx2]) if (file) sourceBytes += await copy(join(dirname(font), file), join(dir, file));
      }
      fonts.push(name);
    } catch (err) {
      warn(`font not exported: ${(err as Error).message}`, name);
    }
  }

  // The manifest over exactly these files.
  emit({ type: 'step', message: 'Writing the manifest' });
  await progress('manifest', 0, 1, 'Writing the manifest');
  const inputs: ManifestInputFile[] = [...written].map(([path, bytes]) => ({ path, bytes }));
  const { manifest, warnings: manifestWarnings } = buildAssetManifest(inputs, config.loadGroups ?? {}, extras);
  for (const w of manifestWarnings) warn(w);
  const conflicts = pageConflicts(manifest);
  for (const c of conflicts) warn(c);

  // Pack, then replace the output folder.
  const out = new Map<string, Uint8Array>();
  let bundles: BundleReport[] = [];
  if (format === 'tbla') {
    emit({ type: 'step', message: 'Packing .tbla bundles' });
    const packed = packBundles(manifest, written, mode, tiers);
    manifest.version = 3;
    manifest.bundles = packed.entries;
    for (const [path, bytes] of packed.files) out.set(path, bytes);
    bundles = packed.entries.map((b) => ({ path: b.file.path, tier: b.tier, group: b.group, ...(b.language ? { language: b.language } : {}), bytes: b.file.bytes, files: b.paths.length }));
  } else {
    for (const [path, bytes] of written) out.set(path, bytes);
  }
  out.set(MANIFEST_FILE, new TextEncoder().encode(`${JSON.stringify(manifest, null, 1)}\n`));
  await prepareOutDir(outDir);
  for (const [path, bytes] of out) {
    await mkdir(dirname(join(outDir, path)), { recursive: true });
    await writeFile(join(outDir, path), bytes);
  }
  let outputBytes = 0;
  for (const bytes of out.values()) outputBytes += bytes.length;
  const report: ExportReport = {
    manifest, mode, format, skeletons, sprites, images, fonts, bundles, conflicts, tiers: availableTiers(manifest), warnings, sourceBytes, outputBytes, ms: performance.now() - t0,
  };
  const summary: Partial<ExportReport> & { date: string } = { ...report, date: new Date().toISOString() };
  delete summary.manifest;
  await writeFile(join(outDir, REPORT_FILE), `${JSON.stringify(summary, null, 1)}\n`);
  await progress('manifest', 1, 1, 'Done');
  return report;
}

/** A bundle in the report. */
export interface BundleReport {
  path: string;
  tier: number;
  group: string;
  language?: string;
  bytes: number;
  /** Files inside. */
  files: number;
}

/**
 * Pages shared by several load groups: loading one of them uploads the
 * page with the other group's art too.
 */
export function pageConflicts(manifest: AssetManifest): string[] {
  const out: string[] = [];
  for (const page of Object.keys(manifest.pages)) {
    const groups = Object.entries(manifest.groups).filter(([, g]) => g.pages.includes(page)).map(([n]) => n);
    if (groups.length > 1) out.push(`page ${page} is shared by load groups ${groups.join(', ')}: loading one uploads it whole (${(manifest.pages[page]!.width * manifest.pages[page]!.height * 4 / 1048576).toFixed(1)} MB RGBA)`);
  }
  return out;
}

/** A page image (standalone image or sprite sheet image) encoded at every tier, with KTX2. */
async function encodeImagePage(
  plan: { name: string; source: string; sheet?: string },
  tiers: readonly number[],
  o: {
    imageFormat: PageImageFormat; quality?: number; ktx2: BasisCodec | null; ktx2Quality?: number;
    encode: (image: RgbaImage, options: Ktx2EncodeOptions, file: string) => Promise<Uint8Array | null>;
    onFile: (name: string, bytes: Uint8Array) => Promise<void>; warn: (message: string) => void;
  },
): Promise<{ page: string; setName: string; width: number; height: number; frame: { width: number; height: number }; tiers: number[]; textures: TextureManifest; hiJson: Map<number, SpriteSheetJson> }> {
  // KTX2 blocks are 4×4: pad to multiples of 4 (edge pixels repeated right and bottom, so filtering at the edge stays clean); the frame keeps the image's own size.
  const source = await decodeImage(plan.source);
  const frame = { width: source.width, height: source.height };
  const image = padToMultipleOf4(source);
  const ext = o.imageFormat === 'png' ? 'png' : 'webp';
  const page: AtlasPage = {
    name: `${plan.name}.${ext}`, width: image.width, height: image.height, format: 'RGBA8888',
    minFilter: 'Linear', magFilter: 'Linear', uWrap: 'ClampToEdge', vWrap: 'ClampToEdge', pma: false,
  };
  // Tiers above 1 need `<name>@2x` exports (never upscaled): the image next to it, or the sheet's own @2x JSON.
  const hi = new Map<number, RgbaImage>();
  const hiJson = new Map<number, SpriteSheetJson>();
  for (const tier of tiers.filter((t) => t > 1)) {
    const suffix = `@${+tier.toFixed(4)}x`;
    let hiPath: string | null = null;
    if (plan.sheet) {
      const jsonPath = plan.sheet.replace(/\.json$/, `${suffix}.json`);
      if (existsSync(jsonPath)) {
        const json = JSON.parse(await readFile(jsonPath, 'utf-8')) as SpriteSheetJson;
        hiJson.set(tier, json);
        hiPath = join(dirname(jsonPath), json.meta.image);
      }
    } else {
      const candidate = plan.source.replace(/(\.[^.]+)$/, `${suffix}$1`);
      if (existsSync(candidate)) hiPath = candidate;
    }
    if (!hiPath) {
      o.warn(`no ${suffix} export: no ${tier}x tier (tiers above 1 are never upscaled)`);
      continue;
    }
    const size = tierSize(image.width, image.height, tier);
    const decoded = await decodeImage(hiPath);
    premultiply(decoded);
    const fitted = resizeArea(decoded, Math.round(frame.width * tier), Math.round(frame.height * tier));
    unpremultiply(fitted);
    const page = createImage(size.width, size.height);
    blit(page, fitted, 0, 0, 4);
    hi.set(tier, page);
  }
  const usable = tiers.filter((t) => t <= 1 || hi.has(t));
  const group = {
    name: plan.name, skeletons: [], atlas: { pages: [page], regions: new Map() }, images: [image],
    sourcePages: [], regionPixels: 0, sharedRegions: [], placements: [],
  };
  const textures = await encodeGroupPages(group, {
    imageFormat: o.imageFormat, quality: o.quality, tiers: usable, ktx2Quality: o.ktx2Quality,
    ktx2For: () => o.ktx2, encodeKtx2: o.encode, tierPages: async (tier) => [hi.get(tier)!],
  }, (name, bytes) => o.onFile(name, bytes));
  return { page: page.name, setName: `${plan.sheet ? 'sprites' : 'image'}-${plan.name}`, width: image.width, height: image.height, frame, tiers: textures.tiers, textures, hiJson };
}

/** `image` grown to multiples of 4 (edge pixels repeated right and bottom), or itself when it already is. */
function padToMultipleOf4(image: RgbaImage): RgbaImage {
  const width = Math.ceil(image.width / 4) * 4;
  const height = Math.ceil(image.height / 4) * 4;
  if (width === image.width && height === image.height) return image;
  const out = createImage(width, height);
  blit(out, image, 0, 0, 4);
  return out;
}

/**
 * Pack the staged files into `.tbla` bundles, one per tier: release, one per
 * load group (language font variants in a bundle of their language);
 * development, one per asset, each with a manifest inside so it also opens
 * on its own. A file is in one bundle per tier (a page shared by groups
 * goes with the first group that uses it).
 */
export function packBundles(manifest: AssetManifest, files: ReadonlyMap<string, Uint8Array>, mode: 'release' | 'development', tiers: readonly number[]): { entries: ManifestBundle[]; files: Map<string, Uint8Array> } {
  const out = new Map<string, Uint8Array>();
  const entries: ManifestBundle[] = [];
  const fonts = manifest.fonts ?? {};
  const fontFiles = (name: string): string[] => {
    const f = fonts[name];
    if (!f) return [];
    const dir = f.json.path.slice(0, f.json.path.lastIndexOf('/') + 1);
    return [f.json.path, ...Object.keys(f.pages).map((p) => dir + p)];
  };
  const pageFiles = (name: string, tier: number): string[] => {
    const p = manifest.pages[name]!;
    const set = p.textureSet ? manifest.textureSets[p.textureSet] : undefined;
    if (!set) return [p.base + name];
    const t = resolveTier(tier, set.tiers);
    const list = [tierFileName(name, t)];
    if (set.pages[name]?.ktx2) list.push(tierFileName(name, t, 'ktx2'));
    return list.map((f) => p.base + f).filter((f) => files.has(f));
  };
  const spriteFiles = (name: string, tier: number): string[] => {
    const sheet = manifest.sprites[name]!;
    const t = sheet.tiers ? resolveTier(tier, [1, ...Object.keys(sheet.tiers).map(Number)]) : 1;
    const json = t === 1 ? sheet.json : sheet.tiers![String(t)]!.json;
    return sheet.page ? [json.path, ...pageFiles(sheet.page, tier)] : [json.path, (t === 1 ? sheet.image : sheet.tiers![String(t)]!.image).path];
  };
  const skeletonFiles = (name: string, tier: number): string[] => {
    const s = manifest.skeletons[name]!;
    return [s.file.path, ...(s.atlas ? [s.atlas.path] : []), ...(s.baked ? [s.baked.path] : []), ...s.pages.flatMap((p) => pageFiles(p, tier))];
  };
  const imageFiles = (name: string, tier: number): string[] => pageFiles(manifest.images![name]!.page, tier);
  const fileName = (base: string, tier: number): string => `${base}${tier === 1 ? '' : `@${+tier.toFixed(4)}x`}.tbla`;
  const add = (base: string, tier: number, group: string, paths: string[], language?: string, embed?: Partial<Record<'skeletons' | 'sprites' | 'fonts' | 'images', string[]>>): void => {
    const unique = [...new Set(paths)].filter((p) => files.has(p));
    if (!unique.length) return;
    const contents = unique.map((p) => ({ path: p, bytes: files.get(p)! }));
    if (embed) contents.push({ path: 'assets.manifest.json', bytes: new TextEncoder().encode(JSON.stringify(embeddedManifest(manifest, files, unique, tier, embed))) });
    const bytes = writeBundle(contents, { tier, group, ...(language ? { language } : {}), mode });
    const path = fileName(base, tier);
    if (out.has(path)) throw new Error(`Two bundles named ${path}: rename an asset or group`);
    out.set(path, bytes);
    entries.push({ file: { path, bytes: bytes.length, hash: contentHash(bytes) }, tier, group, ...(language ? { language } : {}), paths: unique });
  };
  const bundleTiers = [...new Set(tiers)].sort((a, b) => b - a);
  const languageFonts = Object.keys(fonts).filter((n) => fonts[n]!.language);
  if (mode === 'development') {
    for (const tier of bundleTiers) {
      for (const name of Object.keys(manifest.skeletons)) add(name, tier, name, skeletonFiles(name, tier), undefined, { skeletons: [name] });
      for (const name of Object.keys(manifest.sprites)) add(name, tier, name, spriteFiles(name, tier), undefined, { sprites: [name] });
      for (const name of Object.keys(manifest.images ?? {})) add(name, tier, name, imageFiles(name, tier), undefined, { images: [name] });
    }
    for (const name of Object.keys(fonts)) {
      const own = [...fontFiles(name), ...(fonts[name]!.fallbacks ?? []).flatMap(fontFiles)];
      add(name.replace(/@/g, '.'), 1, name, own, fonts[name]!.language, { fonts: [fonts[name]!.base ?? name] });
    }
    return { entries, files: out };
  }
  const groupNames = Object.keys(manifest.groups);
  const single = groupNames.length === 1;
  for (const tier of bundleTiers) {
    const taken = new Set<string>();
    for (const g of groupNames) {
      const spec = manifest.groups[g]!;
      const paths = [
        ...spec.skeletons.flatMap((n) => skeletonFiles(n, tier)),
        ...spec.sprites.flatMap((n) => spriteFiles(n, tier)),
        ...(spec.images ?? []).flatMap((n) => imageFiles(n, tier)),
        // Fonts without language variants (and their fallbacks); variants go to their language's bundle.
        ...(spec.fonts ?? []).filter((n) => fonts[n] && !fonts[n]!.language).flatMap((n) => [...fontFiles(n), ...(fonts[n]!.fallbacks ?? []).flatMap(fontFiles)]),
      ].filter((p) => !taken.has(p));
      for (const p of paths) taken.add(p);
      add(single ? 'game' : g, tier, g, paths);
    }
  }
  const languages = [...new Set(languageFonts.map((n) => fonts[n]!.language!))];
  for (const language of languages) {
    const names = languageFonts.filter((n) => fonts[n]!.language === language);
    add(`fonts@${language}`.replace(/@/g, '.'), 1, 'fonts', names.flatMap((n) => [...fontFiles(n), ...(fonts[n]!.fallbacks ?? []).flatMap(fontFiles)]), language);
  }
  return { entries, files: out };
}

/** The manifest of a self-contained development bundle: its members, its files, its tier only. */
function embeddedManifest(manifest: AssetManifest, files: ReadonlyMap<string, Uint8Array>, paths: string[], tier: number, members: Partial<Record<'skeletons' | 'sprites' | 'fonts' | 'images', string[]>>): AssetManifest {
  const inside = new Set(paths);
  const pages: AssetManifest['pages'] = {};
  const textureSets: AssetManifest['textureSets'] = {};
  for (const [name, page] of Object.entries(manifest.pages)) {
    const pageFilesInside = Object.keys(page.files).filter((f) => inside.has(page.base + f));
    if (!pageFilesInside.length) continue;
    pages[name] = { ...page, files: Object.fromEntries(pageFilesInside.map((f) => [f, page.files[f]!])) };
    const set = page.textureSet ? manifest.textureSets[page.textureSet] : undefined;
    if (set) {
      const t = resolveTier(tier, set.tiers);
      const entry = set.pages[name]!;
      const own = textureSets[page.textureSet!] ?? { version: 1 as const, tiers: [t], pages: {} };
      own.pages[name] = { ...entry, files: Object.fromEntries(Object.entries(entry.files).filter(([f]) => inside.has(page.base + f))) };
      textureSets[page.textureSet!] = own;
    }
  }
  const pick = <T>(all: Record<string, T> | undefined, names: string[] | undefined): Record<string, T> => Object.fromEntries((names ?? []).filter((n) => all?.[n]).map((n) => [n, all![n]!]));
  const fonts = manifest.fonts ?? {};
  const fontNames = (members.fonts ?? []).flatMap((n) => Object.keys(fonts).filter((k) => k === n || fonts[k]!.base === n || inside.has(fonts[k]!.json.path)));
  const sprites = pick(manifest.sprites, members.sprites);
  for (const [name, sheet] of Object.entries(sprites)) {
    const t = sheet.tiers ? resolveTier(tier, [1, ...Object.keys(sheet.tiers).map(Number)]) : 1;
    if (t !== 1) sprites[name] = { ...sheet, json: sheet.tiers![String(t)]!.json, tiers: undefined };
    else sprites[name] = { ...sheet, tiers: undefined };
  }
  const group: ManifestGroup = {
    skeletons: members.skeletons ?? [], sprites: Object.keys(sprites), fonts: members.fonts ?? [], pages: Object.keys(pages),
    bytes: paths.reduce((n, p) => n + (files.get(p)?.length ?? 0), 0),
  };
  if (members.images?.length) group.images = members.images;
  return {
    format: 'tabula-manifest', version: 3, skeletons: pick(manifest.skeletons, members.skeletons), pages, textureSets, sprites,
    fonts: pick(fonts, fontNames), ...(members.images ? { images: pick(manifest.images, members.images) } : {}),
    groups: { base: group }, preload: [],
  };
}

/** Pixi / TexturePacker sprite sheet JSON (the fields scaled here). */
interface SpriteSheetJson {
  frames: Record<string, SpriteFrame> | (SpriteFrame & { filename: string })[];
  meta: { image: string; size?: { w: number; h: number }; scale?: string | number; [key: string]: unknown };
  [key: string]: unknown;
}

interface SpriteFrame {
  frame: { x: number; y: number; w: number; h: number };
  spriteSourceSize?: { x: number; y: number; w: number; h: number };
  sourceSize?: { w: number; h: number };
  anchor?: unknown;
  [key: string]: unknown;
}

/**
 * A sprite sheet at `tier`: frames, trims and sizes in tier pixels and
 * `meta.scale` multiplied by the tier, so Pixi gives the textures the
 * resolution that keeps every sprite at its 1× size.
 */
export function scaleSpriteSheet(json: SpriteSheetJson, tier: number, image: string, imageSize: { w: number; h: number }, target?: { w: number; h: number }): SpriteSheetJson & { meta: { size: { w: number; h: number } } } {
  // Scale to the tier page's exact size (tierSize rounds to 4×4 blocks), not just by `tier`.
  const size = target ?? { w: Math.max(1, Math.round(imageSize.w * tier)), h: Math.max(1, Math.round(imageSize.h * tier)) };
  const sx = size.w / imageSize.w;
  const sy = size.h / imageSize.h;
  const rect = <T extends { x: number; y: number; w: number; h: number }>(b: T): T => {
    const x = Math.round(b.x * sx);
    const y = Math.round(b.y * sy);
    return { ...b, x, y, w: Math.max(1, Math.round((b.x + b.w) * sx) - x), h: Math.max(1, Math.round((b.y + b.h) * sy) - y) };
  };
  const frame = (f: SpriteFrame): SpriteFrame => ({
    ...f,
    frame: rect(f.frame),
    ...(f.spriteSourceSize ? { spriteSourceSize: rect(f.spriteSourceSize) } : {}),
    ...(f.sourceSize ? { sourceSize: { w: Math.max(1, Math.round(f.sourceSize.w * sx)), h: Math.max(1, Math.round(f.sourceSize.h * sy)) } } : {}),
  });
  const frames = Array.isArray(json.frames)
    ? json.frames.map((f) => ({ ...frame(f), filename: f.filename }))
    : Object.fromEntries(Object.entries(json.frames).map(([k, f]) => [k, frame(f)]));
  const scale = Number(json.meta.scale ?? 1) * tier;
  return { ...json, frames, meta: { ...json.meta, image, size, scale: String(+scale.toFixed(6)) } };
}

const IMAGE_FILE = /\.(png|webp|jpe?g|avif)$/i;

const json2bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value, null, 1));

/** Throw before any work when `dir` is a non-empty folder an export did not write. */
async function checkOutDir(dir: string): Promise<void> {
  const entries = await readdir(dir).catch(() => null);
  if (entries?.length && !entries.includes(EXPORT_MARKER)) throw new Error(`${dir} is not empty and was not written by a Tabula export; choose an empty folder`);
}

/** Create `dir`, or empty it if an earlier export wrote it; refuse any other non-empty folder. */
async function prepareOutDir(dir: string): Promise<void> {
  await checkOutDir(dir);
  for (const entry of await readdir(dir).catch(() => [])) await rm(join(dir, entry), { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, EXPORT_MARKER), 'Written by a Tabula export; the next export empties this folder.\n');
}

/** What a project folder holds (see {@link discoverProject}). */
export interface ProjectFiles {
  skeletons: SourceSkeleton[];
  sprites: string[];
  fonts: string[];
  /** Standalone images: not a page of an atlas, sprite sheet or font, and not a tier export (`logo@2x.png`). */
  images: string[];
  /** Spine binary exports (not supported: reported). */
  skel: string[];
  /** `.tbla` bundles (opened by the app, not exported again). */
  bundles: string[];
}

/** Raw exports under `dir` (not in the output or cache folders, not node_modules or dot folders). */
export async function discoverProject(dir: string, outDir: string, cacheDir?: string): Promise<ProjectFiles> {
  const skip = new Set([outDir, resolve(cacheDir ?? join(dir, '.tabula-cache'))]);
  const out = { skeletons: [] as SourceSkeleton[], sprites: [] as string[], fonts: [] as string[], images: [] as string[], skel: [] as string[], bundles: [] as string[] };
  const imageFiles: string[] = [];
  const tierSheets: string[] = [];
  const atlases: string[] = [];
  const names = new Map<string, string>();
  const walk = async (d: string): Promise<void> => {
    for (const entry of (await readdir(d, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(d, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules' && !skip.has(path)) await walk(path);
        continue;
      }
      if (entry.name.endsWith('.skel')) {
        out.skel.push(path);
        continue;
      }
      if (entry.name.toLowerCase().endsWith('.tbla')) {
        out.bundles.push(path);
        continue;
      }
      if (IMAGE_FILE.test(entry.name)) {
        imageFiles.push(path);
        continue;
      }
      if (entry.name.endsWith('.atlas')) {
        atlases.push(path);
        continue;
      }
      if (!entry.name.endsWith('.json') || entry.name === 'tabula.config.json' || entry.name.endsWith('.textures.json') || entry.name.endsWith('.manifest.json')) continue;
      if (entry.name.endsWith('.font.json')) {
        out.fonts.push(path);
        continue;
      }
      if (isTierExport(path)) {
        tierSheets.push(path);
        continue;
      }
      let json: unknown;
      try {
        json = JSON.parse(await readFile(path, 'utf-8'));
      } catch {
        continue;
      }
      if (isSpineJson(json)) {
        const name = basename(path, '.json');
        if (names.has(name)) throw new Error(`Two skeletons named "${name}": ${names.get(name)} and ${path}`);
        names.set(name, path);
        out.skeletons.push({ name, json: path, atlas: path.replace(/\.json$/, '.atlas') });
      } else if (isSpriteSheetJson(json)) {
        out.sprites.push(path);
      }
    }
  };
  await walk(dir);
  // Images used by an atlas (any tier), a sprite sheet or a font are not standalone.
  const used = new Set<string>();
  for (const atlas of atlases) {
    const text = await readFile(atlas, 'utf-8').catch(() => '');
    for (const line of text.split(/\r?\n/)) if (IMAGE_FILE.test(line.trim())) used.add(join(dirname(atlas), line.trim()));
  }
  for (const json of [...out.sprites, ...out.fonts]) {
    const j = JSON.parse(await readFile(json, 'utf-8')) as { meta?: { image?: string }; pages?: { file: string }[] };
    if (j.meta?.image) used.add(join(dirname(json), j.meta.image));
    for (const p of j.pages ?? []) used.add(join(dirname(json), p.file));
  }
  for (const json of tierSheets) {
    const j = JSON.parse(await readFile(json, 'utf-8').catch(() => '{}')) as { meta?: { image?: string } };
    if (j.meta?.image) used.add(join(dirname(json), j.meta.image));
  }
  out.images = imageFiles.filter((f) => !used.has(f) && !/@\d+(\.\d+)?x\.[^.]+$/.test(f));
  return out;
}

function isSpriteSheetJson(json: unknown): boolean {
  const j = json as { frames?: unknown; meta?: { image?: unknown } } | null;
  return !!j && typeof j === 'object' && !!j.frames && typeof j.meta?.image === 'string';
}

/**
 * KTX2 encoder caching by content hash in `dir`: a cached file is the
 * encoder's output for the same pixels and settings. Without the `ktx` tool,
 * cached pages are still used and the others stay images (warned once).
 */
export function cachedKtx2(dir: string, warn: (message: string) => void): (image: RgbaImage, options: Ktx2EncodeOptions, file: string) => Promise<Uint8Array | null> {
  let toolError: string | null | undefined;
  return async (image, options, file) => {
    const hash = createHash('sha1').update(image.data).update(JSON.stringify([image.width, image.height, options])).digest('hex').slice(0, 16);
    const path = join(dir, `${file.replace(/\.ktx2$/, '')}.${hash}.ktx2`);
    if (existsSync(path)) return new Uint8Array(await readFile(path));
    if (toolError === undefined) {
      toolError = await checkKtxTool().then(() => null, (err: Error) => err.message);
      if (toolError) warn(`KTX2 pages skipped (pages load as images): ${toolError}`);
    }
    if (toolError) return null;
    const bytes = await encodeKtx2(image, options);
    await mkdir(dir, { recursive: true });
    await writeFile(path, bytes);
    return bytes;
  };
}

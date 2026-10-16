/**
 * Asset manifest with load groups (design §8, §10.9): one JSON file that lists
 * every runtime file a game needs, which texture pages each skeleton uses, the
 * KTX2 tiers and formats available per page, and the load groups (`base`,
 * `bonus`, `freespins`, ...). Written by `tabula manifest`; read by the
 * Pixi v7 `TabulaAssetManager`.
 *
 * Pure: the builder takes file names and bytes (the CLI reads a directory,
 * the demo server passes its in-memory build), no Node or DOM APIs.
 */

import { loadSkeletonBinary } from './slb.js';
import { AtlasParser } from './adapters/atlas-parser.js';
import { resolveTier, tierFileName, tierSize } from './texture-formats.js';
import type { TextureManifest } from './texture-formats.js';

/**
 * Manifest format version: 3 with bundles (`.tbla`), standalone images or
 * sprite sheet pages; 2 with raw Spine JSON skeletons; else 1 (each the
 * oldest that describes it, so older runtimes read what they can).
 */
export const ASSET_MANIFEST_VERSION = 3;
/** Oldest manifest version {@link validateAssetManifest} reads. */
const OLDEST_MANIFEST_VERSION = 1;

/** A runtime file: path relative to the manifest, size and content hash. */
export interface ManifestFile {
  path: string;
  bytes: number;
  /** Content hash (16 hex chars, FNV-1a 64): cache busting and change detection. */
  hash: string;
}

/**
 * A skeleton: compiled (`.tabula`, with embedded atlas) or a raw Spine JSON
 * export (`.json` + `.atlas`, loaded with the JSON plug-in).
 */
export interface ManifestSkeleton {
  /** `tabula` (default when absent, version 1 manifests) or `json`. */
  format?: 'tabula' | 'json';
  /** The compiled skeleton (`.tabula`) or the Spine JSON export. */
  file: ManifestFile;
  /** The `.atlas` of a JSON skeleton. */
  atlas?: ManifestFile;
  /** Baked samples (`.baked`), if built (compiled skeletons only). */
  baked: ManifestFile | null;
  /** Atlas page names the skeleton draws from (keys of {@link AssetManifest.pages}). */
  pages: string[];
}

/** One atlas page: its 1× image and, with a texture set, the tier / KTX2 files. */
export interface ManifestPage {
  /** 1× size (atlas units). */
  width: number;
  height: number;
  /** Texture set (`<set>.textures.json`) describing the page's tiers and KTX2 files, or null (1× image only). */
  textureSet: string | null;
  /** Every file of the page (all tiers and encodings), by file name relative to {@link base}. */
  files: Record<string, ManifestFile>;
  /** Directory of the page files, relative to the manifest (e.g. "" or "repacked/"). */
  base: string;
}

/** A sprite sheet (Pixi / TexturePacker JSON hash or array format). */
export interface ManifestSprites {
  json: ManifestFile;
  image: ManifestFile;
  /**
   * Other resolution tiers (`ui@0.5x.json` + its image), by tier ("0.5", "2").
   * Their frames are in tier pixels with `meta.scale` set, so sprites keep their size.
   */
  tiers?: Record<string, { json: ManifestFile; image: ManifestFile }>;
  /**
   * The sheet image as a page (key of {@link AssetManifest.pages}), loaded
   * like atlas pages (tiers, KTX2). `json` (and `tiers[t].json`) then give the frames.
   */
  page?: string;
}

/** A standalone image (a logo, a background): a page of its own, with tiers and KTX2 like atlas pages. */
export interface ManifestImage {
  /** Key of {@link AssetManifest.pages}. */
  page: string;
  /** Size of the image at 1× when the page is larger (padded to multiples of 4 for KTX2): the texture shows only this top-left part. */
  frame?: { width: number; height: number };
}

/**
 * A `.tbla` bundle holding some of the manifest's files (by their paths).
 * Files of several tiers are in separate bundles; the runtime reads each
 * file from the bundle of its tier.
 */
export interface ManifestBundle {
  file: ManifestFile;
  /** Tier of the page files in it (other files are in every tier's bundle). */
  tier: number;
  /** Load group (release) or asset (development) it was made for. */
  group: string;
  /** Language of the font variants in it, for a language's own bundle. */
  language?: string;
  /** Paths of the files in it. */
  paths: string[];
}

/** A compiled SDF font (`.font.json` from `tabula font`) and its page files. */
export interface ManifestFont {
  json: ManifestFile;
  /** Page images and KTX2 alternatives, by file name relative to the font JSON. */
  pages: Record<string, ManifestFile>;
  /** Fallback font names from the `.font.json` (loaded and linked with this font). */
  fallbacks?: string[];
  /** Language of a variant named `<base>@<language>`. */
  language?: string;
  /** Name without the `@<language>` suffix (variants of one base switch with `setLanguage`). */
  base?: string;
}

/** Split a font name `main@ka` into base and language (`{ base: 'main', language: 'ka' }`). */
export function splitFontName(name: string): { base: string; language: string | undefined } {
  const at = name.lastIndexOf('@');
  return at > 0 ? { base: name.slice(0, at), language: name.slice(at + 1) } : { base: name, language: undefined };
}

/** A load group: what to load together. Shared members are loaded once and reference-counted. */
export interface ManifestGroup {
  skeletons: string[];
  sprites: string[];
  /** SDF fonts (absent in manifests written before fonts existed). */
  fonts?: string[];
  /** Standalone images (version 3). */
  images?: string[];
  /** Union of the members' pages. */
  pages: string[];
  /** Bytes of the group's files at tier 1 with images (an upper bound for progress). */
  bytes: number;
}

/** `assets.manifest.json`. */
export interface AssetManifest {
  format: 'tabula-manifest';
  version: 1 | 2 | 3;
  skeletons: Record<string, ManifestSkeleton>;
  pages: Record<string, ManifestPage>;
  /** Texture set name → tiers and per-page codecs (the `<set>.textures.json` content). */
  textureSets: Record<string, TextureManifest>;
  sprites: Record<string, ManifestSprites>;
  /** SDF fonts by name (absent in manifests written before fonts existed). */
  fonts?: Record<string, ManifestFont>;
  /** Standalone images by name (version 3). */
  images?: Record<string, ManifestImage>;
  /** `.tbla` bundles the files are in (version 3); without them every file is its own. */
  bundles?: ManifestBundle[];
  groups: Record<string, ManifestGroup>;
  /** Groups to preload in the background after the first group loaded (hint for the runtime). */
  preload: string[];
}

/**
 * Load group definition: group name → glob patterns (`*`, `?`, `[1-9]`) over skeleton
 * sprite sheet and font names. A member may be in several groups. Members matched
 * by no group go to `defaultGroup` (default "base").
 */
export interface LoadGroupsSpec {
  groups?: Record<string, string[]>;
  /** Group for unmatched members (default "base"). */
  defaultGroup?: string;
  /** Group names to preload in the background (copied to the manifest). */
  preload?: string[];
}

/**
 * Images the files alone do not identify (for {@link buildAssetManifest}):
 * standalone images and sprite sheet images to load as pages (tiers, KTX2).
 * Paths are of the 1× image; a texture set in its folder that lists it
 * gives its tier and KTX2 files.
 */
export interface ManifestExtras {
  /** Image name → its 1× image. */
  images?: Record<string, { path: string; width: number; height: number; frame?: { width: number; height: number } }>;
  /** Sprite sheet name → its 1× image, loaded as a page. */
  spritePages?: Record<string, { path: string; width: number; height: number }>;
}

/** An input file for {@link buildAssetManifest}. */
export interface ManifestInputFile {
  /** Path relative to the manifest, with forward slashes. */
  path: string;
  bytes: Uint8Array;
}

/** FNV-1a 64-bit of `bytes`, as 16 hex chars (not cryptographic). */
export function contentHash(bytes: Uint8Array): string {
  // 64-bit arithmetic in four 16-bit limbs (h0 lowest).
  let h0 = 0x2325, h1 = 0x8422, h2 = 0x9ce4, h3 = 0xcbf2; // offset basis 0xcbf29ce484222325 in 16-bit limbs
  for (let i = 0; i < bytes.length; i++) {
    h0 ^= bytes[i]!;
    // multiply by the prime 0x100000001b3 = 2^40 + 0x1b3 (2^40 = limb 2, shifted 8)
    const t0 = h0 * 0x1b3;
    const t1 = h1 * 0x1b3 + (t0 >>> 16);
    const t2 = h2 * 0x1b3 + (h0 << 8) + (t1 >>> 16);
    const t3 = h3 * 0x1b3 + (h1 << 8) + (t2 >>> 16);
    h0 = t0 & 0xffff;
    h1 = t1 & 0xffff;
    h2 = t2 & 0xffff;
    h3 = t3 & 0xffff;
  }
  const hex = (n: number): string => n.toString(16).padStart(4, '0');
  return hex(h3) + hex(h2) + hex(h1) + hex(h0);
}

/** Glob (`*`, `?`, `[a-z]` classes) to RegExp, whole-string match. */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const dirName = (path: string): string => path.slice(0, path.lastIndexOf('/') + 1);
const stripExt = (name: string): string => (name.lastIndexOf('.') > 0 ? name.slice(0, name.lastIndexOf('.')) : name);

/** True when `value` looks like a Spine JSON export (a `skeleton.spine` version and a `bones` list). */
export function isSpineJson(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const { skeleton, bones } = value as { skeleton?: { spine?: unknown }; bones?: unknown };
  return typeof skeleton?.spine === 'string' && Array.isArray(bones);
}

function isSpriteSheet(json: unknown): json is { frames: unknown; meta: { image: string } } {
  const j = json as { frames?: unknown; meta?: { image?: unknown } } | null;
  return !!j && typeof j === 'object' && !!j.frames && typeof j.meta?.image === 'string';
}

/**
 * Build the manifest from build outputs and raw exports: `.tabula` (with embedded atlas),
 * `.baked`, atlas page images and their tier / KTX2 files, `*.textures.json`
 * (from `repack --tiers/--ktx2`) and sprite sheet JSON + image. Skeletons are
 * named by their `.tabula` header; a `.baked` pairs with the `.tabula` of the same
 * base name (any directory). Raw Spine JSON exports (`<name>.json` + `<name>.atlas`
 * + pages) are listed as `format: 'json'`. A compiled skeleton wins over a raw
 * one of the same name; a `.tabula` that cannot be read falls back to its raw
 * export (both with a warning), else throws. Throws if a page file is missing.
 *
 * @example
 * const manifest = buildAssetManifest(files, { groups: { base: ['symbol*', 'reel*'], bigwin: ['bigWin*'] }, preload: ['bigwin'] });
 */
export function buildAssetManifest(files: readonly ManifestInputFile[], spec: LoadGroupsSpec = {}, extras: ManifestExtras = {}): { manifest: AssetManifest; warnings: string[] } {
  const warnings: string[] = [];
  const byPath = new Map(files.map((f) => [f.path, f]));
  const fileEntry = (f: ManifestInputFile): ManifestFile => ({ path: f.path, bytes: f.bytes.length, hash: contentHash(f.bytes) });
  const decoder = new TextDecoder();

  // Texture sets: <set>.textures.json, pages resolved in the same directory.
  const textureSets: Record<string, TextureManifest> = {};
  const pageSet = new Map<string, { set: string; dir: string }>(); // `${dir}${page}` -> set
  for (const f of files) {
    if (!f.path.endsWith('.textures.json')) continue;
    const set = baseName(f.path).slice(0, -'.textures.json'.length);
    const tm = JSON.parse(decoder.decode(f.bytes)) as TextureManifest;
    if (textureSets[set]) warnings.push(`texture set "${set}" appears twice; using ${f.path}`);
    textureSets[set] = tm;
    for (const page of Object.keys(tm.pages)) pageSet.set(dirName(f.path) + page, { set, dir: dirName(f.path) });
  }

  const pages: Record<string, ManifestPage> = {};
  /** Add page `name` (in `dir`) with its texture-set files, unless already there. */
  const addPage = (dir: string, name: string, width: number, height: number, owner: string): void => {
    if (pages[name]) return;
    const set = pageSet.get(dir + name);
    const entry: ManifestPage = { width, height, textureSet: set?.set ?? null, files: {}, base: set?.dir ?? dir };
    const names = set ? Object.keys(textureSets[set.set]!.pages[name]!.files) : [name];
    if (set && !names.includes(name)) names.push(name);
    for (const file of names) {
      const input = byPath.get(entry.base + file);
      if (input) entry.files[file] = fileEntry(input);
      else if (file === name || file === tierFileName(name, 1)) throw new Error(`Page "${name}" of ${owner} not found at ${entry.base + file}`);
      else warnings.push(`page file ${entry.base + file} listed in texture set "${set?.set}" is missing`);
    }
    pages[name] = entry;
  };

  // Skeletons from .tabula, pages from their embedded atlas.
  const bakedByName = new Map<string, ManifestInputFile>();
  for (const f of files) if (f.path.endsWith('.baked')) bakedByName.set(stripExt(baseName(f.path)), f);
  const skeletons: Record<string, ManifestSkeleton> = {};
  const failed = new Map<string, Error>(); // file stem -> why the .tabula could not be read
  for (const f of files) {
    if (!f.path.endsWith('.tabula')) continue;
    let loaded: ReturnType<typeof loadSkeletonBinary>;
    try {
      loaded = loadSkeletonBinary(f.bytes);
    } catch (err) {
      failed.set(stripExt(baseName(f.path)), new Error(`${f.path}: ${(err as Error).message}`));
      continue;
    }
    const { data, atlas } = loaded;
    const name = data.name || stripExt(baseName(f.path));
    if (skeletons[name]) {
      warnings.push(`skeleton "${name}" in ${f.path} and ${skeletons[name].file.path}; keeping the first`);
      continue;
    }
    const baked = bakedByName.get(stripExt(baseName(f.path))) ?? bakedByName.get(name) ?? null;
    const pageNames: string[] = [];
    if (!atlas) warnings.push(`${f.path} has no embedded atlas: its pages are not in the manifest`);
    for (const page of atlas?.pages ?? []) {
      pageNames.push(page.name);
      addPage(dirName(f.path), page.name, page.width, page.height, f.path);
    }
    skeletons[name] = { format: 'tabula', file: fileEntry(f), baked: baked ? fileEntry(baked) : null, pages: pageNames };
  }

  // Raw Spine JSON exports: <name>.json + <name>.atlas + pages next to the atlas.
  const spineJson = new Set<string>();
  for (const f of files) {
    if (!f.path.endsWith('.json') || f.path.endsWith('.textures.json') || f.path.endsWith('.manifest.json') || f.path.endsWith('.font.json')) continue;
    let json: unknown;
    try {
      json = JSON.parse(decoder.decode(f.bytes));
    } catch {
      continue;
    }
    if (!isSpineJson(json)) continue;
    spineJson.add(f.path);
    if (/@\d+(\.\d+)?x\.json$/.test(f.path)) continue; // a tier export (`symbol1@2x.json`), not a skeleton of its own
    const name = stripExt(baseName(f.path));
    if (skeletons[name]) {
      warnings.push(skeletons[name].format === 'json'
        ? `skeleton "${name}" in ${f.path} and ${skeletons[name].file.path}; keeping the first`
        : `skeleton "${name}": using compiled ${skeletons[name].file.path}, raw ${f.path} not used`);
      continue;
    }
    const atlasFile = byPath.get(`${stripExt(f.path)}.atlas`);
    if (!atlasFile) throw new Error(`Spine JSON ${f.path}: atlas ${stripExt(f.path)}.atlas not found`);
    const atlas = new AtlasParser().parse(decoder.decode(atlasFile.bytes));
    const dir = dirName(atlasFile.path);
    for (const page of atlas.pages) {
      const image = byPath.get(dir + page.name);
      if (!image) throw new Error(`Page "${page.name}" of ${atlasFile.path} not found at ${dir + page.name}`);
      const existing = pages[page.name];
      if (existing && existing.base !== dir && (pageSet.get(dir + page.name)?.dir ?? dir) !== existing.base) {
        throw new Error(`Page "${page.name}" of ${atlasFile.path} has the same name as a page in ${existing.base || './'}; rename one`);
      }
      addPage(dir, page.name, page.width, page.height, atlasFile.path);
    }
    const why = failed.get(name);
    if (why) {
      warnings.push(`skeleton "${name}": ${why.message}; using raw ${f.path}`);
      failed.delete(name);
    }
    skeletons[name] = { format: 'json', file: fileEntry(f), atlas: fileEntry(atlasFile), baked: null, pages: atlas.pages.map((p) => p.name) };
  }
  for (const err of failed.values()) throw err;

  // Sprite sheets.
  const sprites: Record<string, ManifestSprites> = {};
  const spriteTiers: { base: string; tier: string; json: ManifestFile; image: ManifestFile }[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.json') || f.path.endsWith('.textures.json') || f.path.endsWith('.manifest.json') || spineJson.has(f.path)) continue;
    let json: unknown;
    try {
      json = JSON.parse(decoder.decode(f.bytes));
    } catch {
      continue;
    }
    if (!isSpriteSheet(json)) continue;
    const image = byPath.get(dirName(f.path) + json.meta.image);
    if (!image) throw new Error(`Sprite sheet ${f.path}: image ${json.meta.image} not found`);
    const stem = stripExt(baseName(f.path));
    const tier = /^(.+)@(\d+(?:\.\d+)?)x$/.exec(stem);
    if (tier) spriteTiers.push({ base: dirName(f.path) + tier[1]!, tier: String(+tier[2]!), json: fileEntry(f), image: fileEntry(image) });
    else sprites[stem] = { json: fileEntry(f), image: fileEntry(image) };
  }
  for (const t of spriteTiers) {
    const name = baseName(t.base);
    const sheet = sprites[name];
    if (!sheet || dirName(sheet.json.path) !== dirName(t.json.path)) {
      warnings.push(`sprite sheet tier ${t.json.path} has no 1x sheet ${t.base}.json; not used`);
      continue;
    }
    (sheet.tiers ??= {})[t.tier] = { json: t.json, image: t.image };
  }

  // Sprite sheet images loaded as pages (tiers, KTX2), and standalone images.
  for (const [name, image] of Object.entries(extras.spritePages ?? {})) {
    const sheet = sprites[name];
    if (!sheet) {
      warnings.push(`sprite sheet "${name}" (page ${image.path}) is not in the files`);
      continue;
    }
    addPage(dirName(image.path), baseName(image.path), image.width, image.height, `sprite sheet ${name}`);
    sheet.page = baseName(image.path);
  }
  const images: Record<string, ManifestImage> = {};
  for (const [name, image] of Object.entries(extras.images ?? {})) {
    if (pages[baseName(image.path)] && pages[baseName(image.path)]!.base !== dirName(image.path)) throw new Error(`Image "${name}": a page named ${baseName(image.path)} exists elsewhere; rename one`);
    addPage(dirName(image.path), baseName(image.path), image.width, image.height, `image ${name}`);
    images[name] = { page: baseName(image.path), ...(image.frame ? { frame: image.frame } : {}) };
  }

  // SDF fonts.
  const fonts: Record<string, ManifestFont> = {};
  for (const f of files) {
    if (!f.path.endsWith('.font.json')) continue;
    let json: { format?: string; pages?: { file: string; ktx2?: string }[]; fallbacks?: string[] };
    try {
      json = JSON.parse(decoder.decode(f.bytes));
    } catch {
      continue;
    }
    if (json.format !== 'tabula-font') continue;
    const entry: ManifestFont = { json: fileEntry(f), pages: {} };
    for (const page of json.pages ?? []) {
      for (const file of [page.file, page.ktx2]) {
        if (!file) continue;
        const input = byPath.get(dirName(f.path) + file);
        if (!input) throw new Error(`Font ${f.path}: page ${file} not found`);
        entry.pages[file] = fileEntry(input);
      }
    }
    const fontName = baseName(f.path).slice(0, -'.font.json'.length);
    const { base, language } = splitFontName(fontName);
    if (json.fallbacks?.length) entry.fallbacks = json.fallbacks;
    if (language) {
      entry.language = language;
      entry.base = base;
    }
    fonts[fontName] = entry;
  }
  for (const [name, font] of Object.entries(fonts)) {
    for (const fallback of font.fallbacks ?? []) {
      if (!fonts[fallback]) warnings.push(`font ${name}: fallback "${fallback}" is not in the manifest`);
    }
  }
  // Group members: fonts that only serve as fallbacks load with their head;
  // language variants are listed once under their base name.
  const fallbackOnly = new Set(Object.values(fonts).flatMap((f) => f.fallbacks ?? []));
  const fontMembers = [...new Set(Object.keys(fonts).filter((n) => !fallbackOnly.has(n)).map((n) => splitFontName(n).base))];
  const fontBytes = (name: string): number => {
    const own = fonts[name] ?? Object.values(fonts).find((f) => f.base === name);
    if (!own) return 0;
    const bytes = (f: ManifestFont): number => f.json.bytes + Object.entries(f.pages).filter(([n]) => !n.endsWith('.ktx2')).reduce((n, [, e]) => n + e.bytes, 0);
    return bytes(own) + (own.fallbacks ?? []).reduce((n, fb) => n + (fonts[fb] ? bytes(fonts[fb]) : 0), 0);
  };

  // Groups.
  const defaultGroup = spec.defaultGroup ?? 'base';
  const groupNames = Object.keys(spec.groups ?? {});
  const patterns = groupNames.map((g) => ({ group: g, res: (spec.groups![g] ?? []).map(globToRegExp) }));
  type Members = { skeletons: string[]; sprites: string[]; fonts: string[]; images: string[] };
  const members = new Map<string, Members>();
  const member = (g: string): Members => {
    let m = members.get(g);
    if (!m) members.set(g, (m = { skeletons: [], sprites: [], fonts: [], images: [] }));
    return m;
  };
  for (const g of groupNames) member(g);
  const assign = (name: string, kind: keyof Members): void => {
    // Groups listing the exact name win over patterns that also match (a member moved by name).
    const exact = groupNames.filter((g) => (spec.groups![g] ?? []).includes(name));
    const matched = exact.length ? exact : patterns.filter((p) => p.res.some((re) => re.test(name))).map((p) => p.group);
    for (const g of matched.length ? matched : [defaultGroup]) member(g)[kind].push(name);
  };
  for (const name of Object.keys(skeletons).sort()) assign(name, 'skeletons');
  for (const name of Object.keys(sprites).sort()) assign(name, 'sprites');
  for (const name of fontMembers.sort()) assign(name, 'fonts');
  for (const name of Object.keys(images).sort()) assign(name, 'images');
  const groups: Record<string, ManifestGroup> = {};
  for (const [g, m] of members) {
    const groupPages = [...new Set([
      ...m.skeletons.flatMap((s) => skeletons[s]!.pages),
      ...m.sprites.flatMap((s) => (sprites[s]!.page ? [sprites[s]!.page!] : [])),
      ...m.images.map((i) => images[i]!.page),
    ])];
    let bytes = 0;
    for (const s of m.skeletons) bytes += skeletons[s]!.file.bytes + (skeletons[s]!.atlas?.bytes ?? 0) + (skeletons[s]!.baked?.bytes ?? 0);
    for (const s of m.sprites) bytes += sprites[s]!.json.bytes + (sprites[s]!.page ? 0 : sprites[s]!.image.bytes);
    for (const s of m.fonts) bytes += fontBytes(s);
    for (const p of groupPages) bytes += pages[p]!.files[p]?.bytes ?? 0;
    groups[g] = { skeletons: m.skeletons, sprites: m.sprites, fonts: m.fonts, pages: groupPages, bytes };
    if (m.images.length) groups[g]!.images = m.images;
    if (!m.skeletons.length && !m.sprites.length && !m.fonts.length && !m.images.length) warnings.push(`load group "${g}" matched nothing`);
  }
  for (const g of spec.preload ?? []) if (!groups[g]) warnings.push(`preload group "${g}" does not exist`);

  const v3 = Object.keys(images).length > 0 || Object.values(sprites).some((s) => s.page);
  const manifest: AssetManifest = {
    format: 'tabula-manifest', version: v3 ? 3 : Object.values(skeletons).some((s) => s.format === 'json') ? 2 : 1,
    skeletons, pages, textureSets, sprites, fonts, groups, preload: (spec.preload ?? []).filter((g) => groups[g]),
  };
  if (Object.keys(images).length) manifest.images = images;
  return { manifest, warnings };
}

/** What one tier costs: download and GPU memory of the pages. */
export interface TierCost {
  tier: number;
  /** Page image bytes at this tier. */
  imageBytes: number;
  /** Bytes with KTX2 where a page has it (images elsewhere). */
  ktx2Bytes: number;
  /** Bytes of the KTX2 files alone (pages without KTX2 not counted). */
  ktx2FileBytes: number;
  /** GPU memory as RGBA8 (no KTX2). */
  vramBytes: number;
  /** GPU memory with KTX2 where a page has it (transcoded to a 1 byte per pixel block format; RGBA8 elsewhere). */
  ktx2VramBytes: number;
}

/** Every tier the manifest's pages and sprite sheets were built at, largest first (empty: 1× only). */
export function manifestTiers(manifest: AssetManifest): number[] {
  // Texture sets list every tier they have (1 included, except in a single-tier bundle's own manifest).
  const tiers = new Set(Object.values(manifest.textureSets).flatMap((s) => s.tiers));
  for (const sheet of Object.values(manifest.sprites)) {
    if (!sheet.tiers || sheet.page) continue;
    tiers.add(1);
    for (const t of Object.keys(sheet.tiers)) tiers.add(Number(t));
  }
  return [...tiers].sort((a, b) => b - a);
}

/**
 * The tiers `manifest` offers, largest first, with the cost of loading the
 * pages of `group` (default: every page) at each (sprite sheets not included). Pages without that tier
 * count at the tier they would load ({@link resolveTier}); pages without a
 * texture set at 1. For the game to choose its tier with.
 */
export function availableTiers(manifest: AssetManifest, group?: string): TierCost[] {
  const names = group === undefined ? Object.keys(manifest.pages) : manifest.groups[group]?.pages;
  if (!names) throw new Error(`Unknown load group "${group}"`);
  const tiers = manifestTiers(manifest);
  return (tiers.length ? tiers : [1]).map((tier) => {
    const cost: TierCost = { tier, imageBytes: 0, ktx2Bytes: 0, ktx2FileBytes: 0, vramBytes: 0, ktx2VramBytes: 0 };
    for (const name of names) {
      const page = manifest.pages[name]!;
      const set = page.textureSet ? manifest.textureSets[page.textureSet] : undefined;
      const t = set ? resolveTier(tier, set.tiers) : 1;
      const image = page.files[tierFileName(name, t)]?.bytes ?? 0;
      const ktx2 = set?.pages[name]?.ktx2 ? page.files[tierFileName(name, t, 'ktx2')]?.bytes : undefined;
      const size = tierSize(page.width, page.height, t);
      cost.imageBytes += image;
      cost.ktx2Bytes += ktx2 ?? image;
      cost.ktx2FileBytes += ktx2 ?? 0;
      cost.vramBytes += size.width * size.height * 4;
      cost.ktx2VramBytes += size.width * size.height * (ktx2 === undefined ? 4 : 1);
    }
    return cost;
  });
}

/** Check a parsed manifest's format and version; throws with a clear message otherwise. */
export function validateAssetManifest(json: unknown): AssetManifest {
  const m = json as Partial<AssetManifest> | null;
  if (!m || m.format !== 'tabula-manifest') throw new Error('Not a Tabula asset manifest');
  if (typeof m.version !== 'number' || m.version < OLDEST_MANIFEST_VERSION || m.version > ASSET_MANIFEST_VERSION) {
    throw new Error(`Asset manifest version ${String(m.version)} is not supported (expected ${OLDEST_MANIFEST_VERSION}–${ASSET_MANIFEST_VERSION}); update tabula-pixi`);
  }
  return m as AssetManifest;
}

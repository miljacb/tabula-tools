/**
 * `tabula font <font.ttf...> -o <dir>`: compile fonts to MSDF atlas pages
 * and `.font.json` metrics for the runtime's SDF text. Sources are font
 * files or Google Fonts families (`--google`); characters come from named
 * sets, languages (`--lang`) or i18n files (`--charset-from`); several
 * sources can form a fallback chain (`--chain`), and `--per-lang` writes one
 * variant per language (`name@ka`) for the manifest's language switching.
 */

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { compileFont, FONT_CHARSETS, resolveCharset } from '../../export/font/compile-font.js';
import type { FontCompileOptions } from '../../export/font/compile-font.js';
import { charsetFromFiles, codePoints, FONT_LANGUAGES } from '../../export/font/charsets.js';
import { fetchGoogleFont, googleFontName } from '../../export/font/google-fonts.js';
import type { GoogleFontOptions } from '../../export/font/google-fonts.js';
import { OpenTypeTables } from '../../export/font/opentype-tables.js';
import { encodeKtx2 } from '../../export/pack/ktx2.js';

/** Options of {@link fontCommand}. */
export interface FontCommandOptions extends Omit<FontCompileOptions, 'name' | 'codes' | 'language'> {
  outDir: string;
  /** Output base name (one font, or the head of each chain; `-<Weight>` is appended for several weights). */
  name?: string;
  /** Also write UASTC KTX2 pages (linear, no RDO). */
  ktx2?: boolean;
  /** Google Fonts families to download (build time only; pinned in the lockfile). */
  google?: readonly string[];
  /** Weights to download for `google` (default [400]). */
  weights?: readonly number[];
  /** i18n files (`.json`: string values; other files: all text) whose characters to include. */
  charsetFrom?: readonly string[];
  /** Treat the sources as one fallback chain: each later font only gets the characters earlier ones lack. */
  chain?: boolean;
  /** Write one variant per `lang` code, named `<name>@<lang>`. */
  perLang?: boolean;
  /** Lockfile and cache options for `google`. */
  lockFile?: string;
  updateLock?: boolean;
  cacheDir?: string;
  fetch?: GoogleFontOptions['fetch'];
  log?: (message: string) => void;
}

/** One written font. */
export interface WrittenFont {
  /** `.font.json` path. */
  path: string;
  name: string;
  language?: string;
  glyphs: number;
  /** Page sizes and PNG bytes. */
  pages: { width: number; height: number; bytes: number }[];
  fallbacks: string[];
}

interface Source {
  name: string;
  bytes: Uint8Array;
  covers: Set<number>;
  weight?: number;
  family?: string;
}

const PRIMARY_ALWAYS = [0x20, 0x3f, 0xfffd];

/** Compile the sources; returns the written fonts. */
export async function fontCommand(files: string[], options: FontCommandOptions): Promise<WrittenFont[]> {
  const log = options.log ?? ((m: string) => console.log(m));
  await mkdir(options.outDir, { recursive: true });

  // Sources, grouped by weight (files: one group).
  const groups = new Map<number | 'files', Source[]>();
  const fileSources: Source[] = [];
  for (const file of files) {
    const ext = extname(file).toLowerCase();
    if (ext !== '.ttf' && ext !== '.otf') throw new Error(`${file}: expected a .ttf or .otf font`);
    const bytes = new Uint8Array(await readFile(file));
    fileSources.push({ name: basename(file, extname(file)), bytes, covers: new OpenTypeTables(bytes).codePoints() });
  }
  if (fileSources.length) groups.set('files', fileSources);
  const weights = options.weights?.length ? options.weights : [400];
  for (const family of options.google ?? []) {
    log(`Google Fonts: ${family} ${weights.join(',')}`);
    const { files: downloaded, license } = await fetchGoogleFont(family, weights, {
      lockFile: options.lockFile, cacheDir: options.cacheDir, update: options.updateLock, fetch: options.fetch, log,
    });
    const licenseFile = `${family.replace(/[^A-Za-z0-9]+/g, '')}-${license.name}`;
    await writeFile(join(options.outDir, licenseFile), license.text);
    for (const d of downloaded) {
      const bytes = new Uint8Array(await readFile(d.path));
      const list = groups.get(d.weight) ?? groups.set(d.weight, []).get(d.weight)!;
      list.push({ name: d.name, bytes, covers: new OpenTypeTables(bytes).codePoints(), weight: d.weight, family });
    }
  }
  if (!groups.size) throw new Error('tabula font: no font files or --google families given');
  if (options.chain && fileSources.length && groups.size > 1) {
    // Font files head every weight's chain.
    groups.delete('files');
    for (const list of groups.values()) list.unshift(...fileSources);
  }
  for (const file of files) await copyLicenseNextTo(file, options.outDir);

  // Character sets: one for all, or one per language.
  const languages = (options.lang ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (options.perLang && !languages.length) throw new Error('--per-lang needs --lang');
  const fromFiles = new Map<string, string>(); // language ('' = all) -> text
  for (const file of options.charsetFrom ?? []) {
    const stem = basename(file, extname(file)).toLowerCase();
    const lang = options.perLang && languages.some((l) => l.toLowerCase() === stem) ? stem : '';
    fromFiles.set(lang, (fromFiles.get(lang) ?? '') + (await charsetFromFiles([file])));
  }
  const charsetFor = (lang: string | null): number[] => {
    const set = new Set<number>();
    const named = options.charset !== undefined || options.chars || (!languages.length && !fromFiles.size);
    if (named) for (const c of resolveCharset(options.charset, options.chars)) set.add(c);
    for (const l of lang === null ? languages : [lang]) for (const c of resolveCharset('', '', l)) set.add(c);
    for (const [l, text] of fromFiles) if (l === '' || l === lang?.toLowerCase()) for (const c of codePoints(text)) set.add(c);
    set.add(0x20);
    return [...set].sort((a, b) => a - b);
  };

  const written: WrittenFont[] = [];
  const multiWeight = [...groups.keys()].filter((k) => k !== 'files').length > 1;
  if (options.name && !options.chain && fileSources.length + (options.google?.length ?? 0) > 1) {
    throw new Error('--name needs a single font (or --chain, where it names the head of the chain)');
  }
  for (const [key, sources] of groups) {
    for (const lang of options.perLang ? languages : [null]) {
      const codes = charsetFor(lang);
      const suffix = lang ? `@${lang}` : '';
      const headName = (s: Source): string => {
        if (!options.name) return s.name;
        return key !== 'files' && multiWeight ? `${options.name}-${googleFontName('', key).slice(1)}` : options.name;
      };
      if (!options.chain) {
        for (const s of sources) {
          written.push(await compileOne(s, `${headName(s)}${suffix}`, codes, [...(options.fallbacks ?? [])], lang, options, log));
        }
        continue;
      }
      // Fallback chain: assign each character to the first source that has it.
      let remaining = new Set(codes);
      const parts: { source: Source; codes: number[] }[] = [];
      sources.forEach((s, i) => {
        const mine = [...remaining].filter((c) => s.covers.has(c));
        if (i === 0) for (const c of PRIMARY_ALWAYS) if (s.covers.has(c) && !mine.includes(c)) mine.push(c);
        parts.push({ source: s, codes: mine });
        remaining = new Set([...remaining].filter((c) => !s.covers.has(c)));
      });
      // A fallback whose characters a later, used fallback also has is merged into it (fewer fonts, pages and texture units).
      for (let i = 1; i < parts.length; i++) {
        const later = parts.slice(i + 1).find((p) => p.codes.length && parts[i]!.codes.every((c) => p.source.covers.has(c)));
        if (later && parts[i]!.codes.length) {
          later.codes.push(...parts[i]!.codes);
          parts[i]!.codes = [];
        }
      }
      for (let i = parts.length - 1; i > 0; i--) if (!parts[i]!.codes.length) parts.splice(i, 1);
      const names = parts.map((p, i) => (i === 0 ? headName(p.source) : p.source.name) + suffix);
      for (let i = parts.length - 1; i >= 0; i--) {
        written.push(await compileOne(parts[i]!.source, names[i]!, parts[i]!.codes, i === 0 ? [...names.slice(1), ...(options.fallbacks ?? [])] : [], lang, options, log));
      }
      const missing = [...remaining].filter((c) => c > 0x20);
      if (missing.length) log(`    ${names[0]}: no font in the chain has ${hexList(missing)}`);
    }
  }
  return written;
}

async function compileOne(
  source: Source, name: string, codes: number[], fallbacks: string[], lang: string | null,
  options: FontCommandOptions, log: (m: string) => void,
): Promise<WrittenFont> {
  const result = await compileFont(source.bytes, {
    ...options, name, codes, fallbacks, language: lang ?? undefined,
  });
  const pages: WrittenFont['pages'] = [];
  for (let i = 0; i < result.pages.length; i++) {
    const page = result.json.pages[i]!;
    await writeFile(join(options.outDir, page.file), result.pages[i]!);
    pages.push({ width: page.width, height: page.height, bytes: result.pages[i]!.length });
    if (options.ktx2) {
      const ktx2 = page.file.replace(/\.png$/, '.ktx2');
      await writeFile(join(options.outDir, ktx2), await encodeKtx2(result.pixels[i]!, { codec: 'uastc', quality: 3, linear: true }));
      page.ktx2 = ktx2;
    }
  }
  const out = join(options.outDir, `${name}.font.json`);
  await writeFile(out, JSON.stringify(result.json));
  const glyphs = result.json.glyphs.length / 11;
  const sizes = pages.map((p) => `${p.width}x${p.height} (${(p.bytes / 1024).toFixed(0)} KB)`).join(', ');
  log(`✓ ${name}: ${glyphs} glyphs, ${result.json.kerning.values.length / 3} kerning class pairs, pages ${sizes}${fallbacks.length ? `, fallbacks ${fallbacks.join(', ')}` : ''}`);
  if (result.missing.length) log(`    missing (no glyph in font): ${hexList(result.missing)}`);
  return { path: out, name, language: lang ?? undefined, glyphs, pages, fallbacks };
}

const hex = (c: number): string => `U+${c.toString(16).toUpperCase().padStart(4, '0')}`;
const hexList = (codes: readonly number[]): string => codes.slice(0, 16).map(hex).join(' ') + (codes.length > 16 ? ` and ${codes.length - 16} more` : '');

/** Copy an OFL / LICENSE file sitting next to a font file into the output directory (if not there yet). */
async function copyLicenseNextTo(file: string, outDir: string): Promise<void> {
  const dir = dirname(file);
  const stem = basename(file, extname(file)).split('-')[0]!;
  for (const candidate of [`${stem}-OFL.txt`, 'OFL.txt', 'LICENSE.txt', 'LICENSE']) {
    const path = join(dir, candidate);
    if (!existsSync(path)) continue;
    const target = join(outDir, candidate === 'OFL.txt' || candidate.startsWith('LICENSE') ? `${stem}-${candidate}` : candidate);
    if (!existsSync(target)) await copyFile(path, target);
    return;
  }
}

/** Help text lines for the font options. */
export const FONT_USAGE = `  --size <n>             font: atlas pixels per em (default 48)
  --range <n>            font: distance range in atlas pixels (default 16; outline + glow reach at most range/2 atlas px,
                         i.e. 1/6 em at the defaults)
  --charset <list>       font: ${Object.keys(FONT_CHARSETS).join(' | ')}
                         (comma-separated; default latin-ext unless --lang / --charset-from / --chars is given)
  --lang <list>          font: languages whose letters (both cases), digits, punctuation and currency to include:
                         ${FONT_LANGUAGES.join(',')}
  --charset-from <files> font: i18n files (comma-separated): exactly the characters their strings use
  --chars <text>         font: extra characters to include
  --google <families>    font: download Google Fonts families (comma-separated), pinned in tabula-fonts.lock.json,
                         cached in node_modules/.cache/tabula/fonts; the license is copied to the output
  --weights <list>       font: weights for --google (default 400)
  --chain                font: the fonts form a fallback chain (later fonts get only the characters earlier ones lack;
                         the first lists the others as fallbacks)
  --per-lang             font: one variant per --lang code, named <name>@<lang> (manifest language switching)
  --fallback <names>     font: fallback font names to record in the .font.json (comma-separated)
  --lock <file>          font: lockfile path (default ./tabula-fonts.lock.json)
  --update-lock          font: re-resolve and re-pin --google downloads
  --name <name>          font: output base name (default: the font file name)
  --ktx2 uastc           font: also write UASTC KTX2 pages (linear, no RDO; the page JSON lists both)`;

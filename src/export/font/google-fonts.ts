/**
 * Google Fonts download for `tabula font --google`: static TTF per
 * weight from the Fonts CSS API (the `truetype` sources it serves to
 * non-browser clients), the license from the google/fonts repository,
 * pinned in a lockfile (URL + SHA-256) and cached under
 * `node_modules/.cache/tabula/fonts`. Build time only: the runtime never
 * loads web fonts.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { toolsCacheDir } from '../cache-dir.js';

/** Lockfile format (`tabula-fonts.lock.json`). */
export interface FontLockFile {
  format: 'tabula-fonts-lock';
  version: 1;
  /** Key: `"<family>:<weight>"`, `"<family>:license"`. */
  files: Record<string, { url: string; sha256: string }>;
}

/** One downloaded weight. */
export interface GoogleFontFile {
  family: string;
  weight: number;
  /** Cached TTF path. */
  path: string;
  /** Suggested output base name, e.g. `NotoSansGeorgian-Bold`. */
  name: string;
}

/** Options of {@link fetchGoogleFont}. */
export interface GoogleFontOptions {
  /** Lockfile path (default `tabula-fonts.lock.json` in the working directory). */
  lockFile?: string;
  /** Cache directory (default `node_modules/.cache/tabula/fonts`; `$TABULA_CACHE_DIR/fonts`). */
  cacheDir?: string;
  /** Ignore pinned entries and pin what the API serves now. */
  update?: boolean;
  /** `fetch` replacement (tests). */
  fetch?: (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }>;
  log?: (message: string) => void;
}

const WEIGHT_NAMES: Record<number, string> = {
  100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black',
};

/** Output base name for a family and weight: `Noto Sans Georgian`, 700 → `NotoSansGeorgian-Bold`. */
export function googleFontName(family: string, weight: number): string {
  return `${family.replace(/[^A-Za-z0-9]+/g, '')}-${WEIGHT_NAMES[weight] ?? `W${weight}`}`;
}

/** Default font cache directory. */
export function fontCacheDir(from?: string): string {
  return join(toolsCacheDir(from), 'fonts');
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

async function readLock(path: string): Promise<FontLockFile> {
  if (!existsSync(path)) return { format: 'tabula-fonts-lock', version: 1, files: {} };
  const lock = JSON.parse(await readFile(path, 'utf-8')) as FontLockFile;
  if (lock.format !== 'tabula-fonts-lock') throw new Error(`${path}: not a Tabula fonts lockfile`);
  lock.files ??= {};
  return lock;
}

/**
 * Parse the CSS API response into weight → TTF URL. Only `truetype` /
 * `opentype` sources without a `unicode-range` (whole font, not a subset)
 * are accepted.
 */
export function parseGoogleFontsCss(css: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const block of css.split('@font-face').slice(1)) {
    if (/font-style:\s*italic/.test(block) || /unicode-range/.test(block)) continue;
    const weight = /font-weight:\s*(\d+)/.exec(block);
    const url = /url\((https:[^)]+\.(?:ttf|otf))\)\s*format\('(?:truetype|opentype)'\)/.exec(block);
    if (weight && url) out.set(Number(weight[1]), url[1]!);
  }
  return out;
}

/**
 * Download (or take from the cache) a Google Fonts family's static TTFs for
 * `weights`, verify them against the lockfile, and pin new entries. The
 * license (OFL.txt, LICENSE.txt or UFL.txt) is fetched and pinned too.
 *
 * @example
 * ```ts
 * const { files, license } = await fetchGoogleFont('Noto Sans Georgian', [400, 700]);
 * ```
 */
export async function fetchGoogleFont(family: string, weights: readonly number[], options: GoogleFontOptions = {}): Promise<{ files: GoogleFontFile[]; license: { name: string; text: string } }> {
  const doFetch = options.fetch ?? ((u: string) => fetch(u));
  const log = options.log ?? (() => undefined);
  const lockPath = resolve(options.lockFile ?? 'tabula-fonts.lock.json');
  const cacheDir = options.cacheDir ?? fontCacheDir();
  const lock = await readLock(lockPath);
  let lockChanged = false;
  await mkdir(cacheDir, { recursive: true });

  const download = async (key: string, url: string): Promise<Uint8Array> => {
    const pinned = options.update ? undefined : lock.files[key];
    const wantUrl = pinned?.url ?? url;
    if (pinned) {
      const cached = join(cacheDir, `${pinned.sha256}.bin`);
      if (existsSync(cached)) {
        const bytes = new Uint8Array(await readFile(cached));
        if (sha256(bytes) === pinned.sha256) return bytes;
      }
    }
    const response = await doFetch(wantUrl);
    if (!response.ok) throw new Error(`${wantUrl}: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const hash = sha256(bytes);
    if (pinned && pinned.sha256 !== hash) {
      throw new Error(`${key}: ${wantUrl} has SHA-256 ${hash}, the lockfile pins ${pinned.sha256}. Run with --update-lock to accept the new file.`);
    }
    await writeFile(join(cacheDir, `${hash}.bin`), bytes);
    if (!pinned || pinned.url !== wantUrl) {
      lock.files[key] = { url: wantUrl, sha256: hash };
      lockChanged = true;
    }
    log(`  downloaded ${wantUrl} (${(bytes.length / 1024).toFixed(0)} KB)`);
    return bytes;
  };

  // Weight URLs: pinned ones need no API call.
  const urls = new Map<number, string>();
  const unpinned = weights.filter((w) => options.update || !lock.files[`${family}:${w}`]);
  if (unpinned.length) {
    const api = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:wght@${[...unpinned].sort((a, b) => a - b).join(';')}`;
    const response = await doFetch(api);
    if (!response.ok) throw new Error(`Google Fonts: "${family}" weights ${unpinned.join(',')}: HTTP ${response.status} (check the family name and that the weights exist)`);
    const served = parseGoogleFontsCss(await response.text());
    for (const w of unpinned) {
      const url = served.get(w);
      if (!url) throw new Error(`Google Fonts: "${family}" has no static TTF for weight ${w} (served: ${[...served.keys()].join(', ') || 'none'})`);
      urls.set(w, url);
    }
  }
  const files: GoogleFontFile[] = [];
  for (const weight of weights) {
    const bytes = await download(`${family}:${weight}`, urls.get(weight) ?? lock.files[`${family}:${weight}`]!.url);
    files.push({ family, weight, path: join(cacheDir, `${sha256(bytes)}.bin`), name: googleFontName(family, weight) });
  }

  // License from the google/fonts repository (directory = family name, lowercase, no spaces).
  const dir = family.toLowerCase().replace(/[^a-z0-9]+/g, '');
  let license: { name: string; text: string } | null = null;
  const licenseKey = `${family}:license`;
  const pinnedLicense = options.update ? undefined : lock.files[licenseKey];
  const candidates = pinnedLicense ? [pinnedLicense.url] : [
    `https://raw.githubusercontent.com/google/fonts/main/ofl/${dir}/OFL.txt`,
    `https://raw.githubusercontent.com/google/fonts/main/apache/${dir}/LICENSE.txt`,
    `https://raw.githubusercontent.com/google/fonts/main/ufl/${dir}/UFL.txt`,
  ];
  for (const url of candidates) {
    try {
      const bytes = await download(licenseKey, url);
      license = { name: url.slice(url.lastIndexOf('/') + 1), text: new TextDecoder().decode(bytes) };
      break;
    } catch (err) {
      if (pinnedLicense) throw err;
    }
  }
  if (!license) throw new Error(`Google Fonts: no license found for "${family}" in google/fonts (ofl/apache/ufl/${dir})`);
  if (lockChanged) {
    lock.files = Object.fromEntries(Object.entries(lock.files).sort(([a], [b]) => a.localeCompare(b)));
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    log(`  pinned in ${lockPath}`);
  }
  return { files, license };
}

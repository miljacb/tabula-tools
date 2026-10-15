/**
 * Font compiler: TTF/OTF -> MSDF atlas pages + `.font.json` metrics.
 *
 * Distance fields come from msdfgen (wasm build, `msdfgen-wasm`, optional
 * dependency); kerning from the font's GPOS / kern tables. The page alpha
 * holds a true Euclidean signed distance computed from the MSDF edge, so
 * soft effects (glow, blurred shadow) round corners while fill and outline
 * keep msdfgen's sharp corners.
 */

import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { SDF_FONT_FORMAT, SDF_FONT_VERSION } from 'tabula-pixi/core/text/font-format.js';
import type { SdfFontJson, SdfKerningJson } from 'tabula-pixi/core/text/font-format.js';
import { OpenTypeTables } from './opentype-tables.js';
import { FONT_CHARSETS, languageCharset } from './charsets.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

export { FONT_CHARSETS } from './charsets.js';

/** Options of {@link compileFont}. */
export interface FontCompileOptions {
  /** Atlas pixels per em (default 48). */
  size?: number;
  /** Distance range in atlas pixels (default 16): outline + glow reach at most half of it (8 atlas px = 1/6 em at size 48). */
  distanceRange?: number;
  /** Comma-separated charset names ({@link FONT_CHARSETS}; default `latin-ext`). */
  charset?: string;
  /** Extra characters to include. */
  chars?: string;
  /** Comma-separated language codes whose characters to include (`hr,el,ka`; see `FONT_LANGUAGES`). */
  lang?: string;
  /** Exact code points to compile; replaces `charset`, `chars` and `lang`. */
  codes?: readonly number[];
  /** Names of the fonts to search for characters this font lacks, in order (written to the `.font.json`). */
  fallbacks?: readonly string[];
  /** Language this font variant is for (written to the `.font.json`; the manifest groups variants by it). */
  language?: string;
  /** Largest page side (default 2048). */
  maxSize?: number;
  /** Power-of-two page sizes (default false: WebGL2 and the Tabula shader need none). */
  pot?: boolean;
  /** Pixels between glyphs (default 2). */
  padding?: number;
  /** Output base name (default: the font's PostScript-ish file name). */
  name?: string;
  /** Page file name for page `i` (default `${name}.png`, `${name}_1.png`, ...). */
  pageFile?: (name: string, index: number) => string;
}

/** Result of {@link compileFont}. */
export interface CompiledFont {
  json: SdfFontJson;
  /** PNG bytes per page, parallel to `json.pages`. */
  pages: Uint8Array[];
  /** Raw RGBA pixels per page (rows top-first), for KTX2 encoding. */
  pixels: { width: number; height: number; data: Uint8Array }[];
  /** Requested code points the font has no glyph for. */
  missing: number[];
}

let msdfgenPromise: Promise<any> | null = null;

/** Load the msdfgen wasm module (once). Throws a clear error when the optional dependency is absent. */
async function loadMsdfgen(): Promise<any> {
  msdfgenPromise ??= (async () => {
    const require = createRequire(import.meta.url);
    let mod: any;
    let wasmPath: string;
    try {
      mod = require('msdfgen-wasm');
      wasmPath = require.resolve('msdfgen-wasm/wasm');
    } catch {
      throw new Error('tabula font: the optional dependency "msdfgen-wasm" is not installed (npm i -D msdfgen-wasm)');
    }
    return mod.Msdfgen.create(await readFile(wasmPath));
  })();
  return msdfgenPromise;
}

/**
 * Characters for a charset spec, languages and extra characters, as unique
 * sorted code points. With `lang` and no `charset`, only the languages'
 * characters are used (no default `latin-ext`).
 */
export function resolveCharset(charset?: string, chars = '', lang?: string): number[] {
  const set = new Set<number>();
  for (const code of (lang ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    for (const ch of languageCharset(code)) set.add(ch.codePointAt(0)!);
  }
  const names = charset ?? (lang || chars ? '' : 'latin-ext');
  for (const name of names.split(',').map((s) => s.trim()).filter(Boolean)) {
    const value = FONT_CHARSETS[name];
    if (value === undefined) throw new Error(`Unknown charset "${name}" (known: ${Object.keys(FONT_CHARSETS).join(', ')})`);
    for (const ch of value) set.add(ch.codePointAt(0)!);
  }
  for (const ch of chars) set.add(ch.codePointAt(0)!);
  set.add(0x20);
  return [...set].sort((a, b) => a - b);
}

const round = (v: number): number => Math.round(v * 1e5) / 1e5;

/** Compile one TTF/OTF font. */
export async function compileFont(fontBytes: Uint8Array, options: FontCompileOptions = {}): Promise<CompiledFont> {
  const size = options.size ?? 48;
  const distanceRange = options.distanceRange ?? 16;
  const maxSize = options.maxSize ?? 2048;
  const padding = options.padding ?? 2;
  if (!(size >= 4 && size <= 512)) throw new Error(`font size must be 4..512 (got ${size})`);
  if (!(distanceRange >= 1 && distanceRange <= 64)) throw new Error(`distance range must be 1..64 (got ${distanceRange})`);
  const tables = new OpenTypeTables(fontBytes);
  const name = options.name ?? (tables.name(6) || tables.name(4) || 'font').replace(/[^\w.-]+/g, '-');
  const codes = options.codes ? [...new Set(options.codes)].sort((a, b) => a - b) : resolveCharset(options.charset, options.chars, options.lang);

  const msdfgen = await loadMsdfgen();
  msdfgen.loadFont(fontBytes);
  msdfgen.loadGlyphs(codes, { preprocess: true });
  const glyphs: any[] = [...msdfgen.glyphs].sort((a, b) => a.unicode - b.unicode);
  const present = new Set(glyphs.map((g) => g.unicode));
  const missing = codes.filter((c) => !present.has(c));
  const msdfOptions = { size, range: distanceRange };
  const bins: any[] = msdfgen.packGlyphs(msdfOptions, {
    maxWidth: maxSize, maxHeight: maxSize, padding, pot: options.pot ?? false, square: false, smart: true, allowRotation: false, border: padding,
  }, glyphs);

  const glyphRecords: number[] = [];
  const pages: Uint8Array[] = [];
  const pixels: CompiledFont['pixels'] = [];
  const pageJson: SdfFontJson['pages'] = [];
  const pageFile = options.pageFile ?? ((n: string, i: number) => (i === 0 ? `${n}.png` : `${n}_${i}.png`));
  const records = new Map<number, number[]>();
  const BitmapClass = createRequire(import.meta.url)('msdfgen-wasm').Bitmap;
  bins.forEach((bin, pageIndex) => {
    // Multiples of 4: block-compressed (KTX2) pages need them.
    const width = (bin.width + 3) & ~3;
    const height = (bin.height + 3) & ~3;
    const page = new Uint8Array(width * height * 4);
    for (const rect of bin.rects) {
      if (rect.oversized) throw new Error(`glyph U+${rect.glyph.unicode.toString(16)} does not fit a ${maxSize}px page; lower --size`);
      const g = rect.glyph;
      const d = rect.msdfData;
      const hasBitmap = rect.width > 0 && rect.height > 0;
      if (hasBitmap) {
        const bitmap = msdfgen.generateBitmap(g, d);
        const src = new Uint8Array(bitmap.buffer);
        addTrueSdfAlpha(src, rect.width, rect.height, distanceRange);
        for (let y = 0; y < rect.height; y++) {
          page.set(src.subarray(y * rect.width * 4, (y + 1) * rect.width * 4), ((rect.y + y) * width + rect.x) * 4);
        }
      }
      const left = hasBitmap ? -d.xTranslate : 0;
      const bottom = hasBitmap ? -d.yTranslate : 0;
      records.set(g.unicode, [
        g.unicode, round(g.advance),
        round(left), round(bottom),
        hasBitmap ? round(left + rect.width / size) : 0, hasBitmap ? round(bottom + rect.height / size) : 0,
        hasBitmap ? rect.x : 0, hasBitmap ? rect.y : 0, hasBitmap ? rect.width : 0, hasBitmap ? rect.height : 0, pageIndex,
      ]);
    }
    pages.push(msdfgen.createPng(new BitmapClass(width, height, page.buffer), 9));
    pixels.push({ width, height, data: page });
    pageJson.push({ file: pageFile(name, pageIndex), width, height });
  });
  for (const g of glyphs) glyphRecords.push(...records.get(g.unicode)!);

  // Kerning: GPOS / kern by glyph index, mapped back to code points.
  const byIndex = new Map<number, number[]>();
  for (const g of glyphs) {
    const list = byIndex.get(g.index);
    if (list) list.push(g.unicode);
    else byIndex.set(g.index, [g.unicode]);
  }
  const pairs = new Map<number, Map<number, number>>();
  for (const [leftIndex, row] of tables.kerning(byIndex.keys())) {
    for (const [rightIndex, value] of row) {
      for (const l of byIndex.get(leftIndex)!) {
        let out = pairs.get(l);
        if (!out) pairs.set(l, (out = new Map()));
        for (const r of byIndex.get(rightIndex)!) out.set(r, round(value / tables.unitsPerEm));
      }
    }
  }
  const kerning = compressKerning(pairs);
  const m = msdfgen.metrics;
  const os2 = tables.os2Heights();
  const json: SdfFontJson = {
    format: SDF_FONT_FORMAT,
    version: SDF_FONT_VERSION,
    name,
    family: tables.name(1),
    type: 'msdf',
    size,
    distanceRange,
    metrics: {
      ascender: round(m.ascenderY),
      descender: round(m.descenderY),
      lineHeight: round(m.lineHeight),
      underlineY: round(m.underlineY),
      underlineThickness: round(m.underlineThickness),
      ...(os2.capHeight ? { capHeight: round(os2.capHeight / tables.unitsPerEm) } : {}),
      ...(os2.xHeight ? { xHeight: round(os2.xHeight / tables.unitsPerEm) } : {}),
    },
    pages: pageJson,
    glyphs: glyphRecords,
    kerning,
    ...(options.fallbacks?.length ? { fallbacks: [...options.fallbacks] } : {}),
    ...(options.language ? { language: options.language } : {}),
  };
  return { json, pages, pixels, missing };
}

/** Group glyphs with identical kerning rows / columns into classes (see {@link SdfKerningJson}). */
export function compressKerning(pairs: Map<number, Map<number, number>>): SdfKerningJson {
  const classOf = (entries: Map<number, Map<number, number>>): { codes: number[]; classes: Map<number, number> } => {
    const byKey = new Map<string, number>();
    const classes = new Map<number, number>();
    const codes = [...entries.keys()].sort((a, b) => a - b);
    for (const code of codes) {
      const key = [...entries.get(code)!].sort((a, b) => a[0] - b[0]).map(([c, v]) => `${c}:${v}`).join(',');
      let cls = byKey.get(key);
      if (cls === undefined) byKey.set(key, (cls = byKey.size));
      classes.set(code, cls);
    }
    return { codes, classes };
  };
  const columns = new Map<number, Map<number, number>>();
  for (const [l, row] of pairs) {
    for (const [r, v] of row) {
      let col = columns.get(r);
      if (!col) columns.set(r, (col = new Map()));
      col.set(l, v);
    }
  }
  const left = classOf(pairs);
  const right = classOf(columns);
  const values = new Map<string, [number, number, number]>();
  for (const [l, row] of pairs) {
    for (const [r, v] of row) {
      const lc = left.classes.get(l)!;
      const rc = right.classes.get(r)!;
      values.set(`${lc},${rc}`, [lc, rc, v]);
    }
  }
  return {
    left: left.codes.flatMap((c) => [c, left.classes.get(c)!]),
    right: right.codes.flatMap((c) => [c, right.classes.get(c)!]),
    values: [...values.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]).flat(),
  };
}

/**
 * Replace the alpha of an RGBA MSDF bitmap (rows top-first) with a true
 * Euclidean signed distance (same range), derived from the MSDF edge.
 */
export function addTrueSdfAlpha(rgba: Uint8Array, width: number, height: number, distanceRange: number): void {
  const n = width * height;
  const INF = 1e20;
  const outer = new Float64Array(n);
  const inner = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4]!;
    const g = rgba[i * 4 + 1]!;
    const b = rgba[i * 4 + 2]!;
    const median = Math.max(Math.min(r, g), Math.min(Math.max(r, g), b)) / 255;
    // Signed distance in pixels (positive inside), exact near the edge.
    const sd = (median - 0.5) * distanceRange;
    const a = Math.min(1, Math.max(0, sd + 0.5));
    if (a === 1) {
      outer[i] = 0;
      inner[i] = INF;
    } else if (a === 0) {
      outer[i] = INF;
      inner[i] = 0;
    } else {
      const d = 0.5 - a;
      outer[i] = d > 0 ? d * d : 0;
      inner[i] = d < 0 ? d * d : 0;
    }
  }
  edt(outer, width, height);
  edt(inner, width, height);
  for (let i = 0; i < n; i++) {
    const dist = Math.sqrt(outer[i]!) - Math.sqrt(inner[i]!); // positive outside
    const v = Math.round((0.5 - dist / distanceRange) * 255);
    rgba[i * 4 + 3] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
}

/** 2D squared Euclidean distance transform (Felzenszwalb & Huttenlocher), in place. */
function edt(data: Float64Array, width: number, height: number): void {
  const len = Math.max(width, height);
  const f = new Float64Array(len);
  const z = new Float64Array(len + 1);
  const v = new Uint16Array(len);
  for (let x = 0; x < width; x++) edt1d(data, x, width, height, f, v, z);
  for (let y = 0; y < height; y++) edt1d(data, y * width, 1, width, f, v, z);
}

function edt1d(grid: Float64Array, offset: number, stride: number, length: number, f: Float64Array, v: Uint16Array, z: Float64Array): void {
  v[0] = 0;
  z[0] = -1e20;
  z[1] = 1e20;
  for (let q = 0; q < length; q++) f[q] = grid[offset + q * stride]!;
  for (let q = 1, k = 0, s = 0; q < length; q++) {
    do {
      const r = v[k]!;
      s = (f[q]! - f[r]! + q * q - r * r) / (q - r) / 2;
    } while (s <= z[k]! && --k > -1);
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = 1e20;
  }
  for (let q = 0, k = 0; q < length; q++) {
    while (z[k + 1]! < q) k++;
    const r = v[k]!;
    const qr = q - r;
    grid[offset + q * stride] = f[r]! + qr * qr;
  }
}

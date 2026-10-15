/**
 * Multi-language fonts (A10): language charsets, charsets from i18n files,
 * cmap / OS/2 reading, Google Fonts download with lockfile and cache,
 * fallback chains and per-language variants. Layout with fallbacks is
 * tested in tabula-pixi (tests/font-fallback.test.ts).
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as hb from 'harfbuzzjs';
import { charsetFromFiles, codePoints, FONT_CHARSETS, FONT_LANGUAGES, languageCharset } from '../src/export/font/charsets.js';
import { OpenTypeTables } from '../src/export/font/opentype-tables.js';
import { fetchGoogleFont, googleFontName, parseGoogleFontsCss } from '../src/export/font/google-fonts.js';
import { fontCommand } from '../src/cli/commands/font.js';
import type { SdfFontJson } from 'tabula-pixi/core/text/font-format.js';
import { buildAssetManifest } from 'tabula-pixi/core/manifest.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const GREEK = 'ΜΕΓΑΛΗ ΝΙΚΗ';
const GEORGIAN = 'დიდი მოგება';
const has = (charset: string, text: string): boolean => [...text].every((ch) => charset.includes(ch));
const tmp = (): string => mkdtempSync(join(tmpdir(), 'tabula-a10-'));

describe('language charsets', () => {
  it('cover the letters of each language in both cases, digits, punctuation and currency', () => {
    expect(has(languageCharset('hr'), 'čćđšžČĆĐŠŽ 0123456789 €$ „Sretno!“')).toBe(true);
    expect(has(languageCharset('el'), `${GREEK} μεγάλη νίκη άέήίόύώΆΈΉΊΌΎΏ;·`)).toBe(true);
    expect(has(languageCharset('ka'), `${GEORGIAN} ${GEORGIAN.toUpperCase()} ₾`)).toBe(true); // Mtavruli capitals
    expect(GEORGIAN.toUpperCase()).not.toBe(GEORGIAN);
    expect(has(languageCharset('hy'), 'ՄԵԾ ՀԱՂԹԱՆԱԿ մեծ հաղթանակ ֏')).toBe(true);
    expect(has(languageCharset('ru'), 'БОЛЬШОЙ ВЫИГРЫШ ёЁ ₽')).toBe(true);
    expect(has(languageCharset('uk'), 'ҐЄІЇ ґєії ₴')).toBe(true);
    expect(has(languageCharset('tr'), 'BÜYÜK KAZANÇ İıĞğŞş ₺')).toBe(true);
    expect(has(languageCharset('vi'), 'THẮNG LỚN thắng lớn ặẶữỮđĐ ₫')).toBe(true);
    expect(has(languageCharset('pt-BR'), 'ãõç')).toBe(true);
    // Every language includes ASCII (codes, brand names, EUR).
    expect(has(languageCharset('hr'), 'QWXY')).toBe(true);
    expect(has(languageCharset('ka'), 'FREE SPINS EUR')).toBe(true);
    expect(() => languageCharset('xx')).toThrow(/Unknown language "xx"/);
    expect(FONT_LANGUAGES.length).toBeGreaterThanOrEqual(40);
  });

  it('script charsets hold only assigned characters', () => {
    for (const name of ['greek', 'cyrillic', 'georgian', 'armenian', 'vietnamese', 'currency']) {
      const set = FONT_CHARSETS[name]!;
      expect(set.length).toBeGreaterThan(30);
      expect(/[\p{Cn}\p{Cc}]/u.test(set)).toBe(false);
    }
    expect(has(FONT_CHARSETS.georgian!, (GEORGIAN + GEORGIAN.toUpperCase()).replace(/ /g, ''))).toBe(true);
    expect(has(FONT_CHARSETS.greek!, GREEK.replace(' ', ''))).toBe(true);
  });

  it('--charset-from takes exactly the characters of the strings (JSON values, NFC)', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'ka.json'), JSON.stringify({ win: { big: GEORGIAN }, keyOnlyQ: 'Ok' }));
    writeFileSync(join(dir, 'el.txt'), 'νι\u0301κη\n'); // decomposed ί
    const text = await charsetFromFiles([join(dir, 'ka.json'), join(dir, 'el.txt')]);
    expect(codePoints(text).map((c) => String.fromCodePoint(c)).join('')).toBe([...new Set([...`\n${GEORGIAN}Okνίκη`])].sort((a, b) => a.codePointAt(0)! - b.codePointAt(0)!).join('').replace('\n', ''));
    expect(text.includes('Q')).toBe(false);
  });
});

describe('OpenType tables', () => {
  it('cmap code points match HarfBuzz; OS/2 cap and x height', () => {
    for (const file of ['Inter-Regular', 'NotoSansGeorgian-Regular', 'NotoSansArmenian-Regular']) {
      const bytes = readFileSync(`../tabula-pixi/test-assets/fonts/${file}.ttf`);
      const ours = new OpenTypeTables(new Uint8Array(bytes)).codePoints();
      const face = new (hb as any).Face(new (hb as any).Blob(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
      const theirs = [...(face.collectUnicodes() as Uint32Array)];
      expect(ours.size).toBeGreaterThan(100);
      expect([...ours].sort((a, b) => a - b)).toEqual(theirs.sort((a, b) => a - b));
    }
    const inter = new OpenTypeTables(new Uint8Array(readFileSync('../tabula-pixi/test-assets/fonts/Inter-Regular.ttf')));
    expect(inter.os2Heights()).toEqual({ capHeight: 1490, xHeight: 1118 }); // Inter 4.1 (2048 units per em)
  });
});

describe('Google Fonts download', () => {
  const css = (weights: number[]): string => weights.map((w) => `@font-face {\n  font-family: 'Test Sans';\n  font-style: normal;\n  font-weight: ${w};\n  src: url(https://fonts.gstatic.com/s/testsans/v1/w${w}.ttf) format('truetype');\n}\n`).join('')
    + "@font-face { font-family: 'Test Sans'; font-style: italic; font-weight: 400; src: url(https://fonts.gstatic.com/s/testsans/v1/i400.ttf) format('truetype'); }\n";
  function server(files: Record<string, Uint8Array | string>): { fetch: any; log: string[] } {
    const log: string[] = [];
    return {
      log,
      fetch: async (url: string) => {
        log.push(url);
        const body = url.startsWith('https://fonts.googleapis.com/') ? css([400, 700]) : files[url];
        if (body === undefined) return { ok: false, status: 404, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
        const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
        return { ok: true, status: 200, text: async () => new TextDecoder().decode(bytes), arrayBuffer: async () => bytes.slice().buffer };
      },
    };
  }
  const font400 = new Uint8Array([1, 2, 3, 4]);
  const font700 = new Uint8Array([5, 6, 7, 8]);
  const files = {
    'https://fonts.gstatic.com/s/testsans/v1/w400.ttf': font400,
    'https://fonts.gstatic.com/s/testsans/v1/w700.ttf': font700,
    'https://raw.githubusercontent.com/google/fonts/main/apache/testsans/LICENSE.txt': 'Apache License 2.0',
  };

  it('parses static TTF sources (no italics, no unicode-range subsets)', () => {
    expect([...parseGoogleFontsCss(css([400, 700]))]).toEqual([[400, 'https://fonts.gstatic.com/s/testsans/v1/w400.ttf'], [700, 'https://fonts.gstatic.com/s/testsans/v1/w700.ttf']]);
    expect(parseGoogleFontsCss("@font-face { font-weight: 400; src: url(https://x/a.woff2) format('woff2'); unicode-range: U+0000-00FF; }").size).toBe(0);
    expect(googleFontName('Noto Sans Georgian', 700)).toBe('NotoSansGeorgian-Bold');
  });

  it('pins URL + SHA-256, serves later runs from the cache, rejects changed files', async () => {
    const dir = tmp();
    const lockFile = join(dir, 'tabula-fonts.lock.json');
    const cacheDir = join(dir, 'cache');
    const s = server(files);
    const first = await fetchGoogleFont('Test Sans', [400, 700], { lockFile, cacheDir, fetch: s.fetch });
    expect(first.license).toEqual({ name: 'LICENSE.txt', text: 'Apache License 2.0' }); // ofl/ 404, apache/ found
    expect(readFileSync(first.files[1]!.path)).toEqual(Buffer.from(font700));
    const lock = JSON.parse(readFileSync(lockFile, 'utf8'));
    expect(lock.files['Test Sans:700']).toEqual({ url: 'https://fonts.gstatic.com/s/testsans/v1/w700.ttf', sha256: createHash('sha256').update(font700).digest('hex') });
    expect(lock.files['Test Sans:license'].url).toContain('/apache/testsans/LICENSE.txt');

    // Second run: everything pinned and cached, no network at all.
    const offline = server({});
    const second = await fetchGoogleFont('Test Sans', [400, 700], { lockFile, cacheDir, fetch: offline.fetch });
    expect(offline.log).toEqual([]);
    expect(second.files.map((f) => f.path)).toEqual(first.files.map((f) => f.path));

    // Cache gone and the server now serves different bytes: refuse, then accept with update.
    const changed = server({ ...files, 'https://fonts.gstatic.com/s/testsans/v1/w400.ttf': new Uint8Array([9, 9]) });
    await expect(fetchGoogleFont('Test Sans', [400], { lockFile, cacheDir: join(dir, 'cache2'), fetch: changed.fetch })).rejects.toThrow(/lockfile pins/);
    await fetchGoogleFont('Test Sans', [400], { lockFile, cacheDir: join(dir, 'cache2'), fetch: changed.fetch, update: true });
    expect(JSON.parse(readFileSync(lockFile, 'utf8')).files['Test Sans:400'].sha256).toBe(createHash('sha256').update(new Uint8Array([9, 9])).digest('hex'));
    await expect(fetchGoogleFont('Test Sans', [300], { lockFile, cacheDir, fetch: s.fetch })).rejects.toThrow(/no static TTF for weight 300/);
  });
});

const read = (dir: string, name: string): SdfFontJson => JSON.parse(readFileSync(join(dir, `${name}.font.json`), 'utf8'));

describe('fallback chains and language variants (compile)', () => {
  it('splits characters over the chain, writes one variant per language and copies licenses', async () => {
    const dir = tmp();
    const log: string[] = [];
    const written = await fontCommand(
      ['../tabula-pixi/test-assets/fonts/Inter-Regular.ttf', '../tabula-pixi/test-assets/fonts/NotoSansGeorgian-Regular.ttf', '../tabula-pixi/test-assets/fonts/NotoSansArmenian-Regular.ttf'],
      { outDir: dir, chain: true, lang: 'hr,el,ka,hy', perLang: true, name: 'main', size: 24, distanceRange: 6, log: (m) => log.push(m) },
    );
    expect(written.map((w) => w.name).sort()).toEqual(['NotoSansArmenian-Regular@hy', 'NotoSansGeorgian-Regular@ka', 'main@el', 'main@hr', 'main@hy', 'main@ka']);
    const ka = read(dir, 'main@ka');
    expect(ka.language).toBe('ka');
    expect(ka.fallbacks).toEqual(['NotoSansGeorgian-Regular@ka']);
    expect(ka.metrics.capHeight).toBeCloseTo(1490 / 2048, 4);
    const codesOf = (j: SdfFontJson): Set<number> => new Set(j.glyphs.filter((_, i) => i % 11 === 0));
    const georgian = codesOf(read(dir, 'NotoSansGeorgian-Regular@ka'));
    for (const ch of GEORGIAN.replace(' ', '') + GEORGIAN.toUpperCase().replace(' ', '')) {
      expect(georgian.has(ch.codePointAt(0)!)).toBe(true);
      expect(codesOf(ka).has(ch.codePointAt(0)!)).toBe(false);
    }
    // Inter has Greek: no fallback for el.
    expect(read(dir, 'main@el').fallbacks).toBeUndefined();
    expect([...GREEK.replace(' ', '')].every((ch) => codesOf(read(dir, 'main@el')).has(ch.codePointAt(0)!))).toBe(true);
    expect(written.find((w) => w.name === 'main@ka')!.pages[0]!.bytes).toBeGreaterThan(1000);
    expect(existsSync(join(dir, 'Inter-OFL.txt')) && existsSync(join(dir, 'NotoSansGeorgian-OFL.txt'))).toBe(true);
    expect(log.some((l) => l.includes('main@ka') && l.includes('fallbacks NotoSansGeorgian-Regular@ka'))).toBe(true);

    // Manifest: variants listed once under their base, fallbacks load with their head.
    const files = (await import('node:fs')).readdirSync(dir).map((f) => ({ path: `fonts/${f}`, bytes: new Uint8Array(readFileSync(join(dir, f))) }));
    const { manifest, warnings } = buildAssetManifest(files, {});
    expect(warnings).toEqual([]);
    expect(manifest.groups.base!.fonts).toEqual(['main']);
    expect(manifest.fonts!['main@ka']).toMatchObject({ language: 'ka', base: 'main', fallbacks: ['NotoSansGeorgian-Regular@ka'] });
  }, 60000);
});


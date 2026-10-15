/**
 * Font compiler: MSDF pages, metrics and kerning. Kerning is checked against
 * HarfBuzz shaping (harfbuzzjs, dev dependency; what browsers use) for every
 * pair of the charset.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as hb from 'harfbuzzjs';

/* eslint-disable @typescript-eslint/no-explicit-any */
import { compileFont, resolveCharset, addTrueSdfAlpha } from '../src/export/font/compile-font.js';
import { SDF_GLYPH_STRIDE } from 'tabula-pixi/core/text/font-format.js';
import { SdfFont } from 'tabula-pixi/core/text/font.js';

const FONT = '../tabula-pixi/test-assets/fonts/Inter-Regular.ttf';

describe('tabula font', () => {
  it('compiles glyphs, metrics and kerning that match fontkit (GPOS)', async () => {
    const chars = 'AVTWYLPoaey.,čćđšžČĆĐŠŽ0123456789';
    const { json, pages, missing } = await compileFont(new Uint8Array(readFileSync(FONT)), { charset: 'digits', chars, size: 32, distanceRange: 6 });
    expect(missing).toEqual([]);
    expect(json.format).toBe('tabula-font');
    expect(json.type).toBe('msdf');
    expect(pages.length).toBe(1);
    expect(json.pages[0]!.width % 4).toBe(0);
    expect(json.glyphs.length / SDF_GLYPH_STRIDE).toBe(resolveCharset('digits', chars).length);
    expect(json.metrics.ascender).toBeCloseTo(0.96875, 4);

    const font = new SdfFont(json);
    const bytes = readFileSync(FONT);
    const hbFont = new (hb as any).Font(new (hb as any).Face(new (hb as any).Blob(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))));
    const upem = 2048;
    const shape = (text: string, features?: string): { ids: number[]; advances: number[] } => {
      const buf = new (hb as any).Buffer();
      buf.addText(text);
      buf.guessSegmentProperties();
      (hb as any).shape(hbFont, buf, features === '-kern' ? [new (hb as any).Feature('kern', 0)] : undefined);
      const result = { ids: buf.getGlyphInfos().map((g: any) => g.codepoint), advances: buf.getGlyphPositions().map((p: any) => p.xAdvance) };
      buf.destroy?.();
      return result;
    };
    let checked = 0;
    let nonZero = 0;
    for (const a of chars) {
      const single = shape(a, '-kern');
      for (const b of chars) {
        const pair = shape(a + b);
        const plain = shape(a + b, '-kern');
        // Contextual substitutions (e.g. raised colon between digits) are out of scope: skip those pairs.
        if (pair.ids.length !== 2 || pair.ids[0] !== single.ids[0] || plain.ids.join() !== pair.ids.join()) continue;
        const expected = (pair.advances[0]! - plain.advances[0]!) / upem;
        const ours = font.kerning(a.codePointAt(0)!, b.codePointAt(0)!);
        expect(ours, `${a}${b}`).toBeCloseTo(expected, 4);
        checked++;
        if (expected !== 0) nonZero++;
      }
    }
    expect(checked).toBeGreaterThan(chars.length ** 2 * 0.9);
    expect(nonZero).toBeGreaterThan(50);

    const g = font.glyph('A'.codePointAt(0)!)!;
    expect(g.advance).toBeCloseTo(shape('A', '-kern').advances[0]! / upem, 4);
    // Plane box = glyph bounds padded by half the range (em).
    expect(g.right - g.left).toBeCloseTo(g.width / json.size, 5);
  });

  it('true SDF alpha: inside > 0.5, outside < 0.5, monotone away from the edge', () => {
    const w = 32;
    const h = 8;
    const rgba = new Uint8Array(w * h * 4);
    // MSDF of a vertical edge at x = 16 (inside on the left), range 8.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const sd = 16 - (x + 0.5);
        const v = Math.max(0, Math.min(255, Math.round((0.5 + sd / 8) * 255)));
        rgba.set([v, v, v, 255], (y * w + x) * 4);
      }
    }
    addTrueSdfAlpha(rgba, w, h, 8);
    const alpha = (x: number): number => rgba[(4 * w + x) * 4 + 3]!;
    expect(alpha(10)).toBeGreaterThan(128);
    expect(alpha(20)).toBeLessThan(128);
    for (let x = 1; x < w; x++) expect(alpha(x)).toBeLessThanOrEqual(alpha(x - 1));
    expect(Math.abs(alpha(15) - rgba[(4 * w + 15) * 4]!)).toBeLessThan(20);
  });

  it('charsets: latin-ext covers Croatian letters; unknown names throw', () => {
    const set = new Set(resolveCharset('latin-ext'));
    for (const ch of 'čćđšžČĆĐŠŽ€') expect(set.has(ch.codePointAt(0)!)).toBe(true);
    expect(() => resolveCharset('klingon')).toThrow(/Unknown charset/);
  });
});

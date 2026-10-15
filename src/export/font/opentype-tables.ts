/**
 * Minimal OpenType table reader for the font compiler: unitsPerEm, the
 * character map and pair kerning from GPOS (`kern` feature, PairPos formats
 * 1 and 2, extension lookups) with the legacy `kern` table as fallback.
 * Glyph outlines and metrics come from msdfgen (FreeType); this only fills
 * what FreeType's legacy kerning API misses (most modern fonts kern in GPOS).
 */

interface TableRecord {
  offset: number;
  length: number;
}

/** Kerning pairs by glyph index: `kerning.get(left)?.get(right)` in font units. */
export type GlyphKerning = Map<number, Map<number, number>>;

export class OpenTypeTables {
  private readonly view: DataView;
  private readonly tables = new Map<string, TableRecord>();
  readonly unitsPerEm: number;

  constructor(bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const v = this.view;
    const tag = v.getUint32(0);
    if (tag === 0x774f4646 || tag === 0x774f4632) throw new Error('WOFF/WOFF2 fonts are not supported; convert to TTF/OTF first');
    if (tag === 0x74746366) throw new Error('font collections (.ttc) are not supported; extract one face to TTF/OTF');
    const numTables = v.getUint16(4);
    for (let i = 0; i < numTables; i++) {
      const r = 12 + i * 16;
      const name = String.fromCharCode(v.getUint8(r), v.getUint8(r + 1), v.getUint8(r + 2), v.getUint8(r + 3));
      this.tables.set(name, { offset: v.getUint32(r + 8), length: v.getUint32(r + 12) });
    }
    const head = this.tables.get('head');
    if (!head) throw new Error('font has no head table');
    this.unitsPerEm = v.getUint16(head.offset + 18);
  }

  /** Font family / full name from the name table (best effort). */
  name(id: number): string | undefined {
    const t = this.tables.get('name');
    if (!t) return undefined;
    const v = this.view;
    const count = v.getUint16(t.offset + 2);
    const strings = t.offset + v.getUint16(t.offset + 4);
    let fallback: string | undefined;
    for (let i = 0; i < count; i++) {
      const r = t.offset + 6 + i * 12;
      if (v.getUint16(r + 6) !== id) continue;
      const platform = v.getUint16(r);
      const length = v.getUint16(r + 8);
      const offset = strings + v.getUint16(r + 10);
      if (platform === 3 || platform === 0) {
        let s = '';
        for (let k = 0; k < length; k += 2) s += String.fromCharCode(v.getUint16(offset + k));
        return s;
      }
      if (platform === 1) {
        let s = '';
        for (let k = 0; k < length; k++) s += String.fromCharCode(v.getUint8(offset + k));
        fallback = s;
      }
    }
    return fallback;
  }

  /** Cap height and x-height (font units) from the OS/2 table (version 2+); 0 when absent. */
  os2Heights(): { capHeight: number; xHeight: number } {
    const t = this.tables.get('OS/2');
    if (!t || t.length < 90 || this.view.getUint16(t.offset) < 2) return { capHeight: 0, xHeight: 0 };
    return { xHeight: this.view.getInt16(t.offset + 86), capHeight: this.view.getInt16(t.offset + 88) };
  }

  /** Every code point the font maps to a glyph (cmap formats 4 and 12). */
  codePoints(): Set<number> {
    const out = new Set<number>();
    const t = this.tables.get('cmap');
    if (!t) return out;
    const v = this.view;
    const count = v.getUint16(t.offset + 2);
    let best = -1;
    let bestFormat = 0;
    for (let i = 0; i < count; i++) {
      const r = t.offset + 4 + i * 8;
      const platform = v.getUint16(r);
      const encoding = v.getUint16(r + 2);
      const sub = t.offset + v.getUint32(r + 4);
      const format = v.getUint16(sub);
      const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
      if (!unicode) continue;
      if (format === 12 && bestFormat !== 12) { best = sub; bestFormat = 12; }
      else if (format === 4 && bestFormat === 0) { best = sub; bestFormat = 4; }
    }
    if (best < 0) return out;
    if (bestFormat === 12) {
      const groups = v.getUint32(best + 12);
      for (let g = 0; g < groups; g++) {
        const r = best + 16 + g * 12;
        const start = v.getUint32(r);
        const end = v.getUint32(r + 4);
        const glyph = v.getUint32(r + 8);
        for (let c = start; c <= end; c++) if (glyph + (c - start) !== 0) out.add(c);
      }
      return out;
    }
    const segX2 = v.getUint16(best + 6);
    const ends = best + 14;
    const starts = ends + segX2 + 2;
    const deltas = starts + segX2;
    const offsets = deltas + segX2;
    for (let s = 0; s < segX2; s += 2) {
      const end = v.getUint16(ends + s);
      const start = v.getUint16(starts + s);
      const delta = v.getInt16(deltas + s);
      const rangeOffset = v.getUint16(offsets + s);
      for (let c = start; c <= end && c !== 0xffff; c++) {
        let glyph: number;
        if (rangeOffset === 0) glyph = (c + delta) & 0xffff;
        else {
          const at = offsets + s + rangeOffset + (c - start) * 2;
          glyph = v.getUint16(at);
          if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
        }
        if (glyph !== 0) out.add(c);
      }
    }
    return out;
  }

  /** Pair kerning (font units) among `glyphs` (glyph indices), GPOS first, legacy kern otherwise. */
  kerning(glyphs: Iterable<number>): GlyphKerning {
    const wanted = new Set(glyphs);
    const out: GlyphKerning = new Map();
    const gpos = this.tables.get('GPOS');
    if (gpos) this.readGpos(gpos.offset, wanted, out);
    if (out.size === 0) {
      const kern = this.tables.get('kern');
      if (kern) this.readKern(kern.offset, wanted, out);
    }
    return out;
  }

  private readGpos(base: number, wanted: Set<number>, out: GlyphKerning): void {
    const v = this.view;
    const featureList = base + v.getUint16(base + 6);
    const lookupList = base + v.getUint16(base + 8);
    const lookups = new Set<number>();
    const featureCount = v.getUint16(featureList);
    for (let i = 0; i < featureCount; i++) {
      const r = featureList + 2 + i * 6;
      const tag = String.fromCharCode(v.getUint8(r), v.getUint8(r + 1), v.getUint8(r + 2), v.getUint8(r + 3));
      if (tag !== 'kern') continue;
      const feature = featureList + v.getUint16(r + 4);
      const n = v.getUint16(feature + 2);
      for (let k = 0; k < n; k++) lookups.add(v.getUint16(feature + 4 + k * 2));
    }
    // Within a lookup the first subtable that covers a pair wins; separate lookups accumulate.
    for (const index of [...lookups].sort((a, b) => a - b)) {
      const lookupOut: GlyphKerning = new Map();
      const lookup = lookupList + v.getUint16(lookupList + 2 + index * 2);
      let type = v.getUint16(lookup);
      const subCount = v.getUint16(lookup + 4);
      for (let s = 0; s < subCount; s++) {
        let sub = lookup + v.getUint16(lookup + 6 + s * 2);
        if (type === 9) {
          type = v.getUint16(sub + 2);
          sub += v.getUint32(sub + 4);
        }
        if (type === 2) this.readPairPos(sub, wanted, lookupOut);
        type = v.getUint16(lookup);
      }
      for (const [left, row] of lookupOut) {
        let target = out.get(left);
        if (!target) out.set(left, (target = new Map()));
        for (const [right, value] of row) {
          const sum = (target.get(right) ?? 0) + value;
          if (sum === 0) target.delete(right);
          else target.set(right, sum);
        }
      }
    }
  }

  private coverage(offset: number): Map<number, number> {
    const v = this.view;
    const map = new Map<number, number>();
    const format = v.getUint16(offset);
    const count = v.getUint16(offset + 2);
    if (format === 1) {
      for (let i = 0; i < count; i++) map.set(v.getUint16(offset + 4 + i * 2), i);
    } else if (format === 2) {
      for (let i = 0; i < count; i++) {
        const r = offset + 4 + i * 6;
        const start = v.getUint16(r);
        const end = v.getUint16(r + 2);
        const startIndex = v.getUint16(r + 4);
        for (let g = start; g <= end; g++) map.set(g, startIndex + g - start);
      }
    }
    return map;
  }

  private classDef(offset: number, glyph: number): number {
    const v = this.view;
    const format = v.getUint16(offset);
    if (format === 1) {
      const start = v.getUint16(offset + 2);
      const count = v.getUint16(offset + 4);
      return glyph >= start && glyph < start + count ? v.getUint16(offset + 6 + (glyph - start) * 2) : 0;
    }
    if (format === 2) {
      const count = v.getUint16(offset + 2);
      let lo = 0;
      let hi = count - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const r = offset + 4 + mid * 6;
        if (glyph < v.getUint16(r)) hi = mid - 1;
        else if (glyph > v.getUint16(r + 2)) lo = mid + 1;
        else return v.getUint16(r + 4);
      }
    }
    return 0;
  }

  /** Size in bytes of a ValueRecord and the offset of XAdvance in it (-1 if absent). */
  private static valueLayout(format: number): { size: number; xAdvance: number } {
    let size = 0;
    let xAdvance = -1;
    for (let bit = 0; bit < 8; bit++) {
      if (!(format & (1 << bit))) continue;
      if (bit === 2) xAdvance = size;
      size += 2;
    }
    return { size, xAdvance };
  }

  private readPairPos(sub: number, wanted: Set<number>, out: GlyphKerning): void {
    const v = this.view;
    const format = v.getUint16(sub);
    const coverage = this.coverage(sub + v.getUint16(sub + 2));
    const f1 = OpenTypeTables.valueLayout(v.getUint16(sub + 4));
    const f2 = OpenTypeTables.valueLayout(v.getUint16(sub + 6));
    if (f1.xAdvance < 0) return;
    const set = (left: number, right: number, value: number): void => {
      if (value === 0) return;
      let row = out.get(left);
      if (!row) out.set(left, (row = new Map()));
      if (!row.has(right)) row.set(right, value);
    };
    if (format === 1) {
      for (const [left, index] of coverage) {
        if (!wanted.has(left)) continue;
        const pairSet = sub + v.getUint16(sub + 10 + index * 2);
        const count = v.getUint16(pairSet);
        const record = 2 + f1.size + f2.size;
        for (let i = 0; i < count; i++) {
          const r = pairSet + 2 + i * record;
          const right = v.getUint16(r);
          if (wanted.has(right)) set(left, right, v.getInt16(r + 2 + f1.xAdvance));
        }
      }
    } else if (format === 2) {
      const classDef1 = sub + v.getUint16(sub + 8);
      const classDef2 = sub + v.getUint16(sub + 10);
      const class2Count = v.getUint16(sub + 14);
      const record = f1.size + f2.size;
      const rights = [...wanted].map((g) => [g, this.classDef(classDef2, g)] as const);
      for (const [left] of coverage) {
        if (!wanted.has(left)) continue;
        const c1 = this.classDef(classDef1, left);
        for (const [right, c2] of rights) {
          if (c2 >= class2Count) continue;
          const r = sub + 16 + (c1 * class2Count + c2) * record;
          set(left, right, v.getInt16(r + f1.xAdvance));
        }
      }
    }
  }

  private readKern(base: number, wanted: Set<number>, out: GlyphKerning): void {
    const v = this.view;
    if (v.getUint16(base) !== 0) return;
    const nTables = v.getUint16(base + 2);
    let sub = base + 4;
    for (let t = 0; t < nTables; t++) {
      const length = v.getUint16(sub + 2);
      const coverage = v.getUint16(sub + 4);
      if (coverage >> 8 === 0 && (coverage & 1) === 1) {
        const nPairs = v.getUint16(sub + 6);
        for (let i = 0; i < nPairs; i++) {
          const r = sub + 14 + i * 6;
          const left = v.getUint16(r);
          const right = v.getUint16(r + 2);
          const value = v.getInt16(r + 4);
          if (value === 0 || !wanted.has(left) || !wanted.has(right)) continue;
          let row = out.get(left);
          if (!row) out.set(left, (row = new Map()));
          row.set(right, value);
        }
      }
      sub += length;
    }
  }
}

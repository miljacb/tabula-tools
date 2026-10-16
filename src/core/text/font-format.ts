/**
 * The `.font.json` format written by `tabula font` and read by
 * {@link SdfFont}: font metrics, glyph boxes and kerning in em units, plus
 * the atlas pages (RGBA: multi-channel signed distance in RGB, true signed
 * distance in A).
 */

/** Format identifier of a `.font.json` file. */
export const SDF_FONT_FORMAT = 'tabula-font';
/** Current `.font.json` version. */
export const SDF_FONT_VERSION = 1;

/** Values per glyph in {@link SdfFontJson.glyphs}. */
export const SDF_GLYPH_STRIDE = 11;

/** One atlas page. */
export interface SdfFontPageJson {
  /** Image file, relative to the `.font.json`. */
  file: string;
  /** KTX2 alternative (UASTC, linear), relative to the `.font.json`. */
  ktx2?: string;
  width: number;
  height: number;
}

/** Vertical metrics in em units (y up, baseline at 0). */
export interface SdfFontMetricsJson {
  ascender: number;
  /** Negative below the baseline. */
  descender: number;
  /** Baseline-to-baseline distance recommended by the font. */
  lineHeight: number;
  underlineY: number;
  underlineThickness: number;
  /** Height of flat capitals (OS/2 sCapHeight), when the font states it. Used to match fallback fonts' sizes. */
  capHeight?: number;
  /** Height of lowercase x (OS/2 sxHeight), when the font states it. */
  xHeight?: number;
}

/** A compiled SDF font. */
export interface SdfFontJson {
  format: typeof SDF_FONT_FORMAT;
  version: number;
  /** Face name, e.g. "Inter-Regular". */
  name: string;
  family?: string;
  /** `msdf` (RGB median + SDF alpha) or `sdf` (single channel in every channel). */
  type: 'msdf' | 'sdf';
  /** Atlas pixels per em. */
  size: number;
  /** Distance range in atlas pixels (signed distance -range/2..+range/2 maps to 0..1). */
  distanceRange: number;
  metrics: SdfFontMetricsJson;
  pages: SdfFontPageJson[];
  /**
   * Flat glyph records, {@link SDF_GLYPH_STRIDE} values each:
   * code point, advance (em), plane left, bottom, right, top (em, y up, relative to the pen
   * on the baseline), atlas x, y, width, height (pixels, y down), page.
   */
  glyphs: number[];
  kerning: SdfKerningJson;
  /**
   * Names of fonts (`<name>.font.json` next to this one, or manifest font
   * names) searched in order for characters this font lacks.
   */
  fallbacks?: string[];
  /** Language this font variant was built for (`hr`, `ka`, ...); manifest font names carry it as `name@lang`. */
  language?: string;
}

/**
 * Pair kerning, compressed into classes: glyphs with identical kerning
 * behaviour share a class (fonts kern by class; this restores it).
 * Adjustment of a pair = value of (left class, right class), or 0.
 */
export interface SdfKerningJson {
  /** Flat pairs: code point, left class. Code points not listed have no kerning as left glyph. */
  left: number[];
  /** Flat pairs: code point, right class. */
  right: number[];
  /** Flat triples: left class, right class, adjustment (em). */
  values: number[];
}

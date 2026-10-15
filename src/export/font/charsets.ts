/**
 * Character sets for the font compiler: named sets (scripts as Unicode
 * ranges), languages (CLDR main exemplar characters, both cases, plus a
 * shared base of ASCII, digits, punctuation and currency symbols), and the
 * exact characters used by i18n files.
 */

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

/** Code points `from..to` that are assigned (not `Cn`) and not controls. */
function range(from: number, to: number): string {
  let s = '';
  for (let c = from; c <= to; c++) {
    const ch = String.fromCodePoint(c);
    if (/[\p{Cn}\p{Cc}\p{Cs}\p{Co}]/u.test(ch)) continue;
    s += ch;
  }
  return s;
}

/** Vietnamese letters: Latin plus each vowel with every tone mark, NFC-composed. */
function vietnamese(): string {
  const vowels = 'aăâeêioôơuưy';
  const tones = ['', '\u0300', '\u0309', '\u0303', '\u0301', '\u0323'];
  let s = 'đĐ';
  for (const v of vowels) {
    for (const t of tones) {
      const lower = (v + t).normalize('NFC');
      s += lower + lower.toUpperCase();
    }
  }
  return s;
}

const PUNCTUATION = '‘’‚“”„«»‹›…–—•·′″¡¿§©®°±¶†‡‰№™−×÷ ';
/** Currency symbols of the supported languages plus the common ones. */
const CURRENCY = '$¢£¤¥€₺₾֏₽₴₫₸₼₹₩₪₦₱฿₡₲₵₭₮₨';
const ASCII = range(0x20, 0x7e);

/** Named character sets for `--charset` (combine with commas). */
export const FONT_CHARSETS: Readonly<Record<string, string>> = {
  digits: '0123456789.,:;+-−%$€£¥×x/ ',
  ascii: ASCII,
  latin: ASCII + range(0xa0, 0xff) + '€‘’‚“”„…–—•™',
  'latin-ext': ASCII + range(0xa0, 0xff) + range(0x100, 0x17f) + range(0x218, 0x21b) + '€‘’‚“”„…–—•™−',
  /** Latin Extended-A and -B, plus Latin Extended Additional (Vietnamese, Welsh, ...). */
  'latin-ext-all': ASCII + range(0xa0, 0x24f) + range(0x1e00, 0x1eff) + PUNCTUATION + CURRENCY,
  currency: CURRENCY + range(0x20a0, 0x20c0),
  punctuation: PUNCTUATION,
  /** Modern Greek and Coptic block (monotonic Greek; polytonic is not included). */
  greek: range(0x370, 0x3ff),
  /** Cyrillic block (Russian, Ukrainian, Belarusian, Bulgarian, Serbian, Macedonian, Kazakh, ...). */
  cyrillic: range(0x400, 0x4ff),
  /** Georgian: Mkhedruli, Asomtavruli/Nuskhuri block and Mtavruli capitals. */
  georgian: range(0x10a0, 0x10ff) + range(0x1c90, 0x1cbf),
  armenian: range(0x531, 0x58f) + '«»',
  vietnamese: ASCII + vietnamese() + '₫',
  turkish: ASCII + 'çÇğĞıİöÖşŞüÜâÂîÎûÛ₺',
};

/**
 * Main exemplar characters per language (lowercase; uppercase is derived),
 * following CLDR. Every language also gets ASCII (see {@link languageCharset}).
 */
const LANGUAGE_EXEMPLARS: Readonly<Record<string, { letters: string; extra?: string }>> = {
  en: { letters: '' },
  hr: { letters: 'čćđšž' },
  bs: { letters: 'čćđšž' },
  'sr-latn': { letters: 'čćđšž' },
  sl: { letters: 'čćšž' },
  cs: { letters: 'áčďéěíňóřšťúůýž' },
  sk: { letters: 'áäčďéíĺľňóôŕšťúýž' },
  pl: { letters: 'ąćęłńóśźż', extra: 'zł' },
  hu: { letters: 'áéíóöőúüű' },
  ro: { letters: 'ăâîșțşţ' },
  de: { letters: 'äöüß', extra: 'ẞ' },
  fr: { letters: 'àâæçéèêëîïôœùûüÿ' },
  es: { letters: 'áéíñóúü', extra: '¡¿' },
  it: { letters: 'àéèìíîòóùú' },
  pt: { letters: 'áàâãçéêíóôõú' },
  nl: { letters: 'áéíóúäëïöüĳ' },
  sv: { letters: 'åäöé' },
  da: { letters: 'æøåé' },
  no: { letters: 'æøåéóôà' },
  nb: { letters: 'æøåéóôà' },
  fi: { letters: 'åäöšž' },
  et: { letters: 'äöõüšž' },
  lv: { letters: 'āčēģīķļņšūž' },
  lt: { letters: 'ąčęėįšųūž' },
  sq: { letters: 'çë' },
  is: { letters: 'áðéíóúýþæö' },
  ga: { letters: 'áéíóú' },
  mt: { letters: 'àċèġħìòùż' },
  tr: { letters: 'çğıöşüâîû', extra: 'İ₺' },
  az: { letters: 'çəğıöşü', extra: 'İ₼' },
  vi: { letters: '', extra: vietnamese() + '₫' },
  el: { letters: 'αβγδεζηθικλμνξοπρσςτυφχψωάέήίόύώϊϋΐΰ', extra: '·;΄' },
  ru: { letters: 'абвгдеёжзийклмнопрстуфхцчшщъыьэюя', extra: '₽' },
  uk: { letters: 'абвгґдеєжзиіїйклмнопрстуфхцчшщьюяʼ', extra: '₴' },
  be: { letters: 'абвгдеёжзійклмнопрстуўфхцчшыьэюяʼ' },
  bg: { letters: 'абвгдежзийклмнопрстуфхцчшщъьюя' },
  sr: { letters: 'абвгдђежзијклљмнњопрстћуфхцчџш' },
  mk: { letters: 'абвгдѓежзѕијклљмнњопрстќуфхцчџш' },
  kk: { letters: 'аәбвгғдеёжзийкқлмнңоөпрстуұүфхһцчшщъыіьэюя', extra: '₸' },
  ka: { letters: range(0x10d0, 0x10f0), extra: '₾„“' },
  hy: { letters: range(0x561, 0x587), extra: '՚՛՜՝՞՟։֊֏' },
};

/** Language codes known to {@link languageCharset}. */
export const FONT_LANGUAGES: readonly string[] = Object.keys(LANGUAGE_EXEMPLARS);

/**
 * Shared by every language: digits, ASCII punctuation, common typographic
 * punctuation and the major currencies (language-specific currencies are in
 * the language's own entry; the `currency` charset has them all).
 */
const LANGUAGE_BASE = ASCII + '‘’‚“”„«»…–—•·°±×÷−™©®§ ' + '$¢£¥€';

/**
 * Characters of one language: its exemplar letters in both cases, plus
 * ASCII (digits, punctuation, and Latin letters, which UIs use in every
 * language for codes, brand names and currency codes such as EUR), common
 * typographic punctuation and the major currency symbols.
 * Region subtags fall back to the language (`pt-BR` → `pt`).
 */
export function languageCharset(lang: string): string {
  const key = lang.toLowerCase().replace('_', '-');
  const entry = LANGUAGE_EXEMPLARS[key] ?? LANGUAGE_EXEMPLARS[key.split('-')[0]!];
  if (!entry) throw new Error(`Unknown language "${lang}" (known: ${FONT_LANGUAGES.join(', ')})`);
  let s = LANGUAGE_BASE + entry.letters + (entry.extra ?? '');
  for (const ch of entry.letters) {
    const upper = ch.toUpperCase();
    if ([...upper].length === 1) s += upper; // not ß → SS
  }
  return s;
}

/** Unique code points of a string, sorted. */
export function codePoints(text: string): number[] {
  const set = new Set<number>();
  for (const ch of text) set.add(ch.codePointAt(0)!);
  return [...set].sort((a, b) => a - b);
}

/** Every string value in parsed JSON (keys excluded). */
function jsonStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) jsonStrings(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) jsonStrings(v, out);
}

/**
 * The characters used by i18n files: every string value of `.json` files
 * (keys are not text), the whole content of other files. Text is NFC
 * normalized (decomposed accents become the precomposed letters the atlas
 * has). Placeholders such as `{name}` or `{{count}}` are kept literally;
 * add the characters their values can have with `--chars` or `--lang`.
 */
export async function charsetFromFiles(files: readonly string[]): Promise<string> {
  let text = '';
  for (const file of files) {
    const content = await readFile(file, 'utf-8');
    if (extname(file).toLowerCase() === '.json') {
      const strings: string[] = [];
      jsonStrings(JSON.parse(content), strings);
      text += strings.join('\n');
    } else {
      text += content;
    }
  }
  return text.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, '');
}

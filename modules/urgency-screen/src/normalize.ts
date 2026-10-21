export const NORMALIZER_VERSION = 'normalize.v3' as const;

/**
 * Apostrophe look-alikes phone keyboards, transcripts and pasted text produce: ASCII `'`, backtick,
 * acute accent, U+02BC, U+2018, U+2019, U+201B, U+2032 and the full-width U+FF07. Written as code
 * points so none of them is misread as another.
 */
const APOSTROPHE_CODE_POINTS = [
  0x27, 0x60, 0xb4, 0x2bc, 0x2018, 0x2019, 0x201b, 0x2032, 0xff07,
] as const;
const APOSTROPHES = new RegExp(`[${String.fromCodePoint(...APOSTROPHE_CODE_POINTS)}]`, 'gu');
/** Invisible format characters: soft hyphen, zero-width space/joiner/non-joiner, word joiner, BOM. */
const FORMAT_CHARACTERS = /\p{Cf}/gu;
const COMBINING_MARKS = /\p{M}/gu;
const NOT_LETTER_OR_DIGIT = /[^\p{L}\p{N}]+/gu;

function fold(text: string, formatCharacterAs: '' | ' '): string {
  return text
    .replace(APOSTROPHES, '')
    .normalize('NFKC')
    .replace(APOSTROPHES, '')
    .replace(FORMAT_CHARACTERS, formatCharacterAs)
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(NOT_LETTER_OR_DIGIT, ' ')
    .trim();
}

/**
 * One normalization for inbound text and for every vocabulary term (WP-045, root cause a).
 * Apostrophes go first, because NFKC turns the acute accent into a space and the full-width
 * apostrophe into ASCII, and again after NFKC. Then invisible format characters are deleted,
 * diacritics dropped, case folded, and every other run of punctuation or whitespace becomes one
 * space.
 */
export function normalizeForScreen(text: string): string {
  return fold(text, '');
}

/**
 * Both readings of an invisible format character: deleted, so `ki<ZWSP>ll` reads `kill`, and as a
 * word break, so `kill<ZWSP>myself` reads `kill myself`. One reading when the text has none.
 */
export function normalizedReadings(text: string): readonly string[] {
  const joined = fold(text, '');
  const split = fold(text, ' ');
  return joined === split ? [joined] : [joined, split];
}

const HAS_FORMAT_CHARACTER = /\p{Cf}/u;

/**
 * Per-occurrence handling of format characters (WP-045 a4): when one invisible character sits
 * inside a word and another (or the same code point) separates words, neither uniform reading
 * is right. The compact reading deletes every format character AND every space, so the matcher
 * can look for each pattern with its spaces removed. Null when the text has no format character,
 * so ordinary messages never pay the over-triage cost of space-free matching.
 */
export function compactReading(text: string): string | null {
  if (!HAS_FORMAT_CHARACTER.test(text)) return null;
  return fold(text, '').replaceAll(' ', '');
}

/** The WP-045 a2 normalization (`normalize.v1`), kept verbatim so a4 stays a superset of a2. */
const V1_APOSTROPHE_CODE_POINTS = [
  0x27, 0x60, 0xb4, 0x2bc, 0x2018, 0x2019, 0x201b, 0x2032,
] as const;
const V1_APOSTROPHES = new RegExp(`[${String.fromCodePoint(...V1_APOSTROPHE_CODE_POINTS)}]`, 'gu');

export function normalizeV1ForScreen(text: string): string {
  return text
    .replace(V1_APOSTROPHES, '')
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(NOT_LETTER_OR_DIGIT, ' ')
    .trim();
}

import { describe, expect, it } from 'vitest';
import {
  NORMALIZER_VERSION,
  compactReading,
  normalizeForScreen,
  normalizeV1ForScreen,
  normalizedReadings,
} from './normalize.js';

const cp = (...codePoints: number[]): string => String.fromCodePoint(...codePoints);

describe('WP-045 normalize.v3', () => {
  it('is versioned', () => {
    expect(NORMALIZER_VERSION).toBe('normalize.v3');
  });

  it('gives a compact reading only when the message carries a format character', () => {
    expect(compactReading('I want to kill myself')).toBeNull();
    expect(compactReading(`I want to ki${cp(0x200b)}ll${cp(0x200b)}myself`)).toBe(
      'iwanttokillmyself',
    );
    expect(compactReading(`ki${cp(0xad)}ll${cp(0x2060)}my${cp(0xad)}self`)).toBe('killmyself');
  });

  it('keeps the a2 normalization verbatim for the superset union', () => {
    expect(normalizeV1ForScreen(`I CAN${cp(0x2019)}T  Breathe!`)).toBe('i cant breathe');
    expect(normalizeV1ForScreen(`Me duelen el p${cp(0xe9)}cho`)).toBe('me duelen el pecho');
  });

  it('reads every apostrophe look-alike the same way, including the full-width one', () => {
    for (const apostrophe of [0x27, 0x60, 0xb4, 0x2bc, 0x2018, 0x2019, 0x201b, 0x2032, 0xff07]) {
      expect(normalizeForScreen(`I can${cp(apostrophe)}t breathe`)).toBe('i cant breathe');
    }
    expect(normalizeForScreen('I cant breathe')).toBe('i cant breathe');
  });

  it('collapses doubled spaces, tabs, newlines and no-break spaces', () => {
    expect(normalizeForScreen('chest  pain')).toBe('chest pain');
    expect(normalizeForScreen(`chest\tpain\r\nnow`)).toBe('chest pain now');
    expect(normalizeForScreen(`dolor${cp(0xa0)}de${cp(0x2003)}pecho`)).toBe('dolor de pecho');
    expect(normalizeForScreen(`chest${cp(0x3000)}pain`)).toBe('chest pain');
    expect(normalizeForScreen('   911   ')).toBe('911');
  });

  it('deletes invisible format characters inside a word', () => {
    for (const format of [0xad, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]) {
      expect(normalizeForScreen(`sui${cp(format)}cide`), format.toString(16)).toBe('suicide');
    }
  });

  it('offers both readings of a format character: deleted and as a word break', () => {
    expect(normalizedReadings(`kill${cp(0x2060)}myself`)).toEqual(['killmyself', 'kill myself']);
    expect(normalizedReadings(`ki${cp(0x200b)}ll myself`)).toEqual(['kill myself', 'ki ll myself']);
    expect(normalizedReadings('chest pain')).toEqual(['chest pain']);
  });

  it('folds case, diacritics, punctuation and compatibility forms', () => {
    expect(normalizeForScreen('DOLOR DE PECHO')).toBe('dolor de pecho');
    expect(normalizeForScreen(`presi${cp(0xf3)}n`)).toBe('presion');
    expect(normalizeForScreen(`presio${cp(0x301)}n`)).toBe('presion');
    expect(normalizeForScreen(`hacerme dan${cp(0x303)}o`)).toBe('hacerme dano');
    expect(normalizeForScreen(`${cp(0xbf)}Cu${cp(0xe1)}l es el horario?`)).toBe(
      'cual es el horario',
    );
    expect(normalizeForScreen('chest-pain!!')).toBe('chest pain');
    expect(normalizeForScreen(cp(0xff43, 0xff48, 0xff45, 0xff53, 0xff54))).toBe('chest');
    expect(normalizeForScreen(`overdose${cp(0xfe0f)}`)).toBe('overdose');
  });

  it('keeps digits and is idempotent', () => {
    const once = normalizeForScreen(`Call 911 NOW ${cp(0x2014)} I can${cp(0x2019)}t  breathe`);
    expect(once).toBe('call 911 now i cant breathe');
    expect(normalizeForScreen(once)).toBe(once);
  });
});

import { KEYWORD_CLASSIFIER_VERSION, type ScreenLanguage, type UrgencyClass } from './types.js';

const URGENT_TERMS: Readonly<Record<ScreenLanguage, readonly string[]>> = {
  en: [
    '911',
    'emergency',
    'chest pain',
    "can't breathe",
    'cannot breathe',
    'suicid',
    'overdose',
    'stroke',
    'unconscious',
    'severe bleeding',
  ],
  es: ['911', 'emergencia', 'dolor de pecho', 'no puedo respirar', 'suicidio', 'sobredosis'],
  unknown: ['911', 'emergency', 'emergencia'],
};

export interface KeywordHit {
  readonly class: UrgencyClass;
  readonly reasons: readonly string[];
  readonly classifierVersion: typeof KEYWORD_CLASSIFIER_VERSION;
}

export function classifyByKeywords(input: {
  readonly text: string;
  readonly language: ScreenLanguage;
}): KeywordHit {
  const haystack = input.text.toLowerCase();
  const terms = URGENT_TERMS[input.language];
  const hits = terms.filter((term) => haystack.includes(term));
  if (hits.length > 0) {
    return {
      class: 'urgent',
      reasons: hits.map((term) => `keyword:${input.language}:${term}`),
      classifierVersion: KEYWORD_CLASSIFIER_VERSION,
    };
  }
  return {
    class: 'routine',
    reasons: [`keyword:${input.language}:none`],
    classifierVersion: KEYWORD_CLASSIFIER_VERSION,
  };
}

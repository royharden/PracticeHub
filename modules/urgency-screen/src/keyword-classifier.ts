import {
  compactReading,
  normalizeForScreen,
  normalizeV1ForScreen,
  normalizedReadings,
} from './normalize.js';
import { KEYWORD_CLASSIFIER_VERSION, type ScreenLanguage, type UrgencyClass } from './types.js';

/**
 * Matching is on whole words of the normalized text. A pattern is one or more words; a word
 * ending in `*` is a stem and matches any word that starts with it (`suicid*` matches suicide,
 * suicidal, suicidarme). So `aire` does not match `Aires`, and `cuesta` alone matches nothing.
 */
interface WordPattern {
  readonly word: string;
  readonly stem: boolean;
}

interface CompiledPattern {
  readonly source: string;
  readonly words: readonly WordPattern[];
  /** The same pattern with its spaces removed, for the compact reading (a stem takes any tail). */
  readonly compact: RegExp;
}

function compile(pattern: string): CompiledPattern {
  const words = pattern
    .split(' ')
    .filter((part) => part !== '')
    .map((part) => {
      const stem = part.endsWith('*');
      return { word: normalizeForScreen(stem ? part.slice(0, -1) : part), stem };
    });
  const compact = new RegExp(
    words.map((w) => `${w.word.replaceAll(' ', '')}${w.stem ? '[\\p{L}\\p{N}]*' : ''}`).join(''),
    'u',
  );
  return { source: words.map((w) => `${w.word}${w.stem ? '*' : ''}`).join(' '), words, compact };
}

function contains(tokens: readonly string[], pattern: CompiledPattern): boolean {
  const { words } = pattern;
  for (let start = 0; start + words.length <= tokens.length; start += 1) {
    const matched = words.every((expected, offset) => {
      const token = tokens[start + offset] ?? '';
      return expected.stem ? token.startsWith(expected.word) : token === expected.word;
    });
    if (matched) return true;
  }
  return false;
}

/**
 * Imminent-danger phrases by vocabulary. Each one alone makes a message urgent. Concepts
 * (REQ-COMM-001 EX3; WP-045 rework 2): suicidality and self-harm (intent, plan, method, wish to be
 * dead, overdose), chest pain and ACS, breathing, stroke, unconscious, seizure, severe bleeding,
 * and an explicit emergency, 911 or ambulance.
 */
const PHRASES: Readonly<Record<ScreenLanguage, readonly string[]>> = {
  en: [
    '911',
    'emergenc*',
    'ambulance*',
    'paramedic*',
    'suicid*',
    'kil* myself',
    'kil* my self',
    'end* my life',
    'end* my own life',
    'take my own life',
    'taking my own life',
    'end* it all',
    'end* things',
    'want* to die',
    'wanna die',
    'wish i was dead',
    'wish i were dead',
    'better off dead',
    'better off without me',
    'better without me',
    'happier without me',
    'if i was gone',
    'if i were gone',
    'if i wasnt here',
    'if i werent here',
    'point of living',
    'point in living',
    'done with life',
    'done living',
    'rather not wake up',
    'rather be dead',
    'dont want to wake up',
    'take them all at once',
    'cant go on',
    'cannot go on',
    'can not go on',
    'want it to end',
    'it all to end',
    'goodbye letter*',
    'goodbye note*',
    'suicide note*',
    'no reason to live',
    'no reason for me to live',
    'nothing to live for',
    'dont want to live',
    'do not want to live',
    'dont want to be alive',
    'do not want to be alive',
    'hurt* myself',
    'harm* myself',
    'self harm*',
    'cut* myself',
    'hang* myself',
    'shoot* myself',
    'stab* myself',
    'jump* off',
    'overdos*',
    'chest pain*',
    'heart attack*',
    'cant breathe',
    'cannot breathe',
    'can not breathe',
    'couldnt breathe',
    'not breathing',
    'isnt breathing',
    'stopped breathing',
    'short of breath',
    'shortness of breath',
    'gasp*',
    'chok*',
    'turning blue',
    'cant get air',
    'cant get any air',
    'cannot get air',
    'stroke*',
    'unconscious',
    'unresponsive',
    'not responding',
    'wont respond',
    'will not respond',
    'doesnt respond',
    'not respond*',
    'seizing',
    'having a seizure',
    'button batter*',
    'passed out',
    'pass* out',
    'faint*',
    'collaps*',
    'wont wake up',
    'will not wake up',
    'not waking up',
    'cant wake',
    'cannot wake',
    'severe bleeding',
    'bleeding heavily',
    'heavy bleeding',
    'hemorrhag*',
    'status epilepticus',
  ],
  es: [
    '911',
    'emergencia*',
    'ambulancia*',
    'paramedic*',
    'suicid*',
    'matarme',
    'me voy a matar',
    'me mato',
    'me quiero matar',
    'quitarme la vida',
    'quitar la vida',
    'acabar con mi vida',
    'terminar con mi vida',
    'quiero morir*',
    'me quiero morir',
    'ganas de morir*',
    'quisiera estar muert*',
    'quiero estar muert*',
    'mejor muert*',
    'no quiero vivir',
    'no quiero seguir viviendo',
    'mejor sin mi',
    'si yo no estuviera',
    'si ya no estuviera',
    'sentido a vivir',
    'sentido de vivir',
    'sentido a la vida',
    'desaparecer para siempre',
    'que todo termine',
    'que todo acabe',
    'no quiero estar aqui',
    'tomarme todas las pastillas',
    'carta de despedida',
    'cartas de despedida',
    'convulsionando',
    'no reacciona',
    'hacerme daño',
    'lastimarme',
    'cortarme',
    'cort* las venas',
    'ahorcarme',
    'sobredosis',
    'dolor de pecho',
    'dolor en el pecho',
    'infarto',
    'ataque al corazon',
    'ataque cardiaco',
    'no puedo respirar',
    'no puede respirar',
    'no respira',
    'dejo de respirar',
    'falta el aire',
    'falta de aire',
    'falta aire',
    'ahog*',
    'asfixi*',
    'derrame*',
    'ictus',
    'embolia',
    'inconscient*',
    'no responde',
    'no despierta',
    'desmay*',
    'perdio el conocimiento',
    'sin conocimiento',
    'se desplomo',
    'hemorragia*',
  ],
  unknown: ['911', 'emergency', 'emergencia'],
};

/**
 * An anchor and a qualifier anywhere in the same message, and one of `also` when it is given.
 * Over-triage is the accepted cost.
 */
interface CoOccurrenceRule {
  readonly concept: string;
  readonly anchors: readonly string[];
  readonly qualifiers: readonly string[];
  readonly also?: readonly string[];
}

const CO_OCCURRENCE_RULES: readonly CoOccurrenceRule[] = [
  {
    concept: 'chest-discomfort',
    anchors: ['chest', 'breastbone', 'sternum', 'pecho'],
    qualifiers: [
      'pain*',
      'pressure',
      'tight*',
      'crush*',
      'squeez*',
      'hurt*',
      'heavy',
      'heaviness',
      'weight',
      'ache*',
      'aching',
      'burn*',
      'sitting on',
      'elephant',
      'sweat*',
      'dolor',
      'duele',
      'presion',
      'opresion',
      'apret*',
      'apriet*',
      'arde',
      'quema*',
      'peso',
      'pesado',
      'sud*',
    ],
  },
  {
    concept: 'chest-discomfort',
    anchors: ['heart', 'corazon'],
    qualifiers: ['crush*', 'squeez*', 'apret*', 'apriet*', 'aplast*'],
  },
  {
    concept: 'referred-cardiac-pain',
    anchors: ['jaw', 'mandibula', 'quijada'],
    qualifiers: ['left arm', 'brazo izquierdo', 'sweat*', 'sud*'],
  },
  {
    concept: 'referred-cardiac-pain',
    anchors: ['left arm', 'brazo izquierdo'],
    qualifiers: ['sweat*', 'sud*', 'pressure', 'presion', 'pain*', 'dolor', 'duele'],
  },
  {
    concept: 'breathing-difficulty',
    anchors: ['breath*', 'respir*'],
    qualifiers: [
      'cant',
      'cannot',
      'can not',
      'not',
      'hard',
      'hardly',
      'barely',
      'trouble',
      'difficult*',
      'short',
      'struggl*',
      'unable',
      'gasp*',
      'no',
      'dificil',
      'cuesta',
      'falta',
      'apenas',
    ],
  },
  {
    concept: 'breathing-difficulty',
    anchors: ['air'],
    qualifiers: ['struggl*', 'cant get', 'cannot get', 'can not get', 'not enough', 'gasp*'],
  },
  {
    concept: 'breathing-difficulty',
    anchors: ['inhaler', 'inhalador'],
    qualifiers: [
      'not working',
      'isnt working',
      'doesnt work',
      'doesnt help',
      'not helping',
      'no funciona',
      'no me ayuda',
    ],
  },
  {
    concept: 'airway-swelling',
    anchors: ['throat', 'tongue', 'lips', 'garganta', 'lengua', 'labios'],
    qualifiers: [
      'clos*',
      'swell*',
      'swollen',
      'tight*',
      'big',
      'bigger',
      'puff*',
      'cerr*',
      'hinch*',
      'inflamad*',
    ],
  },
  {
    concept: 'anaphylaxis',
    anchors: ['allergic reaction', 'reaccion alergica', 'anaphyla*', 'anafilax*'],
    qualifiers: [
      'throat',
      'tongue',
      'lips',
      'breath*',
      'hives',
      'garganta',
      'lengua',
      'labios',
      'respir*',
    ],
  },
  {
    concept: 'cyanosis',
    anchors: ['lips', 'lip', 'face', 'skin', 'labios', 'cara', 'piel'],
    qualifiers: [
      'blue',
      'bluish',
      'purple',
      'purplish',
      'gray',
      'grey',
      'grayish',
      'greyish',
      'azul*',
      'morad*',
      'gris*',
    ],
  },
  {
    concept: 'cyanosis',
    anchors: ['poniendo', 'puso', 'turning', 'turned'],
    qualifiers: ['blue', 'morad*', 'azul*'],
  },
  {
    concept: 'head-injury-red-flag',
    anchors: [
      'hit his head',
      'hit her head',
      'hit my head',
      'hit their head',
      'head injury',
      'fell on his head',
      'fell on her head',
      'golpe en la cabeza',
      'se golpeo la cabeza',
      'me golpee la cabeza',
    ],
    qualifiers: [
      'vomit*',
      'throwing up',
      'threw up',
      'not making sense',
      'confused',
      'passed out',
      'drowsy',
      'wont wake',
      'vomita*',
      'confundid*',
      'desmay*',
    ],
  },
  {
    concept: 'suicidality',
    anchors: ['gun', 'pistol', 'rifle', 'knife', 'rope', 'pistola', 'arma', 'cuchillo', 'cuerda'],
    qualifiers: ['on myself', 'myself', 'contra mi', 'matarme', 'en mi contra'],
  },
  {
    concept: 'suicidality',
    anchors: ['jump*', 'tirarme', 'aventarme', 'lanzarme', 'saltar'],
    qualifiers: [
      'roof',
      'bridge',
      'building',
      'balcony',
      'cliff',
      'window',
      'puente',
      'edificio',
      'balcon',
      'techo',
      'azotea',
      'ventana',
    ],
  },
  {
    concept: 'suicidality',
    anchors: ['stockpil*', 'saving up', 'saved up', 'hoard*', 'juntando', 'guardando'],
    qualifiers: ['pills', 'meds', 'medication*', 'pastillas', 'medicinas'],
  },
  {
    concept: 'unresponsive',
    anchors: ['not moving', 'isnt moving', 'no se mueve'],
    qualifiers: [
      'answer*',
      'respond*',
      'breath*',
      'fell',
      'collaps*',
      'contesta*',
      'reacciona*',
      'respir*',
      'cayo',
    ],
  },
  {
    concept: 'dangerous-ingestion',
    anchors: [
      'kid',
      'child',
      'toddler',
      'baby',
      'son',
      'daughter',
      'nino',
      'nina',
      'hijo',
      'hija',
      'bebe',
      'nieto',
      'nieta',
    ],
    qualifiers: ['ate', 'swallow*', 'got into', 'se comio', 'se trago', 'se tomo'],
    also: ['pill*', 'med*', 'tablet*', 'pastilla*', 'medicina*'],
  },
  {
    concept: 'dangerous-ingestion',
    anchors: ['poison*', 'veneno*'],
    qualifiers: ['ate', 'drank', 'swallow*', 'took', 'tomo', 'bebio', 'comio', 'trago'],
  },
  {
    concept: 'dangerous-ingestion',
    anchors: ['swallow*', 'ate', 'drank', 'trago', 'se trago', 'bebio', 'se tomo', 'se comio'],
    qualifiers: [
      'battery',
      'batteries',
      'magnet*',
      'bleach',
      'detergent*',
      'laundry pod*',
      'antifreeze',
      'pila',
      'pilas',
      'iman*',
      'cloro',
      'lejia',
      'detergente*',
    ],
  },
  {
    concept: 'stroke-face',
    anchors: ['face', 'mouth', 'smile', 'cara', 'boca', 'sonrisa'],
    qualifiers: [
      'droop*',
      'crooked',
      'uneven',
      'lopsided',
      'caid*',
      'cay*',
      'torcid*',
      'chuec*',
      'numb*',
      'dormid*',
      'durmi*',
      'adormecid*',
    ],
  },
  {
    concept: 'stroke-speech',
    anchors: ['speech', 'speak*', 'talk*', 'word', 'words', 'habla*', 'palabras'],
    qualifiers: [
      'slur*',
      'garbl*',
      'cant',
      'cannot',
      'can not',
      'no puede',
      'no puedo',
      'arrastr*',
      'enredad*',
      'weird',
      'strange*',
      'funny',
      'gibberish',
      'nonsense',
      'rar*',
      'extran*',
      'no se le entiende',
      'no se entiende',
    ],
  },
  {
    concept: 'stroke-limb',
    anchors: ['arm', 'leg', 'side', 'hand', 'brazo', 'pierna', 'lado', 'mano'],
    qualifiers: [
      'numb*',
      'weak*',
      'paraly*',
      'cant move',
      'cannot move',
      'can not move',
      'cant lift',
      'cannot lift',
      'can not lift',
      'dormid*',
      'durmi*',
      'adormecid*',
      'debil*',
      'paraliz*',
      'no puede mover',
      'no puedo mover',
      'cant feel',
      'cannot feel',
      'can not feel',
      'no siento',
      'no siente',
    ],
  },
  {
    concept: 'seizure',
    anchors: ['seizure*', 'seizing', 'convuls*'],
    qualifiers: [
      'now',
      'wont stop',
      'will not stop',
      'not stop*',
      'hasnt stopped',
      'still',
      'having',
      'keeps',
      'no para',
      'tiene',
      'esta',
      'ahora',
    ],
  },
  {
    concept: 'severe-bleeding',
    anchors: ['bleed*', 'blood', 'sangr*'],
    qualifiers: [
      'wont stop',
      'will not stop',
      'not stop*',
      'cant stop',
      'heavily',
      'a lot',
      'lots',
      'everywhere',
      'soak*',
      'gush*',
      'spurt*',
      'pouring',
      'vomit*',
      'cough* up',
      'much*',
      'no para',
      'sin parar',
      'no se detiene',
      'abundante',
      'bastante',
    ],
  },
  {
    concept: 'intentional-ingestion',
    anchors: ['took', 'take', 'taking', 'swallow*', 'tome', 'tomo', 'trague'],
    qualifiers: [
      'all my pills',
      'all the pills',
      'too many',
      'whole bottle',
      'entire bottle',
      'todas las pastillas',
      'todas mis pastillas',
      'todas sus pastillas',
      'todas tus pastillas',
      'muchas pastillas',
      'frasco entero',
      'un frasco',
      'todo el frasco',
      'bote entero',
    ],
  },
];

interface CompiledPhrase {
  readonly language: ScreenLanguage;
  readonly pattern: CompiledPattern;
}

const SCREEN_LANGUAGES: readonly ScreenLanguage[] = ['en', 'es', 'unknown'];

const COMPILED_PHRASES: readonly CompiledPhrase[] = SCREEN_LANGUAGES.flatMap((language) =>
  PHRASES[language].map((pattern) => ({ language, pattern: compile(pattern) })),
);

const COMPILED_RULES = CO_OCCURRENCE_RULES.map((rule) => ({
  concept: rule.concept,
  anchors: rule.anchors.map(compile),
  qualifiers: rule.qualifiers.map(compile),
  also: (rule.also ?? []).map(compile),
}));

export interface KeywordHit {
  readonly class: UrgencyClass;
  readonly reasons: readonly string[];
  readonly classifierVersion: typeof KEYWORD_CLASSIFIER_VERSION;
}

/* ------------------------------------------------------------------------------------------ *
 * Superset guarantee (WP-045 a4; integrator decision D-2.2): the screen is urgent whenever the  *
 * a3 concept vocabulary above, the a2 vocabulary or the landed (5a9be52) vocabulary would say   *
 * urgent. The two earlier vocabularies are kept verbatim below with their original substring   *
 * matching, so no phrasing an earlier version caught can be lost.                              *
 * ------------------------------------------------------------------------------------------ */

/** WP-045 a2 (`keyword-classifier.v2`) phrases, every vocabulary, substring on normalize.v1. */
const A2_TERMS: Readonly<Record<ScreenLanguage, readonly string[]>> = {
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
    'kill myself',
    'killing myself',
    'end my life',
    'ending my life',
    'take my own life',
    'taking my own life',
    'end it all',
    'want to die',
    'better off dead',
    'hurt myself',
    'hurting myself',
    'harm myself',
    'self harm',
  ],
  es: [
    '911',
    'emergencia',
    'dolor de pecho',
    'no puedo respirar',
    'suicid',
    'sobredosis',
    'matarme',
    'quitarme la vida',
    'acabar con mi vida',
    'quiero morir',
    'no quiero vivir',
    'hacerme daño',
    'lastimarme',
  ],
  unknown: ['911', 'emergency', 'emergencia'],
};

/** WP-045 a2 co-occurrence rules, substring on normalize.v1. */
const A2_RULES: readonly CoOccurrenceRule[] = [
  {
    concept: 'chest-discomfort',
    anchors: ['chest', 'breastbone', 'sternum', 'pecho'],
    qualifiers: [
      'pain',
      'pressure',
      'tight',
      'crush',
      'squeez',
      'hurt',
      'heavy',
      'weight',
      'ache',
      'dolor',
      'duele',
      'presión',
      'opresión',
      'apret',
      'aprieta',
    ],
  },
  {
    concept: 'breathing-difficulty',
    anchors: ['breath', 'respirar', 'aire'],
    qualifiers: [
      'cant',
      'cannot',
      'hard',
      'trouble',
      'difficult',
      'short',
      'struggl',
      'unable',
      'gasp',
      'no puedo',
      'difícil',
      'cuesta',
      'falta',
      'ahog',
    ],
  },
  {
    concept: 'cyanosis',
    anchors: ['lips', 'labios'],
    qualifiers: ['blue', 'purple', 'gray', 'grey', 'azul', 'morad', 'gris'],
  },
];

/** Landed (5a9be52, `keyword-classifier.v1`) terms, declared language only, raw lower-case. */
const LANDED_TERMS: Readonly<Record<ScreenLanguage, readonly string[]>> = {
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

const A2_NORMALIZED_TERMS = SCREEN_LANGUAGES.flatMap((language) =>
  A2_TERMS[language].map((term) => normalizeV1ForScreen(term)),
);
const A2_NORMALIZED_RULES = A2_RULES.map((rule) => ({
  concept: rule.concept,
  anchors: rule.anchors.map(normalizeV1ForScreen),
  qualifiers: rule.qualifiers.map(normalizeV1ForScreen),
}));

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** What the a2 classifier would report: substring over its own normalization and every reading. */
function a2Reasons(text: string, readings: readonly string[], compact: string | null): string[] {
  const haystacks = unique([normalizeV1ForScreen(text), ...readings]);
  const has = (needle: string): boolean =>
    haystacks.some((haystack) => haystack.includes(needle)) ||
    (compact !== null && compact.includes(needle.replaceAll(' ', '')));
  const reasons: string[] = [];
  for (const term of unique(A2_NORMALIZED_TERMS)) {
    if (has(term)) reasons.push(`keyword:a2:${term}`);
  }
  for (const rule of A2_NORMALIZED_RULES) {
    const anchor = rule.anchors.find(has);
    const qualifier = rule.qualifiers.find(has);
    if (anchor !== undefined && qualifier !== undefined) {
      reasons.push(`keyword:a2:concept:${rule.concept}:${anchor}+${qualifier}`);
    }
  }
  return reasons;
}

/** What the landed classifier would report: declared language, substring over raw lower-case. */
function landedReasons(
  text: string,
  language: ScreenLanguage,
  readings: readonly string[],
  compact: string | null,
): string[] {
  const haystacks = unique([text.toLowerCase(), ...readings]);
  return LANDED_TERMS[language]
    .filter(
      (term) =>
        haystacks.some((haystack) => haystack.includes(term)) ||
        (compact !== null && compact.includes(normalizeForScreen(term).replaceAll(' ', ''))),
    )
    .map((term) => `keyword:landed:${language}:${term}`);
}

/**
 * Every vocabulary is searched whatever the declared language (root cause b): a detector that
 * gives up (`unknown`) or mislabels a message must not drop terms, because uncertain means urgent
 * (REQ-COMM-001 EX2). The declared language's vocabulary is reported first. Both readings of any
 * invisible format character are searched, plus the space-free compact reading when the message
 * carries one. The result is the union of the a3, a2 and landed classifiers (strictly safer).
 */
export function classifyByKeywords(input: {
  readonly text: string;
  readonly language: ScreenLanguage;
}): KeywordHit {
  const flatReadings = normalizedReadings(input.text);
  const compact = compactReading(input.text);
  const readings = flatReadings.map((reading) => (reading === '' ? [] : reading.split(' ')));
  const found = (pattern: CompiledPattern): boolean =>
    readings.some((tokens) => contains(tokens, pattern)) ||
    (compact !== null && pattern.compact.test(compact));
  const ordered = [
    ...COMPILED_PHRASES.filter((entry) => entry.language === input.language),
    ...COMPILED_PHRASES.filter((entry) => entry.language !== input.language),
  ];
  const seen = new Set<string>();
  const reasons: string[] = [];
  for (const entry of ordered) {
    if (seen.has(entry.pattern.source) || !found(entry.pattern)) continue;
    seen.add(entry.pattern.source);
    reasons.push(`keyword:${entry.language}:${entry.pattern.source}`);
  }
  for (const rule of COMPILED_RULES) {
    const anchor = rule.anchors.find(found);
    const qualifier = rule.qualifiers.find(found);
    const third = rule.also.length === 0 ? null : rule.also.find(found);
    if (anchor !== undefined && qualifier !== undefined && third !== undefined) {
      const suffix = third === null ? '' : `+${third.source}`;
      reasons.push(`keyword:concept:${rule.concept}:${anchor.source}+${qualifier.source}${suffix}`);
    }
  }
  reasons.push(...a2Reasons(input.text, flatReadings, compact));
  reasons.push(...landedReasons(input.text, input.language, flatReadings, compact));
  if (reasons.length > 0) {
    return { class: 'urgent', reasons, classifierVersion: KEYWORD_CLASSIFIER_VERSION };
  }
  return {
    class: 'routine',
    reasons: [`keyword:${input.language}:none`],
    classifierVersion: KEYWORD_CLASSIFIER_VERSION,
  };
}

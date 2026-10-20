import type { UrgencyScreenInput } from '../types.js';
import { classifyForEval, inputForCase, sha256Json, type ClassifiedCase } from './evaluate.js';
import { RIGHT_SINGLE_QUOTE, goldenSetDigest } from './golden-set.js';
import {
  TRIAGE_EVAL_VERSION,
  type FailureDirectionReport,
  type FaultId,
  type FaultOutcome,
  type GoldenCase,
  type GoldenSet,
  type TriageClassifier,
} from './types.js';

interface FaultSpec {
  readonly fault: FaultId;
  applies(goldenCase: GoldenCase): boolean;
  perturb(input: UrgencyScreenInput): UrgencyScreenInput;
}

/** Invisible and look-alike characters, spelled as code points so none is misread. */
const NO_BREAK_SPACE = String.fromCodePoint(0xa0);
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
const ZERO_WIDTH_JOINER = String.fromCodePoint(0x200d);
const ZERO_WIDTH_NON_JOINER = String.fromCodePoint(0x200c);
const SOFT_HYPHEN = String.fromCodePoint(0xad);
const IDEOGRAPHIC_SPACE = String.fromCodePoint(0x3000);

/** Puts `mark` inside every word of four or more letters, after its second letter. */
function insideWords(text: string, mark: string): string {
  return text.replace(/\p{L}{4,}/gu, (word) => `${word.slice(0, 2)}${mark}${word.slice(2)}`);
}

/** ASCII to its full-width form (U+FF01..U+FF5E), space to the ideographic space. */
function fullWidth(text: string): string {
  return [...text]
    .map((ch) => {
      const cp = ch.codePointAt(0) ?? 0;
      if (cp === 0x20) return IDEOGRAPHIC_SPACE;
      return cp >= 0x21 && cp <= 0x7e ? String.fromCodePoint(cp + 0xfee0) : ch;
    })
    .join('');
}

const hasWordToSplit = (goldenCase: GoldenCase): boolean => /\p{L}{4,}/u.test(goldenCase.text);

/**
 * Faults a screen meets in service: the kill switch, typography phones and transcripts produce,
 * invisible format characters and full-width forms from pasted text, decomposed accents, a
 * language detector that gives up or picks the wrong language, an unmatched sender, business
 * hours and another channel. None of them changes what the message means, so none may move an
 * urgent case to routine.
 */
export const FAULTS: readonly FaultSpec[] = Object.freeze([
  {
    fault: 'kill-switch',
    applies: () => true,
    perturb: (input) => ({ ...input, killSwitchTripped: true }),
  },
  {
    fault: 'uppercase',
    applies: (goldenCase) => goldenCase.text !== goldenCase.text.toUpperCase(),
    perturb: (input) => ({ ...input, text: input.text.toUpperCase() }),
  },
  {
    fault: 'curly-apostrophe',
    applies: (goldenCase) => goldenCase.text.includes("'"),
    perturb: (input) => ({ ...input, text: input.text.replaceAll("'", RIGHT_SINGLE_QUOTE) }),
  },
  {
    fault: 'extra-whitespace',
    applies: (goldenCase) => goldenCase.text.includes(' '),
    perturb: (input) => ({ ...input, text: input.text.replaceAll(' ', '  ') }),
  },
  {
    fault: 'language-unknown',
    applies: (goldenCase) => goldenCase.language !== 'unknown',
    perturb: (input) => ({ ...input, language: 'unknown' }),
  },
  {
    fault: 'unmatched-identity',
    applies: () => true,
    perturb: (input) => ({ ...input, unmatched: true }),
  },
  {
    fault: 'business-hours',
    applies: (goldenCase) => goldenCase.afterHours,
    perturb: (input) => ({ ...input, afterHours: false }),
  },
  {
    fault: 'voice-transcript',
    applies: (goldenCase) => goldenCase.channel !== 'voice-transcript',
    perturb: (input) => ({ ...input, channel: 'voice-transcript' }),
  },
  {
    fault: 'no-break-space',
    applies: (goldenCase) => goldenCase.text.includes(' '),
    perturb: (input) => ({ ...input, text: input.text.replaceAll(' ', NO_BREAK_SPACE) }),
  },
  {
    fault: 'zero-width-space',
    applies: hasWordToSplit,
    perturb: (input) => ({ ...input, text: insideWords(input.text, ZERO_WIDTH_SPACE) }),
  },
  {
    fault: 'zero-width-joiner',
    applies: hasWordToSplit,
    perturb: (input) => ({ ...input, text: insideWords(input.text, ZERO_WIDTH_JOINER) }),
  },
  {
    fault: 'zero-width-non-joiner',
    applies: hasWordToSplit,
    perturb: (input) => ({ ...input, text: insideWords(input.text, ZERO_WIDTH_NON_JOINER) }),
  },
  {
    fault: 'soft-hyphen',
    applies: hasWordToSplit,
    perturb: (input) => ({ ...input, text: insideWords(input.text, SOFT_HYPHEN) }),
  },
  {
    fault: 'full-width',
    applies: (goldenCase) => /[\x21-\x7e]/.test(goldenCase.text),
    perturb: (input) => ({ ...input, text: fullWidth(input.text) }),
  },
  {
    fault: 'decomposed-accents',
    applies: (goldenCase) => goldenCase.text !== goldenCase.text.normalize('NFD'),
    perturb: (input) => ({ ...input, text: input.text.normalize('NFD') }),
  },
  {
    fault: 'mislabel-en-as-es',
    applies: (goldenCase) => goldenCase.language === 'en',
    perturb: (input) => ({ ...input, language: 'es' }),
  },
  {
    fault: 'mislabel-es-as-en',
    applies: (goldenCase) => goldenCase.language === 'es',
    perturb: (input) => ({ ...input, language: 'en' }),
  },
  {
    // One invisible character in both roles: inside words and as the word separator.
    fault: 'zero-width-separator',
    applies: (goldenCase) => hasWordToSplit(goldenCase) && goldenCase.text.includes(' '),
    perturb: (input) => ({
      ...input,
      text: insideWords(input.text, ZERO_WIDTH_SPACE).replaceAll(' ', ZERO_WIDTH_SPACE),
    }),
  },
]);

/** Safe means toward escalation: an urgent case stays urgent; a kill switch always hands to a human. */
export function isSafe(
  fault: FaultId | 'clean',
  goldenCase: GoldenCase,
  result: ClassifiedCase,
): boolean {
  if (result.observed === 'error' || result.breaches.length > 0) return false;
  if (fault === 'kill-switch') {
    return (
      result.observed === 'urgent' && result.humanFallback && result.routing === 'human_review'
    );
  }
  return goldenCase.expected === 'routine' || result.observed === 'urgent';
}

export function faultKey(caseId: string, fault: FaultId): string {
  return `${caseId}|${fault}`;
}

export function runFailureDirectionSuite(
  classifier: TriageClassifier,
  goldenSet: GoldenSet,
): FailureDirectionReport {
  const outcomes: FaultOutcome[] = [];
  for (const goldenCase of goldenSet.cases) {
    const cleanInput = inputForCase(goldenCase);
    const cleanSafe = isSafe('clean', goldenCase, classifyForEval(classifier, cleanInput));
    for (const spec of FAULTS) {
      if (!spec.applies(goldenCase)) continue;
      const result = classifyForEval(classifier, spec.perturb(cleanInput));
      const safe = isSafe(spec.fault, goldenCase, result);
      outcomes.push(
        Object.freeze({
          key: faultKey(goldenCase.caseId, spec.fault),
          caseId: goldenCase.caseId,
          fault: spec.fault,
          expected: goldenCase.expected,
          observed: result.observed,
          routing: result.routing,
          safe,
          induced: !safe && cleanSafe,
        }),
      );
    }
  }
  const digest = goldenSetDigest(goldenSet);
  const unsafe = outcomes.filter((outcome) => !outcome.safe).map((outcome) => outcome.key);
  const induced = outcomes.filter((outcome) => outcome.induced).map((outcome) => outcome.key);
  return Object.freeze({
    evalVersion: TRIAGE_EVAL_VERSION,
    goldenSetDigest: digest,
    classifierId: classifier.classifierId,
    outcomes: Object.freeze(outcomes),
    unsafe: Object.freeze(unsafe),
    induced: Object.freeze(induced),
    overTriage: outcomes.filter(
      (outcome) => outcome.expected === 'routine' && outcome.observed === 'urgent',
    ).length,
    evidenceDigest: sha256Json({
      evalVersion: TRIAGE_EVAL_VERSION,
      goldenSetDigest: digest,
      classifierId: classifier.classifierId,
      outcomes,
    }),
    synthetic: true,
  });
}

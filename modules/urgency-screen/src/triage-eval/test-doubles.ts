import { screenInbound } from '../screen.js';
import type { ScreenLanguage, UrgencyScreenInput, VersionedUrgencyFact } from '../types.js';
import { RIGHT_SINGLE_QUOTE } from './golden-set.js';
import type { TriageClassifier } from './types.js';

function straightenApostrophes(text: string): string {
  return text.replaceAll(RIGHT_SINGLE_QUOTE, "'");
}

/**
 * Candidate classifiers for exercising the eval and the gate. Test doubles only: none of them is a
 * classifier of record, and none is exported from the package.
 */
function candidate(
  classifierId: string,
  tag: string,
  classify: (input: UrgencyScreenInput) => VersionedUrgencyFact,
): TriageClassifier {
  return Object.freeze({
    classifierId,
    classify: (input: UrgencyScreenInput): VersionedUrgencyFact => {
      const fact = classify(input);
      return Object.freeze({ ...fact, classifierVersion: `${fact.classifierVersion}+${tag}` });
    },
  });
}

/** Normalizes typography and whitespace and unions the language vocabularies before screening. */
export const normalizingUnionCandidate: TriageClassifier = candidate(
  'double.normalize-union',
  'normalize-union.double',
  (input) => {
    const text = straightenApostrophes(input.text).replace(/\s+/g, ' ');
    const facts = (['en', 'es', 'unknown'] as const).map((language) =>
      screenInbound({ ...input, text, language }),
    );
    const chosen =
      facts.find((fact) => fact.class === 'urgent') ?? screenInbound({ ...input, text });
    return { ...chosen, language: input.language };
  },
);

/**
 * A "tuned" change that looks better: it stops over-triaging a negated mention (and, on the base
 * screen, fixes curly apostrophes), but it has dropped `stroke`, so it regresses an urgent golden
 * case.
 */
export const tunedRegressingCandidate: TriageClassifier = candidate(
  'double.tuned-regressing',
  'tuned.double',
  (input) => {
    const text = straightenApostrophes(input.text);
    const fact = screenInbound({ ...input, text });
    const lower = text.toLowerCase();
    const droppedTerm = lower.includes('stroke');
    const negated = lower.startsWith('no chest pain');
    if (!fact.humanFallback && (droppedTerm || negated)) {
      return { ...fact, class: 'routine', routing: 'queue_until_open', confidence: 0.6 };
    }
    return fact;
  },
);

/**
 * Drops coverage for exactly these messages, as a vocabulary trim would: they screen routine and
 * everything else screens as the landed screen does.
 */
export function coverageTrimmingCandidate(droppedTexts: readonly string[]): TriageClassifier {
  const dropped = new Set(droppedTexts);
  return candidate('double.coverage-trim', 'coverage-trim.double', (input) => {
    const fact = screenInbound(input);
    if (fact.humanFallback || !dropped.has(input.text)) return fact;
    return { ...fact, class: 'routine', routing: 'queue_until_open', confidence: 0.4 };
  });
}

/**
 * Catches these messages only under the given labels, as the landed screen caught 'unconscious'
 * only in a message labelled English: under any other label they screen routine.
 */
export function labelLimitedCandidate(
  texts: readonly string[],
  labels: readonly ScreenLanguage[],
): TriageClassifier {
  const limited = new Set(texts);
  return candidate('double.label-limited', 'label-limited.double', (input) => {
    const fact = screenInbound(input);
    if (fact.humanFallback || !limited.has(input.text) || labels.includes(input.language)) {
      return fact;
    }
    return { ...fact, class: 'routine', routing: 'queue_until_open', confidence: 0.4 };
  });
}

/** Screens as if the kill switch were never tripped. */
export const killSwitchIgnoringCandidate: TriageClassifier = candidate(
  'double.kill-switch-ignoring',
  'ignores-kill-switch.double',
  (input) => screenInbound({ ...input, killSwitchTripped: false }),
);

/** Hands a kill-switch case to a human but labels it routine: no contract breach, still unsafe. */
export const killSwitchRoutineCandidate: TriageClassifier = candidate(
  'double.kill-switch-routine',
  'kill-switch-routine.double',
  (input) => {
    const fact = screenInbound(input);
    return fact.humanFallback ? { ...fact, class: 'routine' } : fact;
  },
);

export const alwaysRoutineCandidate: TriageClassifier = candidate(
  'double.always-routine',
  'always-routine.double',
  (input) => {
    const fact = screenInbound({ ...input, killSwitchTripped: false });
    return { ...fact, class: 'routine', routing: 'queue_until_open', humanFallback: false };
  },
);

export const alwaysUrgentCandidate: TriageClassifier = candidate(
  'double.always-urgent',
  'always-urgent.double',
  (input) => {
    const fact = screenInbound(input);
    if (fact.humanFallback) return fact;
    return {
      ...fact,
      class: 'urgent',
      routing: input.afterHours ? 'page_oncall' : 'queue_until_open',
    };
  },
);

/** Drops the 911 line from its reasons: a contract breach the eval must record. */
export const disclaimerDroppingCandidate: TriageClassifier = candidate(
  'double.drops-disclaimer',
  'drops-disclaimer.double',
  (input) => {
    const fact = screenInbound(input);
    return { ...fact, reasons: fact.reasons.filter((reason) => !reason.startsWith('disclaimer:')) };
  },
);

export const throwingCandidate: TriageClassifier = Object.freeze({
  classifierId: 'double.throws',
  classify: (): VersionedUrgencyFact => {
    throw new Error('model-sim timeout');
  },
});

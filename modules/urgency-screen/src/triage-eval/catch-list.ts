import type { ScreenLanguage } from '../types.js';
import { classifyForEval, sha256Json } from './evaluate.js';
import { EVAL_TENANT_ID } from './evaluate.js';
import {
  TRIAGE_EVAL_VERSION,
  type CatchListEntry,
  type CatchListReport,
  type TriageClassifier,
} from './types.js';

const cp = (codePoint: number): string => String.fromCodePoint(codePoint);

/**
 * Baseline catch list v1 (WP-104 a4): phrasings an earlier screen version caught that a later
 * candidate must not drop, whatever the golden set says. Seeded with reviewer 0196's regression
 * probes (reviews/D56-WP-045-a3-review-2.json): the landed and WP-045 a2 phrasings that WP-045 a3
 * lost, and an invisible character used both inside a word and as the separator.
 */
export const BASELINE_CATCH_LIST_V1: readonly CatchListEntry[] = Object.freeze(
  (
    [
      ['cl-landed-01', 'en', 'periods of unconsciousness'],
      ['cl-landed-02', 'en', 'episode of unconsciousness this morning and he is still groggy'],
      ['cl-a2-01', 'en', "it's getting harder and harder to breathe"],
      ['cl-a2-02', 'en', 'breathing harder than normal and my lips feel numb'],
      ['cl-a2-03', 'es', 'me cuesta agarrar aire'],
      ['cl-a2-04', 'es', 'no puedo tomar aire'],
      ['cl-a2-05', 'es', 'no puedo jalar aire'],
      ['cl-a2-06', 'es', 'no puedo agarrar aire'],
      ['cl-a2-07', 'es', 'le cuesta mucho el aire al bebe'],
      ['cl-a2-08', 'es', 'Me duelen el pecho y el brazo'],
      ['cl-a2-09', 'es', 'dolores fuertes en el pecho'],
      ['cl-a2-10', 'en', 'my lips are blueish'],
      ['cl-fmt-01', 'en', `I want to ki${cp(0x200b)}ll${cp(0x200b)}myself`],
      ['cl-fmt-02', 'en', `ki${cp(0x200b)}ll${cp(0x2060)}my${cp(0x200b)}self`],
      ['cl-fmt-03', 'en', `ki${cp(0x200d)}ll${cp(0x2060)}my${cp(0x200d)}self`],
      ['cl-fmt-04', 'en', `ki${cp(0x200c)}ll${cp(0x2060)}my${cp(0x200c)}self`],
      ['cl-fmt-05', 'en', `ki${cp(0xad)}ll${cp(0x2060)}my${cp(0xad)}self`],
      ['cl-fmt-06', 'en', `chest${cp(0x200b)}pa${cp(0x200b)}in`],
    ] as const
  ).map(([id, language, text]) =>
    Object.freeze({ id, language: language as ScreenLanguage, text, synthetic: true as const }),
  ),
);

export function catchListDigest(list: readonly CatchListEntry[]): string {
  return sha256Json(list);
}

/** The labels each phrasing is read under: its own language, `unknown`, then the other one. */
export function catchListLabels(entry: CatchListEntry): readonly ScreenLanguage[] {
  return [entry.language, 'unknown', entry.language === 'es' ? 'en' : 'es'];
}

export function catchListKey(entry: CatchListEntry, language: ScreenLanguage): string {
  return `${entry.id}~${language}`;
}

/**
 * Which catch-list readings a classifier marks urgent, after hours: each phrasing under every
 * label, recorded separately, so the gate refuses a candidate that drops any reading the
 * baseline caught, including one a baseline caught only under the message's declared language.
 */
export function evaluateCatchList(
  classifier: TriageClassifier,
  list: readonly CatchListEntry[],
): CatchListReport {
  const readings = list.flatMap((entry) =>
    catchListLabels(entry).map((language) => ({ entry, language })),
  );
  const urgent = readings
    .filter(
      ({ entry, language }) =>
        classifyForEval(classifier, {
          tenantId: EVAL_TENANT_ID,
          inboundId: entry.id,
          receivedAt: '2026-01-01T03:00:00Z',
          channel: 'sms',
          language,
          text: entry.text,
          unmatched: false,
          afterHours: true,
          killSwitchTripped: false,
          synthetic: true,
        }).observed === 'urgent',
    )
    .map(({ entry, language }) => catchListKey(entry, language));
  const digest = catchListDigest(list);
  return Object.freeze({
    evalVersion: TRIAGE_EVAL_VERSION,
    catchListDigest: digest,
    classifierId: classifier.classifierId,
    total: readings.length,
    urgent: Object.freeze(urgent),
    evidenceDigest: sha256Json({ digest, classifierId: classifier.classifierId, urgent }),
    synthetic: true,
  });
}

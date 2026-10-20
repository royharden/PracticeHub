import { describe, expect, it } from 'vitest';
import {
  GOLDEN_SET_V1,
  GOLDEN_SET_V2,
  GOLDEN_SET_V2_PROVENANCE,
  MATRIX_LANGUAGES,
  addConfirmedMiss,
  createGoldenSet,
  goldenSetDigest,
  type ConfirmedMissInput,
} from './golden-set.js';

describe('WP-104 golden set revision 2', () => {
  it('is revision 2 of revision 1 and keeps every revision-1 case byte for byte', () => {
    expect(GOLDEN_SET_V2.revision).toBe(2);
    expect(GOLDEN_SET_V2.parentRevision).toBe(1);
    expect(GOLDEN_SET_V2.cases).toHaveLength(351);
    expect(GOLDEN_SET_V2.cases.slice(0, 40)).toEqual(GOLDEN_SET_V1.cases);
    expect(GOLDEN_SET_V2.cases.every((item) => item.synthetic === true)).toBe(true);
    expect(goldenSetDigest(GOLDEN_SET_V2)).not.toBe(goldenSetDigest(GOLDEN_SET_V1));
  });

  it('holds 266 seed and 9 probe urgent cases and 76 routine cases', () => {
    const count = (source: string, expected: string) =>
      GOLDEN_SET_V2.cases.filter((item) => item.source === source && item.expected === expected)
        .length;
    expect(count('seed', 'urgent')).toBe(266);
    expect(count('probe', 'urgent')).toBe(9);
    expect(count('seed', 'routine')).toBe(76);
  });

  it('gives every concept exemplar an unknown-labelled and a mislabelled case', () => {
    const ids = new Set(GOLDEN_SET_V2.cases.map((item) => item.caseId));
    for (const exemplar of ['rv-en-sui-12', 'rv-en-stk-01', 'rv-en-oth-03', 'rv-en-oth-04']) {
      expect(ids.has(`${exemplar}~unknown`), exemplar).toBe(true);
      expect(ids.has(`${exemplar}~as-es`), exemplar).toBe(true);
    }
    for (const exemplar of ['rv-es-sui-06', 'rv-es-stk-03', 'rv-es-oth-01', 'rv-es-oth-02']) {
      expect(ids.has(`${exemplar}~unknown`), exemplar).toBe(true);
      expect(ids.has(`${exemplar}~as-en`), exemplar).toBe(true);
    }
  });

  it('records agent curation and a clinical sign-off that is still absent', () => {
    expect(GOLDEN_SET_V2_PROVENANCE.revision).toBe(2);
    expect(GOLDEN_SET_V2_PROVENANCE.curatedBy).toEqual([
      '0194_Claude_Opus5_Sub_Reviewer',
      '0185_Claude_Opus5_DeliveryLead',
    ]);
    expect(GOLDEN_SET_V2_PROVENANCE.humanClinicalSignOff).toBeNull();
  });
});

function miss(overrides: Partial<ConfirmedMissInput> = {}): ConfirmedMissInput {
  return {
    inboundId: 'inb-miss-1',
    language: 'es',
    channel: 'sms',
    afterHours: true,
    text: 'me quiero morir',
    observedClass: 'routine',
    observedClassifierVersion: 'keyword-classifier.v1+ai-screen-double.v1',
    correctedClass: 'urgent',
    failureMode: 'paraphrase',
    reviewerId: 'oncall-synthetic-1',
    reviewerKind: 'human',
    synthetic: true,
    ...overrides,
  };
}

describe('WP-104 golden set v1', () => {
  it('is synthetic, uniquely keyed and covers urgent and routine in every matrix language', () => {
    expect(GOLDEN_SET_V1.synthetic).toBe(true);
    expect(GOLDEN_SET_V1.revision).toBe(1);
    expect(GOLDEN_SET_V1.cases).toHaveLength(40);
    expect(new Set(GOLDEN_SET_V1.cases.map((item) => item.caseId)).size).toBe(40);
    expect(GOLDEN_SET_V1.cases.every((item) => item.synthetic === true)).toBe(true);
    for (const language of MATRIX_LANGUAGES) {
      const cell = GOLDEN_SET_V1.cases.filter((item) => item.language === language);
      expect(cell.some((item) => item.expected === 'urgent')).toBe(true);
      expect(cell.some((item) => item.expected === 'routine')).toBe(true);
    }
    expect(GOLDEN_SET_V1.cases.filter((item) => item.source === 'probe')).toHaveLength(7);
  });

  it('the typography probe really carries U+2019, not a straight apostrophe', () => {
    const probe = GOLDEN_SET_V1.cases.find((item) => item.caseId === 'pr-en-01');
    expect(probe?.text.codePointAt(5)).toBe(0x2019);
    expect(probe?.text.includes("'")).toBe(false);
  });

  it('has a stable digest that moves when any case byte moves', () => {
    const digest = goldenSetDigest(GOLDEN_SET_V1);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(goldenSetDigest(GOLDEN_SET_V1)).toBe(digest);
    const [first, ...rest] = GOLDEN_SET_V1.cases;
    if (first === undefined) throw new Error('golden set is empty');
    const edited = createGoldenSet({
      revision: 1,
      parentRevision: null,
      misses: [],
      cases: [{ ...first, text: `${first.text}.` }, ...rest],
    });
    expect(goldenSetDigest(edited)).not.toBe(digest);
  });

  it('rejects a set with an empty matrix cell, a duplicate or a non-synthetic case', () => {
    const withoutUnknownRoutine = GOLDEN_SET_V1.cases.filter(
      (item) => !(item.language === 'unknown' && item.expected === 'routine'),
    );
    expect(() =>
      createGoldenSet({
        revision: 1,
        parentRevision: null,
        misses: [],
        cases: withoutUnknownRoutine,
      }),
    ).toThrow(/no routine case for language unknown/);
    const [first] = GOLDEN_SET_V1.cases;
    if (first === undefined) throw new Error('golden set is empty');
    expect(() =>
      createGoldenSet({
        revision: 1,
        parentRevision: null,
        misses: [],
        cases: [...GOLDEN_SET_V1.cases, { ...first, caseId: 'dup-text' }],
      }),
    ).toThrow(/duplicate golden case text/);
    expect(() =>
      createGoldenSet({
        revision: 1,
        parentRevision: null,
        misses: [],
        cases: [
          ...GOLDEN_SET_V1.cases,
          { ...first, caseId: 'real', text: 'real inbound', synthetic: false as unknown as true },
        ],
      }),
    ).toThrow(/not synthetic/);
  });
});

describe('WP-104 confirmed-miss feedback loop', () => {
  it('adds the miss as an annotated golden case in a new revision and keeps the misclassification', () => {
    const next = addConfirmedMiss(GOLDEN_SET_V1, miss());
    expect(next.revision).toBe(2);
    expect(next.parentRevision).toBe(1);
    expect(next.cases).toHaveLength(41);
    const added = next.cases.find((item) => item.caseId === 'miss-inb-miss-1');
    expect(added).toMatchObject({
      text: 'me quiero morir',
      language: 'es',
      expected: 'urgent',
      failureMode: 'paraphrase',
      source: 'confirmed-miss',
    });
    expect(next.misses).toEqual([
      {
        caseId: 'miss-inb-miss-1',
        inboundId: 'inb-miss-1',
        observedClass: 'routine',
        observedClassifierVersion: 'keyword-classifier.v1+ai-screen-double.v1',
        correctedClass: 'urgent',
        reviewerId: 'oncall-synthetic-1',
        reviewerKind: 'human',
      },
    ]);
    expect(GOLDEN_SET_V1.cases).toHaveLength(40);
    expect(Object.isFrozen(next.cases)).toBe(true);
    expect(goldenSetDigest(next)).not.toBe(goldenSetDigest(GOLDEN_SET_V1));
  });

  it('refuses an AI self-correction, an unnamed reviewer, a non-miss, a duplicate and real data', () => {
    expect(() => addConfirmedMiss(GOLDEN_SET_V1, miss({ reviewerKind: 'ai' }))).toThrow(
      /human reviewer/,
    );
    expect(() => addConfirmedMiss(GOLDEN_SET_V1, miss({ reviewerId: ' ' }))).toThrow(
      /names its reviewer/,
    );
    expect(() => addConfirmedMiss(GOLDEN_SET_V1, miss({ observedClass: 'urgent' }))).toThrow(
      /not a miss/,
    );
    expect(() =>
      addConfirmedMiss(GOLDEN_SET_V1, miss({ text: 'quiero suicidarme', inboundId: 'inb-2' })),
    ).toThrow(/duplicate golden case text/);
    expect(() =>
      addConfirmedMiss(GOLDEN_SET_V1, miss({ synthetic: false as unknown as true })),
    ).toThrow(/synthetic/);
  });
});

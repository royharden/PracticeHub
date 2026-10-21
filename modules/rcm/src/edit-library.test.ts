import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  applyRulePack,
  applyRulePacks,
  editIdentity,
  regressRulePack,
  runEditRegressionCorpus,
  selectRulePack,
  type ClaimLine,
  type EditRegressionCorpus,
  type RulePack,
} from './edit-library.js';

const directory = dirname(fileURLToPath(import.meta.url));

const line: ClaimLine = {
  lineId: 'line-1',
  code: '99213',
  units: 3,
  serviceDate: '2026-09-25',
};

function pack(family: RulePack['family'], version: string, edits: RulePack['edits']): RulePack {
  return {
    packId: `${family}-${version}`,
    family,
    version,
    effectiveOn: '2026-07-01',
    edits,
  };
}

function loadCorpus(): EditRegressionCorpus {
  return JSON.parse(
    readFileSync(resolve(directory, '../fixtures/edit-regression/corpus.json'), 'utf8'),
  ) as EditRegressionCorpus;
}

/** A column-1 line for the NCCI pair fixtures (NR-123: NCCI fixtures here are column pairs). */
const column1: ClaimLine = { lineId: 'line-0', code: '99214', units: 1, serviceDate: '2026-09-25' };
const ncciPair = { editId: 'ncci-1', code: '99214', column2Code: '99213', maxUnits: null } as const;

describe('WP-084 edit library', () => {
  it('cites the rule-pack version on NCCI, MUE, and LCD/NCD edits', () => {
    const ncci = applyRulePack(pack('NCCI', '2026Q3', [ncciPair]), [column1, line]);
    const mue = applyRulePack(
      pack('MUE', '2026Q3', [{ editId: 'mue-1', code: '99213', maxUnits: 2 }]),
      [line],
    );
    const lcd = applyRulePack(
      pack('LCD-NCD', '2026Q3', [{ editId: 'lcd-1', code: '99213', maxUnits: null }]),
      [line],
    );
    expect(ncci[0]).toMatchObject({ family: 'NCCI', version: '2026Q3', packId: 'NCCI-2026Q3' });
    expect(mue[0]).toMatchObject({ family: 'MUE', version: '2026Q3', packId: 'MUE-2026Q3' });
    expect(lcd[0]).toMatchObject({
      family: 'LCD-NCD',
      version: '2026Q3',
      packId: 'LCD-NCD-2026Q3',
    });
  });

  it('fails the regression harness when a pack change drops a known edit', () => {
    const baseline = applyRulePack(pack('NCCI', '2026Q3', [ncciPair]), [column1, line]);
    const candidate = applyRulePack(pack('NCCI', '2026Q4', []), [column1, line]);
    const same = regressRulePack(baseline, baseline);
    const dropped = regressRulePack(baseline, candidate);
    expect(same.passed).toBe(true);
    expect(dropped.passed).toBe(false);
    expect(dropped.dropped.map((edit) => edit.editId)).toEqual(['ncci-1']);
  });
});

describe('WP-084 hardening H-18', () => {
  const q3: RulePack = {
    packId: 'MUE-Q3',
    family: 'MUE',
    version: '2026Q3',
    effectiveOn: '2026-07-01',
    edits: [{ editId: 'mue-97110', code: '97110', maxUnits: 4 }],
  };
  const q4: RulePack = { ...q3, packId: 'MUE-Q4', version: '2026Q4', effectiveOn: '2026-10-01' };
  const oct: ClaimLine = { lineId: 'oct', code: '97110', units: 5, serviceDate: '2026-10-01' };

  it('NR-122: refuses a superseded pack when given the service date and the other versions', () => {
    expect(() =>
      applyRulePack(q3, [oct], { serviceDate: '2026-10-01', versions: [q3, q4] }),
    ).toThrow(expect.objectContaining({ code: 'RULE_PACK_SUPERSEDED' }));
    expect(
      applyRulePack(q4, [oct], { serviceDate: '2026-10-01', versions: [q3, q4] }),
    ).toHaveLength(1);
  });

  it('NR-122: refuses a pack that is not in force on the service date', () => {
    expect(() =>
      applyRulePack({ ...q3, effectiveThrough: '2026-09-30' }, [oct], {
        serviceDate: '2026-10-01',
      }),
    ).toThrow(expect.objectContaining({ code: 'RULE_PACK_SUPERSEDED' }));
    expect(() => applyRulePack(q4, [oct], { serviceDate: '2026-09-15' })).toThrow(
      expect.objectContaining({ code: 'RULE_PACK_SUPERSEDED' }),
    );
  });

  it('NR-123: the committed regression corpus has no code-level NCCI entry', () => {
    const codeLevel = loadCorpus()
      .packs.filter((p) => p.family === 'NCCI')
      .flatMap((p) =>
        p.edits.filter((e) => e.column2Code === undefined).map((e) => `${p.packId}:${e.editId}`),
      );
    expect(codeLevel).toEqual([]);
  });
});

describe('WP-084 effective-date boundaries', () => {
  const lcd: RulePack = {
    packId: 'LCD-B',
    family: 'LCD-NCD',
    version: 'b',
    effectiveOn: '2026-07-01',
    effectiveThrough: '2026-09-30',
    edits: [{ editId: 'lcd-b', code: 'G0103', maxUnits: null }],
  };
  const on = (serviceDate: string): number =>
    applyRulePack(lcd, [{ lineId: 'x', code: 'G0103', units: 1, serviceDate }]).length;

  it.each([
    ['the day before effectiveOn', '2026-06-30', 0],
    ['effectiveOn itself', '2026-07-01', 1],
    ['the day after effectiveOn', '2026-07-02', 1],
    ['effectiveThrough itself', '2026-09-30', 1],
    ['the day after effectiveThrough', '2026-10-01', 0],
  ])('%s (%s) gives %i edits', (_label, day, count) => {
    expect(on(day)).toBe(count);
  });

  it('refuses an effectiveThrough before effectiveOn', () => {
    expect(() => applyRulePack({ ...lcd, effectiveThrough: '2026-06-30' }, [])).toThrow(
      /on or after/,
    );
  });
});

describe('WP-084 version selection by service date', () => {
  const q3: RulePack = {
    packId: 'MUE-Q3',
    family: 'MUE',
    version: '2026Q3',
    effectiveOn: '2026-07-01',
    edits: [{ editId: 'mue-97110', code: '97110', maxUnits: 4 }],
  };
  const q4: RulePack = {
    ...q3,
    packId: 'MUE-Q4',
    version: '2026Q4',
    effectiveOn: '2026-10-01',
    edits: [{ editId: 'mue-97110', code: '97110', maxUnits: 6 }],
  };

  it('selects the newest version in force and lets it supersede the old one', () => {
    expect(selectRulePack([q4, q3], 'MUE', '2026-06-30')).toBeNull();
    expect(selectRulePack([q4, q3], 'MUE', '2026-07-01')?.packId).toBe('MUE-Q3');
    expect(selectRulePack([q4, q3], 'MUE', '2026-09-30')?.packId).toBe('MUE-Q3');
    expect(selectRulePack([q4, q3], 'MUE', '2026-10-01')?.packId).toBe('MUE-Q4');
    expect(selectRulePack([q4, q3], 'NCCI', '2026-10-01')).toBeNull();
  });

  it('returns null in a gap left by an explicit effectiveThrough', () => {
    const ended = { ...q3, effectiveThrough: '2026-08-31' };
    expect(selectRulePack([ended, q4], 'MUE', '2026-09-15')).toBeNull();
  });

  it('refuses two versions of one family that start the same day', () => {
    expect(() => selectRulePack([q3, { ...q3, packId: 'MUE-Q3b' }], 'MUE', '2026-07-01')).toThrow(
      /take effect/,
    );
  });

  it('applies only the version in force on each line date, never the superseded one', () => {
    const lines: ClaimLine[] = [
      { lineId: 'sep', code: '97110', units: 5, serviceDate: '2026-09-30' },
      { lineId: 'oct', code: '97110', units: 5, serviceDate: '2026-10-01' },
    ];
    const edits = applyRulePacks([q3, q4], lines);
    expect(edits.map((e) => [e.lineId, e.packId])).toEqual([['sep', 'MUE-Q3']]);
    // Applying both packs blindly (the landed behavior) would also cite the old pack in October.
    expect(applyRulePack(q3, lines).map((e) => e.lineId)).toEqual(['sep', 'oct']);
  });

  it('refuses a duplicate packId', () => {
    expect(() => applyRulePacks([q3, q3], [])).toThrow(/duplicate packId/);
  });
});

describe('WP-084 NCCI procedure-to-procedure pairs', () => {
  const ncci: RulePack = {
    packId: 'NCCI-P',
    family: 'NCCI',
    version: 'p',
    effectiveOn: '2026-07-01',
    edits: [
      {
        editId: 'ptp-0',
        code: '80053',
        column2Code: '80048',
        modifierIndicator: '0',
        maxUnits: null,
      },
      {
        editId: 'ptp-1',
        code: '99214',
        column2Code: '36415',
        modifierIndicator: '1',
        maxUnits: null,
      },
      {
        editId: 'ptp-9',
        code: '93000',
        column2Code: '93005',
        modifierIndicator: '9',
        maxUnits: null,
      },
    ],
  };
  const day = '2026-08-01';
  const l = (lineId: string, code: string, modifiers?: string[]): ClaimLine => ({
    lineId,
    code,
    units: 1,
    serviceDate: day,
    ...(modifiers === undefined ? {} : { modifiers }),
  });

  it('fires on the column-2 line when the column-1 code is billed the same day', () => {
    const edits = applyRulePack(ncci, [l('a', '80053'), l('b', '80048')]);
    expect(edits.map((e) => [e.editId, e.lineId, e.code, e.pairedLineId])).toEqual([
      ['ptp-0', 'b', '80048', 'a'],
    ]);
  });

  it('does not fire when the pair is absent, or split across dates of service', () => {
    expect(applyRulePack(ncci, [l('a', '80053')])).toEqual([]);
    expect(applyRulePack(ncci, [l('b', '80048')])).toEqual([]);
    expect(
      applyRulePack(ncci, [l('a', '80053'), { ...l('b', '80048'), serviceDate: '2026-08-02' }]),
    ).toEqual([]);
  });

  it('honours modifier indicators 0, 1 and 9', () => {
    expect(applyRulePack(ncci, [l('a', '99214'), l('b', '36415', ['59'])])).toEqual([]);
    expect(applyRulePack(ncci, [l('a', '99214'), l('b', '36415', ['XU'])])).toEqual([]);
    expect(applyRulePack(ncci, [l('a', '99214'), l('b', '36415', ['25'])])).toHaveLength(1);
    expect(applyRulePack(ncci, [l('a', '80053'), l('b', '80048', ['59'])])).toHaveLength(1);
    expect(applyRulePack(ncci, [l('a', '93000'), l('b', '93005')])).toEqual([]);
  });

  it('keeps a code-level NCCI entry (no column-2 code) firing as before', () => {
    const legacy = pack('NCCI', 'legacy', [{ editId: 'code-1', code: '99213', maxUnits: null }]);
    expect(applyRulePack(legacy, [line]).map((e) => e.editId)).toEqual(['code-1']);
  });

  it('refuses malformed pair edits', () => {
    expect(() =>
      applyRulePack(
        { ...ncci, edits: [{ editId: 'x', code: '1', column2Code: '1', maxUnits: null }] },
        [],
      ),
    ).toThrow(/two different codes/);
    expect(() => applyRulePack({ ...ncci, family: 'MUE' }, [])).toThrow(/only NCCI/);
    expect(() =>
      applyRulePack(
        { ...ncci, edits: [{ editId: 'x', code: '1', modifierIndicator: '1', maxUnits: null }] },
        [],
      ),
    ).toThrow(/needs an NCCI pair/);
  });
});

describe('WP-084 MUE per code per date of service', () => {
  const mue = pack('MUE', 'm', [{ editId: 'mue-97110', code: '97110', maxUnits: 4 }]);
  const l = (lineId: string, units: number, serviceDate = '2026-08-01'): ClaimLine => ({
    lineId,
    code: '97110',
    units,
    serviceDate,
  });

  it('sums split lines on one date of service', () => {
    const edits = applyRulePack(mue, [l('a', 3), l('b', 2)]);
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ lineId: 'a', lineIds: ['a', 'b'], unitsTotal: 5 });
  });

  it('does not sum across dates of service, and exactly the limit passes', () => {
    expect(applyRulePack(mue, [l('a', 3), l('b', 2, '2026-08-02')])).toEqual([]);
    expect(applyRulePack(mue, [l('a', 2), l('b', 2)])).toEqual([]);
  });
});

describe('WP-084 committed regression corpus', () => {
  it('reproduces every stored baseline and allows only the recorded retirements', () => {
    const result = runEditRegressionCorpus(loadCorpus());
    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.versionChanges).toBe(2);
    expect(result.checks).toBe(28);
  });

  it('fails when a version change drops an edit that is not recorded as retired (control)', () => {
    const corpus = loadCorpus();
    const result = runEditRegressionCorpus({ ...corpus, retired: [] });
    expect(result.passed).toBe(false);
    expect(result.failures.map((f) => [f.kind, f.detail])).toEqual([
      ['dropped-edit', 'MUE|mue-97110|M1|97110 fires under MUE-2026Q3 but not MUE-2026Q4'],
    ]);
  });

  it('fails when a new pack version silently loses an NCCI pair (control)', () => {
    const corpus = loadCorpus();
    const q1: RulePack = {
      packId: 'NCCI-2027Q1',
      family: 'NCCI',
      version: '2027Q1',
      effectiveOn: '2027-01-01',
      edits: [
        {
          editId: 'ptp-3',
          code: '93000',
          column2Code: '93005',
          modifierIndicator: '0',
          maxUnits: null,
        },
      ],
    };
    const baselines = [
      ...corpus.baselines,
      ...corpus.cases.map((c) => ({
        packId: q1.packId,
        caseId: c.caseId,
        edits: applyRulePack(
          q1,
          c.lines.map((x) => ({ ...x, serviceDate: q1.effectiveOn })),
        ).map(editIdentity),
      })),
    ];
    const result = runEditRegressionCorpus({ ...corpus, packs: [...corpus.packs, q1], baselines });
    expect(result.failures.map((f) => f.detail)).toEqual([
      'NCCI|ptp-1|L2|80048 fires under NCCI-2026Q4 but not NCCI-2027Q1',
    ]);
  });

  it('fails when a stored baseline no longer matches, or is missing (control)', () => {
    const corpus = loadCorpus();
    const tampered = corpus.baselines.map((b) =>
      b.packId === 'LCD-NCD-v1' && b.caseId === 'case-lcd' ? { ...b, edits: [] } : b,
    );
    expect(
      runEditRegressionCorpus({ ...corpus, baselines: tampered }).failures.map((f) => f.kind),
    ).toEqual(['baseline-mismatch']);
    const missing = corpus.baselines.filter(
      (b) => !(b.packId === 'LCD-NCD-v1' && b.caseId === 'case-lcd'),
    );
    expect(
      runEditRegressionCorpus({ ...corpus, baselines: missing }).failures.map((f) => f.kind),
    ).toEqual(['baseline-missing']);
  });
});

import { describe, expect, it } from 'vitest';

import { applyRulePack, regressRulePack, type ClaimLine, type RulePack } from './edit-library.js';

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

describe('WP-084 edit library', () => {
  it('cites the rule-pack version on NCCI, MUE, and LCD/NCD edits', () => {
    const ncci = applyRulePack(
      pack('NCCI', '2026Q3', [{ editId: 'ncci-1', code: '99213', maxUnits: null }]),
      [line],
    );
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
    const baseline = applyRulePack(
      pack('NCCI', '2026Q3', [{ editId: 'ncci-1', code: '99213', maxUnits: null }]),
      [line],
    );
    const candidate = applyRulePack(pack('NCCI', '2026Q4', []), [line]);
    const same = regressRulePack(baseline, baseline);
    const dropped = regressRulePack(baseline, candidate);
    expect(same.passed).toBe(true);
    expect(dropped.passed).toBe(false);
    expect(dropped.dropped.map((edit) => edit.editId)).toEqual(['ncci-1']);
  });
});

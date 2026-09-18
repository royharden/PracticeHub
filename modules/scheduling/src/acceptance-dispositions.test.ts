import { describe, expect, it } from 'vitest';

import {
  WP040_ACCEPTANCE_DISPOSITIONS,
  WP040_CLAUSE_DISPOSITIONS,
  WP040_INC2_CLAUSE_DISPOSITIONS,
} from './acceptance-dispositions.js';

describe('WP-040 acceptance disposition ledger', () => {
  it('covers every assigned requirement and keeps real provider parity blocked', () => {
    const expected = [
      'REQ-SCH-001',
      'REQ-SCH-002',
      'REQ-SCH-003',
      'REQ-SCH-006',
      'REQ-SCH-007',
      'REQ-SCH-015',
      'REQ-SCH-017',
      'REQ-SCH-018',
      'REQ-SCH-019',
      'REQ-SCH-020',
      'REQ-SCH-021',
      'REQ-SCH-022',
      'REQ-SCH-028',
      'REQ-SCH-031',
      'REQ-SCH-038',
      'REQ-SCH-042',
    ];
    expect(WP040_ACCEPTANCE_DISPOSITIONS.map(({ requirement }) => requirement)).toEqual(expected);
    expect(WP040_ACCEPTANCE_DISPOSITIONS.at(-1)).toMatchObject({
      requirement: 'REQ-SCH-042',
      disposition: 'blocked',
    });
  });

  it('freezes an explicit disposition for every assigned AC and EX clause', () => {
    const expectedCount = 4 + 4 + 4 + 7 + 9 + 10 + 6 + 6 + 5 + 4 + 4 + 4 + 12 + 12 + 5 + 6;
    expect(WP040_CLAUSE_DISPOSITIONS).toHaveLength(expectedCount);
    expect(new Set(WP040_CLAUSE_DISPOSITIONS.map(({ clause }) => clause)).size).toBe(expectedCount);
    expect(WP040_CLAUSE_DISPOSITIONS.every(({ evidence }) => evidence.length > 0)).toBe(true);
  });

  it('records increment-2 encodings without rewriting increment-1 rows', () => {
    expect(
      WP040_INC2_CLAUSE_DISPOSITIONS.every(({ disposition }) => disposition === 'encoded'),
    ).toBe(true);
    expect(WP040_INC2_CLAUSE_DISPOSITIONS.some(({ clause }) => clause === 'REQ-SCH-001.AC1')).toBe(
      true,
    );
    expect(WP040_INC2_CLAUSE_DISPOSITIONS.some(({ clause }) => clause === 'REQ-SCH-015.AC6')).toBe(
      false,
    );
  });
});

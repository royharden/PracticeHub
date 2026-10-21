import { describe, expect, it } from 'vitest';

import {
  CARC_ROUTES,
  DENIAL_QUEUES,
  routeCarcRarc,
  type CarcGroup,
  type DenialQueueId,
} from './carc.js';

function one(code: string, group: CarcGroup = 'CO', rarcs: readonly string[] = []): DenialQueueId {
  return routeCarcRarc([{ group, code, amountMinor: 10_000 }], rarcs).queue;
}

describe('WP-088 CARC/RARC routing', () => {
  it.each([
    ['50', 'medical-necessity'],
    ['197', 'authorization'],
    ['27', 'eligibility-coverage'],
    ['11', 'coding-review'],
    ['97', 'bundling'],
    ['29', 'timely-filing'],
    ['18', 'duplicate'],
    ['16', 'documentation'],
  ] as const)('CO-%s routes to %s', (code, queue) => {
    expect(one(code)).toBe(queue);
  });

  it('routes every mapped CARC to a known queue', () => {
    for (const queue of Object.values(CARC_ROUTES)) {
      expect(DENIAL_QUEUES).toContain(queue);
    }
    expect(Object.keys(CARC_ROUTES).length).toBeGreaterThan(20);
  });

  it('sends PR deductible/coinsurance/copay to patient responsibility, but not a CO-group 2', () => {
    expect(one('1', 'PR')).toBe('patient-responsibility');
    expect(one('3', 'PR')).toBe('patient-responsibility');
    expect(one('2', 'CO')).toBe('general-review');
  });

  it('routes an unknown CARC to general-review instead of dropping it', () => {
    const routing = routeCarcRarc([{ group: 'OA', code: '999', amountMinor: 500 }], []);
    expect(routing.queue).toBe('general-review');
    expect(routing.trace).toBe('OA-999 unmapped -> general-review');
  });

  it('lets a RARC refine a generic CARC but never overrule a specific one', () => {
    const refined = routeCarcRarc([{ group: 'CO', code: '16', amountMinor: 500 }], ['N54']);
    expect(refined.queue).toBe('authorization');
    expect(refined.refinedBy).toBe('N54');
    expect(one('999', 'OA', ['M127'])).toBe('documentation');
    const specific = routeCarcRarc([{ group: 'CO', code: '50', amountMinor: 500 }], ['N54']);
    expect(specific.queue).toBe('medical-necessity');
    expect(specific.refinedBy).toBeNull();
  });

  it('decides by the largest adjustment, first listed on a tie', () => {
    const routing = routeCarcRarc(
      [
        { group: 'CO', code: '97', amountMinor: 2_000 },
        { group: 'CO', code: '50', amountMinor: 9_000 },
        { group: 'CO', code: '197', amountMinor: 9_000 },
      ],
      [],
    );
    expect(routing.decidingCarc).toBe('50');
    expect(routing.queue).toBe('medical-necessity');
  });

  it('refuses empty adjustments, malformed codes and negative amounts', () => {
    expect(() => routeCarcRarc([], [])).toThrow(/at least one CARC/);
    expect(() => routeCarcRarc([{ group: 'CO', code: 'fifty', amountMinor: 1 }], [])).toThrow(
      /not a reason code/,
    );
    expect(() => routeCarcRarc([{ group: 'CO', code: '50', amountMinor: -1 }], [])).toThrow(
      /non-negative/,
    );
    expect(() => routeCarcRarc([{ group: 'CO', code: '50', amountMinor: 1 }], ['X12'])).toThrow(
      /not a remark code/,
    );
  });
});

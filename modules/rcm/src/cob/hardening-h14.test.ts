import { describe, expect, it } from 'vitest';

import { coverage, episode } from './fixtures.test-support.js';
import { deriveCobOrder } from './order.js';

describe('WP-094 hardening H-14 (NR-159): duplicate-payer counts only coverages in the order', () => {
  it('an excluded coverage does not collide with a billed coverage of the same payer', () => {
    const billed = coverage('shared', 'commercial');
    const unrelatedLiability = coverage('liab', 'liability', { payerId: billed.payerId });
    const order = deriveCobOrder(
      episode([billed, unrelatedLiability], { accidentRelated: false }),
      null,
    );
    expect(order.payers.map((payer) => payer.coverageId)).toEqual([billed.coverageId]);
    expect(order.blocking.map((finding) => finding.flag)).not.toContain('duplicate-payer');
  });

  it('two included coverages with one payer are still flagged', () => {
    const first = coverage('shared', 'commercial');
    const second = coverage('shared-2', 'retiree-ghp', { payerId: first.payerId });
    const order = deriveCobOrder(episode([first, second]), null);
    expect(order.blocking.map((finding) => finding.flag)).toContain('duplicate-payer');
  });
});

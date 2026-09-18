import { describe, expect, it } from 'vitest';

import { SecurityPrepThreatModel, ThreatModelError } from './threat-model.js';

describe('EW-SEC-01 threat pack', () => {
  it('consumes WP-010 tenancy model without rewriting it', () => {
    const model = new SecurityPrepThreatModel();
    const row = model.consumeWp010TenancyModel();
    expect(row.disposition).toBe('consumed');
    expect(row.ownerWorkPackage).toBe('WP-010');
    expect(row.mitigation).toContain('tenancy-partition-threat-model.md');
    expect(model.list()).toHaveLength(1);
  });

  it('rejects duplicate threat ids and an empty pack list', () => {
    const model = new SecurityPrepThreatModel();
    expect(() => model.list()).toThrowError(new ThreatModelError('EMPTY_PACK'));
    model.consumeWp010TenancyModel();
    expect(() => model.consumeWp010TenancyModel()).toThrowError(
      new ThreatModelError('DUPLICATE_ID'),
    );
  });
});

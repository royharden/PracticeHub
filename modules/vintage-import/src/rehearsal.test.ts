import { describe, expect, it } from 'vitest';

import { checksumBytes, VintageImportRehearsal } from './rehearsal.js';
import { Wp052MembershipDoubleV1 } from './testing/wp052-membership-double-v1.js';
import { Wp110WorkbenchDoubleV1 } from './testing/wp110-workbench-double-v1.js';
import { VintageImportError } from './types.js';

const northwind = 'northwind-synthetic';
const riverbend = 'riverbend-synthetic';
const bytes = new TextEncoder().encode('{"cohort":"c1","priceMinor":19900}');
const good = checksumBytes(bytes);

const row = {
  recordRef: 'rec-1',
  memberRef: 'person-opaque-1',
  vintageId: 'vin-1',
  offerRef: 'offer-concierge-v1',
  cohortRef: 'c1',
  priceMinor: 19900,
  currency: 'USD',
} as const;

const cohort = {
  cohortRef: 'c1',
  offerRef: 'offer-concierge-v1',
  priceMinor: 19900,
  currency: 'USD',
} as const;

const make = (
  tenantId = northwind,
): {
  rehearsal: VintageImportRehearsal;
  membership: Wp052MembershipDoubleV1;
} => {
  const membership = new Wp052MembershipDoubleV1();
  const rehearsal = new VintageImportRehearsal(tenantId, new Wp110WorkbenchDoubleV1(), membership);
  return { rehearsal, membership };
};

describe('VintageImportRehearsal', () => {
  it('applies a clean vintage cohort then rolls the rehearsal batch back', () => {
    const { rehearsal, membership } = make();
    rehearsal.freezeBaseline(bytes, good);
    rehearsal.addCohort(cohort);
    rehearsal.addRow(row);
    expect(rehearsal.detect()).toEqual([]);
    expect(rehearsal.applyRehearsal('batch-1')).toBe(1);
    expect(membership.snapshot()[0]?.rolledBack).toBe(false);
    expect(rehearsal.rollbackBatch('batch-1')).toBe(1);
    expect(membership.snapshot()[0]?.rolledBack).toBe(true);
  });

  it('blocks apply when the frozen baseline checksum does not match', () => {
    const { rehearsal } = make();
    rehearsal.freezeBaseline(bytes, '0'.repeat(64));
    rehearsal.addCohort(cohort);
    rehearsal.addRow(row);
    expect(rehearsal.detect().map((finding) => finding.code)).toEqual(['CORRUPTED_BASELINE']);
    expect(() => rehearsal.applyRehearsal('batch-1')).toThrow(VintageImportError);
  });

  it('detects cohort price drift without writing membership', () => {
    const { rehearsal, membership } = make();
    rehearsal.freezeBaseline(bytes, good);
    rehearsal.addCohort(cohort);
    rehearsal.addRow({ ...row, priceMinor: 1 });
    expect(rehearsal.detect().map((finding) => finding.code)).toEqual(['COHORT_PRICE_DRIFT']);
    expect(() => rehearsal.applyRehearsal('batch-1')).toThrow('APPLY_BLOCKED');
    expect(membership.snapshot()).toEqual([]);
  });

  it('detects a missing member or vintage key', () => {
    const { rehearsal } = make();
    rehearsal.freezeBaseline(bytes, good);
    rehearsal.addCohort(cohort);
    rehearsal.addRow({ ...row, memberRef: '' });
    expect(rehearsal.detect()[0]?.code).toBe('MISSING_KEY');
  });

  it('refuses detect before a baseline is frozen', () => {
    const { rehearsal } = make();
    expect(() => rehearsal.detect()).toThrow('BASELINE_REQUIRED');
  });

  it('isolates tenants that share batch refs', () => {
    const nw = make(northwind);
    const rb = make(riverbend);
    for (const pack of [nw, rb]) {
      pack.rehearsal.freezeBaseline(bytes, good);
      pack.rehearsal.addCohort(cohort);
      pack.rehearsal.addRow(row);
      pack.rehearsal.applyRehearsal('batch-1');
    }
    expect(nw.rehearsal.rollbackBatch('batch-1')).toBe(1);
    expect(nw.membership.snapshot()[0]?.rolledBack).toBe(true);
    expect(rb.membership.snapshot()[0]?.rolledBack).toBe(false);
  });
});

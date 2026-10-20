/**
 * WP-095 rework 1 regressions (review D46-WP-095-a1-review-1). This file calls
 * only the landed `reportDoubleBills` (charges simply gain a `tenantId` field), so
 * it can be run against the landed bytes to show both report findings failing there.
 */
import { describe, expect, it } from 'vitest';

import { reportDoubleBills, type ChargeFact } from './oig-execution.js';

const charge = (overrides: Partial<ChargeFact> & { chargeId: string }): ChargeFact => ({
  patientRef: 'patient-riley',
  serviceRef: 'svc-ecg',
  serviceDate: '2026-03-02',
  amountMinor: 9000,
  rail: 'insurance',
  ...overrides,
});

const ids = (findings: readonly { chargeIds: readonly string[] }[]) =>
  findings.map((finding) => [...finding.chargeIds]);

describe('[medium] same-rail duplicates are reported (review P3)', () => {
  it('reports two insurance charges for the same patient, service and date', () => {
    const findings = reportDoubleBills([
      charge({ chargeId: 'ins-1' }),
      charge({ chargeId: 'ins-2' }),
    ]);
    expect(ids(findings)).toEqual([['ins-1', 'ins-2']]);
  });

  it('reports a service billed on all three rails once, with every charge', () => {
    const findings = reportDoubleBills([
      charge({ chargeId: 'a', rail: 'insurance' }),
      charge({ chargeId: 'b', rail: 'membership' }),
      charge({ chargeId: 'c', rail: 'cash' }),
      charge({ chargeId: 'd', rail: 'cash' }),
    ]);
    expect(ids(findings)).toEqual([['a', 'b', 'c', 'd']]);
  });
});

describe('[medium] the report is scoped to one tenant', () => {
  it('never pairs identical refs from two tenants into one finding', () => {
    let findings: readonly { chargeIds: readonly string[] }[] = [];
    try {
      findings = reportDoubleBills([
        charge({ chargeId: 'nw-1', tenantId: 'northwind-synthetic', rail: 'insurance' }),
        charge({ chargeId: 'rb-1', tenantId: 'riverbend-synthetic', rail: 'membership' }),
      ]);
    } catch (error) {
      expect((error as Error).message).toBe('MIXED_TENANTS');
    }
    expect(ids(findings)).toEqual([]);
  });
});

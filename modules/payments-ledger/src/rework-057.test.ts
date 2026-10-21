/**
 * WP-057 rework 1 regressions (review D46-WP-057-a1-review-1). The IC-3 block
 * imports only symbols from the landed commit (2390dd1), so it can be run
 * against the landed bytes to show it failing there.
 */
import type { CapabilityGrant, CapabilityId, CapabilityState } from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import { issueStatement, type GuarantorTerm } from './statements.js';

const grant = (
  capabilityId: CapabilityId,
  state: CapabilityState,
  evidenceRefs: readonly string[] = ['synthetic-evidence-0001'],
): CapabilityGrant => ({
  capabilityId,
  tenantId: 'northwind-synthetic',
  scope: {},
  state,
  sinceEventId: null,
  evidenceRefs,
  rollbackRef: 'rollback-synthetic',
  synthetic: true,
});

const guarantors: readonly GuarantorTerm[] = [
  { version: 1, effectiveOn: '2026-01-01', guarantorRef: 'guarantor-alex' },
];

const statement = (grants: readonly CapabilityGrant[]) =>
  issueStatement({
    grants,
    tenantId: 'northwind-synthetic',
    accountRef: 'acct-1',
    statementId: 'stmt-ic3',
    issueOn: '2026-05-01',
    guarantors,
  });

describe('[medium] IC-3 applies to the statement path (review P4)', () => {
  it('refuses a statement when billing authority is missing, although entitlement evidence is present', () => {
    expect(() => statement([grant('membership.entitlement-ledger', 'simulated')])).toThrowError(
      'BILLING_AUTHORITY_DENIED',
    );
  });

  it('refuses a statement when billing authority is below simulated', () => {
    expect(() =>
      statement([
        grant('membership.entitlement-ledger', 'simulated'),
        grant('finance.billing-authority', 'scaffolded'),
      ]),
    ).toThrowError('BILLING_AUTHORITY_DENIED');
  });

  it('issues when both entitlement evidence and simulated billing authority are present', () => {
    expect(
      statement([
        grant('membership.entitlement-ledger', 'simulated'),
        grant('finance.billing-authority', 'simulated'),
      ]).guarantorRef,
    ).toBe('guarantor-alex');
  });
});

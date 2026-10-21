/**
 * WP-070 hardening H-25 (review D49-WP-070-a2-review-2 R2, R3, R4).
 * R2 and R3 fail on candidates/D54-WP-070-a3; R4 covers a branch that already
 * worked there (a coverage gap, not a regression).
 */
import { describe, expect, it } from 'vitest';

import * as crm from './index.js';
import {
  linkSplitToMergeCase,
  openGovernedIdentitySplit,
  resolveIdentitySplit,
} from './identity-split.js';
import type { IdentityReadPort, Wp016MergeCasePort } from './ports.js';

const tenant = 'tenant-synthetic-h25';
const identity: IdentityReadPort = {
  read: (tenantId, personId) =>
    tenantId === tenant && ['person-1', 'person-2'].includes(personId)
      ? ({ tenantId, personId } as never)
      : undefined,
};
type CaseStatus =
  'open' | 'resolved-linked' | 'resolved-distinct' | 'resolved-merged' | 'dismissed';
const cases = (status: CaseStatus, personIds = ['person-1', 'person-2']): Wp016MergeCasePort => ({
  get: (tenantId, caseId) =>
    tenantId === tenant && caseId === 'case-1'
      ? { caseId, tenantId, status, personIds }
      : undefined,
});
const split = () =>
  openGovernedIdentitySplit(
    { splitId: 'split-1', tenantId: tenant, leftPersonId: 'person-1', rightPersonId: 'person-2' },
    identity,
  );

describe('R2: the unscoped constructors are not public', () => {
  it('does not export openLead or openIdentitySplit; the identity-checked ones remain', () => {
    expect('openLead' in crm).toBe(false);
    expect('openIdentitySplit' in crm).toBe(false);
    expect(typeof crm.openLeadForIdentity).toBe('function');
    expect(typeof crm.openGovernedIdentitySplit).toBe('function');
  });
});

describe('R3: dismissed and resolved-linked cases end the split', () => {
  it('a dismissed case resolves the split as distinct', () => {
    const linked = linkSplitToMergeCase(split(), 'case-1', cases('open'));
    const resolved = resolveIdentitySplit(linked, cases('dismissed'), 'staff-1');
    expect(resolved.status).toBe('resolved-distinct');
    expect(resolved.resolvedBy).toBe('staff-1');
  });

  it('a resolved-linked case resolves the split as linked', () => {
    const linked = linkSplitToMergeCase(split(), 'case-1', cases('open'));
    expect(resolveIdentitySplit(linked, cases('resolved-linked'), 'staff-1').status).toBe(
      'resolved-linked',
    );
  });

  it('an open case still leaves the split open', () => {
    const linked = linkSplitToMergeCase(split(), 'case-1', cases('open'));
    expect(() => resolveIdentitySplit(linked, cases('open'), 'staff-1')).toThrow(/stays open/);
  });
});

describe('R4: a merge case in the tenant that covers only one person is refused', () => {
  it('refuses to link a case that does not cover both split persons', () => {
    expect(() =>
      linkSplitToMergeCase(split(), 'case-1', cases('open', ['person-1', 'person-9'])),
    ).toThrow(/does not cover both split persons/);
  });
});

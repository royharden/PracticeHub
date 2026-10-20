/**
 * WP-097 rework 1 regressions (review D55-WP-097-a1-review-1, by D50).
 * Each test fails on the attempt-1 bundle and passes on attempt 2.
 */
import { describe, expect, it } from 'vitest';

import {
  actOnChdRequest,
  appealChdDecision,
  chdMarketingAllowed,
  chdSaleAllowed,
  decideChdAppeal,
  submitChdRequest,
  verifyChdRequester,
  type DataInventoryItem,
  type ProcessorPort,
} from './chd-request.js';
import {
  ConsumerRightsError,
  type EncountersReadPort,
  type MembershipView,
  type OpenClinicalItem,
} from './contracts.js';
import { placeholderIdentity, placeholderMembership } from './placeholders.js';
import { cancelMembership, resolveRenewalPolicy, shouldAutoRenew } from './renewal.js';
import {
  approveTermination,
  assignChecklistItem,
  buildContinuityChecklist,
  closeTermination,
  proposeTermination,
  recordNotice,
  recordUrgentRiskDisposition,
  resolveChecklistItem,
  reviewEscalation,
  type TerminationCase,
} from './termination.js';

const tenant = 'northwind-synthetic';
const otherTenant = 'riverbend-synthetic';
const patient = 'synthetic-patient-0501';
const t0 = '2026-05-04T15:00:00.000Z';
const at = (days: number): string => new Date(Date.parse(t0) + days * 86_400_000).toISOString();

function code(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof ConsumerRightsError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
}

/* ---------------------------------------------------------------- termination */

function mutableEncounters(): EncountersReadPort & { items: OpenClinicalItem[] } {
  const items: OpenClinicalItem[] = [];
  return {
    packageId: 'M14-encounters',
    items,
    openItems(tenantId: string, patientRef: string) {
      return tenantId === tenant && patientRef === patient ? items : [];
    },
  };
}

const noMembership = placeholderMembership([]);

function noticedCase(encounters: EncountersReadPort, delivered = true): TerminationCase {
  const proposed = proposeTermination({
    terminationId: 'term-r1',
    tenantId: tenant,
    patientRef: patient,
    clinicianId: 'synthetic-physician-1',
    jurisdiction: 'NV',
    reason: 'documented relationship breakdown',
    noticeMethod: 'mail-and-portal',
    coverageDays: 30,
    at: t0,
  });
  const approved = approveTermination(proposed, {
    approverId: 'synthetic-physician-2',
    approverRole: 'physician',
    nondiscriminationChecked: true,
    suspectedDiscriminationOrRetaliation: false,
    at: at(1),
  });
  return recordNotice(
    buildContinuityChecklist(approved, encounters, noMembership),
    delivered,
    at(2),
  );
}

function finishAll(termination: TerminationCase): TerminationCase {
  let next = termination;
  for (const item of next.checklist) {
    next = assignChecklistItem(next, item.itemId, 'synthetic-nurse-1');
    next = resolveChecklistItem(next, item.itemId, 'completed', `evidence:${item.itemId}`);
  }
  return recordUrgentRiskDisposition(next, 'no urgent need', at(3));
}

describe('[required F1] work opened during the coverage window is checked at closure', () => {
  it('refuses to close when a critical medication appears after the checklist was built', () => {
    const encounters = mutableEncounters();
    const termination = finishAll(noticedCase(encounters));
    encounters.items.push({
      itemRef: 'med-new-anticoag',
      kind: 'high-risk-medication',
      description: 'synthetic anticoagulant started in the window',
      critical: true,
    });
    const result = closeTermination(termination, at(40), {
      encounters,
      membership: noMembership,
    });
    expect(result.state).toBe('escalated');
    expect(result.blockers).toContain('med-new-anticoag: critical item unresolved');
    expect(result.checklist.map((item) => item.itemId)).toContain('med-new-anticoag');
  });

  it('keeps owners and outcomes when the checklist is refreshed', () => {
    const encounters = mutableEncounters();
    const finished = finishAll(noticedCase(encounters));
    encounters.items.push({
      itemRef: 'msg-new',
      kind: 'open-message',
      description: 'new',
      critical: false,
    });
    const refreshed = buildContinuityChecklist(finished, encounters, noMembership);
    const records = refreshed.checklist.find((item) => item.kind === 'records-transfer-access');
    expect(records?.outcome).toBe('completed');
    expect(refreshed.checklist.find((item) => item.itemId === 'msg-new')?.ownerId).toBeNull();
  });
});

describe('[required F2] an escalated termination has a resolution path', () => {
  it('escalates, is returned by an attributed review, resolves and closes', () => {
    const encounters = mutableEncounters();
    encounters.items.push({
      itemRef: 'med-crit',
      kind: 'high-risk-medication',
      description: 'x',
      critical: true,
    });
    let termination = noticedCase(encounters);
    termination = recordUrgentRiskDisposition(termination, 'no urgent need', at(3));
    termination = closeTermination(termination, at(40), { encounters, membership: noMembership });
    expect(termination.state).toBe('escalated');
    expect(
      code(() =>
        reviewEscalation(termination, {
          reviewerId: '',
          reviewerRole: 'physician',
          decision: 'return',
          reason: 'x',
          at: at(41),
        }),
      ),
    ).toBe('TERMINATION_REVIEW');
    termination = reviewEscalation(termination, {
      reviewerId: 'synthetic-physician-3',
      reviewerRole: 'physician',
      decision: 'return',
      reason: 'anticoagulant transferred to receiving PCP',
      at: at(41),
    });
    expect(termination.state).toBe('noticed');
    termination = finishAll(termination);
    const closed = closeTermination(termination, at(42), { encounters, membership: noMembership });
    expect(closed.state).toBe('closed');
  });

  it('sends a failed-notice case back for a new notice, and can reject a case', () => {
    const encounters = mutableEncounters();
    let termination = finishAll(noticedCase(encounters, false));
    termination = closeTermination(termination, at(40), { encounters, membership: noMembership });
    expect(termination.state).toBe('escalated');
    const returned = reviewEscalation(termination, {
      reviewerId: 'synthetic-compliance-1',
      reviewerRole: 'compliance',
      decision: 'return',
      reason: 'resend by certified mail',
      at: at(41),
    });
    expect(returned.state).toBe('approved');
    expect(returned.notice).toBeNull();
    expect(recordNotice(returned, true, at(42)).state).toBe('noticed');
    const rejected = reviewEscalation(termination, {
      reviewerId: 'synthetic-compliance-1',
      reviewerRole: 'compliance',
      decision: 'reject',
      reason: 'termination withdrawn',
      at: at(41),
    });
    expect(rejected.state).toBe('rejected');
  });
});

/* ---------------------------------------------------------------- CHD requests */

const identity = placeholderIdentity([
  { tenantId: tenant, personRef: 'person-a', outcome: 'verified' },
]);

const item = (itemRef: string, processor: string): DataInventoryItem => ({
  itemRef,
  dataClass: 'chd',
  purpose: 'marketing quiz',
  processor,
  consentRef: 'optin',
  sharedWith: [],
  sold: false,
  retentionBasis: 'none',
});

function verifiedDeletion(requestId = 'req-r1') {
  return verifyChdRequester(
    submitChdRequest({
      requestId,
      tenantId: tenant,
      personRef: 'person-a',
      kind: 'deletion',
      at: t0,
    }),
    identity,
    'ev',
    at(1),
    'privacy-officer-1',
  );
}

function port(processor: string, deleted: string[], failOn: string[] = []): ProcessorPort {
  return {
    processor,
    deleteCopy(itemRef: string) {
      if (failOn.includes(itemRef)) return { receiptRef: `fail:${itemRef}`, deleted: false };
      deleted.push(itemRef);
      return { receiptRef: `ok:${itemRef}`, deleted: true };
    },
  };
}

describe('[required F3] a late CHD request is fulfilled and the breach recorded', () => {
  it('deletes after the deadline and records an owned response-overdue exception', () => {
    const deleted: string[] = [];
    const late = actOnChdRequest(
      verifiedDeletion(),
      [item('i1', 'crm')],
      [port('crm', deleted)],
      at(50),
      'privacy-officer-1',
    );
    expect(late.state).toBe('fulfilled');
    expect(deleted).toEqual(['i1']);
    expect(late.exceptions[0]).toMatchObject({
      kind: 'response-overdue',
      owner: 'privacy-officer-1',
      daysLate: 5,
    });
  });

  it('decides a late appeal and records appeal-overdue', () => {
    const fulfilled = actOnChdRequest(verifiedDeletion(), [], [], at(2), 'privacy-officer-1');
    const appealed = appealChdDecision(fulfilled, 'grounds', at(3));
    const decided = decideChdAppeal(appealed, 'upheld', 'privacy-officer-1', at(60));
    expect(decided.state).toBe('appeal-upheld');
    expect(decided.exceptions.map((e) => e.kind)).toEqual(['appeal-overdue']);
  });
});

describe('[required F4] a CHD deletion never partly runs without evidence', () => {
  it('deletes nothing when any needed processor port is missing', () => {
    const deleted: string[] = [];
    expect(
      code(() =>
        actOnChdRequest(
          verifiedDeletion(),
          [item('i1', 'crm'), item('i2', 'ads')],
          [port('crm', deleted)],
          at(2),
          'privacy-officer-1',
        ),
      ),
    ).toBe('CHD_PROCESSOR');
    expect(deleted).toEqual([]);
  });

  it('keeps receipts on a processor failure, owns the failure, and a retry skips deleted copies', () => {
    const deleted: string[] = [];
    const inventory = [item('i1', 'crm'), item('i2', 'ads')];
    const partial = actOnChdRequest(
      verifiedDeletion(),
      inventory,
      [port('crm', deleted), port('ads', deleted, ['i2'])],
      at(2),
      'privacy-officer-1',
    );
    expect(partial.state).toBe('partial');
    expect(partial.decision?.receipts.map((r) => [r.itemRef, r.deleted])).toEqual([
      ['i1', true],
      ['i2', false],
    ]);
    expect(partial.exceptions.map((e) => e.kind)).toEqual(['processor-failure']);
    const retried = actOnChdRequest(
      partial,
      inventory,
      [port('crm', deleted), port('ads', deleted)],
      at(3),
      'privacy-officer-1',
    );
    expect(retried.state).toBe('fulfilled');
    expect(deleted).toEqual(['i1', 'i2']);
    expect(retried.decision?.receipts.map((r) => r.itemRef)).toEqual(['i1', 'i2']);
  });
});

describe('[required F5] sale authorization and marketing block are tenant-scoped', () => {
  it('an authorization in one tenant never authorizes a sale in another', () => {
    const auth = {
      tenantId: tenant,
      personRef: 'person-a',
      purchaser: 'buyer',
      written: true,
      signedAt: t0,
      expiresAt: at(365),
      bundledWith: [] as string[],
      revokedAt: null,
    };
    expect(chdSaleAllowed([auth], tenant, 'person-a', 'buyer', at(1))).toBe(true);
    expect(chdSaleAllowed([auth], otherTenant, 'person-a', 'buyer', at(1))).toBe(false);
  });

  it('a deletion request in one tenant does not block marketing for a same-ref person elsewhere', () => {
    const request = submitChdRequest({
      requestId: 'r',
      tenantId: tenant,
      personRef: 'person-a',
      kind: 'deletion',
      at: t0,
    });
    expect(chdMarketingAllowed([request], tenant, 'person-a')).toBe(false);
    expect(chdMarketingAllowed([request], otherTenant, 'person-a')).toBe(true);
  });
});

/* ---------------------------------------------------------------- renewal note */

const member: MembershipView = {
  packageId: 'WP-052',
  tenantId: tenant,
  membershipId: 'mem-1',
  personRef: 'person-a',
  status: 'active',
  renewalDate: '2026-12-01T00:00:00.000Z',
  termMonths: 12,
  priceMinor: 250_000,
  stateOfRecord: 'NV',
  priorStateOfRecord: null,
  vintageRef: 'v-2026',
};

describe('[note F6] renewal needs a sent notice and tenant-scoped cancellations', () => {
  const policy = resolveRenewalPolicy(member);
  const renewalDay = '2026-12-01T00:00:00.000Z';

  it('holds a renewal when no notice went out inside the window', () => {
    expect(shouldAutoRenew(member, [], renewalDay, [], policy)).toBe(false);
    const tooEarly = [
      { tenantId: tenant, membershipId: 'mem-1', sentAt: '2026-09-01T00:00:00.000Z' },
    ];
    expect(shouldAutoRenew(member, [], renewalDay, tooEarly, policy)).toBe(false);
    const inWindow = [
      { tenantId: tenant, membershipId: 'mem-1', sentAt: '2026-11-01T00:00:00.000Z' },
    ];
    expect(shouldAutoRenew(member, [], renewalDay, inWindow, policy)).toBe(true);
  });

  it('a cancellation in another tenant does not stop this renewal', () => {
    const inWindow = [
      { tenantId: tenant, membershipId: 'mem-1', sentAt: '2026-11-01T00:00:00.000Z' },
    ];
    const elsewhere = {
      ...cancelMembership(
        { ...member, tenantId: otherTenant },
        { at: '2026-06-01T00:00:00.000Z', immediate: false, openBalanceMinor: 0, exitReason: null },
        policy,
      ),
    };
    expect(shouldAutoRenew(member, [elsewhere], renewalDay, inWindow, policy)).toBe(true);
  });
});

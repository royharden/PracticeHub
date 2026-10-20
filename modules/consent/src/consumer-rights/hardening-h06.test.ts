/**
 * WP-097 hardening H-06 (notes register NR-170, NR-171, NR-172). Each regression
 * test fails on the accepted candidate D55-WP-097-a2 and passes after the fix.
 */
import { describe, expect, it } from 'vitest';

import {
  actOnChdRequest,
  submitChdRequest,
  verifyChdRequester,
  type DataInventoryItem,
  type ProcessorPort,
} from './chd-request.js';
import {
  ConsumerRightsError,
  type EncountersReadPort,
  type OpenClinicalItem,
} from './contracts.js';
import { placeholderIdentity, placeholderMembership } from './placeholders.js';
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
const patient = 'synthetic-patient-0601';
const t0 = '2026-05-04T15:00:00.000Z';
const at = (days: number): string => new Date(Date.parse(t0) + days * 86_400_000).toISOString();
const noMembership = placeholderMembership([]);

function code(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof ConsumerRightsError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
}

function proposed(): TerminationCase {
  return proposeTermination({
    terminationId: 'term-h06',
    tenantId: tenant,
    patientRef: patient,
    clinicianId: 'synthetic-physician-1',
    jurisdiction: 'NV',
    reason: 'documented relationship breakdown',
    noticeMethod: 'mail-and-portal',
    coverageDays: 30,
    at: t0,
  });
}

function discriminationEscalation(): TerminationCase {
  return approveTermination(proposed(), {
    approverId: 'synthetic-physician-2',
    approverRole: 'physician',
    nondiscriminationChecked: true,
    suspectedDiscriminationOrRetaliation: true,
    at: at(1),
  });
}

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

describe('[NR-170] a suspected-discrimination escalation is reviewed independently', () => {
  it('refuses the proposing clinician as reviewer of its own escalation', () => {
    const escalated = discriminationEscalation();
    expect(escalated.state).toBe('escalated');
    expect(
      code(() =>
        reviewEscalation(escalated, {
          reviewerId: 'synthetic-physician-1',
          reviewerRole: 'compliance',
          decision: 'return',
          reason: 'reason reviewed, not discriminatory',
          at: at(2),
        }),
      ),
    ).toBe('TERMINATION_REVIEWER');
  });

  it('refuses an independent physician or APP: only a clinical lead or compliance reviews it', () => {
    const escalated = discriminationEscalation();
    for (const reviewerRole of ['physician', 'app'] as const) {
      expect(
        code(() =>
          reviewEscalation(escalated, {
            reviewerId: 'synthetic-physician-9',
            reviewerRole,
            decision: 'return',
            reason: 'x',
            at: at(2),
          }),
        ),
        reviewerRole,
      ).toBe('TERMINATION_REVIEWER');
    }
  });

  it('an independent clinical lead may return it and compliance may reject it', () => {
    const escalated = discriminationEscalation();
    const returned = reviewEscalation(escalated, {
      reviewerId: 'synthetic-clinical-lead-1',
      reviewerRole: 'clinical-lead',
      decision: 'return',
      reason: 'reason reviewed; documented non-discriminatory basis',
      at: at(2),
    });
    expect(returned.state).toBe('proposed');
    expect(returned.events.at(-1)?.detail).toContain('clinical-lead synthetic-clinical-lead-1');
    const rejected = reviewEscalation(escalated, {
      reviewerId: 'synthetic-compliance-1',
      reviewerRole: 'compliance',
      decision: 'reject',
      reason: 'retaliatory timing; termination withdrawn',
      at: at(2),
    });
    expect(rejected.state).toBe('rejected');
  });

  it('refuses the approver as reviewer of an escalation on the case it approved', () => {
    const encounters = mutableEncounters();
    encounters.items.push({
      itemRef: 'med-crit',
      kind: 'high-risk-medication',
      description: 'x',
      critical: true,
    });
    const approved = approveTermination(proposed(), {
      approverId: 'synthetic-physician-2',
      approverRole: 'physician',
      nondiscriminationChecked: true,
      suspectedDiscriminationOrRetaliation: false,
      at: at(1),
    });
    let termination = recordNotice(
      buildContinuityChecklist(approved, encounters, noMembership),
      true,
      at(2),
    );
    termination = recordUrgentRiskDisposition(termination, 'no urgent need', at(3));
    termination = closeTermination(termination, at(40), { encounters, membership: noMembership });
    expect(termination.state).toBe('escalated');
    expect(
      code(() =>
        reviewEscalation(termination, {
          reviewerId: 'synthetic-physician-2',
          reviewerRole: 'physician',
          decision: 'return',
          reason: 'x',
          at: at(41),
        }),
      ),
    ).toBe('TERMINATION_REVIEWER');
  });
});

describe('[NR-171] an item that turns critical after the checklist was built escalates', () => {
  function readyToClose(encounters: EncountersReadPort & { items: OpenClinicalItem[] }) {
    encounters.items.push({
      itemRef: 'lab-pending',
      kind: 'pending-result',
      description: 'synthetic result pending',
      critical: false,
    });
    const approved = approveTermination(proposed(), {
      approverId: 'synthetic-physician-2',
      approverRole: 'physician',
      nondiscriminationChecked: true,
      suspectedDiscriminationOrRetaliation: false,
      at: at(1),
    });
    let termination = recordNotice(
      buildContinuityChecklist(approved, encounters, noMembership),
      true,
      at(2),
    );
    for (const item of termination.checklist) {
      termination = assignChecklistItem(termination, item.itemId, 'synthetic-nurse-1');
      if (item.itemId !== 'lab-pending') {
        termination = resolveChecklistItem(termination, item.itemId, 'completed', 'ev');
      }
    }
    return recordUrgentRiskDisposition(termination, 'no urgent need', at(3));
  }

  it('closure escalates, it does not merely refuse, when a listed item became critical', () => {
    const encounters = mutableEncounters();
    const termination = readyToClose(encounters);
    const listed = encounters.items[0];
    if (listed === undefined) throw new Error('no listed item');
    encounters.items[0] = { ...listed, critical: true };
    const result = closeTermination(termination, at(40), { encounters, membership: noMembership });
    expect(result.state).toBe('escalated');
    expect(result.blockers).toEqual(['lab-pending: critical item unresolved']);
    expect(result.checklist.find((item) => item.itemId === 'lab-pending')).toMatchObject({
      critical: true,
      ownerId: 'synthetic-nurse-1',
    });
  });

  it('criticality never drops on a refresh', () => {
    const encounters = mutableEncounters();
    encounters.items.push({
      itemRef: 'med-crit',
      kind: 'high-risk-medication',
      description: 'x',
      critical: true,
    });
    const approved = approveTermination(proposed(), {
      approverId: 'synthetic-physician-2',
      approverRole: 'physician',
      nondiscriminationChecked: true,
      suspectedDiscriminationOrRetaliation: false,
      at: at(1),
    });
    const built = buildContinuityChecklist(approved, encounters, noMembership);
    encounters.items[0] = { ...(encounters.items[0] as OpenClinicalItem), critical: false };
    const refreshed = buildContinuityChecklist(built, encounters, noMembership);
    expect(refreshed.checklist.find((item) => item.itemId === 'med-crit')?.critical).toBe(true);
  });
});

describe('[NR-172] a late partial CHD deletion owns one response-overdue exception', () => {
  const identity = placeholderIdentity([
    { tenantId: tenant, personRef: 'person-h06', outcome: 'verified' },
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
  const port = (processor: string, failOn: readonly string[] = []): ProcessorPort => ({
    processor,
    deleteCopy(itemRef: string) {
      return failOn.includes(itemRef)
        ? { receiptRef: `fail:${itemRef}`, deleted: false }
        : { receiptRef: `ok:${itemRef}`, deleted: true };
    },
  });

  it('late retries keep one response-overdue and still own every processor failure', () => {
    const verified = verifyChdRequester(
      submitChdRequest({
        requestId: 'req-h06',
        tenantId: tenant,
        personRef: 'person-h06',
        kind: 'deletion',
        at: t0,
      }),
      identity,
      'ev',
      at(1),
      'privacy-officer-1',
    );
    const inventory = [item('i1', 'crm'), item('i2', 'ads')];
    let request = actOnChdRequest(
      verified,
      inventory,
      [port('crm'), port('ads', ['i2'])],
      at(50),
      'privacy-officer-1',
    );
    request = actOnChdRequest(
      request,
      inventory,
      [port('crm'), port('ads', ['i2'])],
      at(51),
      'privacy-officer-1',
    );
    request = actOnChdRequest(
      request,
      inventory,
      [port('crm'), port('ads')],
      at(52),
      'privacy-officer-1',
    );
    expect(request.state).toBe('fulfilled');
    expect(request.exceptions.map((exception) => exception.kind)).toEqual([
      'response-overdue',
      'processor-failure',
      'processor-failure',
    ]);
    expect(request.exceptions[0]).toMatchObject({ daysLate: 5, owner: 'privacy-officer-1' });
  });
});

import { describe, expect, it } from 'vitest';

import { ConsumerRightsError } from './contracts.js';
import { placeholderEncounters, placeholderMembership } from './placeholders.js';
import {
  approveTermination,
  assignChecklistItem,
  buildContinuityChecklist,
  closeTermination,
  proposeTermination,
  recordNotice,
  recordUrgentRiskDisposition,
  resolveChecklistItem,
  reverseTermination,
  terminationBlockers,
  type ChecklistKind,
  type TerminalOutcome,
  type TerminationCase,
} from './termination.js';

const tenant = 'northwind-synthetic';
const patient = 'synthetic-patient-0301';
const t0 = '2026-04-01T15:00:00.000Z';
const at = (days: number): string => new Date(Date.parse(t0) + days * 86_400_000).toISOString();

const encounters = placeholderEncounters([
  {
    tenantId: tenant,
    patientRef: patient,
    items: [
      {
        itemRef: 'med-anticoag',
        kind: 'high-risk-medication',
        description: 'synthetic anticoagulant',
        critical: true,
      },
      {
        itemRef: 'lab-a1c',
        kind: 'pending-result',
        description: 'synthetic A1c pending',
        critical: false,
      },
      {
        itemRef: 'ref-cards',
        kind: 'referral',
        description: 'synthetic cardiology referral',
        critical: false,
      },
      {
        itemRef: 'visit-f/u',
        kind: 'scheduled-care',
        description: 'synthetic follow-up visit',
        critical: false,
      },
      {
        itemRef: 'msg-open',
        kind: 'open-message',
        description: 'synthetic open portal thread',
        critical: false,
      },
    ],
  },
]);

const membership = placeholderMembership([
  {
    packageId: 'WP-052',
    tenantId: tenant,
    membershipId: 'synthetic-membership-0301',
    personRef: patient,
    status: 'active',
    renewalDate: '2026-12-01T00:00:00.000Z',
    termMonths: 12,
    priceMinor: 250_000,
    stateOfRecord: 'NV',
    priorStateOfRecord: null,
    vintageRef: 'synthetic-vintage-2026',
  },
]);

const ports = { encounters, membership };

function approved(): TerminationCase {
  const proposed = proposeTermination({
    terminationId: 'term-1',
    tenantId: tenant,
    patientRef: patient,
    clinicianId: 'synthetic-physician-1',
    jurisdiction: 'NV',
    reason: 'repeated missed visits after documented outreach',
    noticeMethod: 'mail-and-portal',
    coverageDays: 30,
    at: t0,
  });
  return approveTermination(proposed, {
    approverId: 'synthetic-physician-2',
    approverRole: 'physician',
    nondiscriminationChecked: true,
    suspectedDiscriminationOrRetaliation: false,
    at: at(1),
  });
}

function code(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof ConsumerRightsError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
}

describe('termination continuity checklist', () => {
  it('builds one owned, terminal item per open clinical item, records access and membership', () => {
    const termination = buildContinuityChecklist(approved(), encounters, membership);
    expect(termination.checklist.map((item) => item.kind)).toEqual([
      'high-risk-medication',
      'pending-result',
      'referral',
      'scheduled-care',
      'open-message',
      'records-transfer-access',
      'membership-billing',
    ]);
    expect(
      termination.checklist.every((item) => item.ownerId === null && item.outcome === null),
    ).toBe(true);
  });

  it('closes only after notice, coverage, urgent-risk disposition and every item owned and terminal', () => {
    let termination = recordNotice(
      buildContinuityChecklist(approved(), encounters, membership),
      true,
      at(2),
    );
    expect(code(() => closeTermination(termination, at(40), ports))).toBe('NO_ERROR');
    expect(closeTermination(termination, at(40), ports).state).toBe('escalated');

    for (const item of termination.checklist) {
      termination = assignChecklistItem(termination, item.itemId, 'synthetic-nurse-1');
    }
    const outcomes: Record<ChecklistKind, TerminalOutcome> = {
      'high-risk-medication': 'transferred-accepted',
      order: 'completed',
      'pending-result': 'completed',
      referral: 'transferred-accepted',
      'scheduled-care': 'cancelled-with-notice',
      'open-message': 'completed',
      'records-transfer-access': 'completed',
      'membership-billing': 'completed',
    };
    for (const item of termination.checklist) {
      termination = resolveChecklistItem(
        termination,
        item.itemId,
        outcomes[item.kind],
        `evidence:${item.itemId}`,
      );
    }
    expect(terminationBlockers(termination, at(20))).toEqual([
      'coverage window has not elapsed',
      'urgent-risk disposition not recorded',
    ]);
    expect(code(() => closeTermination(termination, at(20), ports))).toBe('TERMINATION_BLOCKED');
    termination = recordUrgentRiskDisposition(
      termination,
      'no urgent need; receiving PCP accepted',
      at(25),
    );
    const closed = closeTermination(termination, at(31), ports);
    expect(closed.state).toBe('closed');
    expect(closed.events.at(-1)?.kind).toBe('closed');
  });

  it('escalates on an unresolved critical item or a failed notice', () => {
    let termination = buildContinuityChecklist(approved(), encounters, membership);
    termination = recordNotice(termination, false, at(2));
    termination = recordUrgentRiskDisposition(termination, 'none', at(3));
    const escalated = closeTermination(termination, at(40), ports);
    expect(escalated.state).toBe('escalated');
    expect(escalated.blockers).toContain('notice delivery failed');
    expect(escalated.blockers).toContain('med-anticoag: critical item unresolved');
  });

  it('requires a physician or APP, the nondiscrimination check and a lawful coverage window', () => {
    const proposed = proposeTermination({
      terminationId: 'term-2',
      tenantId: tenant,
      patientRef: patient,
      clinicianId: 'synthetic-physician-1',
      jurisdiction: 'MN',
      reason: 'relationship breakdown',
      noticeMethod: 'mail',
      coverageDays: 30,
      at: t0,
    });
    const approval = {
      approverId: 'synthetic-staff-1',
      approverRole: 'staff' as const,
      nondiscriminationChecked: true,
      suspectedDiscriminationOrRetaliation: false,
      at: at(1),
    };
    expect(code(() => approveTermination(proposed, approval))).toBe('TERMINATION_APPROVER');
    expect(
      code(() =>
        approveTermination(proposed, {
          ...approval,
          approverRole: 'app',
          nondiscriminationChecked: false,
        }),
      ),
    ).toBe('TERMINATION_NONDISCRIMINATION');
    expect(
      approveTermination(proposed, {
        ...approval,
        approverRole: 'app',
        suspectedDiscriminationOrRetaliation: true,
      }).state,
    ).toBe('escalated');
    expect(
      code(() =>
        proposeTermination({
          terminationId: 'term-3',
          tenantId: tenant,
          patientRef: patient,
          clinicianId: 'synthetic-physician-1',
          jurisdiction: 'NV',
          reason: 'reason',
          noticeMethod: 'mail',
          coverageDays: 10,
          at: t0,
        }),
      ),
    ).toBe('TERMINATION_COVERAGE');
  });

  it('reverses a mistaken termination and lists the interval events to reconcile', () => {
    const noticed = recordNotice(
      buildContinuityChecklist(approved(), encounters, membership),
      true,
      at(2),
    );
    const { termination, toReconcile } = reverseTermination(
      noticed,
      'synthetic-physician-2',
      at(5),
    );
    expect(termination.state).toBe('reversed');
    expect(toReconcile.map((event) => event.kind)).toEqual(['approved', 'notice-delivered']);
  });
});

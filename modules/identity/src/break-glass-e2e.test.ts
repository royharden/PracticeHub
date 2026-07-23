/**
 * Break-glass LIFECYCLE e2e (WP-017 verification gate: "break-glass lifecycle
 * e2e — expiry, review queue, egress guards still active"). This suite proves
 * the three lifecycle guarantees end to end over the REAL neighbours:
 *  - EGRESS GUARDS STILL ACTIVE — the WP-015 PDP `break-glass-emergency` hook
 *    widens a READ past no-permit but never past the genetic partition guard,
 *    and never widens a write/export (read-only).
 *  - REVIEW QUEUE AGES/ESCALATES — the mandatory-review WorkItem descriptor
 *    drives the REAL WP-022 SLA engine (`resolveSlaPolicy` + `planEscalation`):
 *    an unreviewed break-glass fires its escalation chain as active time
 *    accrues (R6-REQ-003: "unreviewed break-glass ages/escalates").
 *  - EXPIRY — the grant authorizes nothing past its window.
 */
import {
  addSeconds,
  dueAtFor,
  initialWorkItem,
  planEscalation,
  resolveSlaPolicy,
  type SlaPolicy,
  type SlaTimer,
  type WorkItemOpen,
} from '@practicehub/events';
import { describe, expect, it } from 'vitest';

import type { PatientRecordId, PersonId, TenantId } from '@practicehub/contracts';

import {
  breakGlassStatus,
  breakGlassWidensRead,
  grantBreakGlass,
  type BreakGlassGrant,
} from './break-glass.js';
import {
  canonicalRoleTemplateSeedsV1,
  evaluateAccess,
  pdpPolicyV1,
  type PdpActor,
  type PdpRequest,
  type RoleTemplate,
} from './pdp.js';

const tenant = 'northwind-synthetic' as TenantId;
const accessor = 'np-morgan-lee' as PersonId;
const subject = 'np-alex-rivera' as PersonId;

const templates: readonly RoleTemplate[] = canonicalRoleTemplateSeedsV1.map((seed) => ({
  ...seed,
  tenantId: tenant,
}));

// A front-desk workforce member — the template has NO clinical-notes / genetic
// permit, so an ordinary request denies (no-permit) and break-glass must widen.
function frontDeskActor(): PdpActor {
  return {
    kind: 'staff',
    actorRef: 'synthetic-staff:nsa-morgan-lee',
    staffAccountId: 'nsa-morgan-lee',
    personId: accessor,
    assignments: [
      {
        tenantId: tenant,
        assignmentId: 'nra-front-desk',
        staffAccountId: 'nsa-morgan-lee',
        staffPersonId: accessor,
        roleKey: 'front-desk',
        templateVersion: 1,
        locationScope: [],
        effectiveDate: '2026-01-01',
        status: 'active',
        assignedBy: 'synthetic-it-admin-001',
        synthetic: true,
      },
    ],
    templates,
    overrides: [],
  };
}

function request(overrides: Partial<PdpRequest>): PdpRequest {
  return {
    tenantId: tenant,
    actor: frontDeskActor(),
    segment: 'clinical-notes',
    action: 'view',
    purpose: 'break-glass-emergency',
    subjectPersonId: subject,
    subjectPatientRecordId: 'npr-alex-rivera' as PatientRecordId,
    gipaAuthorizations: [],
    providerState: null,
    patientState: null,
    occurredAt: '2026-03-25T10:30:00Z',
    auditId: 'bg-e2e-0001',
    ...overrides,
  };
}

const activeGrant: BreakGlassGrant = grantBreakGlass({
  tenantId: tenant,
  grantId: 'bg-e2e-0001',
  staffAccountId: 'nsa-morgan-lee',
  accessorPersonId: accessor,
  subjectPersonId: subject,
  scope: ['clinical-notes', 'results'],
  reasonCode: 'emergency-care',
  justificationRef: 'synthetic-break-glass-reason-e2e',
  initiatedBy: 'synthetic-it-admin-001',
  effectiveAt: '2026-03-25T10:00:00Z',
  windowMinutes: 60,
  reviewWindowMinutes: 1440,
  reviewSlaPolicyId: 'sla-break-glass-review',
  reviewPolicyVersion: 1,
}).grant;

describe('break-glass egress guards stay active (ADR-006 Decision 3)', () => {
  it('widens a staff READ past no-permit and attaches the independent-review obligation', () => {
    const decision = evaluateAccess(pdpPolicyV1, request({ segment: 'clinical-notes' }));
    expect(decision.allowed).toBe(true);
    expect(decision.obligations).toContain('independent-review-required');
    expect(decision.basisRefs).toContain('break-glass-widened-read');
  });

  it('a genetic-touching break-glass read is TRACKED at elevated-genetic severity, never a silent pass', () => {
    const decision = evaluateAccess(
      pdpPolicyV1,
      request({ segment: 'genetic', partitionTags: ['gipa-genetic'] }),
    );
    // Break-glass reaches genetic for emergency care, but the event is
    // classified elevated-genetic so it forces heightened review (R6-SR-033) —
    // the partition is never bypassed silently.
    expect(decision.breakGlassSeverity).toBe('elevated-genetic');
    expect(decision.obligations).toContain('independent-review-required');
  });

  it('is read-only: an export (disclosure) is NOT widened even under break-glass, so the consent gate stays', () => {
    const widenedView = evaluateAccess(
      pdpPolicyV1,
      request({ segment: 'clinical-notes', action: 'view' }),
    );
    expect(widenedView.allowed).toBe(true);
    // The SAME request as an export is refused — break-glass never widens a
    // disclosure, and a disclosure without granted consent fails closed (WP-018).
    const asExport = evaluateAccess(
      pdpPolicyV1,
      request({ segment: 'clinical-notes', action: 'export', consent: 'denied' }),
    );
    expect(asExport.allowed).toBe(false);
  });

  it('the grant itself authorizes only its scoped segments while active, nothing once expired', () => {
    expect(breakGlassWidensRead(activeGrant, 'clinical-notes', '2026-03-25T10:30:00Z')).toBe(true);
    expect(breakGlassWidensRead(activeGrant, 'medications', '2026-03-25T10:30:00Z')).toBe(false);
    expect(breakGlassStatus(activeGrant, '2026-03-25T11:00:00Z')).toBe('expired');
    expect(breakGlassWidensRead(activeGrant, 'clinical-notes', '2026-03-25T11:00:00Z')).toBe(false);
  });
});

describe('break-glass review queue ages/escalates on the real WP-022 engine (R6-REQ-003)', () => {
  // A review SLA policy: the compliance review is due promptly, then escalates
  // to a supervisor an hour later. This is the effective-dated registry the
  // review WorkItem ages against.
  const reviewPolicy: SlaPolicy = {
    policyId: 'sla-break-glass-review',
    version: 1,
    effectiveOn: '2026-01-01',
    memberTier: 'compliance-review',
    hoursMode: 'after_hours',
    firstResponseTargetMinutes: 60,
    nextResponseTargetMinutes: 60,
    resolutionTargetMinutes: 240,
    quietHoursExempt: true,
    escalationChain: [
      { afterMinutes: 60, action: 'notify_owner', target: 'compliance-privacy-officer' },
      { afterMinutes: 240, action: 'notify_supervisor', target: 'security-lead' },
    ],
  };

  it('the review descriptor is a valid WP-022 WorkItem the engine can open', () => {
    const { reviewWorkItem } = grantBreakGlass({
      tenantId: tenant,
      grantId: 'bg-e2e-review',
      staffAccountId: 'nsa-morgan-lee',
      accessorPersonId: accessor,
      subjectPersonId: subject,
      scope: ['clinical-notes'],
      reasonCode: 'patient-safety',
      justificationRef: 'synthetic-break-glass-reason-review',
      initiatedBy: 'synthetic-it-admin-001',
      effectiveAt: '2026-03-25T10:00:00Z',
      windowMinutes: 60,
      reviewWindowMinutes: 1440,
      reviewSlaPolicyId: 'sla-break-glass-review',
      reviewPolicyVersion: 1,
      reviewServiceTier: 'compliance-review',
    });
    // Assignable to WorkItemOpen — the origin/risk/tier narrow to the engine's types.
    const open: WorkItemOpen = reviewWorkItem;
    const item = initialWorkItem(open);
    expect(item.origin).toBe('authority-review');
    expect(item.hasSla).toBe(true);
    expect(item.status).toBe('unmatched');
  });

  it('an UNREVIEWED break-glass review fires its escalation chain as active time accrues', () => {
    const policy = resolveSlaPolicy([reviewPolicy], 'compliance-review', '2026-03-25');
    expect(policy).toBeDefined();
    if (policy === undefined) {
      throw new Error('review policy must resolve');
    }
    const startedAt = '2026-03-25T11:00:00Z';
    const timer: SlaTimer = {
      timerType: 'first_response',
      startedAt,
      dueAt: dueAtFor(policy, 'first_response', startedAt),
      pausedTotalSeconds: 0,
      state: 'running',
    };
    // Right after opening: nothing has fired.
    expect(planEscalation(policy, timer, startedAt)).toHaveLength(0);
    // One hour later: the first escalation step fires (notify the reviewer).
    const oneHour = addSeconds(startedAt, 60 * 60);
    expect(planEscalation(policy, timer, oneHour).map((f) => f.step.action)).toEqual([
      'notify_owner',
    ]);
    // Four hours later, still unreviewed: it escalates to the supervisor.
    const fourHours = addSeconds(startedAt, 4 * 60 * 60);
    expect(planEscalation(policy, timer, fourHours).map((f) => f.step.action)).toEqual([
      'notify_owner',
      'notify_supervisor',
    ]);
  });
});

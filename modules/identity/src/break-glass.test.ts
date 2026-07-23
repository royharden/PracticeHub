/**
 * Break-glass grant/review unit suite (WP-017, REQ-ID-001 / REQ-ADM-017 /
 * R6-REQ-003). The grant is read-only + auto-expiring + reason-captured by
 * construction; the review is independent (separation of duties). Every audit
 * input is emitted through the REAL WP-020 store so an invalid input cannot
 * pass.
 */
import { emitAuditEvent, emptyChainState, type AuditEmitInput } from '@practicehub/audit-evidence';
import { describe, expect, it } from 'vitest';

import type { PersonId, TenantId } from '@practicehub/contracts';

import {
  breakGlassStatus,
  breakGlassWidensRead,
  completeBreakGlassReview,
  grantBreakGlass,
  type BreakGlassGrantRequest,
} from './break-glass.js';

const tenant = 'northwind-synthetic' as TenantId;
const accessor = 'np-morgan-lee' as PersonId;
const subject = 'np-alex-rivera' as PersonId;

function baseRequest(overrides: Partial<BreakGlassGrantRequest> = {}): BreakGlassGrantRequest {
  return {
    tenantId: tenant,
    grantId: 'bg-0001',
    staffAccountId: 'nsa-morgan-lee',
    accessorPersonId: accessor,
    subjectPersonId: subject,
    scope: ['clinical-notes', 'results'],
    reasonCode: 'emergency-care',
    justificationRef: 'synthetic-break-glass-reason-0001',
    initiatedBy: 'synthetic-it-admin-001',
    effectiveAt: '2026-03-25T10:00:00Z',
    windowMinutes: 60,
    reviewWindowMinutes: 1440,
    ...overrides,
  };
}

describe('grantBreakGlass', () => {
  it('captures the reason, sets auto-expiry, and is born with the independent-review obligation', () => {
    const outcome = grantBreakGlass(baseRequest());
    expect(outcome.grant.reasonCode).toBe('emergency-care');
    expect(outcome.grant.justificationRef).toBe('synthetic-break-glass-reason-0001');
    expect(outcome.grant.expiresAt).toBe('2026-03-25T11:00:00Z');
    expect(outcome.grant.reviewDueAt).toBe('2026-03-26T11:00:00Z');
    expect(outcome.obligations).toEqual(['independent-review-required']);
    expect(outcome.reviewWorkItem.origin).toBe('authority-review');
    expect(outcome.reviewWorkItem.responseDueAt).toBe(outcome.grant.reviewDueAt);
  });

  it('emits a valid break-glass audit record (subject + reason) through the real store', () => {
    const outcome = grantBreakGlass(baseRequest());
    const emitted = emitAuditEvent(emptyChainState, outcome.auditInput as AuditEmitInput);
    expect(emitted.record.stream).toBe('break-glass');
    expect(emitted.record.reason).toBe('break-glass-emergency');
    expect(emitted.record.subjectRef).toBe('person:np-alex-rivera');
  });

  it('classifies a genetic-touching elevation as elevated-genetic and reviews it at critical risk', () => {
    const outcome = grantBreakGlass(baseRequest({ partitionTags: ['gipa-genetic'] }));
    expect(outcome.grant.severity).toBe('elevated-genetic');
    expect(outcome.reviewWorkItem.risk).toBe('critical');
    expect(outcome.auditInput.partitionTags).toEqual(['gipa-genetic']);
  });

  it('is read-only by construction: the scope carries segments, never actions', () => {
    const outcome = grantBreakGlass(baseRequest());
    // The scope type is `readonly DataSegment[]` — there is no action field to
    // express a write elevation. widensRead is view-only widening.
    expect(breakGlassWidensRead(outcome.grant, 'clinical-notes', '2026-03-25T10:30:00Z')).toBe(
      true,
    );
    expect(breakGlassWidensRead(outcome.grant, 'medications', '2026-03-25T10:30:00Z')).toBe(false);
  });

  it('auto-expires: it authorizes nothing at or after the expiry instant', () => {
    const { grant } = grantBreakGlass(baseRequest());
    expect(breakGlassStatus(grant, '2026-03-25T10:59:59Z')).toBe('active');
    expect(breakGlassStatus(grant, '2026-03-25T11:00:00Z')).toBe('expired');
    expect(breakGlassWidensRead(grant, 'results', '2026-03-25T11:00:00Z')).toBe(false);
  });

  it('fails closed on an empty scope, a missing justification, or a non-positive window', () => {
    expect(() => grantBreakGlass(baseRequest({ scope: [] }))).toThrow(/at least one read segment/);
    expect(() => grantBreakGlass(baseRequest({ justificationRef: '' }))).toThrow(
      /justificationRef/,
    );
    expect(() => grantBreakGlass(baseRequest({ windowMinutes: 0 }))).toThrow(/positive integer/);
  });
});

describe('completeBreakGlassReview', () => {
  const { grant } = grantBreakGlass(baseRequest());

  it('records an independent review and emits a valid break-glass review record', () => {
    const outcome = completeBreakGlassReview(grant, {
      reviewId: 'bgr-0001',
      reviewerPersonId: 'np-jordan-kim' as PersonId,
      reviewerRole: 'compliance-privacy-officer',
      outcome: 'access-appropriate',
      evidenceRef: 'synthetic-review-evidence-0001',
      occurredAt: '2026-03-26T09:00:00Z',
    });
    expect(outcome.review.outcome).toBe('access-appropriate');
    expect(outcome.escalation).toBeNull();
    const emitted = emitAuditEvent(emptyChainState, outcome.auditInput as AuditEmitInput);
    expect(emitted.record.stream).toBe('break-glass');
    expect(emitted.record.reason).toBe('investigation');
  });

  it('fails closed when the reviewer is the accessor (separation of duties)', () => {
    expect(() =>
      completeBreakGlassReview(grant, {
        reviewId: 'bgr-0002',
        reviewerPersonId: accessor,
        reviewerRole: 'it-security-admin',
        outcome: 'access-appropriate',
        evidenceRef: 'synthetic-review-evidence-0002',
        occurredAt: '2026-03-26T09:00:00Z',
      }),
    ).toThrow(/must be independent/);
  });

  it('opens a containment follow-up when the access is judged inappropriate', () => {
    const outcome = completeBreakGlassReview(grant, {
      reviewId: 'bgr-0003',
      reviewerPersonId: 'np-jordan-kim' as PersonId,
      reviewerRole: 'it-security-admin',
      outcome: 'access-inappropriate-escalate',
      evidenceRef: 'synthetic-review-evidence-0003',
      occurredAt: '2026-03-26T09:00:00Z',
    });
    expect(outcome.escalation?.purpose).toBe('break-glass-inappropriate-access-containment');
    expect(outcome.escalation?.poolId).toBe('it-security-admin');
  });
});

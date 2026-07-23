/**
 * Access-recertification workflow unit suite (WP-017, REQ-ADM-018). The cycle
 * runs the WP-015 `runAccessReview` and routes each staff member's findings
 * into a manager attestation WorkItem; a revoke attestation carries the WP-015
 * access-change directive (a review that finds excess access acts, not just
 * notes).
 */
import { emitAuditEvent, emptyChainState, type AuditEmitInput } from '@practicehub/audit-evidence';
import { describe, expect, it } from 'vitest';

import type { PersonId, TenantId } from '@practicehub/contracts';

import {
  recordRecertificationAttestation,
  scheduleAccessRecertification,
  type RecertificationCycleRequest,
} from './access-recertification.js';
import { canonicalRoleTemplateSeedsV1, type RoleAssignment, type RoleTemplate } from './pdp.js';

const tenant = 'northwind-synthetic' as TenantId;

const templates: readonly RoleTemplate[] = canonicalRoleTemplateSeedsV1.map((seed) => ({
  ...seed,
  tenantId: tenant,
}));

const assignment: RoleAssignment = {
  tenantId: tenant,
  assignmentId: 'nra-morgan-front-desk',
  staffAccountId: 'nsa-morgan-lee',
  staffPersonId: 'np-morgan-lee' as PersonId,
  roleKey: 'front-desk',
  templateVersion: 1,
  locationScope: [],
  effectiveDate: '2026-01-01',
  status: 'active',
  assignedBy: 'synthetic-it-admin-001',
  synthetic: true,
};

function baseCycle(
  overrides: Partial<RecertificationCycleRequest> = {},
): RecertificationCycleRequest {
  return {
    tenantId: tenant,
    cycleId: 'recert-2026q1',
    assignments: [assignment],
    templates,
    overrides: [],
    // A grant to medications:edit that the front-desk template does NOT include
    // — a drift finding the recertification must surface.
    actualGrants: [
      {
        staffAccountId: 'nsa-morgan-lee',
        system: 'practicehub',
        segment: 'medications',
        action: 'edit',
      },
    ],
    attestationPoolRef: 'practice-manager-pool',
    openedBy: 'synthetic-it-admin-001',
    asOfDate: '2026-03-25',
    occurredAt: '2026-03-25T12:00:00Z',
    ...overrides,
  };
}

describe('scheduleAccessRecertification (REQ-ADM-018)', () => {
  it('surfaces drift findings and routes each staff member into a manager attestation WorkItem', () => {
    const outcome = scheduleAccessRecertification(baseCycle());
    expect(outcome.cycle.findings.some((f) => f.kind === 'drift-remediation-required')).toBe(true);
    const attestationItem = outcome.attestationQueue.find(
      (item) => item.subjectRef === 'staff-account:nsa-morgan-lee',
    );
    expect(attestationItem?.origin).toBe('authority-review');
    expect(attestationItem?.poolId).toBe('practice-manager-pool');
    const emitted = emitAuditEvent(emptyChainState, outcome.auditInput as AuditEmitInput);
    expect(emitted.record.stream).toBe('config-change');
  });

  it('a clean review queues nothing (a clean cycle is not a failure)', () => {
    const outcome = scheduleAccessRecertification(
      baseCycle({
        // Only grants the front-desk template covers — no drift.
        actualGrants: [
          {
            staffAccountId: 'nsa-morgan-lee',
            system: 'practicehub',
            segment: 'scheduling',
            action: 'view',
          },
        ],
      }),
    );
    expect(outcome.cycle.findings.some((f) => f.kind === 'drift-remediation-required')).toBe(false);
    expect(outcome.attestationQueue).toHaveLength(0);
  });
});

describe('recordRecertificationAttestation (REQ-ADM-018)', () => {
  const grant = {
    staffAccountId: 'nsa-morgan-lee',
    system: 'practicehub',
    segment: 'medications',
    action: 'edit',
  } as const;

  it('a revoke attestation carries the access-change directive and audits', () => {
    const outcome = recordRecertificationAttestation({
      tenantId: tenant,
      attestationId: 'recert-att-0001',
      cycleId: 'recert-2026q1',
      grant,
      attesterPersonId: 'np-taylor-manager',
      attesterRole: 'practice-manager',
      decision: 'revoke',
      evidenceRef: 'synthetic-attestation-evidence-0001',
      reason: 'synthetic drift remediation',
      occurredAt: '2026-03-26T09:00:00Z',
    });
    expect(outcome.attestation.decision).toBe('revoked');
    expect(outcome.accessChangeDirective).toEqual({
      kind: 'revoke-access',
      staffAccountId: 'nsa-morgan-lee',
      segment: 'medications',
      action: 'edit',
    });
    const emitted = emitAuditEvent(emptyChainState, outcome.auditInput as AuditEmitInput);
    expect(emitted.record.stream).toBe('config-change');
  });

  it('a confirm attestation records with no access-change directive', () => {
    const outcome = recordRecertificationAttestation({
      tenantId: tenant,
      attestationId: 'recert-att-0002',
      cycleId: 'recert-2026q1',
      grant,
      attesterPersonId: 'np-taylor-manager',
      attesterRole: 'practice-manager',
      decision: 'confirm',
      evidenceRef: 'synthetic-attestation-evidence-0002',
      reason: 'synthetic confirmed appropriate',
      occurredAt: '2026-03-26T09:00:00Z',
    });
    expect(outcome.attestation.decision).toBe('confirmed');
    expect(outcome.accessChangeDirective).toBeNull();
  });

  it('fails closed without evidence', () => {
    expect(() =>
      recordRecertificationAttestation({
        tenantId: tenant,
        attestationId: 'recert-att-0003',
        cycleId: 'recert-2026q1',
        grant,
        attesterPersonId: 'np-taylor-manager',
        attesterRole: 'practice-manager',
        decision: 'confirm',
        evidenceRef: '',
        reason: 'synthetic',
        occurredAt: '2026-03-26T09:00:00Z',
      }),
    ).toThrow(/evidenceRef/);
  });
});

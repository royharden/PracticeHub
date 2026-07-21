/**
 * PDP gate suites (WP-015): the role × segment × action × purpose TABLE
 * sweep with deny-audit COMPLETENESS through the REAL audit emitter
 * (R6-REQ-002 trace; FWD-AUD-015-PDP), guard behavior, SoD policy data,
 * review evaluation, and the no-stale-permission cache property
 * (FWD-MERGE-015-CACHE + REQ-ID-018 AC-5).
 */
import { emitAuditEvent, emptyChainState, verifyAuditChain } from '@practicehub/audit-evidence';
import { describe, expect, it } from 'vitest';

import type { AuditChainState, AuditEmitInput, AuditRecord } from '@practicehub/audit-evidence';
import type { PersonId, TenantId } from '@practicehub/contracts';

import {
  dataSegments,
  pdpActions,
  purposesOfUse,
  type DataSegment,
  type PdpAction,
  type PurposeOfUse,
} from './access-vocabulary.js';
import type { GuarantorRole } from './identity.js';
import type { MergeEvent } from './merge.js';
import {
  assignRole,
  attestGrant,
  assertSeparationOfDuties,
  canonicalRoleTemplateSeedsV1,
  evaluateAccess,
  evaluateSeparationOfDuties,
  grantAccessOverride,
  pdpInvalidationEpochs,
  pdpPolicyV1,
  readPdpCache,
  runAccessReview,
  sodPairsV1,
  type AccessOverride,
  type PdpActor,
  type PdpRequest,
  type RoleAssignment,
  type RoleTemplate,
} from './pdp.js';
import type { AuthorityRecord } from './proxy-authority.js';

const tenant = 'northwind-synthetic' as TenantId;
const subject = 'np-alex-rivera' as PersonId;
const minor = 'np-casey-rivera' as PersonId;
const occurredAt = '2026-03-25T10:00:00Z';

const templates: readonly RoleTemplate[] = canonicalRoleTemplateSeedsV1.map((seed) => ({
  ...seed,
  tenantId: tenant,
}));

function staffActor(
  roleKey: RoleTemplate['roleKey'],
  overrides: readonly AccessOverride[] = [],
): Extract<PdpActor, { kind: 'staff' }> {
  return {
    kind: 'staff',
    actorRef: `synthetic-staff:nsa-${roleKey}`,
    staffAccountId: `nsa-${roleKey}`,
    personId: 'np-morgan-lee' as PersonId,
    assignments: [
      {
        tenantId: tenant,
        assignmentId: `nra-${roleKey}`,
        staffAccountId: `nsa-${roleKey}`,
        staffPersonId: 'np-morgan-lee' as PersonId,
        roleKey,
        templateVersion: 1,
        locationScope: [],
        effectiveDate: '2026-01-01',
        status: 'active',
        assignedBy: 'synthetic-it-admin-001',
        synthetic: true,
      },
    ],
    templates,
    overrides,
  };
}

function request(partial: Partial<PdpRequest> & Pick<PdpRequest, 'actor'>): PdpRequest {
  return {
    tenantId: tenant,
    segment: 'demographics',
    action: 'view',
    purpose: 'treatment',
    subjectPersonId: subject,
    occurredAt,
    auditId: 'fx-pdp-0001',
    ...partial,
  };
}

const geneticAllowed: readonly PurposeOfUse[] = [
  'treatment',
  'patient-request',
  'legal-obligation',
  'break-glass-emergency',
];

describe('PDP table sweep — role x segment x action x purpose (R6-REQ-002)', () => {
  const roleKeys = canonicalRoleTemplateSeedsV1.map((seed) => seed.roleKey);
  let state: AuditChainState = emptyChainState;
  const records: AuditRecord[] = [];
  let cells = 0;
  let allows = 0;

  it('every cell decides, audits (allow AND deny), and the chain verifies', () => {
    let sequence = 0;
    for (const roleKey of roleKeys) {
      for (const segment of dataSegments) {
        for (const action of pdpActions) {
          for (const purpose of purposesOfUse) {
            sequence += 1;
            cells += 1;
            const decision = evaluateAccess(
              pdpPolicyV1,
              request({
                actor: staffActor(roleKey),
                segment,
                action,
                purpose,
                consent: 'granted',
                auditId: `fx-grid-${String(sequence).padStart(5, '0')}`,
              }),
            );
            // Structural completeness: the audit input exists on EVERY
            // decision and matches its effect — then the REAL emitter
            // accepts it and chains it.
            expect(decision.auditInput.decision).toBe(decision.allowed ? 'allow' : 'deny');
            expect(decision.auditInput.reason).toBe(purpose);
            expect(decision.auditInput.detail['policy_version']).toBe('pdp-policy-v1');
            if (!decision.allowed) {
              expect(decision.auditInput.detail['denial_code']).toBeDefined();
            } else {
              expect(decision.auditInput.detail['basis_ref']).toBeDefined();
              allows += 1;
            }
            const emitted = emitAuditEvent(state, decision.auditInput as AuditEmitInput);
            state = emitted.state;
            records.push(emitted.record);
          }
        }
      }
    }
    expect(cells).toBe(roleKeys.length * dataSegments.length * pdpActions.length * 8);
    expect(records.length).toBe(cells);
    expect(verifyAuditChain(records).valid).toBe(true);
    // Deny-by-default: the sweep denies far more than it allows.
    expect(allows).toBeGreaterThan(0);
    expect(allows).toBeLessThan(cells / 2);
  });

  it('deny-by-default: outside the template permit set only break-glass view widens', () => {
    for (const roleKey of ['it-security-admin', 'employer-sponsor-admin'] as const) {
      for (const segment of dataSegments) {
        for (const action of pdpActions) {
          for (const purpose of purposesOfUse) {
            const decision = evaluateAccess(
              pdpPolicyV1,
              request({
                actor: staffActor(roleKey),
                segment,
                action,
                purpose,
                consent: 'granted',
              }),
            );
            const breakGlassView =
              purpose === 'break-glass-emergency' &&
              action === 'view' &&
              (segment !== 'genetic' || geneticAllowed.includes(purpose));
            if (decision.allowed) {
              expect(breakGlassView).toBe(true);
              expect(decision.obligations).toContain('independent-review-required');
            }
          }
        }
      }
    }
  });

  it('genetic minimum-necessary: purposes outside the clinical set always deny', () => {
    for (const roleKey of ['physician-app', 'compliance-privacy-officer'] as const) {
      for (const purpose of purposesOfUse) {
        if (geneticAllowed.includes(purpose)) {
          continue;
        }
        const decision = evaluateAccess(
          pdpPolicyV1,
          request({ actor: staffActor(roleKey), segment: 'genetic', purpose }),
        );
        expect(decision.allowed).toBe(false);
        expect(decision.denialCodes).toContain('genetic-minimum-necessary');
      }
    }
  });

  it('genetic export requires a valid written authorization at the evaluated instant', () => {
    const base = request({
      actor: staffActor('compliance-privacy-officer'),
      segment: 'genetic',
      action: 'export',
      purpose: 'legal-obligation',
      consent: 'granted',
    });
    const denied = evaluateAccess(pdpPolicyV1, base);
    expect(denied.allowed).toBe(false);
    expect(denied.denialCodes).toContain('gipa-authorization-required');
    const expired = evaluateAccess(pdpPolicyV1, {
      ...base,
      gipaAuthorizations: [
        {
          authorizationId: 'nga-expired',
          tenantId: tenant,
          subjectPersonId: subject,
          scopeRef: 'synthetic-gipa-scope-prior-provider',
          grantedOn: '2025-01-15',
          expiresOn: '2026-01-15',
          writtenEvidenceRef: 'synthetic-gipa-written-0002',
          status: 'active',
          synthetic: true,
        },
      ],
    });
    expect(expired.allowed).toBe(false);
    expect(expired.denialCodes).toContain('gipa-authorization-required');
    const allowed = evaluateAccess(pdpPolicyV1, {
      ...base,
      gipaAuthorizations: [
        {
          authorizationId: 'nga-0001',
          tenantId: tenant,
          subjectPersonId: subject,
          scopeRef: 'synthetic-gipa-scope-life-insurer',
          grantedOn: '2026-02-01',
          expiresOn: '2027-02-01',
          writtenEvidenceRef: 'synthetic-gipa-written-0001',
          status: 'active',
          synthetic: true,
        },
      ],
    });
    expect(allowed.allowed).toBe(true);
    expect(allowed.basisRefs).toContain('gipa-authorization:nga-0001');
  });

  it('anchor rows pin the seeded template semantics', () => {
    const anchors: readonly [
      RoleTemplate['roleKey'],
      DataSegment,
      PdpAction,
      PurposeOfUse,
      boolean,
    ][] = [
      ['front-desk', 'scheduling', 'edit', 'operations', true],
      ['front-desk', 'clinical-notes', 'view', 'treatment', false],
      ['front-desk', 'genetic', 'view', 'treatment', false],
      ['ma-nurse', 'clinical-notes', 'edit', 'treatment', true],
      ['ma-nurse', 'medications', 'edit', 'treatment', false],
      ['physician-app', 'genetic', 'view', 'treatment', true],
      ['physician-app', 'genetic', 'view', 'operations', false],
      ['biller-coder', 'statements', 'edit', 'payment', true],
      ['biller-coder', 'results', 'view', 'payment', false],
      ['practice-manager', 'payment-methods', 'view', 'operations', true],
      ['it-security-admin', 'demographics', 'view', 'operations', false],
      ['employer-sponsor-admin', 'demographics', 'view', 'operations', false],
    ];
    for (const [roleKey, segment, action, purpose, expected] of anchors) {
      const decision = evaluateAccess(
        pdpPolicyV1,
        request({ actor: staffActor(roleKey), segment, action, purpose, consent: 'granted' }),
      );
      expect(decision.allowed, `${roleKey} ${segment} ${action} ${purpose}`).toBe(expected);
    }
  });
});

describe('employer principal — structural exclusion', () => {
  const employer: PdpActor = {
    kind: 'employer-sponsor-admin',
    actorRef: 'synthetic-employer:acme-sponsor',
    legalEntityId: 'northwind-health-nv' as never,
  };

  it('denies every segment x action x purpose; genetic names the structural code', () => {
    for (const segment of dataSegments) {
      for (const action of pdpActions) {
        for (const purpose of purposesOfUse) {
          const decision = evaluateAccess(
            pdpPolicyV1,
            request({ actor: employer, segment, action, purpose, consent: 'granted' }),
          );
          expect(decision.allowed).toBe(false);
          expect(decision.denialCodes).toContain('employer-surface-structural');
          if (segment === 'genetic') {
            expect(decision.denialCodes).toContain('employer-genetic-structural');
          }
        }
      }
    }
  });
});

describe('portal-side principals', () => {
  const guardianAuthority: AuthorityRecord = {
    tenantId: tenant,
    authorityId: 'nar-alex-casey',
    version: 1,
    kind: 'guardian-minor',
    granteePersonId: subject,
    subjectPersonId: minor,
    scope: [
      { segment: 'scheduling', actions: ['view', 'edit'] },
      { segment: 'messaging', actions: ['view', 'edit'] },
      { segment: 'results', actions: ['view'] },
    ],
    jurisdiction: 'NV',
    evidenceRef: 'synthetic-guardian-evidence-0001',
    consentCapturedOn: '2026-01-10',
    effectiveDate: '2026-01-10',
    verifiedBy: 'synthetic-front-desk-001',
    status: 'active',
    decidedBy: 'synthetic-front-desk-001',
    synthetic: true,
  };
  const proxy: PdpActor = {
    kind: 'proxy',
    actorRef: 'synthetic-portal:np-alex-rivera',
    personId: subject,
    authorityRecords: [guardianAuthority],
  };

  it('proxy scope property: every segment x action outside the scope denies', () => {
    for (const segment of dataSegments) {
      for (const action of pdpActions) {
        const inScope = guardianAuthority.scope.some(
          (entry) => entry.segment === segment && entry.actions.includes(action),
        );
        const decision = evaluateAccess(
          pdpPolicyV1,
          request({
            actor: proxy,
            segment,
            action,
            subjectPersonId: minor,
            stepUpSatisfied: true,
            consent: 'granted',
            patientState: 'NV',
          }),
        );
        if (!inScope) {
          expect(decision.allowed, `${segment} ${action}`).toBe(false);
        }
      }
    }
  });

  it('proxy in-scope allows and audits the proxy as the actor (REQ-ID-006 AC-3)', () => {
    const decision = evaluateAccess(
      pdpPolicyV1,
      request({
        actor: proxy,
        segment: 'results',
        action: 'view',
        subjectPersonId: minor,
        stepUpSatisfied: true,
        patientState: 'NV',
      }),
    );
    expect(decision.allowed).toBe(true);
    expect(decision.auditInput.actorRef).toBe('synthetic-portal:np-alex-rivera');
    expect(decision.auditInput.subjectRef).toBe(minor);
    expect(decision.basisRefs).toContain('authority:nar-alex-casey:v1');
  });

  it('an expired authority denies the attempted action and audits it (REQ-ID-008 EX-1)', () => {
    const expired: PdpActor = {
      ...proxy,
      authorityRecords: [{ ...guardianAuthority, expiresOn: '2026-02-01' }],
    };
    const decision = evaluateAccess(
      pdpPolicyV1,
      request({
        actor: expired,
        segment: 'scheduling',
        action: 'view',
        subjectPersonId: minor,
        stepUpSatisfied: true,
      }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.denialCodes).toContain('authority-expired');
    expect(decision.auditInput.decision).toBe('deny');
  });

  it('suspended-majority denies WITH the explanatory code — never silent (REQ-ID-007 AC-9)', () => {
    const suspended: PdpActor = {
      ...proxy,
      authorityRecords: [{ ...guardianAuthority, status: 'suspended-majority' }],
    };
    const decision = evaluateAccess(
      pdpPolicyV1,
      request({
        actor: suspended,
        segment: 'messaging',
        action: 'view',
        subjectPersonId: minor,
        stepUpSatisfied: true,
      }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.denialCodes).toEqual(['majority-transition']);
  });

  it('confidential-adolescent denies proxies without an explicit legal basis (REQ-ID-006 AC-2/EX-2)', () => {
    const withConfidential: PdpActor = {
      ...proxy,
      authorityRecords: [
        {
          ...guardianAuthority,
          scope: [
            ...guardianAuthority.scope,
            { segment: 'confidential-adolescent', actions: ['view'] },
          ],
        },
      ],
    };
    const denied = evaluateAccess(
      pdpPolicyV1,
      request({
        actor: withConfidential,
        segment: 'confidential-adolescent',
        action: 'view',
        subjectPersonId: minor,
        stepUpSatisfied: true,
      }),
    );
    expect(denied.allowed).toBe(false);
    expect(denied.denialCodes).toContain('minor-confidential-protected');
  });

  it('MHRA consent-expiry suspends records scopes while scheduling continues (REQ-ID-008 EX-6)', () => {
    const mnProxy: PdpActor = {
      ...proxy,
      authorityRecords: [
        { ...guardianAuthority, jurisdiction: 'MN', consentCapturedOn: '2025-01-01' },
      ],
    };
    const results = evaluateAccess(
      pdpPolicyV1,
      request({
        actor: mnProxy,
        segment: 'results',
        action: 'view',
        subjectPersonId: minor,
        stepUpSatisfied: true,
        patientState: 'MN',
      }),
    );
    expect(results.allowed).toBe(false);
    expect(results.denialCodes).toContain('records-consent-expired');
    const scheduling = evaluateAccess(
      pdpPolicyV1,
      request({
        actor: mnProxy,
        segment: 'scheduling',
        action: 'view',
        subjectPersonId: minor,
        stepUpSatisfied: true,
        patientState: 'MN',
      }),
    );
    expect(scheduling.allowed).toBe(true);
  });

  it('sensitive views demand step-up for portal principals (FWD-AUTH-015-PDP)', () => {
    const noStepUp = evaluateAccess(
      pdpPolicyV1,
      request({
        actor: proxy,
        segment: 'results',
        action: 'view',
        subjectPersonId: minor,
        patientState: 'NV',
      }),
    );
    expect(noStepUp.allowed).toBe(false);
    expect(noStepUp.denialCodes).toContain('step-up-required');
    expect(noStepUp.obligations).toContain('step-up-required');
    const patient: PdpActor = {
      kind: 'patient',
      actorRef: 'synthetic-portal:np-alex-rivera',
      personId: subject,
    };
    const patientNoStepUp = evaluateAccess(
      pdpPolicyV1,
      request({ actor: patient, segment: 'clinical-notes', action: 'view' }),
    );
    expect(patientNoStepUp.allowed).toBe(false);
    const patientStepped = evaluateAccess(
      pdpPolicyV1,
      request({ actor: patient, segment: 'clinical-notes', action: 'view', stepUpSatisfied: true }),
    );
    expect(patientStepped.allowed).toBe(true);
  });

  it('guarantor: billing yes, clinical never; the dual-role person keeps distinct scopes (REQ-ID-023)', () => {
    const guarantorRole: GuarantorRole = {
      guarantorRoleId: 'ngr-alex-for-casey',
      tenantId: tenant,
      guarantorPersonId: subject,
      patientRecordId: 'npr-casey-rivera' as never,
      scope: ['statements', 'payment-methods'],
      evidenceRef: 'synthetic-guarantor-evidence-0001',
      status: 'active',
      synthetic: true,
    };
    const guarantor: PdpActor = {
      kind: 'guarantor',
      actorRef: 'synthetic-portal:np-alex-rivera',
      personId: subject,
      guarantorRoles: [guarantorRole],
    };
    const statements = evaluateAccess(
      pdpPolicyV1,
      request({
        actor: guarantor,
        segment: 'statements',
        action: 'view',
        subjectPersonId: minor,
        subjectPatientRecordId: 'npr-casey-rivera' as never,
      }),
    );
    expect(statements.allowed).toBe(true);
    const paymentEdit = evaluateAccess(
      pdpPolicyV1,
      request({
        actor: guarantor,
        segment: 'payment-methods',
        action: 'edit',
        subjectPersonId: minor,
        subjectPatientRecordId: 'npr-casey-rivera' as never,
      }),
    );
    expect(paymentEdit.allowed).toBe(true);
    for (const segment of ['clinical-notes', 'results', 'medications', 'messaging'] as const) {
      const decision = evaluateAccess(
        pdpPolicyV1,
        request({
          actor: guarantor,
          segment,
          action: 'view',
          subjectPersonId: minor,
          subjectPatientRecordId: 'npr-casey-rivera' as never,
          stepUpSatisfied: true,
        }),
      );
      expect(decision.allowed, segment).toBe(false);
    }
    // Same person as PROXY reaches scoped clinical results — the two roles
    // never conflate (REQ-ID-023 EX-3).
    const asProxy = evaluateAccess(
      pdpPolicyV1,
      request({
        actor: proxy,
        segment: 'results',
        action: 'view',
        subjectPersonId: minor,
        stepUpSatisfied: true,
        patientState: 'NV',
      }),
    );
    expect(asProxy.allowed).toBe(true);
  });

  it('consent fails closed on disclosures (pdp-api decision 9)', () => {
    const staff = staffActor('compliance-privacy-officer');
    const unavailable = evaluateAccess(
      pdpPolicyV1,
      request({ actor: staff, segment: 'documents', action: 'export', purpose: 'investigation' }),
    );
    expect(unavailable.allowed).toBe(false);
    expect(unavailable.denialCodes).toContain('consent-unavailable');
    const denied = evaluateAccess(
      pdpPolicyV1,
      request({
        actor: staff,
        segment: 'documents',
        action: 'export',
        purpose: 'investigation',
        consent: 'denied',
      }),
    );
    expect(denied.denialCodes).toContain('consent-not-granted');
    const patient: PdpActor = {
      kind: 'patient',
      actorRef: 'synthetic-portal:np-alex-rivera',
      personId: subject,
    };
    const own = evaluateAccess(
      pdpPolicyV1,
      request({
        actor: patient,
        segment: 'documents',
        action: 'export',
        purpose: 'patient-request',
        stepUpSatisfied: true,
      }),
    );
    expect(own.allowed).toBe(true);
  });

  it('deceased chart lock: edits deny; only the unlock roles with a documented estate purpose pass', () => {
    const frontDesk = evaluateAccess(
      pdpPolicyV1,
      request({
        actor: staffActor('front-desk'),
        segment: 'scheduling',
        action: 'edit',
        subjectDeceased: true,
      }),
    );
    expect(frontDesk.allowed).toBe(false);
    expect(frontDesk.denialCodes).toContain('chart-locked-deceased');
    const managerNoUnlock = evaluateAccess(
      pdpPolicyV1,
      request({
        actor: staffActor('practice-manager'),
        segment: 'scheduling',
        action: 'edit',
        purpose: 'legal-obligation',
        subjectDeceased: true,
      }),
    );
    expect(managerNoUnlock.allowed).toBe(false);
    const managerUnlocked = evaluateAccess(
      pdpPolicyV1,
      request({
        actor: staffActor('practice-manager'),
        segment: 'scheduling',
        action: 'edit',
        purpose: 'legal-obligation',
        subjectDeceased: true,
        estateUnlock: {
          unlockRef: 'neu-0001',
          personId: subject,
          unlockedByRole: 'practice-manager',
          documentedPurposeRef: 'synthetic-estate-purpose-0001',
        },
      }),
    );
    expect(managerUnlocked.allowed).toBe(true);
    expect(managerUnlocked.basisRefs).toContain('estate-unlock:neu-0001');
  });
});

describe('role administration (REQ-ID-018)', () => {
  const activeAssignment: RoleAssignment = {
    tenantId: tenant,
    assignmentId: 'nra-0001',
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

  it('assignRole ends every prior active assignment in the same act (EX-4)', () => {
    const { ended, active } = assignRole([activeAssignment], {
      ...activeAssignment,
      assignmentId: 'nra-0002',
      roleKey: 'biller-coder',
    });
    expect(active.roleKey).toBe('biller-coder');
    expect(ended).toHaveLength(1);
    expect(ended[0]?.status).toBe('ended');
    expect(ended[0]?.endedReason).toBe('superseded-by-new-assignment');
  });

  it('an override can never grant the genetic segment (REQ-ID-019 EX-3)', () => {
    expect(() =>
      grantAccessOverride({
        tenantId: tenant,
        overrideId: 'nov-genetic',
        staffAccountId: 'nsa-morgan-lee',
        segment: 'genetic',
        actions: ['view'],
        justification: 'synthetic attempted escape hatch',
        approvedBy: 'synthetic-compliance-officer-001',
        expiresOn: '2026-09-30',
      }),
    ).toThrow('never grant the genetic segment');
  });

  it('an override without justification, approver, or expiry is unrepresentable (AC-8/EX-2)', () => {
    const base = {
      tenantId: tenant,
      overrideId: 'nov-0002',
      staffAccountId: 'nsa-morgan-lee',
      segment: 'documents' as const,
      actions: ['view' as const],
      justification: 'synthetic coverage',
      approvedBy: 'synthetic-compliance-officer-001',
      expiresOn: '2026-09-30',
    };
    expect(() => grantAccessOverride({ ...base, justification: '' })).toThrow('justification');
    expect(() => grantAccessOverride({ ...base, approvedBy: '' })).toThrow('approver');
    expect(() => grantAccessOverride({ ...base, expiresOn: '' })).toThrow('time-boxed');
    expect(grantAccessOverride(base).flaggedForReview).toBe(true);
  });

  it('the review flags drift as required remediation and evaluates the combined footprint', () => {
    const review = runAccessReview({
      tenantId: tenant,
      assignments: [activeAssignment],
      templates,
      overrides: [],
      actualGrants: [
        {
          staffAccountId: 'nsa-morgan-lee',
          system: 'practicehub',
          segment: 'scheduling',
          action: 'edit',
        },
        {
          staffAccountId: 'nsa-morgan-lee',
          system: 'practicehub',
          segment: 'medications',
          action: 'view',
        },
        {
          staffAccountId: 'nsa-morgan-lee',
          system: 'athena-one',
          segment: 'clinical-notes',
          action: 'view',
        },
      ],
      externalRoleDefinitions: [
        {
          system: 'athena-one',
          roleKey: 'front-desk',
          permits: [{ segment: 'clinical-notes', actions: ['view'] }],
        },
      ],
      asOfDate: '2026-03-25',
    });
    const kinds = review.findings.map((finding) => finding.kind);
    expect(kinds).toContain('drift-remediation-required');
    expect(kinds).toContain('combined-footprint');
    expect(kinds).toContain('role-definition-mismatch-reconciliation');
    const drift = review.findings.find((finding) => finding.kind === 'drift-remediation-required');
    expect(drift && 'grant' in drift ? drift.grant.segment : undefined).toBe('medications');
  });

  it('a template version bump re-evaluates pinned assignments on the next review (AC-9)', () => {
    const frontDesk = templates.find((template) => template.roleKey === 'front-desk');
    if (frontDesk === undefined) {
      throw new Error('front-desk template missing from the canonical seeds');
    }
    const v2Templates: readonly RoleTemplate[] = [
      ...templates.map((template) =>
        template.roleKey === 'front-desk'
          ? { ...template, status: 'superseded' as const }
          : template,
      ),
      {
        ...frontDesk,
        version: 2,
        status: 'active',
        changeReason: 'synthetic-tightening',
      },
    ];
    const review = runAccessReview({
      tenantId: tenant,
      assignments: [activeAssignment],
      templates: v2Templates,
      overrides: [],
      actualGrants: [
        {
          staffAccountId: 'nsa-morgan-lee',
          system: 'practicehub',
          segment: 'scheduling',
          action: 'edit',
        },
      ],
      asOfDate: '2026-03-25',
    });
    expect(review.findings.map((finding) => finding.kind)).toContain('template-reevaluation');
  });

  it('attestation revocation triggers an actual access change directive (REQ-ADM-018 AC-3 mechanics)', () => {
    const grant = {
      staffAccountId: 'nsa-morgan-lee',
      system: 'practicehub',
      segment: 'medications',
      action: 'view',
    };
    const revoked = attestGrant(grant, 'revoke', 'synthetic-practice-manager-001', 'drift');
    expect(revoked.attested).toBe('revoked');
    expect('accessChangeDirective' in revoked && revoked.accessChangeDirective.kind).toBe(
      'revoke-access',
    );
    expect(() => attestGrant(grant, 'confirm', '', 'x')).toThrow('logged');
  });
});

describe('separation of duties (ADR-006 Decision 4)', () => {
  it('the draft policy data declares the three pairs pending section-11 graduation', () => {
    expect(sodPairsV1.status).toBe('draft');
    expect(sodPairsV1.pendingRef).toBe('section-11-approval-matrix-graduation');
    expect(sodPairsV1.pairs.map((pair) => pair.sodId)).toEqual([
      'sod-gate-1',
      'sod-act-1',
      'sod-ai-1',
    ]);
  });

  it('a same-actor pair violates; distinct actors comply; unknown pairs refuse', () => {
    expect(
      evaluateSeparationOfDuties(sodPairsV1, 'sod-gate-1', 'synthetic-a', 'synthetic-b').compliant,
    ).toBe(true);
    expect(
      evaluateSeparationOfDuties(sodPairsV1, 'sod-act-1', 'synthetic-a', 'synthetic-a').compliant,
    ).toBe(false);
    expect(() =>
      assertSeparationOfDuties(sodPairsV1, 'sod-ai-1', 'synthetic-a', 'synthetic-a'),
    ).toThrow('cannot be the same actor');
    expect(() =>
      evaluateSeparationOfDuties(sodPairsV1, 'sod-nope', 'synthetic-a', 'synthetic-b'),
    ).toThrow('unknown SoD pair');
  });
});

describe('no stale permission survives (FWD-MERGE-015-CACHE + REQ-ID-018 AC-5)', () => {
  const mergeEvent: MergeEvent = {
    tenantId: tenant,
    eventId: 'nme-9001',
    caseId: 'nmc-9001',
    kind: 'merge',
    survivorPersonId: subject,
    mergedPersonId: 'np-sam-porter-legacy' as PersonId,
    basisAttributes: ['given-name', 'family-name', 'birth-date'],
    decidedBy: 'synthetic-data-migration-001',
    rationale: 'synthetic sweep',
    evidenceRef: 'synthetic-merge-evidence-9001',
    synthetic: true,
  };

  it('a merge event refuses a cached permit written before it', () => {
    const before = pdpInvalidationEpochs([], []);
    const entry = {
      personId: subject,
      epochAtWrite: before.get(subject) ?? 0,
      payloadRef: 'synthetic-permit-cache-0001',
    };
    expect(readPdpCache(before, entry).served).toBe(true);
    const after = pdpInvalidationEpochs([mergeEvent], []);
    const read = readPdpCache(after, entry);
    expect(read.served).toBe(false);
    if (!read.served) {
      expect(read.refused).toBe('stale-identity-cache');
    }
  });

  it('a role change refuses a cached permit the same way (session-level immediacy)', () => {
    const before = pdpInvalidationEpochs([], []);
    const entry = {
      personId: 'np-morgan-lee' as PersonId,
      epochAtWrite: before.get('np-morgan-lee' as PersonId) ?? 0,
      payloadRef: 'synthetic-permit-cache-0002',
    };
    expect(readPdpCache(before, entry).served).toBe(true);
    const after = pdpInvalidationEpochs(
      [],
      [{ eventRef: 'nra-0002-assigned', personIds: ['np-morgan-lee' as PersonId] }],
    );
    expect(readPdpCache(after, entry).served).toBe(false);
  });
});

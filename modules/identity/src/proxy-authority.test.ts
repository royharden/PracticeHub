/**
 * Authority-record lifecycle suites (WP-015; REQ-ID-006/-007/-010/-011/
 * -012/-013/-014/-016 + REQ-ID-023 lifecycle halves).
 */
import { jurisdictionPacksV1 } from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import type { PersonId, TenantId } from '@practicehub/contracts';

import type { GuarantorRole } from './identity.js';
import {
  activateIncapacityAuthority,
  assertAuthorityRecordWellFormed,
  attemptAuthorityExtension,
  changeGuarantorAuthority,
  custodyAuthorityBases,
  custodyNonAuthorityBases,
  deactivateOnCapacityReturn,
  deliverEmancipatedArtifact,
  disputeGuarantorDesignation,
  escalateCustodySafetyConcern,
  escalateNoLawfulProxy,
  establishEmancipation,
  establishProxyAuthority,
  evaluateMajorityTransition,
  expireTemporaryAuthority,
  openCustodyConflict,
  openRenewalWindow,
  reassignHistoricalBalances,
  releaseGuarantor,
  replaceGuardianAuthority,
  resolveCustodyConflict,
  rollbackGuardianReplacement,
  versionLegalStatusChange,
  type AuthorityRecord,
  type CourtOrderValidation,
} from './proxy-authority.js';

const tenant = 'northwind-synthetic' as TenantId;
const guardian = 'np-alex-rivera' as PersonId;
const child = 'np-casey-rivera' as PersonId;
const other = 'np-jordan-kim' as PersonId;

const baseRecord: AuthorityRecord = {
  tenantId: tenant,
  authorityId: 'nar-0001',
  version: 1,
  kind: 'guardian-minor',
  granteePersonId: guardian,
  subjectPersonId: child,
  scope: [{ segment: 'scheduling', actions: ['view', 'edit'] }],
  jurisdiction: 'NV',
  evidenceRef: 'synthetic-guardian-evidence-0001',
  effectiveDate: '2026-01-10',
  verifiedBy: 'synthetic-front-desk-001',
  status: 'active',
  decidedBy: 'synthetic-front-desk-001',
  synthetic: true,
};

const validOrder: CourtOrderValidation = {
  jurisdictionValidated: true,
  partiesValidated: true,
  scopeApproved: true,
  authenticityValidated: true,
  effectiveDate: '2026-04-01',
  ambiguous: false,
  conflicting: false,
  appealed: false,
  orderEvidenceRef: 'synthetic-court-order-0001',
};

describe('authority record shape (pdp-api decision 5)', () => {
  it('a non-emancipation record can never be self-directed', () => {
    expect(() =>
      assertAuthorityRecordWellFormed({ ...baseRecord, subjectPersonId: guardian }),
    ).toThrow('over themselves');
  });

  it('emancipation is the ONLY self-directed kind', () => {
    expect(() =>
      assertAuthorityRecordWellFormed({
        ...baseRecord,
        kind: 'emancipation',
        granteePersonId: child,
        subjectPersonId: child,
      }),
    ).not.toThrow();
    expect(() => assertAuthorityRecordWellFormed({ ...baseRecord, kind: 'emancipation' })).toThrow(
      "subject's OWN independent",
    );
  });

  it('time-limited kinds expire by construction (REQ-ID-012 AC-1)', () => {
    expect(() =>
      assertAuthorityRecordWellFormed({ ...baseRecord, kind: 'temporary-guardianship' }),
    ).toThrow('expiresOn is required');
    expect(() =>
      assertAuthorityRecordWellFormed({
        ...baseRecord,
        kind: 'temporary-guardianship',
        expiresOn: '2026-09-01',
      }),
    ).toThrow('renewal owner');
  });

  it('an active incapacity authority carries its triggering determination (REQ-ID-014 EX-1)', () => {
    expect(() =>
      assertAuthorityRecordWellFormed({
        ...baseRecord,
        kind: 'incapacity-contingent',
        expiresOn: '2026-09-01',
      }),
    ).toThrow('assertion alone never activates');
  });

  it('active records carry an attributed verifier; evidence is mandatory', () => {
    const unverified = Object.fromEntries(
      Object.entries(baseRecord).filter(([key]) => key !== 'verifiedBy'),
    ) as unknown as AuthorityRecord;
    expect(() => assertAuthorityRecordWellFormed(unverified)).toThrow('verifier');
    expect(() => assertAuthorityRecordWellFormed({ ...baseRecord, evidenceRef: '' })).toThrow(
      'evidence',
    );
  });
});

describe('establishment (REQ-ID-006, REQ-ID-008 AC-5, REQ-ID-014 EX-1)', () => {
  it('verification precedes grant; unverified routes to trained staff (EX-1)', () => {
    const outcome = establishProxyAuthority({
      record: { ...baseRecord, status: 'pending-verification' },
      relationshipVerified: false,
      packs: jurisdictionPacksV1,
      providerState: 'NV',
    });
    expect(outcome.outcome).toBe('routed-to-staff-verification');
    if (outcome.outcome === 'routed-to-staff-verification') {
      expect(outcome.record.status).toBe('pending-verification');
      expect(outcome.routedTo).toBe('trained-staff-verification');
    }
  });

  it('a records-class scope under a written-consent state requires the artifact (AC-5)', () => {
    const outcome = establishProxyAuthority({
      record: {
        ...baseRecord,
        jurisdiction: 'MN',
        scope: [{ segment: 'results', actions: ['view'] }],
      },
      relationshipVerified: true,
      verifiedBy: 'synthetic-front-desk-001',
      packs: jurisdictionPacksV1,
      providerState: 'MN',
    });
    expect(outcome.outcome).toBe('blocked-written-consent-required');
  });

  it('the written artifact satisfies the MN requirement and establishes active', () => {
    const outcome = establishProxyAuthority({
      record: {
        ...baseRecord,
        jurisdiction: 'MN',
        scope: [{ segment: 'results', actions: ['view'] }],
        writtenConsentRef: 'synthetic-written-consent-0001',
        consentCapturedOn: '2026-01-10',
      },
      relationshipVerified: true,
      verifiedBy: 'synthetic-front-desk-001',
      packs: jurisdictionPacksV1,
      providerState: 'MN',
    });
    expect(outcome.outcome).toBe('established');
  });

  it('an incapacity kind without the triggering determination blocks outright', () => {
    const outcome = establishProxyAuthority({
      record: {
        ...baseRecord,
        kind: 'incapacity-contingent',
        expiresOn: '2026-09-01',
        status: 'pending-verification',
      },
      relationshipVerified: true,
      verifiedBy: 'synthetic-front-desk-001',
      packs: jurisdictionPacksV1,
      providerState: 'NV',
    });
    expect(outcome.outcome).toBe('blocked-assertion-only');
  });
});

describe('court-order replacement (REQ-ID-010)', () => {
  const openItems = [
    {
      itemRef: 'nai-appt-1',
      kind: 'appointment' as const,
      disposition: 'new-owner' as const,
      newOwnerRef: 'np-jordan-kim',
    },
    { itemRef: 'nai-consent-1', kind: 'consent' as const, disposition: 'acknowledged' as const },
  ];

  it('an ambiguous/conflicting/appealed order blocks and escalates while care continues (EX-1)', () => {
    for (const flag of ['ambiguous', 'conflicting', 'appealed'] as const) {
      const outcome = replaceGuardianAuthority({
        current: baseRecord,
        order: { ...validOrder, [flag]: true },
        newGranteePersonId: other,
        newScope: baseRecord.scope,
        openItems,
        decidedBy: 'synthetic-compliance-officer-001',
        verifiedBy: 'synthetic-compliance-officer-001',
      });
      expect(outcome.outcome).toBe('blocked-escalated');
      if (outcome.outcome === 'blocked-escalated') {
        expect(outcome.minimumNecessaryCareContinues).toBe(true);
        expect(outcome.escalatedTo).toContain('compliance-privacy-officer');
      }
    }
  });

  it('open items without a disposition block — none is silently closed (AC-3)', () => {
    const outcome = replaceGuardianAuthority({
      current: baseRecord,
      order: validOrder,
      newGranteePersonId: other,
      newScope: baseRecord.scope,
      openItems: [...openItems, { itemRef: 'nai-result-1', kind: 'result' }],
      decidedBy: 'synthetic-compliance-officer-001',
      verifiedBy: 'synthetic-compliance-officer-001',
    });
    expect(outcome.outcome).toBe('blocked-open-items');
    if (outcome.outcome === 'blocked-open-items') {
      expect(outcome.undispositioned).toEqual(['nai-result-1']);
    }
  });

  it('a valid order versions the decision: prior powers end, new scope only (AC-1/AC-2/AC-4)', () => {
    const outcome = replaceGuardianAuthority({
      current: baseRecord,
      order: validOrder,
      newGranteePersonId: other,
      newScope: [{ segment: 'scheduling', actions: ['view'] }],
      openItems,
      decidedBy: 'synthetic-compliance-officer-001',
      verifiedBy: 'synthetic-compliance-officer-001',
    });
    expect(outcome.outcome).toBe('replaced');
    if (outcome.outcome === 'replaced') {
      expect(outcome.priorEnded.status).toBe('superseded');
      expect(outcome.next.version).toBe(2);
      expect(outcome.next.granteePersonId).toBe(other);
      expect(outcome.next.supersedesVersion).toBe(1);
      expect(outcome.noticeDirective.priorGuardian).toBe('order-permitted-notices-only');
    }
  });

  it('a mistaken replacement rolls back from the version chain without erasure (EX-2)', () => {
    const replaced = replaceGuardianAuthority({
      current: baseRecord,
      order: validOrder,
      newGranteePersonId: other,
      newScope: baseRecord.scope,
      openItems,
      decidedBy: 'synthetic-compliance-officer-001',
      verifiedBy: 'synthetic-compliance-officer-001',
    });
    if (replaced.outcome !== 'replaced') {
      throw new Error('expected replacement');
    }
    const { reinstated, mistakenRetained } = rollbackGuardianReplacement(
      replaced.next,
      baseRecord,
      'synthetic-correction-evidence-0001',
      'synthetic-compliance-officer-001',
    );
    expect(reinstated.version).toBe(3);
    expect(reinstated.granteePersonId).toBe(guardian);
    expect(reinstated.supersedesVersion).toBe(2);
    expect(mistakenRetained.status).toBe('superseded');
    expect(mistakenRetained.endedReason).toBe('mistaken-replacement-rolled-back');
  });
});

describe('custody conflict (REQ-ID-011)', () => {
  const competing: AuthorityRecord = {
    ...baseRecord,
    authorityId: 'nar-0002',
    granteePersonId: other,
  };
  const hold = openCustodyConflict(
    'nch-0001',
    [baseRecord, competing],
    {
      evidenceRefs: ['synthetic-guardian-evidence-0001', 'synthetic-guardian-evidence-0002'],
      jurisdiction: 'NV',
      permittedActions: ['clinically-necessary-care'],
      affectedEncounterRefs: ['synthetic-encounter-0001'],
      safeContactRef: 'synthetic-safe-contact-0001',
    },
    'synthetic-neutral-pathway-0001',
  );

  it('the hold shows staff the evidence and holds contested actions on the neutral pathway (AC-1/AC-2)', () => {
    expect(hold.heldRecords.every((record) => record.status === 'held-conflict')).toBe(true);
    expect(hold.display.safeContactRef).toBe('synthetic-safe-contact-0001');
    const contested = resolveCustodyConflict;
    expect(contested).toBeDefined();
  });

  it('insurance/guarantor/household/prior-message can NEVER carry the resolution (EX-1)', () => {
    for (const basis of custodyNonAuthorityBases) {
      expect(() =>
        resolveCustodyConflict(hold, baseRecord, {
          basis: basis as never,
          evidenceRef: 'synthetic-court-order-0002',
          approvedBy: 'synthetic-compliance-officer-001',
          updates: {
            scope: baseRecord.scope,
            contactRefs: [],
            appointmentRefs: [],
            disclosureRuleRefs: [],
          },
        }),
      ).toThrow('never carry the decision');
    }
    expect(custodyAuthorityBases).toEqual([
      'court-order',
      'legal-agreement',
      'verified-legal-document',
    ]);
  });

  it('authoritative evidence updates scope, contacts, appointments, and disclosure together (AC-3)', () => {
    const resolution = resolveCustodyConflict(hold, baseRecord, {
      basis: 'court-order',
      evidenceRef: 'synthetic-court-order-0002',
      approvedBy: 'synthetic-compliance-officer-001',
      updates: {
        scope: [{ segment: 'messaging', actions: ['view'] }],
        contactRefs: ['synthetic-safe-contact-0001'],
        appointmentRefs: ['synthetic-encounter-0001'],
        disclosureRuleRefs: ['synthetic-disclosure-rule-0001'],
      },
    });
    expect(resolution.resolved.version).toBe(2);
    expect(resolution.appliedTogether.disclosureRuleRefs).toEqual([
      'synthetic-disclosure-rule-0001',
    ]);
    expect(resolution.versionProvenance.fromVersion).toBe(1);
  });

  it('a safety concern escalates without widening either caregiver (EX-2)', () => {
    const escalation = escalateCustodySafetyConcern(hold);
    expect(escalation.accessWidened).toBe(false);
    expect(escalation.escalatedTo).toEqual(['physician-app', 'compliance-privacy-officer']);
  });
});

describe('temporary authority expiry (REQ-ID-012)', () => {
  const temporary: AuthorityRecord = {
    ...baseRecord,
    authorityId: 'nar-0003',
    kind: 'temporary-guardianship',
    expiresOn: '2026-06-01',
    renewalOwnerRef: 'synthetic-renewal-owner-0001',
  };

  it('the renewal window opens a task WITHOUT extending access (AC-2)', () => {
    const directive = openRenewalWindow(temporary);
    expect(directive.kind).toBe('authority-renewal-task');
    expect(directive.accessExtended).toBe(false);
  });

  it('expiry withdraws access and routes open work to a human exception queue (AC-3)', () => {
    const outcome = expireTemporaryAuthority(
      temporary,
      [
        { itemRef: 'nai-result-2', kind: 'result' },
        { itemRef: 'nai-med-1', kind: 'medication' },
      ],
      '2026-06-02',
    );
    expect(outcome.expired.status).toBe('expired');
    expect(outcome.exceptionQueue).toHaveLength(2);
    expect(outcome.exceptionQueue[0]?.queue).toBe('human-exception-queue');
    expect(outcome.exceptionQueue[0]?.reason).toBe('lawful-reassignment-required');
  });

  it('portal activity, staff convenience, and financial ties never extend authority (EX-1)', () => {
    for (const basis of [
      'portal-activity',
      'staff-convenience',
      'financial-relationship',
    ] as const) {
      const outcome = attemptAuthorityExtension(temporary, { basis });
      expect(outcome.outcome).toBe('refused');
    }
  });

  it('a valid renewal resumes from the NEW effective version and reconciles held work (AC-4)', () => {
    const outcome = attemptAuthorityExtension(temporary, {
      basis: 'valid-renewal-evidence',
      evidenceRef: 'synthetic-renewal-evidence-0001',
      newEffectiveDate: '2026-06-02',
      newExpiresOn: '2026-12-01',
      approvedBy: 'synthetic-front-desk-001',
    });
    expect(outcome.outcome).toBe('renewed');
    if (outcome.outcome === 'renewed') {
      expect(outcome.renewed.version).toBe(2);
      expect(outcome.renewed.effectiveDate).toBe('2026-06-02');
      expect(outcome.heldWorkReconciled).toBe(true);
    }
  });

  it('no lawful proxy: urgent needs escalate under policy (EX-2)', () => {
    expect(escalateNoLawfulProxy().under).toBe('safeguarding-policy');
  });
});

describe('emancipation (REQ-ID-013)', () => {
  const emancipation: AuthorityRecord = {
    ...baseRecord,
    authorityId: 'nar-0004',
    kind: 'emancipation',
    granteePersonId: child,
    subjectPersonId: child,
    scope: [
      { segment: 'scheduling', actions: ['view', 'edit'] },
      { segment: 'results', actions: ['view'] },
    ],
  };

  it('unresolved status denies contested disclosure by default without delaying care (EX-1)', () => {
    const outcome = establishEmancipation({
      record: { ...emancipation, status: 'pending-verification' },
      statusResolved: false,
      verifiedBy: 'synthetic-compliance-officer-001',
    });
    expect(outcome.outcome).toBe('held-compliance-review');
    if (outcome.outcome === 'held-compliance-review') {
      expect(outcome.contestedDisclosure).toBe('denied-by-default');
      expect(outcome.emergencyCareDelayed).toBe(false);
    }
  });

  it('clinical and guarantor authority are checked SEPARATELY on delivery (AC-3)', () => {
    const established = establishEmancipation({
      record: emancipation,
      statusResolved: true,
      verifiedBy: 'synthetic-compliance-officer-001',
    });
    if (established.outcome !== 'established') {
      throw new Error('expected establishment');
    }
    const guarantorRole: GuarantorRole = {
      guarantorRoleId: 'ngr-0002',
      tenantId: tenant,
      guarantorPersonId: guardian,
      patientRecordId: 'npr-casey-rivera' as never,
      scope: ['statements'],
      evidenceRef: 'synthetic-guarantor-evidence-0002',
      status: 'active',
      synthetic: true,
    };
    const clinicalToGuardian = deliverEmancipatedArtifact(
      established.record,
      { kind: 'clinical', recipientPersonId: guardian },
      [guarantorRole],
    );
    expect(clinicalToGuardian.recipientAuthorized).toBe(false);
    const financialToGuarantor = deliverEmancipatedArtifact(
      established.record,
      { kind: 'financial', recipientPersonId: guardian },
      [guarantorRole],
    );
    expect(financialToGuarantor.recipientAuthorized).toBe(true);
    expect(financialToGuarantor.checkedAgainst).toBe('guarantor-authority');
  });

  it('a later legal-status change re-versions without deleting earlier lawful activity (EX-2)', () => {
    const change = versionLegalStatusChange(emancipation, {
      evidenceRef: 'synthetic-status-change-0001',
      decidedBy: 'synthetic-compliance-officer-001',
      ended: true,
    });
    expect(change.next.version).toBe(2);
    expect(change.next.status).toBe('ended');
    expect(change.earlierActivityRetained).toBe(true);
  });
});

describe('incapacity activation (REQ-ID-014)', () => {
  const contingent: AuthorityRecord = {
    ...baseRecord,
    authorityId: 'nar-0005',
    kind: 'incapacity-contingent',
    subjectPersonId: other,
    expiresOn: '2026-09-01',
    status: 'pending-verification',
  };

  it('a caregiver assertion alone cannot activate (EX-1)', () => {
    const outcome = activateIncapacityAuthority({
      contingent,
      verifiedBy: 'synthetic-compliance-officer-001',
      reviewerRef: 'synthetic-reviewer-0001',
      expiresOn: '2026-09-01',
    });
    expect(outcome.outcome).toBe('blocked-assertion-only');
  });

  it('conflicting capacity evidence blocks nonurgent delegated actions and escalates (EX-2)', () => {
    const outcome = activateIncapacityAuthority({
      contingent,
      triggeringDeterminationRef: 'synthetic-determination-0001',
      conflictingCapacityEvidence: true,
      verifiedBy: 'synthetic-compliance-officer-001',
      reviewerRef: 'synthetic-reviewer-0001',
      expiresOn: '2026-09-01',
    });
    expect(outcome.outcome).toBe('blocked-escalated');
  });

  it('verified activation scopes access; capacity return withdraws it (AC-1/AC-2/AC-3)', () => {
    const outcome = activateIncapacityAuthority({
      contingent,
      triggeringDeterminationRef: 'synthetic-determination-0001',
      verifiedBy: 'synthetic-compliance-officer-001',
      reviewerRef: 'synthetic-reviewer-0001',
      expiresOn: '2026-09-01',
    });
    expect(outcome.outcome).toBe('activated');
    if (outcome.outcome !== 'activated') {
      throw new Error('expected activation');
    }
    expect(outcome.record.triggeringEvidenceRef).toBe('synthetic-determination-0001');
    const deactivated = deactivateOnCapacityReturn(outcome.record, 'synthetic-physician-0001');
    expect(deactivated.ended.status).toBe('ended');
    expect(deactivated.futureActionsReturnTo).toBe(other);
  });
});

describe('majority transition (REQ-ID-007)', () => {
  const guardianRecord: AuthorityRecord = { ...baseRecord, authorityId: 'nar-0006' };

  const evaluate = (asOfDate: string, records: readonly AuthorityRecord[] = [guardianRecord]) =>
    evaluateMajorityTransition({
      subjectBirthDate: '2011-06-02',
      authorityRecords: records,
      guardianSignedConsentRefs: ['synthetic-consent-0002'],
      packs: jurisdictionPacksV1,
      providerState: 'NV',
      patientState: 'NV',
      asOfDate,
      adultConsentCompleted: false,
    });

  it('the review point derives from birth date + the 18-year floor with a 30-day lead (AC-1)', () => {
    expect(evaluate('2029-05-02').phase).toBe('pre-review');
    const window = evaluate('2029-05-03');
    expect(window.phase).toBe('review-window');
    expect(window.workItemDirective?.dueBy).toBe('2029-06-02');
  });

  it('at majority, guardian authority suspends pending the adult’s own consent (AC-7/AC-8/AC-9)', () => {
    const at = evaluate('2029-06-02');
    expect(at.phase).toBe('suspended-pending-adult-consent');
    expect(at.suspendedRecords[0]?.status).toBe('suspended-majority');
    expect(at.denialExplanation?.code).toBe('majority-transition');
    expect(at.reConsentFlags).toEqual(['synthetic-consent-0002']);
    expect(at.contactDirective?.severGuardianOwnedNumbers).toBe(true);
    expect(at.contactDirective?.clinicalNotificationsRoute).toBe(
      'portal-only-until-adult-confirms',
    );
  });

  it('a documented continuing-authority order with an expiry survives; one without does not (EX-2/EX-5)', () => {
    const continuing: AuthorityRecord = {
      ...guardianRecord,
      authorityId: 'nar-0007',
      kind: 'court-order-guardian',
      expiresOn: '2032-06-02',
    };
    const indefinite: AuthorityRecord = {
      ...guardianRecord,
      authorityId: 'nar-0008',
      kind: 'court-order-guardian',
    };
    const at = evaluate('2029-06-02', [guardianRecord, continuing, indefinite]);
    expect(at.preservedRecords.map((record) => record.authorityId)).toEqual(['nar-0007']);
    expect(at.suspendedRecords.map((record) => record.authorityId).sort()).toEqual([
      'nar-0006',
      'nar-0008',
    ]);
  });

  it('state-specific confidential carve-outs arrive as resolver DATA (EX-3)', () => {
    const at = evaluate('2029-06-02');
    expect(at.confidentialCarveoutObligations).toContain('strictest-minor-confidentiality');
  });

  it('an unresolvable birth date denies confidential segments by default (REQ-ID-006 EX-2)', () => {
    const outcome = evaluateMajorityTransition({
      subjectBirthDate: null,
      authorityRecords: [guardianRecord],
      guardianSignedConsentRefs: [],
      packs: jurisdictionPacksV1,
      providerState: 'NV',
      patientState: null,
      asOfDate: '2026-03-25',
      adultConsentCompleted: false,
    });
    expect(outcome.phase).toBe('unresolved-birth-date');
    expect(outcome.confidentialDefault).toBe('deny');
  });
});

describe('guarantor authority change (REQ-ID-016 / REQ-ID-023)', () => {
  const currentRole: GuarantorRole = {
    guarantorRoleId: 'ngr-alex-for-casey',
    tenantId: tenant,
    guarantorPersonId: guardian,
    patientRecordId: 'npr-casey-rivera' as never,
    scope: ['statements', 'payment-methods'],
    evidenceRef: 'synthetic-guarantor-evidence-0001',
    status: 'active',
    synthetic: true,
  };
  const newRole: GuarantorRole = {
    ...currentRole,
    guarantorRoleId: 'ngr-jordan-for-casey',
    guarantorPersonId: other,
    evidenceRef: 'synthetic-guarantor-evidence-0003',
  };
  const reviewedAll = {
    effectiveScope: true,
    dates: true,
    patientAccounts: true,
    balances: true,
    priorNotices: true,
    portalPermissions: true,
    source: true,
  };

  it('blockers hold the change AND statement release (EX-1)', () => {
    const outcome = changeGuarantorAuthority({
      current: currentRole,
      newRole,
      evidenceRef: 'synthetic-responsibility-evidence-0001',
      reviewed: reviewedAll,
      blockers: ['disputed-responsibility'],
      guarantorBillingConsentRef: 'synthetic-billing-consent-0001',
      decidedBy: 'synthetic-front-desk-001',
    });
    expect(outcome.outcome).toBe('blocked-review');
    if (outcome.outcome === 'blocked-review') {
      expect(outcome.statementReleaseHeld).toBe(true);
    }
  });

  it('every reviewed dimension is required (AC-1); the guarantor consent is separate (023 AC-4)', () => {
    expect(() =>
      changeGuarantorAuthority({
        current: currentRole,
        newRole,
        evidenceRef: 'synthetic-responsibility-evidence-0001',
        reviewed: { ...reviewedAll, balances: false },
        blockers: [],
        guarantorBillingConsentRef: 'synthetic-billing-consent-0001',
        decidedBy: 'synthetic-front-desk-001',
      }),
    ).toThrow('reviews effective scope');
    expect(() =>
      changeGuarantorAuthority({
        current: currentRole,
        newRole,
        evidenceRef: 'synthetic-responsibility-evidence-0001',
        reviewed: reviewedAll,
        blockers: [],
        guarantorBillingConsentRef: '',
        decidedBy: 'synthetic-front-desk-001',
      }),
    ).toThrow('captured separately');
  });

  it('the change is prospective: the prior actor loses ONLY the ended authority (AC-2)', () => {
    const outcome = changeGuarantorAuthority({
      current: currentRole,
      newRole,
      evidenceRef: 'synthetic-responsibility-evidence-0001',
      reviewed: reviewedAll,
      blockers: [],
      guarantorBillingConsentRef: 'synthetic-billing-consent-0001',
      decidedBy: 'synthetic-front-desk-001',
    });
    expect(outcome.outcome).toBe('changed');
    if (outcome.outcome === 'changed') {
      expect(outcome.priorEnded.status).toBe('ended');
      expect(outcome.onlyFinancialAuthorityEnded).toBe(true);
      expect(outcome.statementsRouteTo).toBe(other);
    }
  });

  it('historical reassignment needs a human approver + legal basis; lineage never rewrites (AC-3)', () => {
    expect(() =>
      reassignHistoricalBalances({
        balanceRefs: ['synthetic-balance-0001'],
        approvedBy: '',
        legalBasisRef: 'x',
      }),
    ).toThrow('human approver');
    const outcome = reassignHistoricalBalances({
      balanceRefs: ['synthetic-balance-0001'],
      approvedBy: 'synthetic-counselor-0001',
      legalBasisRef: 'synthetic-legal-basis-0001',
    });
    expect(outcome.lineage[0]?.rewritesPriorTransactions).toBe(false);
  });

  it('release with an unpaid balance requires a patient payment method or plan (023 EX-2)', () => {
    const blocked = releaseGuarantor({
      role: currentRole,
      patientPersonId: child,
      unpaidBalance: true,
    });
    expect(blocked.outcome).toBe('blocked-payment-method-required');
    const released = releaseGuarantor({
      role: currentRole,
      patientPersonId: child,
      unpaidBalance: true,
      patientPaymentMethodRef: 'synthetic-payment-method-0001',
    });
    expect(released.outcome).toBe('released');
    if (released.outcome === 'released') {
      expect(released.ended.status).toBe('ended');
      expect(released.billingTransfersTo).toBe(child);
    }
  });

  it('a contested designation opens an attributed review (023 EX-4)', () => {
    const review = disputeGuarantorDesignation(currentRole, {
      disputedBy: child,
      reviewRef: 'synthetic-designation-review-0001',
    });
    expect(review.review).toBe('guarantor-designation-review');
  });
});

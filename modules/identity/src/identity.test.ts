import { describe, expect, it } from 'vitest';

import type { PatientRecordId, PersonId, TenantId } from '@practicehub/contracts';

import {
  IdentityInvariantError,
  assertGuarantorRoleWellFormed,
  assertPersonWellFormed,
  assertProxyGrantWellFormed,
  reconcileDemographics,
  type GuarantorRole,
  type Person,
  type ProxyGrant,
} from './identity.js';

const tenantId = 'northwind-synthetic' as TenantId;

const verifiedPerson: Person = {
  personId: 'np-alex-rivera' as PersonId,
  tenantId,
  status: 'verified',
  verificationEvidenceRef: 'synthetic-idproof-0001',
  birthDate: '1980-03-14',
  provenance: { source: 'synthetic-intake', capturedBy: 'synthetic-front-desk-001' },
  synthetic: true,
};

describe('person invariants', () => {
  it('accepts a verified person carrying identity-proofing evidence', () => {
    expect(() => assertPersonWellFormed(verifiedPerson)).not.toThrow();
  });

  it('a verified person without evidence fails closed', () => {
    const unevidenced = { ...verifiedPerson };
    delete (unevidenced as { verificationEvidenceRef?: string }).verificationEvidenceRef;
    expect(() => assertPersonWellFormed(unevidenced)).toThrow(
      /verified without identity-proofing evidence/,
    );
  });

  it('a person without provenance fails closed (REQ-ID-003 AC-3)', () => {
    expect(() =>
      assertPersonWellFormed({
        ...verifiedPerson,
        provenance: { source: '', capturedBy: 'synthetic-front-desk-001' },
      }),
    ).toThrow(/source and capture provenance/);
  });
});

const proxyGrant: ProxyGrant = {
  proxyGrantId: 'npx-alex-for-casey',
  tenantId,
  granteePersonId: 'np-alex-rivera' as PersonId,
  subjectPersonId: 'np-casey-rivera' as PersonId,
  scope: ['scheduling', 'messaging'],
  expiresOn: '2029-06-02',
  evidenceRef: 'synthetic-proxy-evidence-0001',
  status: 'active',
  synthetic: true,
};

describe('proxy grants are scoped and expiring by construction (ADR-005)', () => {
  it('accepts a scoped, expiring, evidenced grant', () => {
    expect(() => assertProxyGrantWellFormed(proxyGrant)).not.toThrow();
  });

  it('an unbounded grant is unrepresentable', () => {
    expect(() =>
      assertProxyGrantWellFormed({ ...proxyGrant, expiresOn: '' } as ProxyGrant),
    ).toThrow(/ISO expiry date/);
  });

  it('an unscoped grant is unrepresentable', () => {
    expect(() => assertProxyGrantWellFormed({ ...proxyGrant, scope: [] })).toThrow(
      /non-empty scope/,
    );
  });

  it('a self-referential grant is unrepresentable', () => {
    expect(() =>
      assertProxyGrantWellFormed({
        ...proxyGrant,
        subjectPersonId: proxyGrant.granteePersonId,
      }),
    ).toThrow(/authority over themselves/);
  });

  it('an unevidenced grant fails closed', () => {
    expect(() => assertProxyGrantWellFormed({ ...proxyGrant, evidenceRef: '' })).toThrow(
      /evidence reference/,
    );
  });
});

const guarantorRole: GuarantorRole = {
  guarantorRoleId: 'ngr-alex-for-casey',
  tenantId,
  guarantorPersonId: 'np-alex-rivera' as PersonId,
  patientRecordId: 'npr-casey-rivera' as PatientRecordId,
  scope: ['statements', 'payment-methods'],
  evidenceRef: 'synthetic-guarantor-evidence-0001',
  status: 'active',
  synthetic: true,
};

describe('guarantor role invariants', () => {
  it('accepts a scoped, evidenced role', () => {
    expect(() => assertGuarantorRoleWellFormed(guarantorRole)).not.toThrow();
  });

  it('ending a role requires a recorded reason', () => {
    expect(() => assertGuarantorRoleWellFormed({ ...guarantorRole, status: 'ended' })).toThrow(
      /without a recorded reason/,
    );
    expect(() =>
      assertGuarantorRoleWellFormed({
        ...guarantorRole,
        status: 'ended',
        endedReason: 'synthetic-court-order-0001',
      }),
    ).not.toThrow();
  });

  it('an unevidenced role fails closed', () => {
    expect(() => assertGuarantorRoleWellFormed({ ...guarantorRole, evidenceRef: '' })).toThrow(
      IdentityInvariantError,
    );
  });
});

describe('demographic reconciliation never overwrites (REQ-ID-005 exception 1)', () => {
  it('conflicting values open a review with both values retained', () => {
    const result = reconcileDemographics(
      { 'birth-date': '1980-03-14', 'postal-code': '89011' },
      { 'birth-date': '1980-03-15', 'postal-code': '89011' },
    );
    expect(result.outcome).toBe('review-required');
    if (result.outcome === 'review-required') {
      expect(result.sourceValuesRetained).toBe(true);
      expect(result.conflicts).toEqual([
        { field: 'birth-date', currentValue: '1980-03-14', incomingValue: '1980-03-15' },
      ]);
    }
  });

  it('agreeing or missing values raise no conflict', () => {
    expect(
      reconcileDemographics({ 'birth-date': '1980-03-14' }, { 'postal-code': '89011' }).outcome,
    ).toBe('no-conflict');
  });
});

import { describe, expect, it } from 'vitest';

import type { PersonId, TenantId } from '@practicehub/contracts';

import {
  assertMergeAuthorizationBasis,
  findIdentityCandidates,
  registerIdentityInquiry,
  MergeGovernanceError,
  type IdentityInquiry,
  type MatchablePerson,
} from './matching.js';
import type { PersonName } from './names.js';

const tenantId = 'northwind-synthetic' as TenantId;

function matchable(
  personId: string,
  attributes: MatchablePerson['attributes'],
  names: readonly PersonName[] = [],
): MatchablePerson {
  return {
    person: {
      personId: personId as PersonId,
      tenantId,
      status: 'provisional',
      provenance: { source: 'synthetic-intake', capturedBy: 'synthetic-front-desk-001' },
      synthetic: true,
    },
    names,
    attributes,
  };
}

const alex = matchable(
  'np-alex-rivera',
  {
    givenName: 'Alex',
    familyName: 'Rivera',
    birthDate: '1980-03-14',
    phone: '+15550100001',
    email: 'rivera-family@synthetic.invalid',
  },
  [
    {
      tenantId,
      personId: 'np-alex-rivera' as PersonId,
      kind: 'affirmed',
      givenName: 'Alex',
      familyName: 'Rivera',
      source: 'synthetic-patient-update',
      unsafeContexts: [],
      synthetic: true,
    },
    {
      tenantId,
      personId: 'np-alex-rivera' as PersonId,
      kind: 'legal',
      givenName: 'Alexander',
      familyName: 'Rivera',
      source: 'synthetic-intake',
      unsafeContexts: [],
      synthetic: true,
    },
  ],
);

const inquiry: IdentityInquiry = {
  tenantId,
  proposedPersonId: 'np-new-inquiry' as PersonId,
  attributes: { givenName: 'Dana', familyName: 'Okafor', birthDate: '1992-11-30' },
  provenance: {
    source: 'synthetic-web-form',
    capturedBy: 'synthetic-web-intake',
    consentRef: 'synthetic-consent-0009',
  },
};

describe('REQ-ID-003: provisional identity without duplication', () => {
  it('no match yields exactly one provisional identity retaining provenance', () => {
    const outcome = registerIdentityInquiry(inquiry, [alex]);
    expect(outcome.outcome).toBe('provisional-created');
    if (outcome.outcome === 'provisional-created') {
      expect(outcome.person.status).toBe('provisional');
      expect(outcome.person.provenance).toEqual(inquiry.provenance);
    }
  });

  it('a possible match quarantines for staff review — no new record, no auto-merge, no value exposure', () => {
    const outcome = registerIdentityInquiry(
      {
        ...inquiry,
        attributes: { givenName: 'Alex', familyName: 'Rivera', phone: '+15550100001' },
      },
      [alex],
    );
    expect(outcome.outcome).toBe('possible-match-queue');
    if (outcome.outcome === 'possible-match-queue') {
      expect(outcome.newRecordCreated).toBe(false);
      expect(outcome.quarantined).toBe(true);
      expect(outcome.candidates).toHaveLength(1);
      const candidate = outcome.candidates[0];
      expect(candidate?.matchedAttributes).toEqual(['given-name', 'family-name', 'phone']);
      // Attribute NAMES only — the serialized candidate must not leak record values.
      expect(JSON.stringify(outcome)).not.toContain('1980-03-14');
      expect(JSON.stringify(outcome)).not.toContain('Rivera');
    }
  });

  it('resolver downtime holds for reconciliation rather than creating an unreviewed duplicate (REQ-ID-005 exception 2)', () => {
    const outcome = registerIdentityInquiry(inquiry, [alex], { resolverAvailable: false });
    expect(outcome.outcome).toBe('downtime-hold');
    if (outcome.outcome === 'downtime-hold') {
      expect(outcome.queuedForReconciliation).toBe(true);
      expect(outcome.newRecordCreated).toBe(false);
    }
  });
});

describe('candidate detection', () => {
  it('requires at least two matching attributes', () => {
    const candidates = findIdentityCandidates({ familyName: 'Rivera' }, [alex]);
    expect(candidates).toHaveLength(0);
  });

  it('a person presenting their LEGAL name still matches their one identity (REQ-ID-015 exception 1)', () => {
    const candidates = findIdentityCandidates(
      { givenName: 'Alexander', familyName: 'Rivera', birthDate: '1980-03-14' },
      [alex],
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.matchedAttributes).toEqual(['given-name', 'family-name', 'birth-date']);
    expect(candidates[0]?.strong).toBe(true);
  });

  it('an endpoint-only match is a weak candidate — flagged, never merge-sufficient', () => {
    const candidates = findIdentityCandidates(
      { phone: '+15550100001', email: 'rivera-family@synthetic.invalid' },
      [alex],
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.strong).toBe(false);
  });
});

describe('merge authorization basis (REQ-ID-003 AC-2; execution lands with WP-016)', () => {
  it('two attributes including a merge-sufficient one, attributed, passes', () => {
    expect(() =>
      assertMergeAuthorizationBasis({
        comparedAttributes: ['family-name', 'birth-date'],
        decidedBy: 'synthetic-staff-001',
      }),
    ).not.toThrow();
  });

  it('fewer than two compared attributes is refused', () => {
    expect(() =>
      assertMergeAuthorizationBasis({
        comparedAttributes: ['birth-date'],
        decidedBy: 'synthetic-staff-001',
      }),
    ).toThrow(MergeGovernanceError);
  });

  it('an unattributed decision is refused', () => {
    expect(() =>
      assertMergeAuthorizationBasis({
        comparedAttributes: ['family-name', 'birth-date'],
        decidedBy: '',
      }),
    ).toThrow(/attributed to its decision maker/);
  });
});

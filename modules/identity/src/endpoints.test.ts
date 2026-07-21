/**
 * The WP-013 verification-gate property: a shared endpoint is NEVER a person.
 * The sweep below walks every association-set shape up to four persons ×
 * both verification states and asserts that no shape ever resolves a
 * multi-person endpoint to an identity, and that endpoint-equality bases can
 * never authorize a merge (REQ-ID-017 + exception).
 */
import { describe, expect, it } from 'vitest';

import type { PersonId, TenantId } from '@practicehub/contracts';

import {
  assertEndpointAssociationWellFormed,
  disputeEndpointOwnership,
  personsSharingEndpoint,
  resolveOutreachIdentity,
  type EndpointAssociation,
} from './endpoints.js';
import { MergeGovernanceError, assertMergeAuthorizationBasis } from './matching.js';

const tenantId = 'northwind-synthetic' as TenantId;

function association(
  personIndex: number,
  verification: 'asserted' | 'verified',
): EndpointAssociation {
  return {
    tenantId,
    endpointId: 'nce-shared-endpoint',
    personId: `np-person-${String(personIndex)}` as PersonId,
    relationship: personIndex === 0 ? 'self' : 'household',
    verification,
    ...(verification === 'verified'
      ? { evidenceRef: `synthetic-endpoint-evidence-${String(personIndex)}` }
      : {}),
    source: 'synthetic-intake',
    consentRef: `synthetic-consent-${String(personIndex)}`,
    synthetic: true,
  };
}

describe('shared-endpoint-never-person property (gate)', () => {
  it('across every association-set shape, a shared endpoint never resolves to one identity', () => {
    for (let personCount = 2; personCount <= 4; personCount += 1) {
      for (let mask = 0; mask < 2 ** personCount; mask += 1) {
        const associations = Array.from({ length: personCount }, (_, index) =>
          association(index, (mask >> index) & 1 ? 'verified' : 'asserted'),
        );
        const persons = personsSharingEndpoint(associations, 'nce-shared-endpoint');
        expect(persons).toHaveLength(personCount);
        const resolution = resolveOutreachIdentity(associations, 'nce-shared-endpoint');
        expect(resolution.kind).toBe('ambiguous');
        if (resolution.kind === 'ambiguous') {
          expect(resolution.personIds).toHaveLength(personCount);
        }
      }
    }
  });

  it('a sole ASSERTED association stays ambiguous — asserted facts never resolve outreach', () => {
    const resolution = resolveOutreachIdentity([association(0, 'asserted')], 'nce-shared-endpoint');
    expect(resolution.kind).toBe('ambiguous');
  });

  it('only a sole verified association resolves outreach identity', () => {
    const resolution = resolveOutreachIdentity([association(0, 'verified')], 'nce-shared-endpoint');
    expect(resolution).toEqual({
      kind: 'resolved',
      personId: 'np-person-0',
      basis: 'verified-sole-association',
    });
  });

  it('an unknown endpoint resolves to nothing', () => {
    expect(resolveOutreachIdentity([], 'nce-absent').kind).toBe('unknown');
  });

  it('endpoint equality can never authorize a merge, no matter how many endpoint facts agree', () => {
    expect(() =>
      assertMergeAuthorizationBasis({
        comparedAttributes: ['phone', 'email'],
        decidedBy: 'synthetic-staff-001',
      }),
    ).toThrow(MergeGovernanceError);
    expect(() =>
      assertMergeAuthorizationBasis({
        comparedAttributes: ['phone', 'email', 'postal-address'],
        decidedBy: 'synthetic-staff-001',
      }),
    ).toThrow(/can never authorize an identity merge/);
  });
});

describe('per-person attribution (REQ-ID-017 AC-1)', () => {
  it('every association carries its own source attribution', () => {
    expect(() =>
      assertEndpointAssociationWellFormed({ ...association(0, 'asserted'), source: '' }),
    ).toThrow(/own source attribution/);
  });

  it('a verified association without evidence fails closed', () => {
    const broken = { ...association(0, 'verified') };
    delete (broken as { evidenceRef?: string }).evidenceRef;
    expect(() => assertEndpointAssociationWellFormed(broken)).toThrow(/without evidence/);
  });
});

describe('wrong-person outreach dispute (REQ-ID-017 AC-3)', () => {
  it('stops the campaign for the disputed identity until a human resolves ownership', () => {
    const directive = disputeEndpointOwnership({
      tenantId,
      endpointId: 'nce-shared-endpoint',
      disputedPersonId: 'np-person-1' as PersonId,
      reportedBy: 'synthetic-staff-001',
    });
    expect(directive.suppressOutreachPersonIds).toEqual(['np-person-1']);
    expect(directive.resumeRequires).toBe('human-endpoint-ownership-resolution');
  });

  it('an unattributed dispute is refused', () => {
    expect(() =>
      disputeEndpointOwnership({
        tenantId,
        endpointId: 'nce-shared-endpoint',
        disputedPersonId: 'np-person-1' as PersonId,
        reportedBy: '',
      }),
    ).toThrow(/name its reporter/);
  });
});

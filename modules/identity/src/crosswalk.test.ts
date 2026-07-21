import { describe, expect, it } from 'vitest';

import type { PersonId, TenantId } from '@practicehub/contracts';

import {
  assertOpaqueExternalReference,
  linkSourceIdentifier,
  recordBuyerConversion,
  resolvePersonBySourceId,
  type SourceIdentifier,
} from './crosswalk.js';

const tenantId = 'northwind-synthetic' as TenantId;

function link(system: string, value: string, personId: string): SourceIdentifier {
  return {
    tenantId,
    sourceSystem: system,
    sourceValue: value,
    personId: personId as PersonId,
    verification: 'asserted',
    provenanceSource: 'synthetic-adapter',
    synthetic: true,
  };
}

const existing = [
  link('athena', 'ath-100234', 'np-alex-rivera'),
  link('stripe', 'cus_synthetic0001', 'np-alex-rivera'),
];

describe('opaque payment references (REQ-ID-004 AC-1)', () => {
  it('accepts an opaque token', () => {
    expect(() => assertOpaqueExternalReference('stripe', 'cus_synthetic0001')).not.toThrow();
  });

  it('rejects contact detail, date-like content, and short/spaced values', () => {
    expect(() => assertOpaqueExternalReference('stripe', 'alex@synthetic.invalid')).toThrow(
      /opaque token/,
    );
    expect(() => assertOpaqueExternalReference('stripe', 'dob-1980-03-14-alex')).toThrow(
      /opaque token/,
    );
    expect(() => assertOpaqueExternalReference('stripe', 'a b')).toThrow(/opaque token/);
  });

  it('non-payment systems may carry native id shapes', () => {
    expect(() => assertOpaqueExternalReference('athena', 'ath-100234')).not.toThrow();
  });
});

describe('crosswalk linking (REQ-ID-004)', () => {
  it('links a new source id to its one person', () => {
    const outcome = linkSourceIdentifier(existing, link('hubspot', 'hs-88121', 'np-jordan-kim'));
    expect(outcome.outcome).toBe('linked');
  });

  it('payment-to-patient mismatch quarantines and retains the existing link (exception 1)', () => {
    const outcome = linkSourceIdentifier(
      existing,
      link('stripe', 'cus_synthetic0001', 'np-jordan-kim'),
    );
    expect(outcome.outcome).toBe('conflict-quarantined');
    if (outcome.outcome === 'conflict-quarantined') {
      expect(outcome.existingLinkRetained).toBe(true);
      expect(outcome.existingLink.personId).toBe('np-alex-rivera');
    }
  });

  it('a duplicate arrival holds for staff review — never a second attachment (exception 2)', () => {
    const outcome = linkSourceIdentifier(
      existing,
      link('stripe', 'cus_synthetic0001', 'np-alex-rivera'),
    );
    expect(outcome.outcome).toBe('duplicate-held');
    if (outcome.outcome === 'duplicate-held') {
      expect(outcome.heldForReview).toBe(true);
    }
  });
});

describe('one longitudinal identity (REQ-ID-005 AC-1)', () => {
  it('every preserved source id resolves to the one person', () => {
    expect(resolvePersonBySourceId(existing, tenantId, 'athena', 'ath-100234')).toBe(
      'np-alex-rivera',
    );
    expect(resolvePersonBySourceId(existing, tenantId, 'stripe', 'cus_synthetic0001')).toBe(
      'np-alex-rivera',
    );
    expect(resolvePersonBySourceId(existing, tenantId, 'athena', 'ath-999999')).toBeNull();
  });
});

describe('buyer conversion attribution (REQ-ID-004 AC-2)', () => {
  const attribution = {
    entitlementRef: 'synthetic-entitlement-0001',
    paymentStateRef: 'synthetic-payment-0001',
    leadSourceRef: 'synthetic-lead-0001',
    communicationConsentRef: 'synthetic-consent-0001',
  };

  it('keeps the four attributions separately addressable', () => {
    const conversion = recordBuyerConversion(
      'np-alex-rivera' as PersonId,
      link('stripe', 'cus_synthetic0001', 'np-alex-rivera'),
      attribution,
    );
    expect(conversion.attribution).toEqual(attribution);
  });

  it('a collapsed or missing attribution fails closed', () => {
    expect(() =>
      recordBuyerConversion(
        'np-alex-rivera' as PersonId,
        link('stripe', 'cus_synthetic0001', 'np-alex-rivera'),
        { ...attribution, leadSourceRef: '' },
      ),
    ).toThrow(/attribute leadSourceRef distinctly/);
  });

  it('a transaction linked to another person cannot convert', () => {
    expect(() =>
      recordBuyerConversion(
        'np-jordan-kim' as PersonId,
        link('stripe', 'cus_synthetic0001', 'np-alex-rivera'),
        attribution,
      ),
    ).toThrow(/linked to np-alex-rivera/);
  });
});

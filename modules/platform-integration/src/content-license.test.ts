import { describe, expect, it } from 'vitest';

import { licenseGate, type ContentLicenseRow } from './content-license.js';

const tenant = 'northwind-synthetic';

function license(overrides: Partial<ContentLicenseRow> = {}): ContentLicenseRow {
  return {
    tenantId: tenant,
    licenseId: 'synthetic-cpt-license',
    contentFamily: 'cpt',
    status: 'active',
    effective: '2026-01-01',
    expiry: '2027-01-01',
    rightsRef: 'synthetic-license:cpt',
    checksum: 'a'.repeat(64),
    synthetic: true,
    ...overrides,
  };
}

describe('licenseGate (R6-REQ-080 CPT / R6-REQ-081 drug compendium), fail-closed', () => {
  it('permits a dependent command against an active, in-date license (flag-gating allow)', () => {
    const decision = licenseGate(license(), { contentFamily: 'cpt', asOf: '2026-06-01' });
    expect(decision.permitted).toBe(true);
    expect(decision.reason).toBe('permitted');
  });

  it('DENIES when no license is on record (absent = fail closed)', () => {
    expect(licenseGate(null, { contentFamily: 'cpt', asOf: '2026-06-01' })).toEqual({
      permitted: false,
      reason: 'no-license-on-record',
    });
  });

  it('DENIES a pending license', () => {
    expect(
      licenseGate(license({ status: 'pending', effective: null, expiry: null }), {
        contentFamily: 'cpt',
        asOf: '2026-06-01',
      }).reason,
    ).toBe('license-pending');
  });

  it('DENIES a lapsed license (license-lapse-disable, R6-REQ-081)', () => {
    expect(
      licenseGate(license({ status: 'lapsed' }), {
        contentFamily: 'drug-compendium',
        asOf: '2026-06-01',
      }).reason,
    ).toBe('license-lapsed');
  });

  it('DENIES an expired license as of the check date', () => {
    expect(
      licenseGate(license({ expiry: '2026-05-31' }), { contentFamily: 'cpt', asOf: '2026-06-01' })
        .reason,
    ).toBe('license-expired');
  });

  it('DENIES a not-yet-effective license', () => {
    expect(
      licenseGate(license({ effective: '2026-07-01' }), {
        contentFamily: 'cpt',
        asOf: '2026-06-01',
      }).reason,
    ).toBe('license-not-yet-effective');
  });

  it('DENIES a checksum mismatch (a pinned historical edition retains its edition)', () => {
    expect(
      licenseGate(license(), {
        contentFamily: 'cpt',
        asOf: '2026-06-01',
        expectedChecksum: 'b'.repeat(64),
      }).reason,
    ).toBe('checksum-mismatch');
  });

  it('permits when the pinned checksum matches', () => {
    expect(
      licenseGate(license(), {
        contentFamily: 'cpt',
        asOf: '2026-06-01',
        expectedChecksum: 'a'.repeat(64),
      }).permitted,
    ).toBe(true);
  });
});

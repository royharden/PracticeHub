import { describe, expect, it } from 'vitest';

import type { PersonId, TenantId } from '@practicehub/contracts';

import {
  nameForContext,
  outstandingNameAcknowledgments,
  routeExternalNameRejection,
  type PersonName,
} from './names.js';

const tenantId = 'northwind-synthetic' as TenantId;
const personId = 'np-alex-rivera' as PersonId;

const affirmed: PersonName = {
  tenantId,
  personId,
  kind: 'affirmed',
  givenName: 'Alex',
  familyName: 'Rivera',
  effectiveDate: '2026-01-05',
  source: 'synthetic-patient-update',
  unsafeContexts: [],
  synthetic: true,
};

const legal: PersonName = {
  tenantId,
  personId,
  kind: 'legal',
  givenName: 'Alexander',
  familyName: 'Rivera',
  source: 'synthetic-intake',
  unsafeContexts: [],
  synthetic: true,
};

describe('REQ-ID-015: affirmed vs legal rendering', () => {
  it('patient-facing contexts default to the affirmed name (AC-2)', () => {
    const rendered = nameForContext([affirmed, legal], 'care');
    expect(rendered).toEqual({
      givenName: 'Alex',
      familyName: 'Rivera',
      kindUsed: 'affirmed',
      legalIdentifierRequired: false,
    });
  });

  it('a context the patient marked unsafe falls back to the legal name (AC-2)', () => {
    const guarded = { ...affirmed, unsafeContexts: ['portal'] as const };
    expect(nameForContext([guarded, legal], 'portal').kindUsed).toBe('legal');
    expect(nameForContext([guarded, legal], 'care').kindUsed).toBe('affirmed');
  });

  it('legal-matching transactions carry the legal identifier only in the necessary field (AC-3)', () => {
    for (const context of ['payer', 'pharmacy', 'laboratory', 'legal-document'] as const) {
      const rendered = nameForContext([affirmed, legal], context);
      expect(rendered.kindUsed).toBe('legal');
      expect(rendered.legalIdentifierRequired).toBe(true);
      expect(rendered.givenName).toBe('Alexander');
    }
  });

  it('a legal-matching context with no legal record is a data error, never a silent fallback', () => {
    expect(() => nameForContext([affirmed], 'payer')).toThrow(
      /requires a legal matching identifier/,
    );
  });
});

describe('REQ-ID-015 exception 2: external rejection routing', () => {
  it('routes to reconciliation and retains the affirmed name', () => {
    const resolution = routeExternalNameRejection('synthetic-lab', 'synthetic-rejection-0001');
    expect(resolution.outcome).toBe('reconciliation-required');
    expect(resolution.affirmedNameRetained).toBe(true);
  });

  it('an unreferenced rejection is refused', () => {
    expect(() => routeExternalNameRejection('synthetic-lab', '')).toThrow(
      /name its system and reference/,
    );
  });
});

describe('REQ-ID-015 AC-4: unresolved mismatches stay visible', () => {
  it('outstanding systems remain listed until each acknowledges', () => {
    const required = ['synthetic-athena', 'synthetic-lab', 'synthetic-payer'];
    expect(outstandingNameAcknowledgments(required, ['synthetic-lab'])).toEqual([
      'synthetic-athena',
      'synthetic-payer',
    ]);
    expect(outstandingNameAcknowledgments(required, required)).toEqual([]);
  });
});

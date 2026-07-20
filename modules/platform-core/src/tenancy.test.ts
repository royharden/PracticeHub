import { describe, expect, it } from 'vitest';

import type { LegalEntity, Location } from './tenancy.js';
import {
  assertLegalEntityWellFormed,
  assertLocationBelongsTo,
  assertLocationWellFormed,
  assertTenancyId,
  TenancyInvariantError,
} from './tenancy.js';

function entity(overrides: Partial<LegalEntity>): LegalEntity {
  return {
    legalEntityId: 'northwind-health-nv',
    tenantId: 'northwind-synthetic',
    name: 'Northwind Health & Care NV Synthetic PLLC',
    entityType: 'PLLC',
    synthetic: true,
    ...overrides,
  } as LegalEntity;
}

function location(overrides: Partial<Location>): Location {
  return {
    locationId: 'northwind-nv-henderson',
    tenantId: 'northwind-synthetic',
    legalEntityId: 'northwind-health-nv',
    name: 'Northwind Henderson Synthetic Clinic',
    stateCode: 'NV',
    kind: 'physical',
    synthetic: true,
    ...overrides,
  } as Location;
}

describe('tenancy invariants', () => {
  it('accepts controlled-vocabulary ids and rejects everything else', () => {
    expect(() => assertTenancyId('northwind-synthetic', 'tenantId')).not.toThrow();
    for (const bad of ['', 'Upper-Case', 'has space', "quote'attempt", '-leading']) {
      expect(() => assertTenancyId(bad, 'tenantId')).toThrow(TenancyInvariantError);
    }
  });

  it('T-12a: a CPOM entity without counsel ratification fails closed (R6-SR-110)', () => {
    expect(() => assertLegalEntityWellFormed(entity({ cpomState: 'NV' }))).toThrow(
      /counsel ratification/,
    );
    expect(() =>
      assertLegalEntityWellFormed(
        entity({ cpomState: 'NV', counselRatificationRef: 'synthetic-counsel-cpom-nv-001' }),
      ),
    ).not.toThrow();
    expect(() => assertLegalEntityWellFormed(entity({}))).not.toThrow();
  });

  it('rejects malformed state codes on entities and locations', () => {
    expect(() =>
      assertLegalEntityWellFormed(
        entity({ cpomState: 'Nevada', counselRatificationRef: 'synthetic-ref' }),
      ),
    ).toThrow(TenancyInvariantError);
    expect(() => assertLocationWellFormed(location({ stateCode: 'nv' }))).toThrow(
      TenancyInvariantError,
    );
  });

  it('T-08a: a location cannot attach to another tenant or another entity', () => {
    const nvEntity = entity({});
    expect(() => assertLocationBelongsTo(location({}), nvEntity)).not.toThrow();
    expect(() =>
      assertLocationBelongsTo(
        location({ tenantId: 'riverbend-synthetic' } as Partial<Location>),
        nvEntity,
      ),
    ).toThrow(/cannot attach/);
    expect(() =>
      assertLocationBelongsTo(
        location({ legalEntityId: 'northwind-health-fl' } as Partial<Location>),
        nvEntity,
      ),
    ).toThrow(/references legal entity/);
  });
});

import { describe, expect, it } from 'vitest';

import {
  foldVendorRegistry,
  registryCompleteness,
  validateVendorEvent,
  vendorRow,
  VendorRegistryError,
  type VendorRegistryEvent,
} from './vendor-registry.js';

const tenant = 'northwind-synthetic';

function event(
  overrides: Partial<VendorRegistryEvent> & Pick<VendorRegistryEvent, 'version' | 'kind'>,
): VendorRegistryEvent {
  return {
    tenantId: tenant,
    vendorId: 'synthetic-vendor',
    occurredAt: '2026-01-01T00:00:00Z',
    synthetic: true,
    ...overrides,
  };
}

const registered = (): VendorRegistryEvent =>
  event({
    version: 1,
    kind: 'registered',
    vendorClass: 'labs',
    isAiVendor: false,
    enforcementPoint: 'lab-boundary',
    permittedCategories: ['ID', 'CLIN'],
    approvedBy: 'synthetic-compliance-officer',
  });

const executed = (): VendorRegistryEvent =>
  event({
    version: 2,
    kind: 'baa-executed',
    baaStatus: 'executed',
    baaEffective: '2026-01-05',
    baaExpiry: '2027-01-05',
    permittedCategories: ['ID', 'CLIN'],
    approvedBy: 'synthetic-compliance-officer',
  });

describe('foldVendorRegistry', () => {
  it('folds a registered + executed log into the current projection', () => {
    const rows = foldVendorRegistry([registered(), executed()]);
    const row = vendorRow(rows, tenant, 'synthetic-vendor');
    expect(row?.baaStatus).toBe('executed');
    expect(row?.baaExpiry).toBe('2027-01-05');
    expect(row?.permittedCategories).toEqual(['ID', 'CLIN']);
    expect(row?.version).toBe(2);
  });

  it('a category-expanded event unions the permitted categories', () => {
    const rows = foldVendorRegistry([
      registered(),
      executed(),
      event({
        version: 3,
        kind: 'category-expanded',
        permittedCategories: ['GEN'],
        approvedBy: 'synthetic-compliance-officer',
      }),
    ]);
    expect(vendorRow(rows, tenant, 'synthetic-vendor')?.permittedCategories).toEqual([
      'ID',
      'CLIN',
      'GEN',
    ]);
  });

  it('a baa-lapsed event suspends the row so the guard fails closed (REQ-PLAT-001 ex 2)', () => {
    const rows = foldVendorRegistry([
      registered(),
      executed(),
      event({ version: 3, kind: 'baa-lapsed' }),
    ]);
    expect(vendorRow(rows, tenant, 'synthetic-vendor')?.status).toBe('suspended');
  });

  it('refuses a version gap in the log', () => {
    expect(() =>
      foldVendorRegistry([registered(), event({ version: 3, kind: 'baa-lapsed' })]),
    ).toThrow(VendorRegistryError);
  });

  it('refuses an event before the vendor is registered', () => {
    expect(() => foldVendorRegistry([executed()])).toThrow(VendorRegistryError);
  });

  it('an absent vendor resolves to null (the fail-closed lookup)', () => {
    expect(vendorRow(foldVendorRegistry([]), tenant, 'nope')).toBeNull();
  });
});

describe('validateVendorEvent', () => {
  it('a permission-increasing event without approvedBy is refused (compliance sign-off)', () => {
    expect(() =>
      validateVendorEvent(
        event({
          version: 2,
          kind: 'baa-executed',
          baaStatus: 'executed',
          baaEffective: '2026-01-05',
          baaExpiry: '2027-01-05',
        }),
      ),
    ).toThrow(/approvedBy/);
  });

  it('a protective suspend event does NOT require sign-off', () => {
    expect(() => validateVendorEvent(event({ version: 3, kind: 'suspended' }))).not.toThrow();
  });

  it('a registered event must declare class/ai/enforcement', () => {
    expect(() =>
      validateVendorEvent(
        event({ version: 1, kind: 'registered', approvedBy: 'synthetic-compliance-officer' }),
      ),
    ).toThrow(/vendorClass/);
  });

  it('an unknown PHI category is refused', () => {
    expect(() =>
      validateVendorEvent(
        event({
          version: 1,
          kind: 'registered',
          vendorClass: 'labs',
          isAiVendor: false,
          enforcementPoint: 'x',
          permittedCategories: ['NOPE' as never],
          approvedBy: 'synthetic-compliance-officer',
        }),
      ),
    ).toThrow(/category/);
  });
});

describe('registryCompleteness (go-live gate, REQ-PLAT-001 AC-7 / REQ-PLAT-005 AC-4)', () => {
  it('confirms every PHI-path vendor has an executed, in-date, un-suspended BAA', () => {
    const rows = foldVendorRegistry([registered(), executed()]);
    const result = registryCompleteness(rows, ['synthetic-vendor'], tenant, '2026-06-01');
    expect(result.complete).toBe(true);
    expect(result.incomplete).toEqual([]);
  });

  it('names a PHI-path vendor whose BAA is not executed / not yet on record', () => {
    const rows = foldVendorRegistry([registered()]);
    const result = registryCompleteness(
      rows,
      ['synthetic-vendor', 'synthetic-missing'],
      tenant,
      '2026-06-01',
    );
    expect(result.complete).toBe(false);
    expect(result.incomplete).toEqual(['synthetic-vendor', 'synthetic-missing']);
  });

  it('names a vendor whose BAA has expired as of the check date', () => {
    const rows = foldVendorRegistry([
      registered(),
      event({
        version: 2,
        kind: 'baa-executed',
        baaStatus: 'executed',
        baaEffective: '2026-01-05',
        baaExpiry: '2026-03-05',
        approvedBy: 'synthetic-compliance-officer',
      }),
    ]);
    expect(
      registryCompleteness(rows, ['synthetic-vendor'], tenant, '2026-06-01').incomplete,
    ).toEqual(['synthetic-vendor']);
  });
});

import { describe, expect, it } from 'vitest';

import { TenantIsolationStore } from './store.js';
import { Wp126WhiteLabelDoubleV1 } from './testing/wp126-whitelabel-double-v1.js';
import { IsolationError } from './types.js';

const tenant1 = 'northwind-synthetic';
const tenant2 = 'riverbend-synthetic';

const make = (): TenantIsolationStore => {
  const whiteLabel = new Wp126WhiteLabelDoubleV1();
  whiteLabel.register({
    tenantId: tenant1,
    brandName: 'Northwind Synthetic',
    jurisdiction: 'ON',
    paletteRef: 'palette-nw',
  });
  whiteLabel.register({
    tenantId: tenant2,
    brandName: 'Riverbend Synthetic',
    jurisdiction: 'MI',
    paletteRef: 'palette-rb',
  });
  const store = new TenantIsolationStore(whiteLabel);
  store.put({ tenantId: tenant1, recordId: 'rec-1', kind: 'chart-stub' });
  store.put({ tenantId: tenant2, recordId: 'rec-2', kind: 'chart-stub' });
  return store;
};

describe('TenantIsolationStore', () => {
  it('returns only the calling tenant brand', () => {
    const store = make();
    expect(store.brand(tenant1).brandName).toBe('Northwind Synthetic');
    expect(store.brand(tenant2).brandName).toBe('Riverbend Synthetic');
    expect(store.brand(tenant1).jurisdiction).not.toBe(store.brand(tenant2).jurisdiction);
  });

  it('lists records only for the calling tenant', () => {
    const store = make();
    expect(store.list(tenant1).map((row) => row.recordId)).toEqual(['rec-1']);
    expect(store.list(tenant2).map((row) => row.recordId)).toEqual(['rec-2']);
  });

  it('refuses tenant-2 reading a tenant-1 record id', () => {
    const store = make();
    expect(() => store.get(tenant2, 'rec-1')).toThrow(IsolationError);
    expect(() => store.get(tenant2, 'rec-1')).toThrow('CROSS_TENANT');
  });

  it('refuses an unknown tenant instead of falling back to tenant-1 branding', () => {
    const store = make();
    expect(() => store.brand('unknown-tenant')).toThrow('UNKNOWN_TENANT');
  });
});

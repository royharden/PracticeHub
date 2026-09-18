import { describe, expect, it } from 'vitest';

import { assembleTenant2Profile } from './assemble.js';
import { TenantWhiteLabelStore } from './store.js';
import { wp077BrandDoubleV1 } from './testing/wp077-brand-double-v1.js';
import { wp118BootstrapDoubleV1 } from './testing/wp118-bootstrap-double-v1.js';
import { WhiteLabelError } from './types.js';

function tenant2() {
  return assembleTenant2Profile({
    tenantId: 'tenant-2',
    brand: wp077BrandDoubleV1(),
    bootstrap: wp118BootstrapDoubleV1(),
    faxCoverRef: 'tpl:fax-2',
    letterheadRef: 'tpl:letter-2',
    printers: ['prn:t2'],
    faxNumberRef: 'fax:t2',
    synthetic: true,
  });
}

describe('TenantWhiteLabelStore isolation', () => {
  it('lets tenant-2 read its own brand hours templates printers fax', () => {
    const store = new TenantWhiteLabelStore();
    store.put(tenant2(), 'tenant-2');
    const profile = store.get('tenant-2', 'tenant-2');
    expect(profile.brand.wordmark).toBe('wordmark:tenant-2');
    expect(profile.hours.timezone).toBe('tz:tenant-2');
    expect(profile.templates.faxCoverRef).toBe('tpl:fax-2');
    expect(profile.printers).toEqual(['prn:t2']);
    expect(profile.faxNumberRef).toBe('fax:t2');
  });

  it('forbids tenant-1 from reading tenant-2 white-label', () => {
    const store = new TenantWhiteLabelStore();
    store.put(tenant2(), 'tenant-2');
    expect(() => store.get('tenant-2', 'tenant-1')).toThrow(WhiteLabelError);
  });

  it('forbids a write using another tenant actor', () => {
    const store = new TenantWhiteLabelStore();
    expect(() => store.put(tenant2(), 'tenant-1')).toThrow(
      'cross-tenant white-label write is forbidden',
    );
  });
});

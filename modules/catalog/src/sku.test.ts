import { describe, expect, it } from 'vitest';

import { assertOpaqueProcessorSku, SkuError } from './sku.js';

describe('SKU grammar', () => {
  it('accepts an opaque processor SKU', () => {
    expect(assertOpaqueProcessorSku('sku:nwind-o1-aaaa')).toBe('sku:nwind-o1-aaaa');
  });

  it('rejects missing prefix, short bodies, uppercase, and spaces', () => {
    expect(() => assertOpaqueProcessorSku('nwind-o1-aaaa')).toThrowError(
      new SkuError('SKU_GRAMMAR'),
    );
    expect(() => assertOpaqueProcessorSku('sku:short')).toThrowError(new SkuError('SKU_GRAMMAR'));
    expect(() => assertOpaqueProcessorSku('sku:Nwind-o1-aaaa')).toThrowError(
      new SkuError('SKU_GRAMMAR'),
    );
    expect(() => assertOpaqueProcessorSku('sku:nwind o1 aaaa')).toThrowError(
      new SkuError('SKU_GRAMMAR'),
    );
  });

  it('rejects health-revealing tokens including obfuscations', () => {
    expect(() => assertOpaqueProcessorSku('sku:glp-1-offer-x')).toThrowError(
      new SkuError('SKU_HEALTH_REVEALING'),
    );
    expect(() => assertOpaqueProcessorSku('sku:sema-glutide')).toThrowError(
      new SkuError('SKU_HEALTH_REVEALING'),
    );
    expect(() => assertOpaqueProcessorSku('sku:awv-visit-01')).toThrowError(
      new SkuError('SKU_HEALTH_REVEALING'),
    );
  });
});

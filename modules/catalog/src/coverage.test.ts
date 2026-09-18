import { describe, expect, it } from 'vitest';

import { CoverageError, CoverageFlags, type CoverageFlag } from './coverage.js';

const flag: CoverageFlag = {
  tenantId: 'northwind-synthetic',
  payerRef: 'payer-cash',
  skuRef: 'sku:nwind-o1-aaaa',
  tableVersionRef: 'cov-v1',
  classification: 'non-covered',
};

describe('coverage flags', () => {
  it('resolves a classified flag and default-denies unclassified', () => {
    const flags = new CoverageFlags();
    flags.add(flag);
    expect(flags.resolve(flag).classification).toBe('non-covered');
    flags.add({ ...flag, skuRef: 'sku:nwind-o2-bbbb', classification: 'unclassified' });
    expect(() => flags.resolve({ ...flag, skuRef: 'sku:nwind-o2-bbbb' })).toThrowError(
      new CoverageError('UNCLASSIFIED'),
    );
  });

  it('fails closed without payer context or a matching flag', () => {
    const flags = new CoverageFlags();
    flags.add(flag);
    expect(() => flags.resolve({ ...flag, payerRef: '' })).toThrowError(
      new CoverageError('PAYER_CONTEXT_MISSING'),
    );
    expect(() => flags.resolve({ ...flag, payerRef: 'payer-other' })).toThrowError(
      new CoverageError('FLAG_NOT_FOUND'),
    );
  });
});

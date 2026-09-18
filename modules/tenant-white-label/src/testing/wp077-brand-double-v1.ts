import type { BrandKitDouble } from '../ports.js';

export function wp077BrandDoubleV1(): BrandKitDouble {
  return {
    doubleId: 'wp077-brand-double/v1',
    wordmarkFor(tenantId) {
      return `wordmark:${tenantId}`;
    },
  };
}

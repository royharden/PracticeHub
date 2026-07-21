import { describe, expect, it } from 'vitest';

import type { TenantId, PersonId } from '@practicehub/contracts';

import { createIdProofStub } from './index.js';

const request = {
  tenantId: 'northwind-synthetic' as TenantId,
  personId: 'np-alex-rivera' as PersonId,
  method: 'document',
  synthetic: true,
} as const;

describe('idproof-sim stub', () => {
  it('pass scenario verifies with a deterministic evidence reference', () => {
    const result = createIdProofStub('pass').prove(request);
    expect(result.verified).toBe(true);
    expect(result.evidenceRef).toBe('synthetic-idproof:np-alex-rivera:document');
    expect(result.synthetic).toBe(true);
  });

  it('fail scenario refuses with a reason and refusal evidence', () => {
    const result = createIdProofStub('fail').prove(request);
    expect(result.verified).toBe(false);
    expect(result.failureReason).toBe('synthetic-scenario-fail');
  });

  it('refuses an unwatermarked request at runtime', () => {
    const raw = { ...request, synthetic: false } as unknown as typeof request;
    expect(() => createIdProofStub().prove(raw)).toThrow('synthetic requests only');
  });
});

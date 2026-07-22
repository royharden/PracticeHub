/**
 * Policy/disclosure registry unit tests (WP-019, ADR-007 D3). Effective-dated
 * resolution through the SHARED primitive, base-variant fallback, fail-closed
 * paths, and policy-version stamping.
 */
import { describe, expect, it } from 'vitest';

import {
  assertPolicyRegistryWellFormed,
  policyVersionStamp,
  resolvePolicyDocument,
  PolicyRegistryError,
  type PolicyDocumentVersion,
} from './policy-registry.js';
import { syntheticPolicyDocumentsV1 } from './policy-clock-seed.js';

const documents = syntheticPolicyDocumentsV1;

describe('resolvePolicyDocument (effective-dated, ADR-ADJ-002 shared model)', () => {
  it('selects the MN disclosure-authorization variant on/after its effective date', () => {
    const resolution = resolvePolicyDocument(
      documents,
      'northwind-synthetic',
      'disclosure-authorization',
      'MN',
      '2026-06-01',
    );
    expect(resolution.jurisdiction).toBe('MN');
    expect(resolution.version).toBe(1);
    expect(resolution.fallbackToBase).toBe(false);
    expect(resolution.counselReviewPending).toBe(true); // draft
  });

  it('falls back to the floor base variant before the state variant is effective', () => {
    const resolution = resolvePolicyDocument(
      documents,
      'northwind-synthetic',
      'disclosure-authorization',
      'MN',
      '2025-12-31',
    );
    expect(resolution.jurisdiction).toBe('floor');
    expect(resolution.fallbackToBase).toBe(true);
  });

  it('falls back to the base for a state with no variant at all', () => {
    const resolution = resolvePolicyDocument(
      documents,
      'northwind-synthetic',
      'disclosure-authorization',
      'NV',
      '2026-06-01',
    );
    expect(resolution.jurisdiction).toBe('floor');
    expect(resolution.fallbackToBase).toBe(true);
  });

  it('stamps a grammar-safe policy version for the consent ledger', () => {
    const resolution = resolvePolicyDocument(
      documents,
      'northwind-synthetic',
      'disclosure-authorization',
      'MN',
      '2026-06-01',
    );
    expect(policyVersionStamp(resolution)).toBe('disclosure-authorization:MN:v1');
  });

  it('fails closed for a brand/type with no policy at all', () => {
    expect(() =>
      resolvePolicyDocument(
        documents,
        'northwind-synthetic',
        'terms-of-service',
        'MN',
        '2026-06-01',
      ),
    ).toThrow(PolicyRegistryError);
  });
});

describe('registry validation', () => {
  it('requires a floor base variant for every (tenant, documentType) pair', () => {
    const missingBase: PolicyDocumentVersion[] = documents.filter(
      (document) =>
        !(
          document.tenantId === 'northwind-synthetic' &&
          document.documentType === 'ai-disclosure' &&
          document.jurisdiction === 'floor'
        ),
    );
    // Add a state-only ai-disclosure variant so the pair exists without a base.
    missingBase.push({
      tenantId: 'northwind-synthetic',
      documentType: 'ai-disclosure',
      jurisdiction: 'NV',
      version: 1,
      effectiveOn: '2026-01-01',
      status: 'draft',
      changeControlRef: 'wp-019-ai-nv-v1',
      contentRef: 'policy-doc:northwind:ai-disclosure:nv:v1',
      contentHash: 'a'.repeat(64),
      synthetic: true,
    });
    expect(() => assertPolicyRegistryWellFormed(missingBase)).toThrow(
      /missing the 'floor' base variant/,
    );
  });

  it('requires the earliest base variant to carry the epoch sentinel', () => {
    const misdated: PolicyDocumentVersion[] = documents.map((document) =>
      document.documentType === 'ai-disclosure' && document.jurisdiction === 'floor'
        ? { ...document, effectiveOn: '2026-01-01' }
        : document,
    );
    expect(() => assertPolicyRegistryWellFormed(misdated)).toThrow(/epoch sentinel/);
  });

  it('rejects a counsel-signed document with no sign-off ref', () => {
    const unsigned: PolicyDocumentVersion[] = [
      {
        tenantId: 'northwind-synthetic',
        documentType: 'recording-notice',
        jurisdiction: 'floor',
        version: 1,
        effectiveOn: '1970-01-01',
        status: 'counsel-signed',
        changeControlRef: 'wp-019-recording-floor-v1',
        contentRef: 'policy-doc:northwind:recording-notice:floor:v1',
        contentHash: 'b'.repeat(64),
        synthetic: true,
      },
    ];
    expect(() => assertPolicyRegistryWellFormed(unsigned)).toThrow(/counsel sign-off reference/);
  });
});

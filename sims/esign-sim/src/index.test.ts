import {
  appendDocumentVersion,
  blobRefFor,
  contentByteLength,
  hashContent,
  type SignatureRequest,
} from '@practicehub/documents';
import { describe, expect, it } from 'vitest';

import { createEsignStub } from './index.js';

const tenant = 'northwind-synthetic';

function request(): SignatureRequest {
  return {
    requestId: 'nesr-test-0001',
    tenantId: tenant,
    documentId: 'nd-esign-0001',
    versionNo: 2,
    contentHash: hashContent('synthetic-consent-form-signed'),
    signerRefs: ['synthetic-patient:np-sam-porter'],
    method: 'click-to-sign',
    synthetic: true,
  };
}

describe('esign-sim stub', () => {
  it('a signed scenario returns a closed evidence chain that can become an esign version', () => {
    const rail = createEsignStub('signed');
    const evidence = rail.request(request());
    expect(evidence.status).toBe('signed');
    expect(evidence.certificateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.signedAt).toBeDefined();

    // the signed evidence records a real document version (closure)
    const content = 'synthetic-consent-form-signed';
    const hash = hashContent(content);
    const original = appendDocumentVersion([], {
      versionEventId: 'nv-esign-0001',
      tenantId: tenant,
      documentId: 'nd-esign-0001',
      versionNo: 1,
      kind: 'original',
      blobRef: blobRefFor(hashContent('synthetic-consent-form-unsigned')),
      contentHash: hashContent('synthetic-consent-form-unsigned'),
      contentBytes: contentByteLength('synthetic-consent-form-unsigned'),
      mediaType: 'application/pdf',
      actorRef: 'synthetic-portal-intake',
      occurredAt: '2026-03-09T08:00:00Z',
      synthetic: true,
    }).versions;
    const { version } = appendDocumentVersion(original, {
      versionEventId: 'nv-esign-0002',
      tenantId: tenant,
      documentId: 'nd-esign-0001',
      versionNo: 2,
      kind: 'esign-execution',
      blobRef: blobRefFor(hash),
      contentHash: hash,
      contentBytes: contentByteLength(content),
      mediaType: 'application/pdf',
      supersedesVersionNo: 1,
      signature: evidence,
      actorRef: 'synthetic-esign-rail',
      occurredAt: '2026-03-09T08:30:00Z',
      synthetic: true,
    });
    expect(version.kind).toBe('esign-execution');
  });

  it('pending and declined scenarios are not closure — they carry no certificate', () => {
    for (const scenario of ['pending', 'declined'] as const) {
      const evidence = createEsignStub(scenario).request(request());
      expect(evidence.status).toBe(scenario);
      expect(evidence.certificateHash).toBeUndefined();
      expect(evidence.signedAt).toBeUndefined();
    }
  });

  it('poll returns the recorded outcome and throws for an unknown request', () => {
    const rail = createEsignStub('signed');
    rail.request(request());
    expect(rail.poll('nesr-test-0001').status).toBe('signed');
    expect(() => rail.poll('nesr-unknown')).toThrow(/no outcome/);
  });

  it('refuses a non-synthetic request', () => {
    const rail = createEsignStub('signed');
    expect(() => rail.request({ ...request(), synthetic: false as unknown as true })).toThrow(
      /synthetic/,
    );
  });
});

import { describe, expect, it } from 'vitest';

import { synthCorpusFindings, synthCorpusManifest } from './synthgen-corpus.js';

const corpus = {
  synthetic: true,
  corpus_version: 'SynthCorpus-v1',
  tenant_id: 'northwind-synthetic',
  subjects: [{ subjectId: 'sg-p-0001', synthetic: true }],
  import_quarantine: [
    {
      rowRef: 'sy-orphan-0011/syn-cond-005',
      reason: 'unresolved-subject',
      observedAttributeNames: ['subject-ref'],
      synthetic: true,
    },
  ],
  collisions: [
    {
      collisionId: 'sg-col-0001',
      knownTruth: 'distinct-person',
      sharedAttributeNames: ['phone-endpoint', 'email-endpoint'],
      synthetic: true,
    },
  ],
} as const;

describe('WP-029 corpus contract double', () => {
  it('surfaces quarantines and known-truth collisions as distinct workbench findings', () => {
    const manifest = synthCorpusManifest(corpus, 'a'.repeat(64));
    const findings = synthCorpusFindings(corpus);
    expect(manifest.inScopeRecordRefs).toEqual(['sg-p-0001', 'sy-orphan-0011/syn-cond-005']);
    expect(findings.map((finding) => finding.category)).toEqual([
      'business-rule',
      'identity-ambiguity',
    ]);
    expect(findings.every((finding) => finding.tenantId === corpus.tenant_id)).toBe(true);
    expect(findings.every((finding) => finding.synthetic)).toBe(true);
  });
});

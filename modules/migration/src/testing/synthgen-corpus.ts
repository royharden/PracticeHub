import type { SourceManifest, ValidationFinding } from '../types.js';

export interface SynthCorpusMigrationInput {
  readonly synthetic: true;
  readonly corpus_version: string;
  readonly tenant_id: string;
  readonly subjects: readonly { readonly subjectId: string; readonly synthetic: true }[];
  readonly import_quarantine: readonly {
    readonly rowRef: string;
    readonly reason: string;
    readonly observedAttributeNames: readonly string[];
    readonly synthetic: true;
  }[];
  readonly collisions: readonly {
    readonly collisionId: string;
    readonly knownTruth: 'distinct-person' | 'same-person';
    readonly sharedAttributeNames: readonly string[];
    readonly synthetic: true;
  }[];
}

const quarantineCategory = (reason: string): ValidationFinding['category'] => {
  if (reason === 'unresolved-subject') return 'business-rule';
  if (reason === 'missing-required-field') return 'required-field';
  if (reason === 'unmapped-code') return 'unmapped-field';
  return 'schema';
};

export function synthCorpusManifest(
  corpus: SynthCorpusMigrationInput,
  sourceManifestHash: string,
): SourceManifest {
  return {
    tenantId: corpus.tenant_id,
    sourceSystemRef: 'synthea-synthetic',
    sourceManifestRef: `manifest:${corpus.corpus_version.toLowerCase()}`,
    sourceManifestHash,
    structurallyReadable: true,
    inScopeRecordRefs: [
      ...corpus.subjects.map((subject) => subject.subjectId),
      ...corpus.import_quarantine.map((row) => row.rowRef),
    ],
    sourceFields: ['patient-id', 'birth-date'],
    synthetic: true,
  };
}

export function synthCorpusFindings(
  corpus: SynthCorpusMigrationInput,
): readonly ValidationFinding[] {
  const quarantine: ValidationFinding[] = corpus.import_quarantine.map((row, index) => ({
    findingRef: `finding:corpus-quarantine-${String(index + 1).padStart(4, '0')}`,
    tenantId: corpus.tenant_id,
    recordRef: row.rowRef,
    category: quarantineCategory(row.reason),
    triage: row.reason === 'unmapped-code' ? 'auto-fixable' : 'needs-source-correction',
    observedAttributeNames: row.observedAttributeNames,
    synthetic: true,
  }));
  const collisions: ValidationFinding[] = corpus.collisions.map((collision) => ({
    findingRef: `finding:${collision.collisionId}`,
    tenantId: corpus.tenant_id,
    recordRef: corpus.subjects[0]?.subjectId ?? collision.collisionId,
    category: 'identity-ambiguity',
    triage: 'identity-review',
    observedAttributeNames: collision.sharedAttributeNames,
    synthetic: true,
  }));
  return [...quarantine, ...collisions];
}

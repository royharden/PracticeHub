export type MigrationPlanRef = string;
export type MappingVersionRef = string;
export type SourceManifestRef = string;
export type MigrationBatchRef = string;
export type ValidationRunRef = string;
export type FindingRef = string;

export type FieldDisposition = 'mapped' | 'unmapped' | 'excluded-with-reason';

export interface MappingRule {
  readonly sourceField: string;
  readonly disposition: FieldDisposition;
  readonly targetField?: string;
  readonly exclusionReasonRef?: string;
  readonly transformRef?: string;
  readonly dataClassification: 'none' | 'demographic' | 'phi' | 'phi-restricted';
}

export interface MappingVersion {
  readonly tenantId: string;
  readonly sourceSystemRef: string;
  readonly mappingVersionRef: MappingVersionRef;
  readonly mappingVersionHash: string;
  readonly status: 'review-required' | 'approved';
  readonly approvedBy?: string;
  readonly approvalEvidenceRef?: string;
  readonly rules: readonly MappingRule[];
  readonly synthetic: true;
}

export interface SourceManifest {
  readonly tenantId: string;
  readonly sourceSystemRef: string;
  readonly sourceManifestRef: SourceManifestRef;
  readonly sourceManifestHash: string;
  readonly structurallyReadable: boolean;
  readonly inScopeRecordRefs: readonly string[];
  readonly sourceFields: readonly string[];
  readonly synthetic: true;
}

export const findingCategories = [
  'schema',
  'required-field',
  'business-rule',
  'unmapped-field',
  'type-mismatch',
  'out-of-range',
  'identity-ambiguity',
  'genetic-misclassification',
  'payer-panel-unmapped',
  'file-structural-error',
] as const;

export type FindingCategory = (typeof findingCategories)[number];

export const findingTriages = [
  'auto-fixable',
  'needs-source-correction',
  'identity-review',
  'file-level-quarantine',
] as const;

export type FindingTriage = (typeof findingTriages)[number];

export interface ValidationFinding {
  readonly findingRef: FindingRef;
  readonly tenantId: string;
  readonly recordRef?: string;
  readonly category: FindingCategory;
  readonly triage: FindingTriage;
  readonly mappingRuleRef?: string;
  readonly observedAttributeNames: readonly string[];
  readonly synthetic: true;
}

export interface ControlTotal {
  readonly totalRef: string;
  readonly tenantId: string;
  readonly side: 'source' | 'candidate-target';
  readonly name: string;
  readonly valueMinor: string;
  readonly unit: string;
  readonly currency?: string;
  readonly checksum: string;
  readonly synthetic: true;
}

export interface ReconciledControlTotal {
  readonly name: string;
  readonly state: 'reconciled' | 'explained-difference' | 'blocking';
  readonly source: ControlTotal;
  readonly target: ControlTotal;
  readonly explanationRef?: string;
}

export interface DryRunEvidence {
  readonly codeVersionRef: string;
  readonly configVersionRef: string;
  readonly sampleEvidenceRefs: readonly string[];
  readonly runtimeMilliseconds: number;
  readonly signoffRefs: readonly string[];
}

export interface DryRunComparison {
  readonly sourceRecordCount: number;
  readonly candidateRecordCount: number;
  readonly keyFieldCompleteness: Readonly<
    Record<
      string,
      {
        readonly sourceCompleteCount: number;
        readonly candidateCompleteCount: number;
      }
    >
  >;
  readonly identityMatchResults: Readonly<
    Record<'matched' | 'candidate' | 'ambiguous' | 'unmatched', number>
  >;
  readonly outcomeCounts: Readonly<Record<'created' | 'updated' | 'merged' | 'flagged', number>>;
}

export interface DryRunReport {
  readonly tenantId: string;
  readonly waveRef: string;
  readonly runRef: ValidationRunRef;
  readonly predecessorRunRef?: ValidationRunRef;
  readonly sourceManifestRef: SourceManifestRef;
  readonly sourceManifestHash: string;
  readonly mappingVersionRef: MappingVersionRef;
  readonly mappingVersionHash: string;
  readonly findings: readonly ValidationFinding[];
  readonly failureCountsByCategory: Partial<Readonly<Record<FindingCategory, number>>>;
  readonly failedRecordRefs: readonly string[];
  readonly failedRecordCount: number;
  readonly inScopeRecordCount: number;
  readonly thresholdBasisPoints: number;
  readonly thresholdState: 'clear' | 'blocked' | 'held-until-below';
  readonly readiness: 'blocked' | 'ready-for-review';
  readonly blockerCodes: readonly string[];
  readonly controlTotals: readonly ReconciledControlTotal[];
  readonly comparison: DryRunComparison;
  readonly failedRecordCountChange?: number;
  readonly evidence: DryRunEvidence;
  readonly proposedWriteSetHash: string;
  readonly targetDataWrites: 0;
  readonly synthetic: true;
}

export interface WorkbenchContext {
  readonly tenantId: string;
  readonly legalEntityId: string;
  readonly waveRef: string;
}

export interface CapabilityGrantSnapshot {
  readonly tenantId: string;
  readonly capabilityId: string;
  readonly state:
    | 'disabled'
    | 'scaffolded'
    | 'simulated'
    | 'shadow'
    | 'pilot'
    | 'active'
    | 'read-only'
    | 'retiring';
  readonly waveRef?: string;
}

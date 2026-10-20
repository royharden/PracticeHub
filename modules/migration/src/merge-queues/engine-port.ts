/**
 * WP-111 consumer port over the FROZEN WP-016 merge-governance engine
 * (docs/contracts/merge-governance.md, `modules/identity/src/merge.ts`).
 *
 * `@practicehub/migration` does not yet depend on `@practicehub/identity`
 * (package.json and the lockfile are integrator-owned), so this port mirrors
 * the frozen shapes WP-111 uses with plain-string ids. The binding adapter
 * (identity's branded `TenantId`/`PersonId` plus the real functions) replaces
 * `FrozenMergeEngineDouble` once the dependency is added: FWD-MIG-111-ENGINE-BIND.
 * Every shape below is a structural subset of the frozen contract.
 */

export const mergeArtifactKindsV1 = [
  'patient-record',
  'person-name',
  'endpoint-association',
  'source-identifier',
  'guarantor-role',
  'proxy-grant',
  'timeline-entry',
] as const;

export const identityMatchAttributeNames = [
  'given-name',
  'family-name',
  'birth-date',
  'phone',
  'email',
  'postal-address',
] as const;

export type MatchAttribute = (typeof identityMatchAttributeNames)[number];

export const specializedReviewPatternNames = [
  'minor-or-proxy',
  'shared-household-contact',
  'name-change',
  'sponsor-roster',
  'duplicate-payment-rail-email',
] as const;

export type SpecializedPattern = (typeof specializedReviewPatternNames)[number];

export type Confidence = 'high' | 'medium' | 'low';

export interface EngineMergeCase {
  readonly caseId: string;
  readonly tenantId: string;
  readonly kind:
    'possible-match' | 'check-in-duplicate' | 'staff-flagged-duplicate' | 'wrong-merge-suspect';
  readonly status:
    'open' | 'resolved-linked' | 'resolved-distinct' | 'resolved-merged' | 'dismissed';
  readonly personIds: readonly string[];
  readonly matchedAttributes: readonly MatchAttribute[];
  readonly conflictingAttributes: readonly MatchAttribute[];
  readonly confidence: Confidence;
  readonly contactRisk: boolean;
  readonly sourceIdRefs: readonly string[];
  readonly specializedPatterns: readonly SpecializedPattern[];
  readonly openedBy: string;
  readonly source: string;
  readonly synthetic: boolean;
}

export interface EngineOpenCaseInput {
  readonly caseId: string;
  readonly tenantId: string;
  readonly kind: 'possible-match';
  readonly personIds: readonly string[];
  readonly matchedAttributes: readonly MatchAttribute[];
  readonly conflictingAttributes: readonly MatchAttribute[];
  readonly confidence: Confidence;
  readonly contactRisk: boolean;
  readonly sourceIdRefs: readonly string[];
  readonly specializedPatterns: readonly SpecializedPattern[];
  readonly openedBy: string;
  readonly source: string;
}

export interface EngineMergeArtifact {
  readonly kind: string;
  readonly artifactRef: string;
  readonly ownerPersonId: string;
}

export interface EngineMergeEvent {
  readonly eventId: string;
  readonly tenantId: string;
  readonly caseId: string;
  readonly kind: 'merge' | 'unmerge';
  readonly survivorPersonId: string;
  readonly mergedPersonId: string;
  readonly basisAttributes: readonly MatchAttribute[];
  readonly decidedBy: string;
  readonly rationale: string;
  readonly evidenceRef?: string;
  readonly reversesEventId?: string;
  readonly synthetic: boolean;
}

export interface EngineLineageRecord {
  readonly lineageId: string;
  readonly tenantId: string;
  readonly eventId: string;
  readonly artifactKind: string;
  readonly artifactRef: string;
  readonly fromPersonId: string;
  readonly toPersonId: string;
  readonly disposition: 're-attributed' | 'indeterminate-quarantined';
  readonly synthetic: boolean;
}

export interface EngineMergeInput {
  readonly mergeCase: EngineMergeCase;
  readonly basis: {
    readonly comparedAttributes: readonly MatchAttribute[];
    readonly decidedBy: string;
  };
  readonly eventId: string;
  readonly survivorPersonId: string;
  readonly mergedPersonId: string;
  readonly artifacts: readonly EngineMergeArtifact[];
  readonly mergedPersonSourceIdRefs: readonly string[];
  readonly rationale: string;
  readonly evidenceRef: string;
  readonly specializedChecksRef?: string;
}

export interface EngineMergeExecution {
  readonly event: EngineMergeEvent;
  readonly lineage: readonly EngineLineageRecord[];
  readonly resolvedCase: EngineMergeCase;
  readonly preservedAliases: readonly string[];
  readonly aliasesPreserved: true;
}

export interface EnginePostMergeArtifact {
  readonly kind: string;
  readonly artifactRef: string;
  readonly referencesPersonIds: readonly string[];
}

export interface EngineUnmergeInput {
  readonly mergeEvent: EngineMergeEvent;
  readonly lineage: readonly EngineLineageRecord[];
  readonly postMergeArtifacts: readonly EnginePostMergeArtifact[];
  readonly eventId: string;
  readonly approvedBy: string;
  readonly rationale: string;
  readonly applyRestore?: (record: EngineLineageRecord) => void;
}

export type EngineUnmergeOutcome =
  | {
      readonly outcome: 'unmerged';
      readonly event: EngineMergeEvent;
      readonly restoredLineage: readonly EngineLineageRecord[];
      readonly quarantined: readonly EngineLineageRecord[];
      readonly report: {
        readonly rows: readonly {
          readonly artifactRef: string;
          readonly artifactKind: string;
          readonly preUnmergeOwner: string;
          readonly postUnmergeOwner: string;
        }[];
        readonly indeterminateCount: number;
      };
    }
  | {
      readonly outcome: 'blocked-no-lineage';
      readonly manualChartReviewOpened: true;
      readonly autoSplitRefused: true;
    }
  | {
      readonly outcome: 'rolled-back-to-merged';
      readonly noHalfSplit: true;
      readonly p0Alert: {
        readonly severity: 'P0';
        readonly kind: 'unmerge-partial-failure';
        readonly failedArtifactRef: string;
      };
    };

export type DownstreamSystemName = 'claims' | 'messages' | 'portal-results' | 'referrals';

export interface EngineDownstreamExposure {
  readonly system: DownstreamSystemName;
  readonly artifactRef: string;
  readonly exposedPersonId: string;
  readonly correctPersonId: string;
  readonly status: 'submitted' | 'adjudicated-paid' | 'sent' | 'released' | 'active';
  readonly electronicCorrectionSupported: boolean;
  readonly materializedClinicalDecision?: boolean;
}

export interface EngineCorrectionDirective {
  readonly system: DownstreamSystemName;
  readonly ownerRole: string;
  readonly artifactRef: string;
  readonly action: 'electronic-correction' | 'rcm-void-rebill-refund' | 'manual-correction-task';
  readonly trackedConfirmationRequired: boolean;
}

export interface EngineUnmergePropagation {
  readonly directives: readonly EngineCorrectionDirective[];
  readonly wrongDisclosureIncidents: readonly {
    readonly artifactRef: string;
    readonly system: DownstreamSystemName;
    readonly exposedPersonId: string;
    readonly linkedWorkflow: 'phi-breach-evaluation';
  }[];
  readonly harmReview: { readonly taskOwner: 'clinician'; readonly findingRecorded: boolean };
  readonly escalations: readonly {
    readonly artifactRef: string;
    readonly escalateTo: 'treating-provider';
    readonly immediate: true;
  }[];
}

export type EngineClosureReport =
  | { readonly complete: true; readonly confirmedCount: number }
  | { readonly complete: false; readonly outstanding: readonly string[] };

/** The engine operations WP-111 drives. Opening a case never merges. */
export interface IdentityMergeEnginePort {
  openMergeCase(input: EngineOpenCaseInput): EngineMergeCase;
  executeMerge(input: EngineMergeInput): EngineMergeExecution;
  resolveMergedPerson(
    events: readonly EngineMergeEvent[],
    personId: string,
  ): { readonly personId: string; readonly redirected: boolean };
  executeUnmerge(input: EngineUnmergeInput): EngineUnmergeOutcome;
  propagateUnmerge(exposures: readonly EngineDownstreamExposure[]): EngineUnmergePropagation;
  unmergeClosureReport(
    directives: readonly EngineCorrectionDirective[],
    confirmations: ReadonlyMap<string, string>,
  ): EngineClosureReport;
}

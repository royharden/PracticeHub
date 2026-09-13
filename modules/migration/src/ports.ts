import type {
  ControlTotal,
  DryRunComparison,
  DryRunReport,
  MappingVersion,
  SourceManifest,
  ValidationFinding,
  WorkbenchContext,
} from './types.js';

/** Read-only source surface. Implementations freeze bytes behind the manifest hash. */
export interface SourceSnapshotPort {
  open(context: WorkbenchContext, manifestRef: string): SourceManifest;
}

/**
 * Deliberately contains no apply/write method. A dry-run composition cannot
 * acquire target-domain write authority through this interface.
 */
export interface TargetDryRunPort {
  validate(
    context: WorkbenchContext,
    manifest: SourceManifest,
    mapping: MappingVersion,
  ): {
    readonly findings: readonly ValidationFinding[];
    readonly controlTotals: readonly ControlTotal[];
    readonly proposedWriteSetHash: string;
    readonly candidateRecordCount: number;
    readonly keyFieldCompleteness: DryRunComparison['keyFieldCompleteness'];
    readonly outcomeCounts: DryRunComparison['outcomeCounts'];
  };
}

/** Produces candidates only. WP-111 owns feeding and operating the real merge queue. */
export interface IdentityCandidatePort {
  score(
    context: WorkbenchContext,
    manifest: SourceManifest,
  ): {
    readonly findings: readonly ValidationFinding[];
    readonly resultCounts: DryRunComparison['identityMatchResults'];
  };
}

export interface SourceControlTotalPort {
  calculate(context: WorkbenchContext, manifest: SourceManifest): readonly ControlTotal[];
}

/** Reads immutable prior-run evidence; callers cannot supply hysteresis state. */
export interface ValidationRunHistoryPort {
  loadLatest(
    context: WorkbenchContext,
    sourceManifestRef: string,
  ):
    | Pick<
        DryRunReport,
        | 'tenantId'
        | 'waveRef'
        | 'runRef'
        | 'sourceManifestRef'
        | 'thresholdBasisPoints'
        | 'thresholdState'
        | 'failedRecordCount'
      >
    | undefined;
}

export interface WorkItemDirective {
  readonly tenantId: string;
  readonly stableKey: string;
  readonly kind: 'migration-go-no-go-review' | 'migration-validation-exception';
  readonly ownerRole: 'data-migration';
  readonly evidenceRefs: readonly string[];
  readonly deadlinePolicyRef: string;
  readonly synthetic: true;
}

/** WP-110 owns the real adapter to the existing WP-022 public WorkItem API. */
export interface WorkItemPort {
  open(directive: WorkItemDirective): { readonly workItemRef: string; readonly created: boolean };
}

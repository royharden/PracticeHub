import type {
  IdentityCandidatePort,
  SourceControlTotalPort,
  SourceSnapshotPort,
  TargetDryRunPort,
  ValidationRunHistoryPort,
  WorkItemDirective,
  WorkItemPort,
} from '../ports.js';
import type {
  ControlTotal,
  DryRunComparison,
  DryRunReport,
  MappingVersion,
  SourceManifest,
  ValidationFinding,
  WorkbenchContext,
} from '../types.js';

export class SyntheticSourceSnapshotDouble implements SourceSnapshotPort {
  public constructor(private readonly manifest: SourceManifest) {}

  public open(context: WorkbenchContext, manifestRef: string): SourceManifest {
    if (
      context.tenantId !== this.manifest.tenantId ||
      manifestRef !== this.manifest.sourceManifestRef
    ) {
      throw new Error('synthetic source snapshot request does not match its tenant/manifest');
    }
    return this.manifest;
  }
}

export class RecordingTargetDryRunDouble implements TargetDryRunPort {
  public calls = 0;

  public constructor(
    private readonly result: {
      readonly findings: readonly ValidationFinding[];
      readonly controlTotals: readonly ControlTotal[];
      readonly proposedWriteSetHash: string;
      readonly candidateRecordCount?: number;
      readonly keyFieldCompleteness?: DryRunComparison['keyFieldCompleteness'];
      readonly outcomeCounts?: DryRunComparison['outcomeCounts'];
    },
  ) {}

  public validate(context: WorkbenchContext, manifest: SourceManifest, mapping: MappingVersion) {
    void context;
    void manifest;
    void mapping;
    this.calls += 1;
    return {
      ...this.result,
      candidateRecordCount: this.result.candidateRecordCount ?? manifest.inScopeRecordRefs.length,
      keyFieldCompleteness: this.result.keyFieldCompleteness ?? {},
      outcomeCounts: this.result.outcomeCounts ?? {
        created: manifest.inScopeRecordRefs.length,
        updated: 0,
        merged: 0,
        flagged: this.result.findings.filter((finding) => finding.recordRef !== undefined).length,
      },
    };
  }
}

export class RecordingIdentityCandidateDouble implements IdentityCandidatePort {
  public constructor(
    private readonly findings: readonly ValidationFinding[],
    private readonly resultCounts: DryRunComparison['identityMatchResults'] = {
      matched: 0,
      candidate: 0,
      ambiguous: 0,
      unmatched: -1,
    },
  ) {}

  public score(context: WorkbenchContext, manifest: SourceManifest) {
    void context;
    void manifest;
    return {
      findings: this.findings,
      resultCounts:
        this.resultCounts.unmatched === -1
          ? { ...this.resultCounts, unmatched: manifest.inScopeRecordRefs.length }
          : this.resultCounts,
    };
  }
}

export class FixedSourceControlTotalDouble implements SourceControlTotalPort {
  public constructor(private readonly totals: readonly ControlTotal[]) {}

  public calculate(context: WorkbenchContext, manifest: SourceManifest) {
    void context;
    void manifest;
    return this.totals;
  }
}

export class StoredValidationRunHistoryDouble implements ValidationRunHistoryPort {
  public constructor(
    private readonly reports: readonly Pick<
      DryRunReport,
      | 'tenantId'
      | 'waveRef'
      | 'runRef'
      | 'sourceManifestRef'
      | 'thresholdBasisPoints'
      | 'thresholdState'
      | 'failedRecordCount'
    >[],
  ) {}

  public loadLatest(context: WorkbenchContext, sourceManifestRef: string) {
    return [...this.reports]
      .reverse()
      .find(
        (report) =>
          report.tenantId === context.tenantId &&
          report.waveRef === context.waveRef &&
          report.sourceManifestRef === sourceManifestRef,
      );
  }
}

export class RecordingWorkItemDouble implements WorkItemPort {
  private readonly created = new Map<string, WorkItemDirective>();

  public open(directive: WorkItemDirective) {
    const existing = this.created.get(directive.stableKey);
    if (existing !== undefined) {
      if (existing.tenantId !== directive.tenantId) {
        throw new Error('work-item stable key crossed tenant scope');
      }
      if (JSON.stringify(existing) !== JSON.stringify(directive)) {
        throw new Error('work-item stable key was reused with changed directive intent');
      }
      return { workItemRef: `synthetic-workitem:${directive.stableKey}`, created: false };
    }
    this.created.set(directive.stableKey, directive);
    return { workItemRef: `synthetic-workitem:${directive.stableKey}`, created: true };
  }

  public values(): readonly WorkItemDirective[] {
    return [...this.created.values()];
  }
}

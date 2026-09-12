import type { EventId, LegalEntityId, PhiClass, TenantId } from '@practicehub/contracts';

export type AnalyticsPartitionTag = 'gipa-genetic' | 'chd' | 'part2' | 'biometric';
export type AnalyticsDeliverySurface = 'view' | 'export';

export const analyticsDimensions = [
  'location',
  'cohort',
  'service',
  'channel',
  'status',
  'owner',
] as const;
export type AnalyticsDimension = (typeof analyticsDimensions)[number];

export interface ReleaseNode {
  readonly nodeId: string;
  /** Atomic, mutually-exclusive cells whose sum this node releases. */
  readonly memberCellIds: readonly string[];
}

export interface ReleaseFamily {
  readonly familyId: string;
  readonly atomicCellIds: readonly string[];
  readonly nodes: readonly ReleaseNode[];
}

export interface MetricDefinition {
  readonly metricId: string;
  readonly version: number;
  readonly status: 'draft' | 'active' | 'superseded';
  readonly denominatorRef: string;
  readonly allowedEventTypes: readonly string[];
  readonly requiredSourceRefs: readonly string[];
  readonly freshnessObjectiveMinutes: number;
  readonly dimensions: readonly AnalyticsDimension[];
  readonly minimumCellCount: number;
  readonly maximumClassification: Exclude<PhiClass, 'PHI-restricted' | 'secret'>;
  readonly accountableOwnerRef: string;
  readonly releaseFamily: ReleaseFamily;
  readonly synthetic: true;
}

export interface AnalyticsFact {
  readonly tenantId: TenantId;
  readonly legalEntityId?: LegalEntityId;
  readonly eventId: EventId;
  readonly eventType: string;
  readonly metricId: string;
  readonly metricVersion: number;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly sourceRef: string;
  readonly sourceOffset: string;
  readonly sourceReceiptRef?: string;
  readonly supersedesEventId?: EventId;
  readonly reversalOfEventId?: EventId;
  readonly cellId: string;
  readonly measure: number;
  readonly classification: PhiClass;
  readonly partitionTags: readonly AnalyticsPartitionTag[];
  readonly workItemRefs: readonly string[];
  readonly synthetic: true;
}

export interface ProjectionCell {
  readonly cellId: string;
  readonly count: number;
  readonly value: number;
  readonly workItemRefs: readonly string[];
}

export interface SourceOffset {
  readonly sourceRef: string;
  readonly highWaterMark: string;
  readonly loadedAt: string;
  readonly receiptRef?: string;
}

export interface ProjectionVersion {
  readonly tenantId: TenantId;
  readonly legalEntityId?: LegalEntityId;
  readonly datasetId: string;
  readonly cohortRef: string;
  readonly metricId: string;
  readonly metricVersion: number;
  readonly definitionHash: string;
  readonly versionRef: string;
  readonly builtAt: string;
  readonly eventIds: readonly EventId[];
  readonly sourceOffsets: readonly SourceOffset[];
  readonly cells: readonly ProjectionCell[];
  readonly maximumClassification: Exclude<PhiClass, 'PHI-restricted' | 'secret'>;
  readonly partitionTags: readonly Exclude<AnalyticsPartitionTag, 'gipa-genetic'>[];
  readonly verificationStatus: 'verified' | 'quarantined';
  readonly contentHash: string;
  readonly supersedesVersionRef?: string;
  readonly synthetic: true;
}

export type DataQualityReason =
  | 'cross-entity-access'
  | 'small-cell-or-differencing'
  | 'unresolved-identity-join'
  | 'missing-source-receipt'
  | 'rebuild-divergence';

export interface DataQualityTaskRequest {
  readonly tenantId: TenantId;
  readonly reason: DataQualityReason;
  readonly subjectRef: string;
  readonly openedAt: string;
  readonly workItemId: string;
  readonly synthetic: true;
}

export interface DisclosureScope {
  readonly tenantId: TenantId;
  readonly datasetId: string;
  readonly cohortRef: string;
  readonly metricId: string;
  readonly projectionVersionRef: string;
  readonly purpose: string;
}

export interface DisclosureRecord extends DisclosureScope {
  readonly disclosureId: string;
  readonly nodeId: string;
  readonly surface: AnalyticsDeliverySurface;
  readonly occurredAt: string;
  readonly synthetic: true;
}

export interface ProjectionExportReceipt {
  readonly tenantId: TenantId;
  readonly exportReceiptId: string;
  readonly disclosureId: string;
  readonly artifactRef: string;
  readonly contentHash: string;
  readonly exportedAt: string;
  readonly synthetic: true;
}

export interface FreshnessEvidence {
  readonly objectiveMinutes: number;
  readonly lastSuccessfulLoad: string | null;
  readonly knownGaps: readonly string[];
  readonly sourceSystems: readonly string[];
  readonly highWaterMarks: Readonly<Record<string, string>>;
  readonly fresh: boolean;
}

export interface AccessDecision {
  readonly allowed: boolean;
  readonly policyVersion: string;
  readonly reason?: string;
}

export type AnalyticsQueryDecision =
  | {
      readonly kind: 'available';
      readonly versionRef: string;
      readonly nodeId: string;
      readonly count: number;
      readonly value: number;
      readonly workItemRefs: readonly string[];
      readonly freshness: FreshnessEvidence;
    }
  | {
      readonly kind: 'masked';
      readonly reason: 'access-scope' | 'partition' | 'identity-unresolved';
      readonly versionRef: string;
      readonly qualityTaskRef: string;
    }
  | {
      readonly kind: 'suppressed';
      readonly reason: 'small-cell' | 'differencing-risk';
      readonly versionRef: string;
      readonly qualityTaskRef: string;
    }
  | {
      readonly kind: 'stale';
      readonly reason: 'late-source' | 'missing-receipt' | 'rebuild-divergence';
      readonly versionRef: string;
      readonly qualityTaskRef: string;
      readonly freshness: FreshnessEvidence;
    }
  | {
      readonly kind: 'unavailable';
      readonly reason: 'no-definition' | 'no-authorized-version' | 'source-unavailable';
    };

export class AnalyticsInvariantError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'AnalyticsInvariantError';
  }
}

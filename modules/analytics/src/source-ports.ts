import type { EventId, LegalEntityId, TenantId } from '@practicehub/contracts';
import { openWorkItem, type Queryable, type WorkItem } from '@practicehub/events';

import type { ReleaseDecision } from './privacy.js';
import { projectionIntegrityValid } from './projection.js';
import type {
  AccessDecision,
  DataQualityTaskRequest,
  DisclosureRecord,
  DisclosureScope,
  ProjectionExportReceipt,
  ProjectionVersion,
} from './types.js';

export interface AnalyticsAccessPort {
  readonly evaluate: (input: {
    readonly tenantId: string;
    readonly legalEntityId?: string;
    readonly actorRef: string;
    readonly purpose: string;
    readonly occurredAt: string;
    readonly datasetId: string;
    readonly cohortRef: string;
    readonly metricId: string;
    readonly metricVersion: number;
    readonly nodeId: string;
    readonly maximumClassification: string;
    readonly partitionTags: readonly string[];
    readonly segments: readonly string[];
    readonly drilldown: 'work-item-refs';
  }) => Promise<AccessDecision>;
}

export interface AnalyticsWorkItemPort {
  readonly createDataQualityWorkItem: (
    request: DataQualityTaskRequest,
  ) => Promise<{ readonly workItemRef: string }>;
}

export interface DisclosureHistoryPort {
  /** Atomically evaluate against global history and append only on allow. */
  readonly evaluateAndRecord: (
    scope: DisclosureScope,
    candidate: DisclosureRecord,
    evaluate: (history: readonly DisclosureRecord[]) => ReleaseDecision,
  ) => Promise<ReleaseDecision>;
}

function assertDisclosureCandidate(scope: DisclosureScope, candidate: DisclosureRecord): void {
  if (
    candidate.synthetic !== true ||
    candidate.tenantId !== scope.tenantId ||
    candidate.datasetId !== scope.datasetId ||
    candidate.cohortRef !== scope.cohortRef ||
    candidate.metricId !== scope.metricId ||
    candidate.projectionVersionRef !== scope.projectionVersionRef ||
    candidate.purpose !== scope.purpose
  ) {
    throw new Error('disclosure candidate does not match its reservation scope');
  }
}

export interface AuditEvidencePort {
  readonly record: (input: {
    readonly action: string;
    readonly decision: 'allow' | 'deny';
    readonly subjectRef: string;
    readonly policyVersion: string;
    readonly occurredAt: string;
    readonly synthetic: true;
  }) => Promise<void>;
}

/** Real WP-022 domain/store binding used by parity and DB tests. */
export function createWp022DataQualityPort(exec: Queryable): AnalyticsWorkItemPort {
  return {
    createDataQualityWorkItem: async (request) => {
      const item: WorkItem = await openWorkItem(exec, {
        tenantId: request.tenantId,
        open: {
          workItemId: request.workItemId,
          origin: 'admin',
          subjectRef: request.subjectRef,
          purpose: `analytics-data-quality:${request.reason}`,
          risk: request.reason === 'cross-entity-access' ? 'elevated' : 'routine',
          serviceTier: 'analytics-data-quality',
          slaPolicyId: null,
          policyVersion: null,
          responseDueAt: null,
          poolId: 'data-quality',
          openedAt: request.openedAt,
        },
        actorRef: 'analytics-read-model',
      });
      return { workItemRef: `work-item:${item.workItemId}` };
    },
  };
}

export function createMemoryDisclosureHistory(): DisclosureHistoryPort & {
  readonly records: readonly DisclosureRecord[];
} {
  const records: DisclosureRecord[] = [];
  let prior = Promise.resolve();
  return {
    get records() {
      return records;
    },
    evaluateAndRecord: async (scope, candidate, evaluate) => {
      assertDisclosureCandidate(scope, candidate);
      let release: ReleaseDecision | undefined;
      const current = prior.then(() => {
        const history = records.filter(
          (record) =>
            record.tenantId === scope.tenantId &&
            record.datasetId === scope.datasetId &&
            record.cohortRef === scope.cohortRef,
        );
        release = evaluate(history);
        if (release.allowed) records.push(candidate);
      });
      prior = current.catch(() => undefined);
      await current;
      if (release === undefined) throw new Error('disclosure reservation produced no decision');
      return release;
    },
  };
}

/**
 * Durable global disclosure reservation. The caller must provide a transaction-
 * bound executor; the advisory transaction lock serializes even an empty
 * tenant/dataset/cohort history, and insert lands in the same transaction.
 */
export function createPostgresDisclosureHistory(exec: Queryable): DisclosureHistoryPort {
  return {
    evaluateAndRecord: async (scope, candidate, evaluate) => {
      assertDisclosureCandidate(scope, candidate);
      const lockKey = `${scope.tenantId}|${scope.datasetId}|${scope.cohortRef}`;
      await exec.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey]);
      const result = await exec.query(
        `SELECT disclosure_id, dataset_id, cohort_ref, metric_id,
                projection_version_ref, purpose, node_id, surface,
                to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
                  AS occurred_at
           FROM analytics.projection_disclosure
          WHERE dataset_id = $1 AND cohort_ref = $2
          ORDER BY occurred_at, disclosure_id`,
        [scope.datasetId, scope.cohortRef],
      );
      const history: DisclosureRecord[] = result.rows.map((row) => ({
        tenantId: scope.tenantId,
        disclosureId: String(row['disclosure_id']),
        datasetId: String(row['dataset_id']),
        cohortRef: String(row['cohort_ref']),
        metricId: String(row['metric_id']),
        projectionVersionRef: String(row['projection_version_ref']),
        purpose: String(row['purpose']),
        nodeId: String(row['node_id']),
        surface: row['surface'] as DisclosureRecord['surface'],
        occurredAt: String(row['occurred_at']),
        synthetic: true,
      }));
      const release = evaluate(history);
      if (release.allowed) {
        await exec.query(
          `INSERT INTO analytics.projection_disclosure
             (tenant_id, disclosure_id, dataset_id, cohort_ref, metric_id,
              projection_version_ref, purpose, node_id, surface, occurred_at, synthetic)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)`,
          [
            candidate.tenantId,
            candidate.disclosureId,
            candidate.datasetId,
            candidate.cohortRef,
            candidate.metricId,
            candidate.projectionVersionRef,
            candidate.purpose,
            candidate.nodeId,
            candidate.surface,
            candidate.occurredAt,
          ],
        );
      }
      return release;
    },
  };
}

export interface ProjectionStore {
  readonly save: (projection: ProjectionVersion) => Promise<void>;
  readonly load: (tenantId: TenantId, versionRef: string) => Promise<ProjectionVersion | null>;
}

/** Append one immutable projection and its cells/offsets in the caller's transaction. */
export function createPostgresProjectionStore(exec: Queryable): ProjectionStore {
  return {
    load: async (tenantId, versionRef) => {
      const version = await exec.query(
        `SELECT legal_entity_id, dataset_id, cohort_ref, metric_id, metric_version,
                definition_hash,
                to_char(built_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS built_at,
                event_ids, maximum_classification, partition_tags, verification_status,
                content_hash, supersedes_version_ref
           FROM analytics.projection_version WHERE version_ref = $1`,
        [versionRef],
      );
      const row = version.rows[0];
      if (row === undefined) return null;
      const cells = await exec.query(
        `SELECT cell_id, member_count, measure_value, work_item_refs
           FROM analytics.projection_cell WHERE version_ref = $1 ORDER BY cell_id`,
        [versionRef],
      );
      const offsets = await exec.query(
        `SELECT source_ref, high_water_mark,
                to_char(loaded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS loaded_at,
                receipt_ref
           FROM analytics.projection_source_offset WHERE version_ref = $1 ORDER BY source_ref`,
        [versionRef],
      );
      const projection: ProjectionVersion = {
        tenantId,
        ...(row['legal_entity_id'] === null
          ? {}
          : { legalEntityId: String(row['legal_entity_id']) as LegalEntityId }),
        datasetId: String(row['dataset_id']),
        cohortRef: String(row['cohort_ref']),
        metricId: String(row['metric_id']),
        metricVersion: Number(row['metric_version']),
        definitionHash: String(row['definition_hash']),
        versionRef,
        builtAt: String(row['built_at']),
        eventIds: row['event_ids'] as readonly EventId[],
        sourceOffsets: offsets.rows.map((offset) => ({
          sourceRef: String(offset['source_ref']),
          highWaterMark: String(offset['high_water_mark']),
          loadedAt: String(offset['loaded_at']),
          ...(offset['receipt_ref'] === null ? {} : { receiptRef: String(offset['receipt_ref']) }),
        })),
        cells: cells.rows.map((cell) => ({
          cellId: String(cell['cell_id']),
          count: Number(cell['member_count']),
          value: Number(cell['measure_value']),
          workItemRefs: cell['work_item_refs'] as readonly string[],
        })),
        maximumClassification: row[
          'maximum_classification'
        ] as ProjectionVersion['maximumClassification'],
        partitionTags: row['partition_tags'] as ProjectionVersion['partitionTags'],
        verificationStatus: row['verification_status'] as ProjectionVersion['verificationStatus'],
        contentHash: String(row['content_hash']),
        ...(row['supersedes_version_ref'] === null
          ? {}
          : { supersedesVersionRef: String(row['supersedes_version_ref']) }),
        synthetic: true,
      };
      if (!projectionIntegrityValid(projection)) {
        throw new Error(`persisted projection ${versionRef} failed content-hash validation`);
      }
      return projection;
    },
    save: async (projection) => {
      if (!projectionIntegrityValid(projection)) {
        throw new Error('refusing to persist a projection with an invalid content hash');
      }
      await exec.query(
        `INSERT INTO analytics.projection_version
           (tenant_id, version_ref, legal_entity_id, dataset_id, cohort_ref,
            metric_id, metric_version, built_at, event_ids, maximum_classification,
            definition_hash, partition_tags, verification_status, content_hash,
            supersedes_version_ref, synthetic)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,true)`,
        [
          projection.tenantId,
          projection.versionRef,
          projection.legalEntityId ?? null,
          projection.datasetId,
          projection.cohortRef,
          projection.metricId,
          projection.metricVersion,
          projection.builtAt,
          [...projection.eventIds],
          projection.maximumClassification,
          projection.definitionHash,
          [...projection.partitionTags],
          projection.verificationStatus,
          projection.contentHash,
          projection.supersedesVersionRef ?? null,
        ],
      );
      for (const cell of projection.cells) {
        await exec.query(
          `INSERT INTO analytics.projection_cell
             (tenant_id, version_ref, cell_id, member_count, measure_value,
              work_item_refs, synthetic)
           VALUES ($1,$2,$3,$4,$5,$6,true)`,
          [
            projection.tenantId,
            projection.versionRef,
            cell.cellId,
            cell.count,
            cell.value,
            [...cell.workItemRefs],
          ],
        );
      }
      for (const offset of projection.sourceOffsets) {
        await exec.query(
          `INSERT INTO analytics.projection_source_offset
             (tenant_id, version_ref, source_ref, high_water_mark, loaded_at,
              receipt_ref, synthetic)
           VALUES ($1,$2,$3,$4,$5,$6,true)`,
          [
            projection.tenantId,
            projection.versionRef,
            offset.sourceRef,
            offset.highWaterMark,
            offset.loadedAt,
            offset.receiptRef ?? null,
          ],
        );
      }
    },
  };
}

export interface ProjectionExportReceiptStore {
  readonly record: (receipt: ProjectionExportReceipt) => Promise<void>;
}

export function createPostgresExportReceiptStore(exec: Queryable): ProjectionExportReceiptStore {
  return {
    record: async (receipt) => {
      await exec.query(
        `INSERT INTO analytics.projection_export_receipt
           (tenant_id, export_receipt_id, disclosure_id, artifact_ref,
            content_hash, exported_at, synthetic)
         VALUES ($1,$2,$3,$4,$5,$6,true)`,
        [
          receipt.tenantId,
          receipt.exportReceiptId,
          receipt.disclosureId,
          receipt.artifactRef,
          receipt.contentHash,
          receipt.exportedAt,
        ],
      );
    },
  };
}

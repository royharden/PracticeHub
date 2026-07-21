/**
 * Synthetic audit-evidence seed data of record (WP-020). The committed seed
 * file `infra/postgres/seed/009-audit-seed.sql` embeds
 * `renderAuditSeedSection` output between the audit markers — a drift test
 * compares the file against a fresh emission, and the DB suite recomputes the
 * seeded hash chains from the stored rows.
 *
 * Standing proofs this seed carries:
 * - a Northwind tenant-day chain across the streams, including an access DENY
 *   (deny paths are audited — R6-REQ-001) and an AI interaction with model +
 *   version and prompt/output ref+hash pairs (R6-REQ-102);
 * - a disclosure export carrying a partition tag (tags survive export);
 * - an ACTIVE Northwind legal hold on clinical records (hold suspends
 *   destruction) beside executed destruction evidence for an unheld class;
 * - a released Riverbend hold retaining its release evidence — the standing
 *   opposite-posture proof — plus a one-link Riverbend chain for the
 *   cross-tenant negatives.
 */

import { createHash } from 'node:crypto';

import {
  emitAuditEvent,
  emptyChainState,
  type AuditChainState,
  type AuditEmitInput,
  type AuditRecord,
} from './audit.js';
import {
  destructionManifestHash,
  retentionScheduleV1,
  type DestructionEvidence,
  type LegalHold,
  type RetentionSchedule,
} from './retention.js';

const northwind = 'northwind-synthetic';
const riverbend = 'riverbend-synthetic';

const syntheticBodyHash = (bodyRef: string): string =>
  createHash('sha256').update(`synthetic-body:${bodyRef}`).digest('hex');

const destroyedGfeRefs = ['synthetic-gfe:gfe-legacy-0114'] as const;

const seedEmitInputs: readonly AuditEmitInput[] = [
  {
    auditId: 'nae-0001',
    tenantId: northwind,
    stream: 'access',
    action: 'chart-view',
    actorRef: 'synthetic-staff:synthetic-front-desk-001',
    occurredAt: '2026-03-15T09:00:00Z',
    subjectRef: 'np-sam-porter',
    decision: 'allow',
    reason: 'treatment',
    sourceRef: 'synthetic-device:workstation-01',
    synthetic: true,
  },
  {
    auditId: 'nae-0002',
    tenantId: northwind,
    stream: 'access',
    action: 'chart-view',
    actorRef: 'synthetic-staff:synthetic-front-desk-001',
    occurredAt: '2026-03-15T09:05:00Z',
    subjectRef: 'np-jordan-kim',
    decision: 'deny',
    reason: 'operations',
    sourceRef: 'synthetic-device:workstation-01',
    synthetic: true,
  },
  {
    auditId: 'nae-0003',
    tenantId: northwind,
    stream: 'ai-interaction',
    action: 'draft-message',
    actorRef: 'synthetic-staff:synthetic-care-guide-001',
    occurredAt: '2026-03-15T09:20:00Z',
    subjectRef: 'np-jordan-kim',
    modelRef: 'model-sim:claude-sonnet',
    modelVersion: 'claude-sonnet-5-synthetic',
    promptRef: 'minio://synthetic-ai/prompts/nai-0003-prompt',
    promptHash: syntheticBodyHash('nai-0003-prompt'),
    outputRef: 'minio://synthetic-ai/outputs/nai-0003-output',
    outputHash: syntheticBodyHash('nai-0003-output'),
    synthetic: true,
  },
  {
    auditId: 'nae-0004',
    tenantId: northwind,
    stream: 'disclosure',
    action: 'records-export',
    actorRef: 'synthetic-staff:synthetic-compliance-001',
    occurredAt: '2026-03-15T10:00:00Z',
    subjectRef: 'np-sam-porter',
    decision: 'allow',
    recipientRef: 'synthetic-recipient:records-requester-0007',
    purpose: 'patient-request',
    partitionTags: ['gipa-genetic'],
    synthetic: true,
  },
  {
    auditId: 'nae-0005',
    tenantId: northwind,
    stream: 'config-change',
    action: 'legal-hold-placed',
    actorRef: 'synthetic-staff:synthetic-compliance-001',
    occurredAt: '2026-03-15T10:30:00Z',
    correlationRef: 'nlh-0001',
    detail: {
      config_ref: 'legal-hold:nlh-0001',
      matter_ref: 'synthetic-matter-0001',
    },
    synthetic: true,
  },
  {
    auditId: 'nae-0006',
    tenantId: northwind,
    stream: 'config-change',
    action: 'destruction-executed',
    actorRef: 'synthetic-staff:synthetic-compliance-001',
    occurredAt: '2026-03-15T11:00:00Z',
    correlationRef: 'nde-0001',
    detail: {
      config_ref: 'destruction:nde-0001',
      record_class: 'gfe-record',
      manifest_hash: destructionManifestHash(destroyedGfeRefs),
      authority_ref: 'synthetic-staff:synthetic-compliance-001',
    },
    synthetic: true,
  },
  {
    auditId: 'nae-0007',
    tenantId: northwind,
    stream: 'capability-transition',
    action: 'capability-transition-recorded',
    actorRef: 'synthetic-platform-bootstrap',
    occurredAt: '2026-03-15T11:30:00Z',
    correlationRef: 'synthetic-cap-evt-0011',
    detail: {
      capability_id: 'platform.audit-store',
      from_state: 'disabled',
      to_state: 'scaffolded',
    },
    synthetic: true,
  },
  {
    auditId: 'rae-0001',
    tenantId: riverbend,
    stream: 'access',
    action: 'chart-view',
    actorRef: 'synthetic-staff:synthetic-front-desk-101',
    occurredAt: '2026-03-15T09:00:00Z',
    subjectRef: 'rb-taylor-quinn',
    decision: 'allow',
    reason: 'treatment',
    synthetic: true,
  },
];

function buildSeedRecords(): readonly AuditRecord[] {
  let state: AuditChainState = emptyChainState;
  const records: AuditRecord[] = [];
  for (const input of seedEmitInputs) {
    const emitted = emitAuditEvent(state, input);
    state = emitted.state;
    records.push(emitted.record);
  }
  return records;
}

export const syntheticLegalHoldSeedV1: readonly LegalHold[] = [
  {
    holdId: 'nlh-0001',
    tenantId: northwind,
    matterRef: 'synthetic-matter-0001',
    recordClasses: ['clinical-record'],
    status: 'active',
    placedBy: 'synthetic-staff:synthetic-compliance-001',
    placedBasisRef: 'synthetic-litigation-hold-order-0001',
    synthetic: true,
  },
  {
    holdId: 'rlh-0001',
    tenantId: riverbend,
    matterRef: 'synthetic-matter-0101',
    recordClasses: [],
    status: 'released',
    placedBy: 'synthetic-staff:synthetic-compliance-101',
    placedBasisRef: 'synthetic-litigation-hold-order-0101',
    releasedBy: 'synthetic-staff:synthetic-compliance-101',
    releaseEvidenceRef: 'synthetic-hold-release-memo-0101',
    synthetic: true,
  },
];

export const syntheticDestructionEvidenceSeedV1: readonly DestructionEvidence[] = [
  {
    destructionId: 'nde-0001',
    tenantId: northwind,
    recordClass: 'gfe-record',
    recordRefs: [...destroyedGfeRefs],
    whyBasisRefs: ['r6-req-052-nsa-gfe-45-cfr-149-610'],
    authorityRef: 'synthetic-staff:synthetic-compliance-001',
    manifestHash: destructionManifestHash(destroyedGfeRefs),
    auditId: 'nae-0006',
    synthetic: true,
  },
];

export interface AuditSeed {
  readonly records: readonly AuditRecord[];
  readonly holds: readonly LegalHold[];
  readonly destructionEvidence: readonly DestructionEvidence[];
  readonly retentionSchedule: RetentionSchedule;
}

export const syntheticAuditSeedV1: AuditSeed = {
  records: buildSeedRecords(),
  holds: syntheticLegalHoldSeedV1,
  destructionEvidence: syntheticDestructionEvidenceSeedV1,
  retentionSchedule: retentionScheduleV1,
};

export const auditSeedBeginMarker = '-- audit:generated:begin';
export const auditSeedEndMarker = '-- audit:generated:end';

const sqlLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const sqlOptional = (value: string | undefined): string =>
  value === undefined ? 'NULL' : sqlLiteral(value);
const sqlJson = (value: unknown): string => `${sqlLiteral(JSON.stringify(value))}::jsonb`;
const sqlTextArray = (values: readonly string[]): string =>
  values.length === 0
    ? `'{}'::text[]`
    : `ARRAY[${values.map((value) => sqlLiteral(value)).join(', ')}]::text[]`;

/**
 * Render the synthetic seed as idempotent SQL. Audit events and destruction
 * evidence insert with ON CONFLICT DO NOTHING (append-only history is never
 * rewritten by a re-seed); holds and the retention registry upsert.
 */
export function renderAuditSeedSection(seed: AuditSeed): string {
  const scheduleRows = seed.retentionSchedule.entries.map(
    (entry) =>
      `  (${sqlLiteral(entry.recordClass)}, ${seed.retentionSchedule.version}, ` +
      `${sqlLiteral(seed.retentionSchedule.status)}, ${sqlLiteral(entry.basis)}, ` +
      `${entry.fixedTermYears ?? 'NULL'}, ${entry.minimumYears}, ` +
      `${sqlLiteral(entry.minorsExtension)}, ${entry.ageOfMajorityYears}, ` +
      `${sqlLiteral(entry.basisRef)}, ${sqlLiteral(seed.retentionSchedule.changeControlRef)}, true)`,
  );
  const eventRows = seed.records.map(
    (record) =>
      `  (${sqlLiteral(record.tenantId)}, ${sqlLiteral(record.auditId)}, ` +
      `${sqlLiteral(record.stream)}, ${sqlLiteral(record.action)}, ` +
      `${sqlLiteral(record.actorRef)}, ${sqlOptional(record.subjectRef)}, ` +
      `${sqlOptional(record.decision)}, ${sqlOptional(record.reason)}, ` +
      `${sqlOptional(record.sourceRef)}, ${sqlOptional(record.correlationRef)}, ` +
      `${sqlOptional(record.recipientRef)}, ${sqlOptional(record.purpose)}, ` +
      `${sqlOptional(record.modelRef)}, ${sqlOptional(record.modelVersion)}, ` +
      `${sqlOptional(record.promptRef)}, ${sqlOptional(record.promptHash)}, ` +
      `${sqlOptional(record.outputRef)}, ${sqlOptional(record.outputHash)}, ` +
      `${sqlJson(record.detail ?? {})}, ${sqlTextArray(record.partitionTags ?? [])}, ` +
      `${sqlLiteral(record.chainDay)}, ${record.chainSeq}, ` +
      `${sqlLiteral(record.prevHash)}, ${sqlLiteral(record.entryHash)}, ` +
      `${sqlLiteral(record.occurredAt)}, true)`,
  );
  const holdRows = seed.holds.map(
    (hold) =>
      `  (${sqlLiteral(hold.tenantId)}, ${sqlLiteral(hold.holdId)}, ` +
      `${sqlLiteral(hold.matterRef)}, ${sqlOptional(hold.legalEntityId)}, ` +
      `${sqlTextArray(hold.recordClasses)}, ${sqlLiteral(hold.status)}, ` +
      `${sqlLiteral(hold.placedBy)}, ${sqlLiteral(hold.placedBasisRef)}, ` +
      `${sqlOptional(hold.releasedBy)}, ${sqlOptional(hold.releaseEvidenceRef)}, true)`,
  );
  const destructionRows = seed.destructionEvidence.map(
    (evidence) =>
      `  (${sqlLiteral(evidence.tenantId)}, ${sqlLiteral(evidence.destructionId)}, ` +
      `${sqlLiteral(evidence.recordClass)}, ${sqlTextArray(evidence.recordRefs)}, ` +
      `${sqlTextArray(evidence.whyBasisRefs)}, ${sqlLiteral(evidence.authorityRef)}, ` +
      `${sqlLiteral(evidence.manifestHash)}, ${sqlLiteral(evidence.auditId)}, true)`,
  );
  return [
    auditSeedBeginMarker,
    '-- Generated by @practicehub/audit-evidence renderAuditSeedSection from',
    '-- syntheticAuditSeedV1. Regenerate on any seed change; the drift test and',
    '-- the DB chain-recompute test fail on divergence.',
    'INSERT INTO audit_evidence.retention_schedule',
    '  (record_class, version, status, basis, fixed_term_years, minimum_years,',
    '   minors_extension, age_of_majority_years, basis_ref, change_control_ref, synthetic)',
    'VALUES',
    scheduleRows.join(',\n'),
    'ON CONFLICT (record_class, version) DO UPDATE',
    'SET status = EXCLUDED.status,',
    '    basis = EXCLUDED.basis,',
    '    fixed_term_years = EXCLUDED.fixed_term_years,',
    '    minimum_years = EXCLUDED.minimum_years,',
    '    minors_extension = EXCLUDED.minors_extension,',
    '    age_of_majority_years = EXCLUDED.age_of_majority_years,',
    '    basis_ref = EXCLUDED.basis_ref,',
    '    change_control_ref = EXCLUDED.change_control_ref,',
    '    synthetic = EXCLUDED.synthetic;',
    '',
    'INSERT INTO audit_evidence.audit_event',
    '  (tenant_id, audit_id, stream, action, actor_ref, subject_ref, decision,',
    '   reason, source_ref, correlation_ref, recipient_ref, purpose, model_ref,',
    '   model_version, prompt_ref, prompt_hash, output_ref, output_hash, detail,',
    '   partition_tags, chain_day, chain_seq, prev_hash, entry_hash, occurred_at,',
    '   synthetic)',
    'VALUES',
    eventRows.join(',\n'),
    'ON CONFLICT (tenant_id, audit_id) DO NOTHING;',
    '',
    'INSERT INTO audit_evidence.legal_hold',
    '  (tenant_id, hold_id, matter_ref, legal_entity_id, record_classes, status,',
    '   placed_by, placed_basis_ref, released_by, release_evidence_ref, synthetic)',
    'VALUES',
    holdRows.join(',\n'),
    'ON CONFLICT (tenant_id, hold_id) DO UPDATE',
    'SET matter_ref = EXCLUDED.matter_ref,',
    '    legal_entity_id = EXCLUDED.legal_entity_id,',
    '    record_classes = EXCLUDED.record_classes,',
    '    status = EXCLUDED.status,',
    '    placed_by = EXCLUDED.placed_by,',
    '    placed_basis_ref = EXCLUDED.placed_basis_ref,',
    '    released_by = EXCLUDED.released_by,',
    '    release_evidence_ref = EXCLUDED.release_evidence_ref,',
    '    synthetic = EXCLUDED.synthetic;',
    '',
    'INSERT INTO audit_evidence.destruction_evidence',
    '  (tenant_id, destruction_id, record_class, record_refs, why_basis_refs,',
    '   authority_ref, manifest_hash, audit_id, synthetic)',
    'VALUES',
    destructionRows.join(',\n'),
    'ON CONFLICT (tenant_id, destruction_id) DO NOTHING;',
    auditSeedEndMarker,
  ].join('\n');
}

/** Extract the generated section from the committed seed file's contents. */
export function extractAuditSeedSection(seedSql: string): string | null {
  const begin = seedSql.indexOf(auditSeedBeginMarker);
  const end = seedSql.indexOf(auditSeedEndMarker);
  if (begin === -1 || end === -1 || end < begin) {
    return null;
  }
  return seedSql.slice(begin, end + auditSeedEndMarker.length);
}

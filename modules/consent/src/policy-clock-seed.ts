/**
 * Synthetic policy/clock seed data of record (WP-019). The committed seed file
 * `infra/postgres/seed/013-policy-clocks-seed.sql` embeds
 * `renderPolicyClockSeedSection` output between the markers — a drift test
 * compares the file against a fresh emission, and the DB suite re-folds the
 * seeded clock event log against the seeded projection.
 *
 * Standing proofs (Northwind), each a distinct owned surface:
 * - obligation_clock_policy: FL breach 30-day beats the federal 60-day floor
 *   (C-05 obligation × jurisdiction), MHRA renewal + access + statute-tracker
 *   floors, all effective-dated;
 * - policy_document: an effective-dated disclosure-authorization with a floor
 *   base variant + an MN state variant (ADR-007 D3);
 * - obligation_clock: a pending MHRA renewal clock (R6-SR-041), a satisfied
 *   records-request-closure clock (R6-REQ-010), an escalated statute-tracker
 *   clock (R6-SR-102), and a pending FL breach clock (C-05).
 * Riverbend carries a pending floor breach clock + a floor disclosure policy as
 * the standing cross-tenant negatives and opposite posture.
 */

import { createHash } from 'node:crypto';

import {
  escalateClock,
  foldClocks,
  recordClockSatisfaction,
  triggerClock,
  type ObligationClock,
  type ObligationClockEvent,
  type ObligationClockPolicy,
} from './clocks.js';
import type { PolicyDocumentVersion } from './policy-registry.js';

const northwind = 'northwind-synthetic';
const riverbend = 'riverbend-synthetic';

const evidence = (ref: string): string =>
  createHash('sha256').update(`synthetic-clock-evidence:${ref}`).digest('hex');

// --- Clock policies (counsel-owned, effective-dated) -----------------------

export const obligationClockPoliciesV1: readonly ObligationClockPolicy[] = [
  {
    obligationType: 'breach-notification',
    jurisdiction: 'floor',
    version: 1,
    effectiveOn: '1970-01-01',
    status: 'draft',
    changeControlRef: 'wp-019-breach-floor-v1',
    durationDays: 60,
    escalationLeadDays: 20,
    sourceRef: 'hipaa-45-cfr-164-404-federal-breach-floor',
    synthetic: true,
  },
  {
    obligationType: 'breach-notification',
    jurisdiction: 'FL',
    version: 1,
    effectiveOn: '2026-01-01',
    status: 'draft',
    changeControlRef: 'wp-019-breach-fl-v1',
    durationDays: 30,
    escalationLeadDays: 10,
    sourceRef: 'fl-stat-501-171-breach-shorter-clock',
    synthetic: true,
  },
  {
    obligationType: 'mhra-renewal',
    jurisdiction: 'floor',
    version: 1,
    effectiveOn: '1970-01-01',
    status: 'draft',
    changeControlRef: 'wp-019-mhra-floor-v1',
    escalationLeadDays: 30,
    sourceRef: 'mn-stat-144-293-mhra-release-expiry',
    synthetic: true,
  },
  {
    obligationType: 'records-request-closure',
    jurisdiction: 'floor',
    version: 1,
    effectiveOn: '1970-01-01',
    status: 'draft',
    changeControlRef: 'wp-019-access-floor-v1',
    durationDays: 30,
    escalationLeadDays: 10,
    sourceRef: 'hipaa-45-cfr-164-524-right-of-access',
    synthetic: true,
  },
  {
    obligationType: 'rule-pack-review',
    jurisdiction: 'floor',
    version: 1,
    effectiveOn: '1970-01-01',
    status: 'draft',
    changeControlRef: 'wp-019-tracker-floor-v1',
    durationDays: 90,
    escalationLeadDays: 14,
    sourceRef: 'r6-sr-102-quarterly-statute-tracker',
    synthetic: true,
  },
];

// --- Policy documents (per-jurisdiction, effective-dated) ------------------

const contentHash = (ref: string): string =>
  createHash('sha256').update(`synthetic-policy-body:${ref}`).digest('hex');

export const syntheticPolicyDocumentsV1: readonly PolicyDocumentVersion[] = [
  {
    tenantId: northwind,
    documentType: 'disclosure-authorization',
    jurisdiction: 'floor',
    version: 1,
    effectiveOn: '1970-01-01',
    status: 'draft',
    changeControlRef: 'wp-019-disclosure-floor-v1',
    contentRef: 'policy-doc:northwind:disclosure-authorization:floor:v1',
    contentHash: contentHash('nw-disclosure-floor-v1'),
    synthetic: true,
  },
  {
    tenantId: northwind,
    documentType: 'disclosure-authorization',
    jurisdiction: 'MN',
    version: 1,
    effectiveOn: '2026-01-01',
    status: 'draft',
    changeControlRef: 'wp-019-disclosure-mn-v1',
    contentRef: 'policy-doc:northwind:disclosure-authorization:mn:v1',
    contentHash: contentHash('nw-disclosure-mn-v1'),
    synthetic: true,
  },
  {
    tenantId: northwind,
    documentType: 'ai-disclosure',
    jurisdiction: 'floor',
    version: 1,
    effectiveOn: '1970-01-01',
    status: 'draft',
    changeControlRef: 'wp-019-ai-disclosure-floor-v1',
    contentRef: 'policy-doc:northwind:ai-disclosure:floor:v1',
    contentHash: contentHash('nw-ai-disclosure-floor-v1'),
    synthetic: true,
  },
  {
    tenantId: riverbend,
    documentType: 'disclosure-authorization',
    jurisdiction: 'floor',
    version: 1,
    effectiveOn: '1970-01-01',
    status: 'draft',
    changeControlRef: 'wp-019-rb-disclosure-floor-v1',
    contentRef: 'policy-doc:riverbend:disclosure-authorization:floor:v1',
    contentHash: contentHash('rb-disclosure-floor-v1'),
    synthetic: true,
  },
];

// --- Clock instances + event log (standing proofs) -------------------------

interface SeedClock {
  readonly trigger: ReturnType<typeof triggerClock>;
  readonly follow: readonly ObligationClockEvent[];
}

function buildClocks(): {
  readonly events: readonly ObligationClockEvent[];
  readonly instances: readonly ObligationClock[];
} {
  const policies = obligationClockPoliciesV1;
  const seeds: SeedClock[] = [];

  // 1. Northwind MHRA renewal clock, anchored on nce-0004's expiry (pending).
  const mhra = triggerClock({
    tenantId: northwind,
    clockId: 'ncl-mhra-0001',
    clockEventId: 'ncle-0001',
    obligationType: 'mhra-renewal',
    subjectRef: 'np-riley-quinn',
    triggerRef: 'consent:nce-0004',
    triggeredAt: '2026-01-15T00:00:00.000Z',
    actorRef: 'synthetic-platform-clock',
    basis: { providerState: 'MN', patientState: 'MN' },
    anchorDueAt: '2027-01-15T00:00:00.000Z',
    policies,
  });
  seeds.push({ trigger: mhra, follow: [] });

  // 2. Northwind records-request-closure clock — SATISFIED (records released).
  const access = triggerClock({
    tenantId: northwind,
    clockId: 'ncl-access-0001',
    clockEventId: 'ncle-0002',
    obligationType: 'records-request-closure',
    subjectRef: 'np-jordan-kim',
    triggerRef: 'records-request:synthetic-req-0001',
    triggeredAt: '2026-02-10T00:00:00.000Z',
    actorRef: 'synthetic-platform-clock',
    basis: { providerState: 'IL', patientState: 'IL' },
    policies,
  });
  const accessSatisfy = recordClockSatisfaction(access.instance, {
    clockEventId: 'ncle-0003',
    occurredAt: '2026-02-20T00:00:00.000Z',
    actorRef: 'synthetic-records-officer',
    evidenceRef: 'records-release:synthetic-req-0001',
    evidenceHash: evidence('access-0001'),
  });
  seeds.push({ trigger: access, follow: [accessSatisfy.event] });

  // 3. Northwind statute-tracker (rule-pack-review) clock — ESCALATED worklist.
  const tracker = triggerClock({
    tenantId: northwind,
    clockId: 'ncl-tracker-0001',
    clockEventId: 'ncle-0004',
    obligationType: 'rule-pack-review',
    subjectRef: 'rule-pack-scope:all-jurisdictions',
    triggerRef: 'statute-tracker:synthetic-cycle-0001',
    triggeredAt: '2026-01-01T00:00:00.000Z',
    actorRef: 'synthetic-platform-clock',
    basis: { providerState: null, patientState: null },
    policies,
  });
  const trackerEscalate = escalateClock(tracker.instance, {
    clockEventId: 'ncle-0005',
    occurredAt: '2026-03-18T00:00:00.000Z',
    actorRef: 'synthetic-platform-clock',
  });
  seeds.push({ trigger: tracker, follow: [trackerEscalate.event] });

  // 4. Northwind FL breach-notification clock — pending (FL 30-day beats floor 60).
  const breach = triggerClock({
    tenantId: northwind,
    clockId: 'ncl-breach-0001',
    clockEventId: 'ncle-0006',
    obligationType: 'breach-notification',
    subjectRef: 'incident:synthetic-breach-0001',
    triggerRef: 'incident:synthetic-breach-0001',
    triggeredAt: '2026-03-01T00:00:00.000Z',
    actorRef: 'synthetic-compliance-officer',
    basis: { providerState: 'FL', patientState: 'FL' },
    policies,
  });
  seeds.push({ trigger: breach, follow: [] });

  // 5. Riverbend floor breach clock — the standing cross-tenant negative.
  const rbBreach = triggerClock({
    tenantId: riverbend,
    clockId: 'rcl-breach-0001',
    clockEventId: 'rcle-0001',
    obligationType: 'breach-notification',
    subjectRef: 'incident:synthetic-rb-breach-0001',
    triggerRef: 'incident:synthetic-rb-breach-0001',
    triggeredAt: '2026-03-01T00:00:00.000Z',
    actorRef: 'synthetic-compliance-officer',
    basis: { providerState: null, patientState: null },
    policies,
  });
  seeds.push({ trigger: rbBreach, follow: [] });

  const events: ObligationClockEvent[] = [];
  const triggers: ObligationClock[] = [];
  for (const seed of seeds) {
    events.push(seed.trigger.event, ...seed.follow);
    triggers.push(seed.trigger.instance);
  }
  const instances = [...foldClocks(events, triggers).values()].sort((left, right) =>
    `${left.tenantId}|${left.clockId}`.localeCompare(`${right.tenantId}|${right.clockId}`),
  );
  return { events, instances };
}

export interface PolicyClockSeed {
  readonly policies: readonly ObligationClockPolicy[];
  readonly documents: readonly PolicyDocumentVersion[];
  readonly events: readonly ObligationClockEvent[];
  readonly instances: readonly ObligationClock[];
}

const built = buildClocks();

export const syntheticPolicyClockSeedV1: PolicyClockSeed = {
  policies: obligationClockPoliciesV1,
  documents: syntheticPolicyDocumentsV1,
  events: built.events,
  instances: built.instances,
};

export const policyClockSeedBeginMarker = '-- policy-clocks:generated:begin';
export const policyClockSeedEndMarker = '-- policy-clocks:generated:end';

const sqlLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const sqlOptional = (value: string | undefined): string =>
  value === undefined ? 'NULL' : sqlLiteral(value);
const sqlInt = (value: number | undefined): string =>
  value === undefined ? 'NULL' : String(value);

/**
 * Render the synthetic seed as idempotent SQL. Reference registries (clock
 * policies, policy documents) upsert; the append-only clock event log inserts
 * with ON CONFLICT DO NOTHING; the clock projection upserts (it is the fold of
 * the event log — one data source, drift-tested and re-proven by the DB suite).
 */
export function renderPolicyClockSeedSection(seed: PolicyClockSeed): string {
  const policyRows = seed.policies.map(
    (policy) =>
      `  (${sqlLiteral(policy.obligationType)}, ${sqlLiteral(policy.jurisdiction)}, ` +
      `${policy.version}, DATE ${sqlLiteral(policy.effectiveOn)}, ${sqlLiteral(policy.status)}, ` +
      `${sqlOptional(policy.counselSignoffRef)}, ${sqlLiteral(policy.changeControlRef)}, ` +
      `${sqlInt(policy.durationDays)}, ${policy.escalationLeadDays}, ` +
      `${sqlLiteral(policy.sourceRef)}, true)`,
  );
  const documentRows = seed.documents.map(
    (document) =>
      `  (${sqlLiteral(document.tenantId)}, ${sqlLiteral(document.documentType)}, ` +
      `${sqlLiteral(document.jurisdiction)}, ${document.version}, ` +
      `DATE ${sqlLiteral(document.effectiveOn)}, ${sqlLiteral(document.status)}, ` +
      `${sqlOptional(document.counselSignoffRef)}, ${sqlLiteral(document.changeControlRef)}, ` +
      `${sqlLiteral(document.contentRef)}, ${sqlLiteral(document.contentHash)}, true)`,
  );
  const eventRows = seed.events.map(
    (event) =>
      `  (${sqlLiteral(event.tenantId)}, ${sqlLiteral(event.clockEventId)}, ` +
      `${sqlLiteral(event.clockId)}, ${sqlLiteral(event.obligationType)}, ` +
      `${sqlLiteral(event.kind)}, ${sqlLiteral(event.subjectRef)}, ` +
      `${sqlLiteral(event.occurredAt)}, ${sqlOptional(event.dueAt)}, ` +
      `${sqlOptional(event.evidenceRef)}, ${sqlOptional(event.evidenceHash)}, ` +
      `${sqlLiteral(event.actorRef)}, ${sqlOptional(event.reason)}, true)`,
  );
  const instanceRows = seed.instances.map(
    (instance) =>
      `  (${sqlLiteral(instance.tenantId)}, ${sqlLiteral(instance.clockId)}, ` +
      `${sqlLiteral(instance.obligationType)}, ${sqlLiteral(instance.subjectRef)}, ` +
      `${sqlLiteral(instance.triggerRef)}, ${sqlLiteral(instance.triggeredAt)}, ` +
      `${sqlLiteral(instance.dueAt)}, ${sqlLiteral(instance.escalateAt)}, ` +
      `${sqlLiteral(instance.status)}, ${sqlLiteral(instance.ownerRole)}, ` +
      `${sqlOptional(instance.closureEvidenceRef)}, ${sqlLiteral(instance.lastEventId)}, true)`,
  );
  return [
    policyClockSeedBeginMarker,
    '-- Generated by @practicehub/consent renderPolicyClockSeedSection from',
    '-- syntheticPolicyClockSeedV1. Regenerate on any seed change; the drift test',
    '-- and the DB projection-sync test fail on divergence.',
    'INSERT INTO consent.obligation_clock_policy',
    '  (obligation_type, jurisdiction, version, effective_on, status,',
    '   counsel_signoff_ref, change_control_ref, duration_days, escalation_lead_days,',
    '   source_ref, synthetic)',
    'VALUES',
    policyRows.join(',\n'),
    '-- Append-only reference registry: a version is immutable, never rewritten.',
    'ON CONFLICT (obligation_type, jurisdiction, version) DO NOTHING;',
    '',
    'INSERT INTO consent.policy_document',
    '  (tenant_id, document_type, jurisdiction, version, effective_on, status,',
    '   counsel_signoff_ref, change_control_ref, content_ref, content_hash, synthetic)',
    'VALUES',
    documentRows.join(',\n'),
    '-- Append-only: a policy document version is immutable; new documents are',
    '-- new versions, never rewrites.',
    'ON CONFLICT (tenant_id, document_type, jurisdiction, version) DO NOTHING;',
    '',
    'INSERT INTO consent.obligation_clock_event',
    '  (tenant_id, clock_event_id, clock_id, obligation_type, kind, subject_ref,',
    '   occurred_at, due_at, evidence_ref, evidence_hash, actor_ref, reason, synthetic)',
    'VALUES',
    eventRows.join(',\n'),
    'ON CONFLICT (tenant_id, clock_event_id) DO NOTHING;',
    '',
    'INSERT INTO consent.obligation_clock',
    '  (tenant_id, clock_id, obligation_type, subject_ref, trigger_ref, triggered_at,',
    '   due_at, escalate_at, status, owner_role, closure_evidence_ref, last_event_id,',
    '   synthetic)',
    'VALUES',
    instanceRows.join(',\n'),
    'ON CONFLICT (tenant_id, clock_id) DO UPDATE',
    'SET obligation_type = EXCLUDED.obligation_type,',
    '    subject_ref = EXCLUDED.subject_ref,',
    '    trigger_ref = EXCLUDED.trigger_ref,',
    '    triggered_at = EXCLUDED.triggered_at,',
    '    due_at = EXCLUDED.due_at,',
    '    escalate_at = EXCLUDED.escalate_at,',
    '    status = EXCLUDED.status,',
    '    owner_role = EXCLUDED.owner_role,',
    '    closure_evidence_ref = EXCLUDED.closure_evidence_ref,',
    '    last_event_id = EXCLUDED.last_event_id,',
    '    synthetic = EXCLUDED.synthetic;',
    policyClockSeedEndMarker,
  ].join('\n');
}

/** Extract the generated section from the committed seed file's contents. */
export function extractPolicyClockSeedSection(seedSql: string): string | null {
  const begin = seedSql.indexOf(policyClockSeedBeginMarker);
  const end = seedSql.indexOf(policyClockSeedEndMarker);
  if (begin === -1 || end === -1 || end < begin) {
    return null;
  }
  return seedSql.slice(begin, end + policyClockSeedEndMarker.length);
}

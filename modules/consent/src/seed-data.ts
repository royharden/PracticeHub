/**
 * Synthetic consent seed data of record (WP-018). The committed seed file
 * `infra/postgres/seed/011-consent-seed.sql` embeds `renderConsentSeedSection`
 * output between the consent markers — a drift test compares the file against a
 * fresh emission, and the DB suite re-folds the seeded events against the
 * seeded projection.
 *
 * Standing proofs this seed carries (Northwind), each a distinct owned R6
 * obligation surface:
 * - sms/treatment opted_in (canSend allow) beside sms/marketing revoked by a
 *   STOP keyword (opted_out — R6-REQ-072 / REQ-COMM-005);
 * - a live MHRA records-disclosure consent (granted) beside a lapsed one
 *   (expired as-of — R6-SR-041 auto-block);
 * - a voice/treatment opt-in with NO ai_voice event, so an ai_voice send fails
 *   closed on the distinct channel (R6-REQ-074);
 * - a genetic disclosure with written authorization (granted — R6-SR-031);
 * - a compliance-blocked email/marketing consent.
 * Riverbend carries an opted-out sms/marketing consent as the standing
 * cross-tenant negative and opposite posture.
 */

import { createHash } from 'node:crypto';

import {
  appendConsentEvent,
  foldConsentState,
  type ConsentEvent,
  type ConsentEventInput,
  type ConsentStateRow,
} from './consent.js';

const northwind = 'northwind-synthetic';
const riverbend = 'riverbend-synthetic';

const evidence = (ref: string): string =>
  createHash('sha256').update(`synthetic-consent-evidence:${ref}`).digest('hex');

const seedEventInputs: readonly ConsentEventInput[] = [
  {
    consentEventId: 'nce-0001',
    tenantId: northwind,
    personRef: 'np-sam-porter',
    scope: { type: 'communication', channel: 'sms', purpose: 'treatment' },
    action: 'grant',
    effectiveAt: '2026-02-01T00:00:00Z',
    source: 'portal_form',
    evidenceRef: 'synthetic-consent:nce-0001-portal',
    evidenceHash: evidence('nce-0001'),
    jurisdiction: 'NV',
    policyVersion: 'consent-v1',
    quietHoursTz: 'America/Los_Angeles',
    synthetic: true,
  },
  {
    consentEventId: 'nce-0002',
    tenantId: northwind,
    personRef: 'np-sam-porter',
    scope: { type: 'communication', channel: 'sms', purpose: 'marketing' },
    action: 'grant',
    effectiveAt: '2026-02-01T00:00:00Z',
    source: 'double_optin',
    evidenceRef: 'synthetic-consent:nce-0002-double-optin',
    evidenceHash: evidence('nce-0002'),
    jurisdiction: 'NV',
    policyVersion: 'consent-v1',
    quietHoursTz: 'America/Los_Angeles',
    synthetic: true,
  },
  {
    consentEventId: 'nce-0003',
    tenantId: northwind,
    personRef: 'np-sam-porter',
    scope: { type: 'communication', channel: 'sms', purpose: 'marketing' },
    action: 'revoke',
    effectiveAt: '2026-03-01T00:00:00Z',
    source: 'sms_keyword',
    evidenceRef: 'synthetic-inbound:nce-0003-stop',
    jurisdiction: 'NV',
    policyVersion: 'consent-v1',
    quietHoursTz: 'America/Los_Angeles',
    synthetic: true,
  },
  {
    consentEventId: 'nce-0004',
    tenantId: northwind,
    personRef: 'np-riley-quinn',
    scope: {
      type: 'disclosure',
      purpose: 'treatment',
      recipient: 'synthetic-recipient:referral-partner-0007',
      recordType: 'general',
    },
    action: 'grant',
    effectiveAt: '2026-01-15T00:00:00Z',
    expiresAt: '2027-01-15T00:00:00Z',
    source: 'paper_form',
    evidenceRef: 'synthetic-consent:nce-0004-mhra-release',
    evidenceHash: evidence('nce-0004'),
    jurisdiction: 'MN',
    policyVersion: 'records-consent-v1',
    synthetic: true,
  },
  {
    consentEventId: 'nce-0005',
    tenantId: northwind,
    personRef: 'np-riley-quinn',
    scope: {
      type: 'disclosure',
      purpose: 'treatment',
      recipient: 'synthetic-recipient:referral-partner-0008',
      recordType: 'general',
    },
    action: 'grant',
    effectiveAt: '2024-01-15T00:00:00Z',
    expiresAt: '2025-01-15T00:00:00Z',
    source: 'paper_form',
    evidenceRef: 'synthetic-consent:nce-0005-mhra-release',
    evidenceHash: evidence('nce-0005'),
    jurisdiction: 'MN',
    policyVersion: 'records-consent-v1',
    synthetic: true,
  },
  {
    consentEventId: 'nce-0006',
    tenantId: northwind,
    personRef: 'np-jordan-kim',
    scope: { type: 'communication', channel: 'voice', purpose: 'treatment' },
    action: 'grant',
    effectiveAt: '2026-02-10T00:00:00Z',
    source: 'staff_entry',
    evidenceRef: 'synthetic-consent:nce-0006-verbal',
    jurisdiction: 'IL',
    policyVersion: 'consent-v1',
    synthetic: true,
  },
  {
    consentEventId: 'nce-0007',
    tenantId: northwind,
    personRef: 'np-jordan-kim',
    scope: {
      type: 'disclosure',
      purpose: 'treatment',
      recipient: 'synthetic-recipient:lab-0003',
      recordType: 'genetic',
    },
    action: 'grant',
    effectiveAt: '2026-02-10T00:00:00Z',
    source: 'paper_form',
    evidenceRef: 'synthetic-consent:nce-0007-genetic-authorization',
    evidenceHash: evidence('nce-0007'),
    jurisdiction: 'IL',
    policyVersion: 'genetic-authorization-v1',
    partitionTags: ['gipa-genetic'],
    synthetic: true,
  },
  {
    consentEventId: 'nce-0008',
    tenantId: northwind,
    personRef: 'np-alex-rivera',
    scope: { type: 'communication', channel: 'email', purpose: 'marketing' },
    action: 'block',
    effectiveAt: '2026-03-05T00:00:00Z',
    source: 'staff_entry',
    evidenceRef: 'synthetic-compliance-hold:nce-0008',
    jurisdiction: 'NV',
    policyVersion: 'consent-v1',
    synthetic: true,
  },
  {
    consentEventId: 'rce-0001',
    tenantId: riverbend,
    personRef: 'rb-taylor-quinn',
    scope: { type: 'communication', channel: 'sms', purpose: 'marketing' },
    action: 'grant',
    effectiveAt: '2026-02-01T00:00:00Z',
    source: 'double_optin',
    evidenceRef: 'synthetic-consent:rce-0001-double-optin',
    evidenceHash: evidence('rce-0001'),
    jurisdiction: 'NV',
    policyVersion: 'consent-v1',
    synthetic: true,
  },
  {
    consentEventId: 'rce-0002',
    tenantId: riverbend,
    personRef: 'rb-taylor-quinn',
    scope: { type: 'communication', channel: 'sms', purpose: 'marketing' },
    action: 'revoke',
    effectiveAt: '2026-03-01T00:00:00Z',
    source: 'sms_keyword',
    evidenceRef: 'synthetic-inbound:rce-0002-stop',
    jurisdiction: 'NV',
    policyVersion: 'consent-v1',
    synthetic: true,
  },
];

function buildSeedRecords(): readonly ConsentEvent[] {
  let log: readonly ConsentEvent[] = [];
  for (const input of seedEventInputs) {
    ({ log } = appendConsentEvent(log, input));
  }
  return log;
}

/** Fold per tenant so the projection PK (tenant, person, scope) is exact even
 * if two tenants ever shared a person_ref. */
function buildProjection(records: readonly ConsentEvent[]): readonly ConsentStateRow[] {
  const byTenant = new Map<string, ConsentEvent[]>();
  for (const record of records) {
    const bucket = byTenant.get(record.tenantId) ?? [];
    bucket.push(record);
    byTenant.set(record.tenantId, bucket);
  }
  const rows: ConsentStateRow[] = [];
  for (const bucket of byTenant.values()) {
    for (const row of foldConsentState(bucket).values()) {
      rows.push(row);
    }
  }
  return rows.sort((left, right) =>
    `${left.tenantId}|${left.personRef}|${left.scopeKey}`.localeCompare(
      `${right.tenantId}|${right.personRef}|${right.scopeKey}`,
    ),
  );
}

export interface ConsentSeed {
  readonly records: readonly ConsentEvent[];
  readonly projection: readonly ConsentStateRow[];
}

const seedRecords = buildSeedRecords();

export const syntheticConsentSeedV1: ConsentSeed = {
  records: seedRecords,
  projection: buildProjection(seedRecords),
};

export const consentSeedBeginMarker = '-- consent:generated:begin';
export const consentSeedEndMarker = '-- consent:generated:end';

const sqlLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const sqlOptional = (value: string | undefined): string =>
  value === undefined ? 'NULL' : sqlLiteral(value);
const sqlTextArray = (values: readonly string[]): string =>
  values.length === 0
    ? `'{}'::text[]`
    : `ARRAY[${values.map((value) => sqlLiteral(value)).join(', ')}]::text[]`;

/**
 * Render the synthetic seed as idempotent SQL. Events insert with ON CONFLICT
 * DO NOTHING (the append-only log is never rewritten by a re-seed); the
 * projection upserts — it is the fold of the events, one data source,
 * drift-tested in the unit suite and re-proven against the database by the DB
 * suite's projection-sync test.
 */
export function renderConsentSeedSection(seed: ConsentSeed): string {
  const eventRows = seed.records.map(
    (record) =>
      `  (${sqlLiteral(record.tenantId)}, ${sqlLiteral(record.consentEventId)}, ` +
      `${sqlLiteral(record.personRef)}, ${sqlLiteral(record.scopeType)}, ` +
      `${sqlLiteral(record.scopeKey)}, ${sqlOptional(record.channel)}, ` +
      `${sqlLiteral(record.purpose)}, ${sqlOptional(record.recipientRef)}, ` +
      `${sqlOptional(record.recordType)}, ${sqlLiteral(record.action)}, ` +
      `${sqlLiteral(record.resultingState)}, ${sqlLiteral(record.effectiveAt)}, ` +
      `${sqlOptional(record.expiresAt)}, ${sqlLiteral(record.source)}, ` +
      `${sqlOptional(record.evidenceRef)}, ${sqlOptional(record.evidenceHash)}, ` +
      `${sqlOptional(record.capturedBy)}, ${sqlLiteral(record.jurisdiction)}, ` +
      `${sqlLiteral(record.policyVersion)}, ${sqlLiteral(record.quietHoursTz)}, ` +
      `${sqlTextArray(record.partitionTags)}, ${sqlLiteral(record.occurredAt)}, true)`,
  );
  const stateRows = seed.projection.map(
    (row) =>
      `  (${sqlLiteral(row.tenantId)}, ${sqlLiteral(row.personRef)}, ` +
      `${sqlLiteral(row.scopeKey)}, ${sqlLiteral(row.scopeType)}, ` +
      `${sqlOptional(row.channel)}, ${sqlLiteral(row.purpose)}, ` +
      `${sqlOptional(row.recipientRef)}, ${sqlOptional(row.recordType)}, ` +
      `${sqlLiteral(row.currentState)}, ${sqlLiteral(row.effectiveAt)}, ` +
      `${sqlOptional(row.expiresAt)}, ${sqlLiteral(row.lastEventId)}, ` +
      `${sqlLiteral(row.quietHoursTz)}, ${sqlLiteral(row.jurisdiction)}, true)`,
  );
  return [
    consentSeedBeginMarker,
    '-- Generated by @practicehub/consent renderConsentSeedSection from',
    '-- syntheticConsentSeedV1. Regenerate on any seed change; the drift test and',
    '-- the DB projection-sync test fail on divergence.',
    'INSERT INTO consent.consent_event',
    '  (tenant_id, consent_event_id, person_ref, scope_type, scope_key, channel,',
    '   purpose, recipient_ref, record_type, action, resulting_state, effective_at,',
    '   expires_at, source, evidence_ref, evidence_hash, captured_by, jurisdiction,',
    '   policy_version, quiet_hours_tz, partition_tags, occurred_at, synthetic)',
    'VALUES',
    eventRows.join(',\n'),
    'ON CONFLICT (tenant_id, consent_event_id) DO NOTHING;',
    '',
    'INSERT INTO consent.consent_state',
    '  (tenant_id, person_ref, scope_key, scope_type, channel, purpose,',
    '   recipient_ref, record_type, current_state, effective_at, expires_at,',
    '   last_event_id, quiet_hours_tz, jurisdiction, synthetic)',
    'VALUES',
    stateRows.join(',\n'),
    'ON CONFLICT (tenant_id, person_ref, scope_key) DO UPDATE',
    'SET scope_type = EXCLUDED.scope_type,',
    '    channel = EXCLUDED.channel,',
    '    purpose = EXCLUDED.purpose,',
    '    recipient_ref = EXCLUDED.recipient_ref,',
    '    record_type = EXCLUDED.record_type,',
    '    current_state = EXCLUDED.current_state,',
    '    effective_at = EXCLUDED.effective_at,',
    '    expires_at = EXCLUDED.expires_at,',
    '    last_event_id = EXCLUDED.last_event_id,',
    '    quiet_hours_tz = EXCLUDED.quiet_hours_tz,',
    '    jurisdiction = EXCLUDED.jurisdiction,',
    '    synthetic = EXCLUDED.synthetic;',
    consentSeedEndMarker,
  ].join('\n');
}

/** Extract the generated section from the committed seed file's contents. */
export function extractConsentSeedSection(seedSql: string): string | null {
  const begin = seedSql.indexOf(consentSeedBeginMarker);
  const end = seedSql.indexOf(consentSeedEndMarker);
  if (begin === -1 || end === -1 || end < begin) {
    return null;
  }
  return seedSql.slice(begin, end + consentSeedEndMarker.length);
}

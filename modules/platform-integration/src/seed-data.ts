/**
 * Synthetic seed for the vendor registry (WP-026, M07). The committed seed file
 * `infra/postgres/seed/019-vendor-registry-seed.sql` embeds
 * `renderVendorRegistrySeedSection(syntheticVendorRegistrySeedV1)` output between
 * the generated markers; a drift test fails on divergence, and the DB suite
 * re-folds the seeded lifecycle events against the seeded projection.
 *
 * Northwind carries a spread that proves the egress matrix at rest — a covered
 * allow vendor, an AI vendor with both clauses, a CLIN-only labs vendor (the
 * GEN-block standing proof), an AI vendor missing the no-training clause, and a
 * lapsed-BAA vendor (suspended). Riverbend carries the OPPOSITE posture (a
 * vendor with no executed BAA) as the standing cross-tenant proof. All refs are
 * neutral synthetic tokens (no tenant/business context — publication boundary).
 */

import type { ContentLicenseRow } from './content-license.js';
import {
  foldVendorRegistry,
  type PhiCategory,
  type VendorClass,
  type VendorRegistryEvent,
  type VendorRegistryRow,
} from './vendor-registry.js';

const northwind = 'northwind-synthetic';
const riverbend = 'riverbend-synthetic';
const approver = 'synthetic-compliance-officer';

export interface EgressDecisionSeed {
  readonly tenantId: string;
  readonly decisionId: string;
  readonly vendorId: string;
  readonly decision: 'allow' | 'deny';
  readonly phiClass: string;
  readonly categories: readonly PhiCategory[];
  readonly reason: string;
  readonly incidentOpened: boolean;
  readonly occurredAt: string;
  readonly synthetic: true;
}

export interface VendorRegistrySeed {
  readonly events: readonly VendorRegistryEvent[];
  readonly contentLicenses: readonly ContentLicenseRow[];
  readonly egressDecisions: readonly EgressDecisionSeed[];
}

function registered(
  tenantId: string,
  vendorId: string,
  vendorClass: VendorClass,
  isAiVendor: boolean,
  enforcementPoint: string,
  occurredAt: string,
): VendorRegistryEvent {
  return {
    tenantId,
    vendorId,
    version: 1,
    kind: 'registered',
    vendorClass,
    isAiVendor,
    enforcementPoint,
    baaStatus: 'required',
    approvedBy: approver,
    evidenceRef: `synthetic-baa:${vendorId}-registered`,
    occurredAt,
    synthetic: true,
  };
}

function executed(
  tenantId: string,
  vendorId: string,
  version: number,
  effective: string,
  expiry: string,
  categories: readonly PhiCategory[],
  clauses: { readonly noTraining?: boolean; readonly zeroRetention?: boolean },
  occurredAt: string,
): VendorRegistryEvent {
  return {
    tenantId,
    vendorId,
    version,
    kind: 'baa-executed',
    baaStatus: 'executed',
    baaEffective: effective,
    baaExpiry: expiry,
    permittedCategories: categories,
    ...(clauses.noTraining !== undefined ? { noTrainingOnPhi: clauses.noTraining } : {}),
    ...(clauses.zeroRetention !== undefined ? { zeroRetention: clauses.zeroRetention } : {}),
    approvedBy: approver,
    evidenceRef: `synthetic-baa:${vendorId}-executed`,
    occurredAt,
    synthetic: true,
  };
}

// Category sets are seeded at registration (an executed BAA also declares its
// permitted categories); `category-expanded` folds a union afterward.
const withCategories = (
  event: VendorRegistryEvent,
  categories: readonly PhiCategory[],
): VendorRegistryEvent => ({ ...event, permittedCategories: categories });

export const syntheticVendorRegistrySeedV1: VendorRegistrySeed = {
  events: [
    // Covered payments vendor — the (a) allow standing proof (non-AI, PAY+ID).
    withCategories(
      registered(
        northwind,
        'synthetic-payments-vendor',
        'payments',
        false,
        'stripe-metadata-boundary',
        '2026-01-02T00:00:00Z',
      ),
      ['PAY', 'ID'],
    ),
    executed(
      northwind,
      'synthetic-payments-vendor',
      2,
      '2026-01-05',
      '2027-01-05',
      ['PAY', 'ID'],
      {},
      '2026-01-05T00:00:00Z',
    ),
    // Covered CPaaS vendor — appointment/clinical context (ID+CLIN).
    withCategories(
      registered(
        northwind,
        'synthetic-cpaas-vendor',
        'cpaas',
        false,
        'message-send-boundary',
        '2026-01-02T00:00:00Z',
      ),
      ['ID', 'CLIN'],
    ),
    executed(
      northwind,
      'synthetic-cpaas-vendor',
      2,
      '2026-01-05',
      '2027-06-05',
      ['ID', 'CLIN'],
      {},
      '2026-01-05T00:00:00Z',
    ),
    // AI LLM vendor WITH both clauses — the AI allow case (c passes).
    withCategories(
      registered(
        northwind,
        'synthetic-ai-llm-vendor',
        'voice-ai-llm',
        true,
        'llm-api-boundary',
        '2026-01-02T00:00:00Z',
      ),
      ['ID', 'CLIN'],
    ),
    executed(
      northwind,
      'synthetic-ai-llm-vendor',
      2,
      '2026-01-05',
      '2027-01-05',
      ['ID', 'CLIN'],
      { noTraining: true, zeroRetention: true },
      '2026-01-05T00:00:00Z',
    ),
    // AI vendor MISSING the no-training clause — the (c) block standing proof.
    withCategories(
      registered(
        northwind,
        'synthetic-ai-uncovered',
        'ai-general',
        true,
        'ai-api-boundary',
        '2026-01-02T00:00:00Z',
      ),
      ['ID', 'CLIN'],
    ),
    executed(
      northwind,
      'synthetic-ai-uncovered',
      2,
      '2026-01-05',
      '2027-01-05',
      ['ID', 'CLIN'],
      { noTraining: false, zeroRetention: true },
      '2026-01-05T00:00:00Z',
    ),
    // Labs vendor permitted only for CLIN — the (e) GEN-block standing proof.
    withCategories(
      registered(
        northwind,
        'synthetic-labs-vendor',
        'labs',
        false,
        'lab-order-result-boundary',
        '2026-01-02T00:00:00Z',
      ),
      ['ID', 'CLIN'],
    ),
    executed(
      northwind,
      'synthetic-labs-vendor',
      2,
      '2026-01-05',
      '2027-01-05',
      ['ID', 'CLIN'],
      {},
      '2026-01-05T00:00:00Z',
    ),
    // Lapsed-BAA fax vendor — the lapse standing proof (REQ-PLAT-029): executed
    // then lapsed, so the row is suspended and the guard fails closed.
    withCategories(
      registered(
        northwind,
        'synthetic-lapsed-vendor',
        'fax',
        false,
        'outbound-fax-boundary',
        '2026-01-02T00:00:00Z',
      ),
      ['ID', 'CLIN'],
    ),
    executed(
      northwind,
      'synthetic-lapsed-vendor',
      2,
      '2026-01-05',
      '2026-03-05',
      ['ID', 'CLIN'],
      {},
      '2026-01-05T00:00:00Z',
    ),
    {
      tenantId: northwind,
      vendorId: 'synthetic-lapsed-vendor',
      version: 3,
      kind: 'baa-lapsed',
      evidenceRef: 'synthetic-baa:lapsed-vendor-lapse',
      occurredAt: '2026-03-06T00:00:00Z',
      synthetic: true,
    },
    // Riverbend — the OPPOSITE posture: a registered vendor whose BAA is never
    // executed (the cross-tenant negative; the guard blocks any PHI to it).
    withCategories(
      registered(
        riverbend,
        'synthetic-rb-vendor',
        'cpaas',
        false,
        'message-send-boundary',
        '2026-01-02T00:00:00Z',
      ),
      [],
    ),
  ],
  contentLicenses: [
    // Active CPT license — the R6-REQ-080 flag-gating allow standing proof.
    {
      tenantId: northwind,
      licenseId: 'synthetic-cpt-license',
      contentFamily: 'cpt',
      status: 'active',
      effective: '2026-01-01',
      expiry: '2027-01-01',
      rightsRef: 'synthetic-license:cpt-permitted-use',
      checksum: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      synthetic: true,
    },
    // Lapsed compendium license — the R6-REQ-081 license-lapse-disable proof.
    {
      tenantId: northwind,
      licenseId: 'synthetic-compendium-license',
      contentFamily: 'drug-compendium',
      status: 'lapsed',
      effective: '2025-01-01',
      expiry: '2026-01-01',
      rightsRef: 'synthetic-license:compendium-permitted-use',
      checksum: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      synthetic: true,
    },
    // Riverbend — a pending CPT license (opposite posture; the gate denies).
    {
      tenantId: riverbend,
      licenseId: 'synthetic-rb-cpt',
      contentFamily: 'cpt',
      status: 'pending',
      effective: null,
      expiry: null,
      rightsRef: 'synthetic-license:rb-cpt-pending',
      checksum: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      synthetic: true,
    },
  ],
  egressDecisions: [
    // The standing activity feed: one allow (covered payments egress) and one
    // block (genetic data to the CLIN-only labs vendor, incident opened).
    {
      tenantId: northwind,
      decisionId: 'synthetic-egress-allow-0001',
      vendorId: 'synthetic-payments-vendor',
      decision: 'allow',
      phiClass: 'demographic',
      categories: ['PAY', 'ID'],
      reason: 'permitted',
      incidentOpened: false,
      occurredAt: '2026-03-15T09:00:00Z',
      synthetic: true,
    },
    {
      tenantId: northwind,
      decisionId: 'synthetic-egress-block-0001',
      vendorId: 'synthetic-labs-vendor',
      decision: 'deny',
      phiClass: 'PHI-restricted',
      categories: ['GEN'],
      reason: 'category-not-permitted',
      incidentOpened: true,
      occurredAt: '2026-03-15T09:05:00Z',
      synthetic: true,
    },
    {
      tenantId: riverbend,
      decisionId: 'synthetic-rb-egress-block-0001',
      vendorId: 'synthetic-rb-vendor',
      decision: 'deny',
      phiClass: 'PHI',
      categories: ['ID', 'CLIN'],
      reason: 'baa-not-executed',
      incidentOpened: true,
      occurredAt: '2026-03-15T09:10:00Z',
      synthetic: true,
    },
  ],
};

export const vendorRegistrySeedBeginMarker = '-- vendor-registry:generated:begin';
export const vendorRegistrySeedEndMarker = '-- vendor-registry:generated:end';

const sqlLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const sqlBool = (value: boolean): string => (value ? 'true' : 'false');
const sqlOptional = (value: string | null | undefined): string =>
  value === null || value === undefined ? 'NULL' : sqlLiteral(value);
const sqlDate = (value: string | null): string =>
  value === null ? 'NULL' : `${sqlLiteral(value)}::date`;
const sqlTextArray = (values: readonly string[]): string =>
  values.length === 0
    ? `'{}'::text[]`
    : `ARRAY[${values.map((value) => sqlLiteral(value)).join(', ')}]::text[]`;

function vendorEventRow(event: VendorRegistryEvent): string {
  return (
    `  (${sqlLiteral(event.tenantId)}, ${sqlLiteral(event.vendorId)}, ${event.version}, ` +
    `${sqlLiteral(event.kind)}, ${sqlOptional(event.vendorClass)}, ` +
    `${event.isAiVendor === undefined ? 'NULL' : sqlBool(event.isAiVendor)}, ` +
    `${sqlOptional(event.enforcementPoint)}, ${sqlOptional(event.baaStatus)}, ` +
    `${sqlDate(event.baaEffective ?? null)}, ${sqlDate(event.baaExpiry ?? null)}, ` +
    `${event.noTrainingOnPhi === undefined ? 'NULL' : sqlBool(event.noTrainingOnPhi)}, ` +
    `${event.zeroRetention === undefined ? 'NULL' : sqlBool(event.zeroRetention)}, ` +
    `${event.permittedCategories === undefined ? 'NULL' : sqlTextArray([...event.permittedCategories])}, ` +
    `${sqlOptional(event.evidenceRef)}, ${sqlOptional(event.approvedBy)}, ` +
    `${sqlLiteral(event.occurredAt)}::timestamptz, true)`
  );
}

function vendorRow(row: VendorRegistryRow): string {
  return (
    `  (${sqlLiteral(row.tenantId)}, ${sqlLiteral(row.vendorId)}, ${sqlLiteral(row.vendorClass)}, ` +
    `${sqlBool(row.isAiVendor)}, ${sqlLiteral(row.enforcementPoint)}, ${sqlLiteral(row.baaStatus)}, ` +
    `${sqlDate(row.baaEffective)}, ${sqlDate(row.baaExpiry)}, ${sqlBool(row.noTrainingOnPhi)}, ` +
    `${sqlBool(row.zeroRetention)}, ${sqlTextArray([...row.permittedCategories])}, ` +
    `${sqlLiteral(row.status)}, ${row.version}, true)`
  );
}

function licenseRow(row: ContentLicenseRow): string {
  return (
    `  (${sqlLiteral(row.tenantId)}, ${sqlLiteral(row.licenseId)}, ${sqlLiteral(row.contentFamily)}, ` +
    `${sqlLiteral(row.status)}, ${sqlDate(row.effective)}, ${sqlDate(row.expiry)}, ` +
    `${sqlLiteral(row.rightsRef)}, ${sqlLiteral(row.checksum)}, true)`
  );
}

function decisionRow(row: EgressDecisionSeed): string {
  return (
    `  (${sqlLiteral(row.tenantId)}, ${sqlLiteral(row.decisionId)}, ${sqlLiteral(row.vendorId)}, ` +
    `${sqlLiteral(row.decision)}, ${sqlLiteral(row.phiClass)}, ${sqlTextArray([...row.categories])}, ` +
    `${sqlLiteral(row.reason)}, ${sqlBool(row.incidentOpened)}, ${sqlLiteral(row.occurredAt)}::timestamptz, true)`
  );
}

/**
 * Render the synthetic seed as idempotent SQL. Lifecycle events insert with
 * ON CONFLICT DO NOTHING (the log is append-only); the vendor projection is the
 * FOLD of that log (one data source, re-proven against the database by the DB
 * suite's projection-sync test); licenses and egress decisions upsert/insert.
 */
export function renderVendorRegistrySeedSection(seed: VendorRegistrySeed): string {
  const eventRows = [...seed.events]
    .sort((left, right) =>
      `${left.tenantId}|${left.vendorId}|${String(left.version).padStart(4, '0')}`.localeCompare(
        `${right.tenantId}|${right.vendorId}|${String(right.version).padStart(4, '0')}`,
      ),
    )
    .map(vendorEventRow);
  const folded = [...foldVendorRegistry(seed.events).values()].sort((left, right) =>
    `${left.tenantId}|${left.vendorId}`.localeCompare(`${right.tenantId}|${right.vendorId}`),
  );
  const projectionRows = folded.map(vendorRow);
  const licenseRows = [...seed.contentLicenses]
    .sort((left, right) =>
      `${left.tenantId}|${left.licenseId}`.localeCompare(`${right.tenantId}|${right.licenseId}`),
    )
    .map(licenseRow);
  const decisionRows = [...seed.egressDecisions]
    .sort((left, right) =>
      `${left.tenantId}|${left.decisionId}`.localeCompare(`${right.tenantId}|${right.decisionId}`),
    )
    .map(decisionRow);
  return [
    vendorRegistrySeedBeginMarker,
    '-- Generated by @practicehub/platform-integration renderVendorRegistrySeedSection from',
    '-- syntheticVendorRegistrySeedV1. Regenerate on any seed change; the drift test',
    '-- and the DB projection-sync test fail on divergence.',
    'INSERT INTO platform_integration.vendor_event',
    '  (tenant_id, vendor_id, version, kind, vendor_class, is_ai_vendor, enforcement_point,',
    '   baa_status, baa_effective, baa_expiry, no_training_on_phi, zero_retention,',
    '   permitted_categories, evidence_ref, approved_by, occurred_at, synthetic)',
    'VALUES',
    `${eventRows.join(',\n')}`,
    'ON CONFLICT (tenant_id, vendor_id, version) DO NOTHING;',
    '',
    'INSERT INTO platform_integration.vendor',
    '  (tenant_id, vendor_id, vendor_class, is_ai_vendor, enforcement_point, baa_status,',
    '   baa_effective, baa_expiry, no_training_on_phi, zero_retention, permitted_categories,',
    '   status, version, synthetic)',
    'VALUES',
    `${projectionRows.join(',\n')}`,
    'ON CONFLICT (tenant_id, vendor_id) DO UPDATE',
    'SET vendor_class = EXCLUDED.vendor_class,',
    '    is_ai_vendor = EXCLUDED.is_ai_vendor,',
    '    enforcement_point = EXCLUDED.enforcement_point,',
    '    baa_status = EXCLUDED.baa_status,',
    '    baa_effective = EXCLUDED.baa_effective,',
    '    baa_expiry = EXCLUDED.baa_expiry,',
    '    no_training_on_phi = EXCLUDED.no_training_on_phi,',
    '    zero_retention = EXCLUDED.zero_retention,',
    '    permitted_categories = EXCLUDED.permitted_categories,',
    '    status = EXCLUDED.status,',
    '    version = EXCLUDED.version,',
    '    synthetic = EXCLUDED.synthetic;',
    '',
    'INSERT INTO platform_integration.content_license',
    '  (tenant_id, license_id, content_family, status, effective, expiry, rights_ref, checksum, synthetic)',
    'VALUES',
    `${licenseRows.join(',\n')}`,
    'ON CONFLICT (tenant_id, license_id) DO UPDATE',
    'SET content_family = EXCLUDED.content_family,',
    '    status = EXCLUDED.status,',
    '    effective = EXCLUDED.effective,',
    '    expiry = EXCLUDED.expiry,',
    '    rights_ref = EXCLUDED.rights_ref,',
    '    checksum = EXCLUDED.checksum,',
    '    synthetic = EXCLUDED.synthetic;',
    '',
    'INSERT INTO platform_integration.egress_decision',
    '  (tenant_id, decision_id, vendor_id, decision, phi_class, categories, reason,',
    '   incident_opened, occurred_at, synthetic)',
    'VALUES',
    `${decisionRows.join(',\n')}`,
    'ON CONFLICT (tenant_id, decision_id) DO NOTHING;',
    vendorRegistrySeedEndMarker,
  ].join('\n');
}

/** Extract the generated section from a seed file's contents (drift test). */
export function extractVendorRegistrySeedSection(seedSql: string): string | null {
  const begin = seedSql.indexOf(vendorRegistrySeedBeginMarker);
  const end = seedSql.indexOf(vendorRegistrySeedEndMarker);
  if (begin === -1 || end === -1 || end < begin) {
    return null;
  }
  return seedSql.slice(begin, end + vendorRegistrySeedEndMarker.length);
}

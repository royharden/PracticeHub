/**
 * RLS table registry for the `identity` schema (WP-013), consumed by the
 * WP-010 generator. All identity tables are tenant-scoped; the generated
 * section embedded in migrations/0004-identity.sql is drift-tested against a
 * fresh emission, and the schema coverage guard fails the migration if any
 * table in the schema lacks forced RLS.
 */

import type { RlsTableSpec } from '@practicehub/platform-core';

/** Tables created by 0004-identity.sql — that migration's DDL scope. */
export const identityRlsSpecs: readonly RlsTableSpec[] = [
  { schema: 'identity', table: 'person', kind: 'tenant-scoped' },
  { schema: 'identity', table: 'person_name', kind: 'tenant-scoped' },
  { schema: 'identity', table: 'patient_record', kind: 'tenant-scoped' },
  { schema: 'identity', table: 'staff_account', kind: 'tenant-scoped' },
  { schema: 'identity', table: 'guarantor_role', kind: 'tenant-scoped' },
  { schema: 'identity', table: 'proxy_grant', kind: 'tenant-scoped' },
  { schema: 'identity', table: 'channel_endpoint', kind: 'tenant-scoped' },
  { schema: 'identity', table: 'endpoint_association', kind: 'tenant-scoped' },
  { schema: 'identity', table: 'source_identifier', kind: 'tenant-scoped' },
  { schema: 'identity', table: 'identity_timeline', kind: 'tenant-scoped' },
];

/** Tables created by 0005-authn.sql (WP-014) — that migration's DDL scope. */
export const authnRlsSpecs: readonly RlsTableSpec[] = [
  { schema: 'identity', table: 'auth_credential', kind: 'tenant-scoped' },
  { schema: 'identity', table: 'auth_device', kind: 'tenant-scoped' },
  { schema: 'identity', table: 'auth_session', kind: 'tenant-scoped' },
  { schema: 'identity', table: 'auth_challenge', kind: 'tenant-scoped' },
  { schema: 'identity', table: 'account_lockdown', kind: 'tenant-scoped' },
];

/** Tables created by 0006-merge.sql (WP-016) — that migration's DDL scope. */
export const mergeRlsSpecs: readonly RlsTableSpec[] = [
  { schema: 'identity', table: 'merge_case', kind: 'tenant-scoped' },
  { schema: 'identity', table: 'merge_case_person', kind: 'tenant-scoped' },
  { schema: 'identity', table: 'merge_event', kind: 'tenant-scoped' },
  { schema: 'identity', table: 'merge_lineage', kind: 'tenant-scoped' },
];

/** Tables created by 0008-pdp.sql (WP-015) — that migration's DDL scope. */
export const pdpRlsSpecs: readonly RlsTableSpec[] = [
  { schema: 'identity', table: 'role_template', kind: 'tenant-scoped' },
  { schema: 'identity', table: 'role_assignment', kind: 'tenant-scoped' },
  { schema: 'identity', table: 'access_override', kind: 'tenant-scoped' },
  { schema: 'identity', table: 'authority_record', kind: 'tenant-scoped' },
  { schema: 'identity', table: 'person_flag', kind: 'tenant-scoped' },
  { schema: 'identity', table: 'partition_tag', kind: 'tenant-scoped' },
  { schema: 'identity', table: 'gipa_authorization', kind: 'tenant-scoped' },
];

/** Tables created by 0013-elevation.sql (WP-017) — that migration's DDL scope. */
export const elevationRlsSpecs: readonly RlsTableSpec[] = [
  { schema: 'identity', table: 'break_glass_grant', kind: 'tenant-scoped' },
  { schema: 'identity', table: 'break_glass_review', kind: 'tenant-scoped' },
  { schema: 'identity', table: 'offboarding_case', kind: 'tenant-scoped' },
  { schema: 'identity', table: 'offboarding_reassignment', kind: 'tenant-scoped' },
  { schema: 'identity', table: 'access_anomaly_case', kind: 'tenant-scoped' },
  { schema: 'identity', table: 'access_recertification', kind: 'tenant-scoped' },
];

/** The full identity-schema registry — every migration's coverage guard declares it. */
export const identitySchemaRlsSpecs: readonly RlsTableSpec[] = [
  ...identityRlsSpecs,
  ...authnRlsSpecs,
  ...mergeRlsSpecs,
  ...pdpRlsSpecs,
  ...elevationRlsSpecs,
];

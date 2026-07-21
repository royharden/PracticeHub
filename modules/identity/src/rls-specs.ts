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

/** The full identity-schema registry — every migration's coverage guard declares it. */
export const identitySchemaRlsSpecs: readonly RlsTableSpec[] = [
  ...identityRlsSpecs,
  ...authnRlsSpecs,
];

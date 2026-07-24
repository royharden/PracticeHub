/**
 * RLS table registry for the `platform_integration` schema (WP-026, M07),
 * consumed by the WP-010 generator. The vendor registry, its append-only
 * lifecycle log, the egress-decision activity feed, and the content-license
 * gate are all per-tenant — each tenant's BAA posture is its own, and an
 * unbound session must read zero rows (fail-closed) from every table. Riverbend
 * carries the opposite BAA posture as the standing cross-tenant proof.
 *
 * Per-migration DDL scope + a schema-wide guard registry (the WP-014
 * schema-wide-guard precedent); the section embedded in
 * 0017-vendor-registry.sql is drift-tested against a fresh emission.
 */

import type { RlsTableSpec } from '@practicehub/platform-core';

/** Tables created by 0017-vendor-registry.sql — that migration's DDL scope. */
export const vendorRegistryRlsSpecs: readonly RlsTableSpec[] = [
  { schema: 'platform_integration', table: 'vendor', kind: 'tenant-scoped' },
  { schema: 'platform_integration', table: 'vendor_event', kind: 'tenant-scoped' },
  { schema: 'platform_integration', table: 'egress_decision', kind: 'tenant-scoped' },
  { schema: 'platform_integration', table: 'content_license', kind: 'tenant-scoped' },
];

/** The full platform_integration-schema registry — every migration's guard declares it. */
export const platformIntegrationSchemaRlsSpecs: readonly RlsTableSpec[] = [
  ...vendorRegistryRlsSpecs,
];

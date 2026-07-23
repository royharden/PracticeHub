/**
 * RLS table registry for the `events` schema, consumed by the WP-010 generator.
 * The event spine is per-tenant, and so is the WP-022 tasking engine; an unbound
 * session must read zero rows (fail-closed) from every table.
 *
 * Per-migration DDL scope (each migration's generated section covers only ITS
 * tables) + a schema-wide guard registry (every migration's coverage guard lists
 * every table in the schema, so a later table left un-RLS'd is caught). The
 * sections embedded in 0010-events.sql and 0012-workitems.sql are drift-tested
 * against a fresh emission (WP-011 split; WP-014 schema-wide-guard precedent).
 */

import type { RlsTableSpec } from '@practicehub/platform-core';

/** Tables created by 0010-events.sql — that migration's DDL scope. */
export const eventsRlsSpecs: readonly RlsTableSpec[] = [
  { schema: 'events', table: 'outbox', kind: 'tenant-scoped' },
  { schema: 'events', table: 'outbox_delivery', kind: 'tenant-scoped' },
  { schema: 'events', table: 'inbox', kind: 'tenant-scoped' },
];

/** Tables created by 0012-workitems.sql — that migration's DDL scope (WP-022). */
export const workItemsRlsSpecs: readonly RlsTableSpec[] = [
  { schema: 'events', table: 'sla_policy', kind: 'tenant-scoped' },
  { schema: 'events', table: 'work_item', kind: 'tenant-scoped' },
  { schema: 'events', table: 'work_item_event', kind: 'tenant-scoped' },
  { schema: 'events', table: 'sla_timer', kind: 'tenant-scoped' },
];

/** The full events-schema registry — every migration's guard declares it. */
export const eventsSchemaRlsSpecs: readonly RlsTableSpec[] = [
  ...eventsRlsSpecs,
  ...workItemsRlsSpecs,
];

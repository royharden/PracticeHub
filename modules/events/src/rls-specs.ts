/**
 * RLS table registry for the `events` schema (WP-021), consumed by the WP-010
 * generator. All three tables are tenant-scoped: the event spine is per-tenant,
 * and an unbound session must read zero rows (fail-closed). The generated
 * section embedded in migrations/0010-events.sql is drift-tested against a fresh
 * emission.
 */

import type { RlsTableSpec } from '@practicehub/platform-core';

/** Tables created by 0010-events.sql — that migration's DDL scope. */
export const eventsRlsSpecs: readonly RlsTableSpec[] = [
  { schema: 'events', table: 'outbox', kind: 'tenant-scoped' },
  { schema: 'events', table: 'outbox_delivery', kind: 'tenant-scoped' },
  { schema: 'events', table: 'inbox', kind: 'tenant-scoped' },
];

/** The full events-schema registry — every migration's guard declares it. */
export const eventsSchemaRlsSpecs: readonly RlsTableSpec[] = [...eventsRlsSpecs];

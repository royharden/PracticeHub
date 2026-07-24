/**
 * Drift gates (WP-021): the committed migration embeds EXACTLY the generated
 * RLS section; the guard registry declares every DDL-scope table; and the
 * committed seed file embeds EXACTLY the generated events seed section (the
 * outbox envelopes, the delivery projection, and the inbox dedup rows).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { extractRlsMigrationSection, renderRlsMigrationSection } from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import {
  eventsRlsSpecs,
  eventsSchemaRlsSpecs,
  onCallRlsSpecs,
  workItemsRlsSpecs,
} from './rls-specs.js';
import {
  extractEventsSeedSection,
  renderEventsSeedSection,
  syntheticEventsSeedV1,
} from './seed-data.js';
import {
  extractWorkItemsSeedSection,
  renderWorkItemsSeedSection,
  syntheticWorkItemsSeedV1,
} from './sla-seed-data.js';
import {
  extractOnCallSeedSection,
  renderOnCallSeedSection,
  syntheticOnCallSeedV1,
} from './oncall-seed-data.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

describe('0010-events.sql RLS drift gate', () => {
  it('embeds exactly the generated section (guard grows schema-wide as later migrations add tables)', () => {
    const migration = readFileSync(`${repoRoot}modules/events/migrations/0010-events.sql`, 'utf8');
    const embedded = extractRlsMigrationSection(migration);
    expect(embedded).toBe(
      renderRlsMigrationSection('events', eventsRlsSpecs, eventsSchemaRlsSpecs),
    );
  });

  it('the schema-wide guard registry declares every DDL-scope table', () => {
    const guardTables = new Set(eventsSchemaRlsSpecs.map((spec) => `${spec.schema}.${spec.table}`));
    for (const spec of [...eventsRlsSpecs, ...workItemsRlsSpecs]) {
      expect(guardTables.has(`${spec.schema}.${spec.table}`)).toBe(true);
    }
  });
});

describe('0012-workitems.sql RLS drift gate (WP-022)', () => {
  it('embeds exactly the generated section (DDL scope = tasking tables; guard = full schema)', () => {
    const migration = readFileSync(
      `${repoRoot}modules/events/migrations/0012-workitems.sql`,
      'utf8',
    );
    const embedded = extractRlsMigrationSection(migration);
    expect(embedded).toBe(
      renderRlsMigrationSection('events', workItemsRlsSpecs, eventsSchemaRlsSpecs),
    );
  });
});

describe('0014-oncall.sql RLS drift gate (WP-023)', () => {
  it('embeds exactly the generated section (DDL scope = on-call/coverage tables; guard = full schema)', () => {
    const migration = readFileSync(`${repoRoot}modules/events/migrations/0014-oncall.sql`, 'utf8');
    const embedded = extractRlsMigrationSection(migration);
    expect(embedded).toBe(
      renderRlsMigrationSection('events', onCallRlsSpecs, eventsSchemaRlsSpecs),
    );
  });

  it('the schema-wide guard registry now declares the on-call/coverage tables', () => {
    const guardTables = new Set(eventsSchemaRlsSpecs.map((spec) => `${spec.schema}.${spec.table}`));
    for (const spec of onCallRlsSpecs) {
      expect(guardTables.has(`${spec.schema}.${spec.table}`)).toBe(true);
    }
  });
});

describe('016-oncall-seed.sql drift gate (WP-023)', () => {
  it('embeds exactly the generated section', () => {
    const seed = readFileSync(`${repoRoot}infra/postgres/seed/016-oncall-seed.sql`, 'utf8');
    const embedded = extractOnCallSeedSection(seed);
    expect(embedded).toBe(renderOnCallSeedSection(syntheticOnCallSeedV1));
  });

  it('the pto-coverage handoff manifest length matches its item_count (contract §2)', () => {
    const handoff = syntheticOnCallSeedV1.handoffs.find(
      (record) => record.handoffId === 'handoff-noor-pto-0001',
    );
    expect(handoff?.kind).toBe('pto-coverage');
    expect(handoff?.itemCount).toBe(handoff?.manifest.length);
    expect(handoff?.itemCount).toBe(2);
  });
});

describe('014-workitems-seed.sql drift gate (WP-022)', () => {
  it('embeds exactly the generated section', () => {
    const seed = readFileSync(`${repoRoot}infra/postgres/seed/014-workitems-seed.sql`, 'utf8');
    const embedded = extractWorkItemsSeedSection(seed);
    expect(embedded).toBe(renderWorkItemsSeedSection(syntheticWorkItemsSeedV1));
  });

  it('the William seed folds to a single owner with the prior owner demoted to a watcher', () => {
    const william = syntheticWorkItemsSeedV1.records.find(
      (record) => record.item.workItemId === 'wi-thread-william-0001',
    );
    expect(william?.item.ownerRef).toBe('synthetic-guide:maya');
    expect(william?.item.watchers).toContain('synthetic-guide:william');
    expect(william?.item.escalated).toBe(true);
    const next = william?.timers.find((timer) => timer.timerType === 'next_response');
    const resolution = william?.timers.find((timer) => timer.timerType === 'resolution');
    expect(next?.state).toBe('paused');
    expect(resolution?.state).toBe('running');
  });
});

describe('012-events-seed.sql drift gate', () => {
  it('embeds exactly the generated section', () => {
    const seed = readFileSync(`${repoRoot}infra/postgres/seed/012-events-seed.sql`, 'utf8');
    const embedded = extractEventsSeedSection(seed);
    expect(embedded).toBe(renderEventsSeedSection(syntheticEventsSeedV1));
  });

  it('every published seed delivery carries a published_at and a pending one does not', () => {
    for (const record of syntheticEventsSeedV1.records) {
      if (record.deliveryStatus === 'published') {
        expect(record.publishedAt).not.toBeNull();
      } else {
        expect(record.publishedAt).toBeNull();
      }
    }
  });
});

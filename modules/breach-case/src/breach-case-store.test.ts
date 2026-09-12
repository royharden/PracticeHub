import { describe, expect, it } from 'vitest';
import { types as pgTypes } from 'pg';

import type { BreachCaseEvent } from './breach-case.js';
import {
  appendBreachEvents,
  breachEventIntentHash,
  breachNormalizedSnapshot,
  createBreachCase,
  loadBreachCase,
  normalizePostgresCalendarDate,
  type BreachQueryable,
  type QueryResultLike,
} from './breach-case-store.js';
import { syntheticBreachCaseSeedV1 } from './seed-data.js';

class CorruptLoadQueryable implements BreachQueryable {
  public constructor(
    private readonly event: BreachCaseEvent,
    private readonly mutation: 'hash' | 'tuple',
  ) {}

  public async query<Row = Record<string, unknown>>(sql: string): Promise<QueryResultLike<Row>> {
    if (sql.includes('FROM breach_case.breach_case_event')) {
      const row = {
        tenant_id: this.event.tenantId,
        case_id: this.event.caseId,
        event_seq: this.event.eventSeq,
        event_key: this.mutation === 'tuple' ? 'changed-key' : this.event.eventKey,
        event_type: this.event.eventType,
        occurred_at: this.event.occurredAt,
        actor_ref: this.event.actorRef,
        payload: this.event,
        payload_hash: this.mutation === 'hash' ? '0'.repeat(64) : breachEventIntentHash(this.event),
      };
      return { rows: [row as Row], rowCount: 1 };
    }
    const projection = {
      case_id: this.event.caseId,
      status: 'assessing',
      current_assessment_version: null,
      current_scope_version: null,
      determination: null,
      last_event_seq: 1,
    };
    return { rows: [projection as Row], rowCount: 1 };
  }
}

class ValidOpenQueryable implements BreachQueryable {
  public writes = 0;

  public constructor(private readonly event: BreachCaseEvent) {}

  public async query<Row = Record<string, unknown>>(sql: string): Promise<QueryResultLike<Row>> {
    if (/^\s*(INSERT|UPDATE|DELETE)/.test(sql)) this.writes += 1;
    if (sql.includes('FROM breach_case.breach_case_event')) {
      return {
        rows: [
          {
            tenant_id: this.event.tenantId,
            case_id: this.event.caseId,
            event_seq: this.event.eventSeq,
            event_key: this.event.eventKey,
            event_type: this.event.eventType,
            occurred_at: this.event.occurredAt,
            actor_ref: this.event.actorRef,
            payload: this.event,
            payload_hash: breachEventIntentHash(this.event),
          } as Row,
        ],
        rowCount: 1,
      };
    }
    if (sql.includes('FROM breach_case.breach_case\n')) {
      return {
        rows: [
          {
            case_id: this.event.caseId,
            source_kind: this.event.sourceKind,
            source_ref: this.event.sourceRef,
            incident_at: this.event.incidentAt,
            discovery_at: this.event.discoveryAt,
            owner_ref: this.event.ownerRef,
            status: 'assessing',
            current_assessment_version: null,
            current_scope_version: null,
            determination: null,
            strictest_due_at: null,
            retention_evidence_ref: null,
            closure_evidence_ref: null,
            last_event_seq: 1,
          } as Row,
        ],
        rowCount: 1,
      };
    }
    if (sql.includes('FROM breach_case.effect_fence')) {
      return {
        rows: [
          { event_key: this.event.eventKey, intent_hash: breachEventIntentHash(this.event) } as Row,
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  }
}

class SeedLoadQueryable implements BreachQueryable {
  public constructor(
    private readonly mutation: 'none' | 'driver-date' | 'policy-date' | 'duty' | 'scope' | 'notice',
  ) {}

  public async query<Row = Record<string, unknown>>(sql: string): Promise<QueryResultLike<Row>> {
    const aggregate = syntheticBreachCaseSeedV1.aggregates[0];
    if (aggregate === undefined) throw new Error('seed aggregate missing');
    const normalized = breachNormalizedSnapshot(aggregate);
    let rows: readonly Record<string, unknown>[];
    if (sql.includes('FROM breach_case.breach_case_event')) {
      rows = aggregate.events.map((event) => ({
        tenant_id: event.tenantId,
        case_id: event.caseId,
        event_seq: event.eventSeq,
        event_key: event.eventKey,
        event_type: event.eventType,
        occurred_at: event.occurredAt,
        actor_ref: event.actorRef,
        payload: event,
        payload_hash: breachEventIntentHash(event),
      }));
    } else if (sql.includes('FROM breach_case.breach_case\n')) {
      rows = [
        {
          case_id: aggregate.caseId,
          source_kind: aggregate.sourceKind,
          source_ref: aggregate.sourceRef,
          incident_at: aggregate.incidentAt,
          discovery_at: aggregate.discoveryAt,
          owner_ref: aggregate.ownerRef,
          status: aggregate.status,
          current_assessment_version: aggregate.assessments.at(-1)?.version ?? null,
          current_scope_version: aggregate.affectedScopes.at(-1)?.version ?? null,
          determination: aggregate.determination,
          strictest_due_at: aggregate.strictestOpenDueAt,
          retention_evidence_ref: aggregate.retentionEvidenceRef,
          closure_evidence_ref: aggregate.events.at(-1)?.evidenceRef ?? null,
          last_event_seq: aggregate.lastEventSeq,
        },
      ];
    } else if (sql.includes('factor_assessment')) rows = normalized.assessments;
    else if (sql.includes('affected_scope_version')) {
      rows = normalized.scopes.map((row, index) =>
        this.mutation === 'scope' && index === 0 ? { ...row, complete: false } : row,
      );
    } else if (sql.includes('affected_subject')) rows = normalized.subjects;
    else if (sql.includes('jurisdiction_duty')) {
      rows = normalized.duties.map((row, index) =>
        this.mutation === 'duty' && index === 0
          ? { ...row, due_at: '2030-01-01T00:00:00Z' }
          : this.mutation === 'driver-date' && index === 0
            ? { ...row, policy_effective_on: pgTypes.getTypeParser(1082, 'text')('2026-01-01') }
            : this.mutation === 'policy-date' && index === 0
              ? { ...row, policy_effective_on: '2026-01-02' }
              : row,
      );
    } else if (sql.includes('notification_evidence')) {
      rows = normalized.notices.map((row, index) =>
        this.mutation === 'notice' && index === normalized.notices.length - 1
          ? { ...row, terminal_evidence_ref: 'receipt:corrupted' }
          : row,
      );
    } else if (sql.includes('genetic_targeted_review')) rows = normalized.reviews;
    else if (sql.includes('effect_fence')) rows = normalized.fences;
    else rows = [];
    return { rows: rows as Row[], rowCount: rows.length };
  }
}

describe('breach store trust boundary', () => {
  it('hashes semantically identical events independent of object property insertion order', () => {
    const original = syntheticBreachCaseSeedV1.aggregates[1]?.events[0];
    if (original === undefined) throw new Error('seed event missing');
    const reordered = Object.fromEntries(
      Object.entries(original).reverse(),
    ) as unknown as BreachCaseEvent;
    expect(breachEventIntentHash(reordered)).toBe(breachEventIntentHash(original));
  });

  it.each(['hash', 'tuple'] as const)(
    'rejects a persisted event with corrupted %s before folding',
    async (mutation) => {
      const event = syntheticBreachCaseSeedV1.aggregates[1]?.events[0];
      if (event === undefined) throw new Error('seed event missing');
      await expect(
        loadBreachCase(new CorruptLoadQueryable(event, mutation), event.tenantId, event.caseId),
      ).rejects.toThrow(/tuple\/hash mismatch/);
    },
  );

  it('rejects malformed raw append before writing a fence or event', async () => {
    const opened = syntheticBreachCaseSeedV1.aggregates[1]?.events[0];
    if (opened === undefined) throw new Error('seed event missing');
    const queryable = new ValidOpenQueryable(opened);
    const invalid: BreachCaseEvent = {
      tenantId: opened.tenantId,
      caseId: opened.caseId,
      eventSeq: 2,
      eventKey: 'raw-invalid-determination',
      eventType: 'determination-recorded',
      occurredAt: '2026-03-06T10:00:00Z',
      actorRef: 'person:same',
      determination: {
        kind: 'low-probability',
        assessmentVersion: 999,
        rationaleRef: 'rationale:raw',
        determinedBy: 'person:same',
        approvedBy: 'person:same',
        determinedAt: '2026-03-06T10:00:00Z',
        synthetic: true,
      },
      synthetic: true,
    };
    await expect(
      appendBreachEvents(queryable, opened.tenantId, opened.caseId, [invalid]),
    ).rejects.toThrow(/current complete known scope assessment/);
    expect(queryable.writes).toBe(0);
  });

  it('validates the opening fold and aggregate projection before any create write', async () => {
    const aggregate = syntheticBreachCaseSeedV1.aggregates[1];
    const opening = aggregate?.events[0];
    if (aggregate === undefined || opening === undefined) throw new Error('seed opening missing');
    const queryable = new ValidOpenQueryable(opening);
    const invalid = {
      ...aggregate,
      events: [{ ...opening, synthetic: false as true }],
    };
    await expect(createBreachCase(queryable, invalid)).rejects.toThrow(/must be synthetic/);
    expect(queryable.writes).toBe(0);
  });

  it('loads a complete normalized seed snapshot and rejects closure-relevant corruption', async () => {
    const aggregate = syntheticBreachCaseSeedV1.aggregates[0];
    if (aggregate === undefined) throw new Error('seed aggregate missing');
    await expect(
      loadBreachCase(new SeedLoadQueryable('none'), aggregate.tenantId, aggregate.caseId),
    ).resolves.toMatchObject({ status: 'closed' });
    await expect(
      loadBreachCase(new SeedLoadQueryable('driver-date'), aggregate.tenantId, aggregate.caseId),
    ).resolves.toMatchObject({ status: 'closed' });
    for (const mutation of ['policy-date', 'duty', 'scope', 'notice'] as const) {
      await expect(
        loadBreachCase(new SeedLoadQueryable(mutation), aggregate.tenantId, aggregate.caseId),
      ).rejects.toThrow(/normalized facts/);
    }
  });

  it('normalizes driver and non-UTC local-midnight DATE values without UTC date shifting', () => {
    const parsed = pgTypes.getTypeParser(1082, 'text')('2026-01-01');
    expect(normalizePostgresCalendarDate(parsed)).toBe('2026-01-01');
    expect(normalizePostgresCalendarDate(new Date(2026, 0, 1))).toBe('2026-01-01');
    expect(normalizePostgresCalendarDate('2024-02-29')).toBe('2024-02-29');
    for (const invalid of ['2026-02-29', '2026-02-30', '2026-99-99']) {
      expect(() => normalizePostgresCalendarDate(invalid)).toThrow(/calendar date/);
    }
    expect(() => normalizePostgresCalendarDate(new Date(2026, 0, 1, 12))).toThrow(/local midnight/);
    expect(() => normalizePostgresCalendarDate(new Date(2026, 0, 1, 0, 0, 0, 1))).toThrow(
      /local midnight/,
    );
    expect(() => normalizePostgresCalendarDate('2026-01-01T00:00:00Z')).toThrow(/calendar date/);
  });
});

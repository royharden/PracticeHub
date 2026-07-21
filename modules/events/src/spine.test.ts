import { buildEventEnvelope, type EventEnvelopeInput } from '@practicehub/platform';
import { describe, expect, it } from 'vitest';

import {
  envelopeFromClaim,
  outboxColumns,
  outboxInsertParams,
  type ClaimedDeliveryRow,
} from './spine.js';

const eventId = '01H8XGJWBWBAQ4Z5Z5Z5Z5Z5Z5';

function envelope(overrides: Partial<EventEnvelopeInput<unknown>> = {}) {
  return buildEventEnvelope({
    eventId,
    tenantId: 'northwind-synthetic',
    type: 'consent.recorded',
    aggregate: { type: 'consent-ledger', id: 'np-sam-porter', version: 1 },
    occurredAt: '2026-03-01T00:00:00Z',
    recordedAt: '2026-03-01T00:00:00Z',
    source: { module: 'consent', actorRef: 'synthetic-staff:intake' },
    idempotencyKey: 'consent:np-sam-porter:recorded:0001',
    dataClassification: 'demographic',
    payload: { scope: 'sms/treatment' },
    synthetic: true,
    ...overrides,
  });
}

function claimFrom(
  env: ReturnType<typeof envelope>,
  status = 'pending',
  attempts = 0,
): ClaimedDeliveryRow {
  return {
    tenant_id: env.tenantId,
    event_id: env.eventId,
    legal_entity_id: env.legalEntityId ?? null,
    type: env.type,
    aggregate_type: env.aggregate.type,
    aggregate_id: env.aggregate.id,
    aggregate_version: env.aggregate.version,
    occurred_at_iso: env.occurredAt,
    recorded_at_iso: env.recordedAt,
    effective_at_iso: env.effectiveAt ?? null,
    source_module: env.source.module,
    source_actor_ref: env.source.actorRef ?? null,
    correlation_id: env.correlationId ?? null,
    causation_id: env.causationId ?? null,
    idempotency_key: env.idempotencyKey,
    data_classification: env.dataClassification,
    retention_class: env.retentionClass ?? null,
    supersedes_event_id: env.supersedesEventId ?? null,
    reversal_of_event_id: env.reversalOfEventId ?? null,
    external_receipt_ref: env.externalReceiptRef ?? null,
    payload: env.payload,
    status,
    attempts,
  };
}

describe('outbox row mapping', () => {
  it('produces one parameter per outbox column', () => {
    expect(outboxInsertParams(envelope())).toHaveLength(outboxColumns.length);
  });

  it('serializes the payload as JSON text for the jsonb column', () => {
    const params = outboxInsertParams(envelope());
    const payloadParam = params[outboxColumns.indexOf('payload')];
    expect(payloadParam).toBe(JSON.stringify({ scope: 'sms/treatment' }));
  });

  it('round-trips a claimed row back to an equal envelope', () => {
    const original = envelope({
      correlationId: 'saga:onboarding:0001',
      externalReceiptRef: 'synthetic-receipt:cpaas-sim-0001',
      retentionClass: 'consent-artifact',
    });
    const reconstructed = envelopeFromClaim(claimFrom(original));
    expect(reconstructed).toEqual(original);
  });

  it('re-validates on read: a claimed row with a bad ref is rejected', () => {
    const bad = claimFrom(envelope());
    const forged = { ...bad, aggregate_id: 'Not A Ref' };
    expect(() => envelopeFromClaim(forged)).toThrow();
  });
});

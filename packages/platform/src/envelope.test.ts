import { describe, expect, it } from 'vitest';

import {
  buildEventEnvelope,
  canonicalEnvelope,
  EventEnvelopeError,
  validateEventEnvelope,
  type EventEnvelopeInput,
} from './envelope.js';

const validEventId = '01H8XGJWBWBAQ4Z5Z5Z5Z5Z5Z5';
const otherEventId = '01H8XGJWBWBAQ4Z5Z5Z5Z5Z5Z6';

function validInput(
  overrides: Partial<EventEnvelopeInput<unknown>> = {},
): EventEnvelopeInput<unknown> {
  return {
    eventId: validEventId,
    tenantId: 'northwind-synthetic',
    type: 'consent.granted',
    aggregate: { type: 'consent-ledger', id: 'np-fx', version: 3 },
    occurredAt: '2026-03-15T09:00:00Z',
    recordedAt: '2026-03-15T09:00:00Z',
    source: { module: 'consent', actorRef: 'synthetic-staff:fx' },
    idempotencyKey: 'consent:np-fx:grant:0003',
    dataClassification: 'demographic',
    payload: { scope: 'sms/treatment' },
    synthetic: true,
    ...overrides,
  };
}

describe('event envelope build + validate', () => {
  it('builds a frozen envelope from a valid input', () => {
    const envelope = buildEventEnvelope(validInput());
    expect(envelope.eventId).toBe(validEventId);
    expect(envelope.aggregate.version).toBe(3);
    expect(envelope.synthetic).toBe(true);
  });

  it('omits absent optional fields rather than setting them undefined', () => {
    const envelope = buildEventEnvelope(validInput());
    expect('legalEntityId' in envelope).toBe(false);
    expect('effectiveAt' in envelope).toBe(false);
    expect('causationId' in envelope).toBe(false);
  });

  it('carries every optional field through when supplied', () => {
    const envelope = buildEventEnvelope(
      validInput({
        legalEntityId: 'northwind-pc',
        effectiveAt: '2026-03-14T00:00:00Z',
        correlationId: 'saga:onboarding:0007',
        causationId: otherEventId,
        retentionClass: 'consent-artifact',
        supersedesEventId: otherEventId,
        externalReceiptRef: 'synthetic-receipt:0001',
      }),
    );
    expect(envelope.legalEntityId).toBe('northwind-pc');
    expect(envelope.causationId).toBe(otherEventId);
    expect(envelope.retentionClass).toBe('consent-artifact');
  });

  it('rejects a non-ULID event id, causation id, and reversal pointer', () => {
    expect(() => validateEventEnvelope(validInput({ eventId: 'nce-0001' }))).toThrow(
      EventEnvelopeError,
    );
    expect(() => validateEventEnvelope(validInput({ causationId: 'nce-0001' }))).toThrow(
      EventEnvelopeError,
    );
    expect(() => validateEventEnvelope(validInput({ reversalOfEventId: 'x' }))).toThrow(
      EventEnvelopeError,
    );
  });

  it('rejects malformed scalars: tenant, type, aggregate version, instants, refs, class', () => {
    expect(() => validateEventEnvelope(validInput({ tenantId: 'Northwind' }))).toThrow();
    expect(() => validateEventEnvelope(validInput({ type: 'Consent Granted' }))).toThrow();
    expect(() =>
      validateEventEnvelope(validInput({ aggregate: { type: 'a', id: 'x', version: -1 } })),
    ).toThrow();
    expect(() => validateEventEnvelope(validInput({ occurredAt: '2026-03-15' }))).toThrow();
    expect(() =>
      validateEventEnvelope(validInput({ source: { module: 'consent', actorRef: 'A Person' } })),
    ).toThrow();
    expect(() =>
      validateEventEnvelope(
        validInput({
          dataClassification: 'top-secret' as EventEnvelopeInput<unknown>['dataClassification'],
        }),
      ),
    ).toThrow();
  });

  it('accepts millisecond-precision UTC instants', () => {
    expect(() =>
      validateEventEnvelope(validInput({ occurredAt: '2026-03-15T09:00:00.250Z' })),
    ).not.toThrow();
  });

  it('refuses a non-synthetic envelope', () => {
    expect(() =>
      validateEventEnvelope(validInput({ synthetic: false as unknown as true })),
    ).toThrow(EventEnvelopeError);
  });

  it('canonical serialization is stable regardless of construction order', () => {
    const a = buildEventEnvelope(validInput({ correlationId: 'saga:1' }));
    const b = buildEventEnvelope({
      synthetic: true,
      payload: { scope: 'sms/treatment' },
      dataClassification: 'demographic',
      idempotencyKey: 'consent:np-fx:grant:0003',
      source: { module: 'consent', actorRef: 'synthetic-staff:fx' },
      recordedAt: '2026-03-15T09:00:00Z',
      occurredAt: '2026-03-15T09:00:00Z',
      aggregate: { type: 'consent-ledger', id: 'np-fx', version: 3 },
      type: 'consent.granted',
      tenantId: 'northwind-synthetic',
      eventId: validEventId,
      correlationId: 'saga:1',
    });
    expect(canonicalEnvelope(a)).toBe(canonicalEnvelope(b));
  });
});

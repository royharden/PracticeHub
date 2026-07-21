/**
 * Consumer-side inbox dedup (WP-021; ADR-009 Decision 3). At-least-once
 * delivery from the outbox means a consumer can see an event more than once
 * (redelivery after a crash between the side effect and the mark-published).
 * The inbox is keyed by `(consumer, eventId)` — the FIRST time a consumer sees
 * an event it processes and records the key; every later sighting is a
 * duplicate and is skipped. This is the pure decision half; the module's inbox
 * table + `INSERT ... ON CONFLICT DO NOTHING` is the durable enforcement.
 */

export type InboxDecision = 'process' | 'skip-duplicate';

const consumerPattern = /^[a-z0-9][a-z0-9.:-]{0,127}$/;

export class InboxError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InboxError';
  }
}

/** The dedup key a consumer records once per event it has processed. */
export function inboxKey(consumer: string, eventId: string): string {
  if (!consumerPattern.test(consumer)) {
    throw new InboxError(
      `consumer must match ${consumerPattern.source}; received ${JSON.stringify(consumer)}`,
    );
  }
  return `${consumer}|${eventId}`;
}

/**
 * Decide whether a consumer should process an event: `process` the first time,
 * `skip-duplicate` on every redelivery. `seen` is the set of `inboxKey`s the
 * consumer has already recorded (built from the inbox table).
 */
export function inboxDedupDecision(
  seen: ReadonlySet<string>,
  consumer: string,
  eventId: string,
): InboxDecision {
  return seen.has(inboxKey(consumer, eventId)) ? 'skip-duplicate' : 'process';
}

export interface InboxRecord {
  readonly consumer: string;
  readonly eventId: string;
}

/** Build the seen-key set from inbox records (the pure fold the DB mirrors). */
export function foldInbox(records: readonly InboxRecord[]): ReadonlySet<string> {
  const seen = new Set<string>();
  for (const record of records) {
    seen.add(inboxKey(record.consumer, record.eventId));
  }
  return seen;
}
